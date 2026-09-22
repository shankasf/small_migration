import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from agents import Agent, Runner, RunConfig
from agents.items import ModelResponse
from agents.models.interface import Model
from agents.tool_context import ToolContext
from agents.usage import Usage
from openai.types.responses import ResponseOutputMessage, ResponseOutputText, ResponseFunctionToolCall

import impact_agent as impact
from routes.migration import get_or_create_agent, agent_for_route


def run(coro):
    return asyncio.run(coro)


def context(tool):
    return ToolContext(context=None, tool_name=tool.name, tool_call_id='test', tool_arguments='{}')


def grant(**kwargs):
    return {'state': {'id': 'analysis', 'userId': 'alice', 'phase': 'confirmed', 'sources': ['uploads'],
                      'request': 'Rename customer_id in stg_customers', **kwargs}, 'connections': ['github'], 'history': []}


def report(**kwargs):
    fields = dict(
        ready=True, missing_information='',
        answers=[
            impact.Answer(question='What breaks downstream?',
                          answer="`customer_mart` breaks: it selects `customer_id` from "
                                 "`ref('stg_customers')` (models/customer_mart.sql:3)."),
            impact.Answer(question='How do I validate it?',
                          answer='`dbt compile --select stg_customers`, then '
                                 '`dbt build --select stg_customers+ --defer --state prod`.'),
        ],
        critical_warnings='- Do not validate this with one project-wide `dbt build`.',
        gaps='Dashboard consumers are not in the manifest.')
    fields.update(kwargs)
    return impact.ImpactReport(**fields)


class FakeModel(Model):
    def __init__(self, outputs):
        self.outputs = outputs
        self.calls = []

    async def get_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs, tracing, **kwargs):
        self.calls.append({'instructions': system_instructions, 'input': input, 'tools': tools, 'settings': model_settings})
        output = self.outputs.pop(0)
        if isinstance(output, str):
            output = [ResponseOutputMessage(id='m', role='assistant', status='completed',
                      content=[ResponseOutputText(type='output_text', text=output, annotations=[])], type='message')]
        return ModelResponse(output=output, usage=Usage(requests=1, input_tokens=11, output_tokens=7, total_tokens=18), response_id=None)

    async def stream_response(self, *args, **kwargs):
        raise AssertionError('Specialist output must stay internal, not stream to the user')
        yield  # async generator contract


def test_head_retains_migration_tools_and_routes_impact_as_a_tool_without_handoffs():
    head = get_or_create_agent('impact-head-test')
    assert head.name == 'Head Agent'
    assert head.model == impact.settings.model_name
    names = {tool.name for tool in head.tools}
    assert {'generate_output', 'get_file_content', 'impact_analysis_agent'} <= names
    assert head.handoffs == []
    assert head.tool_use_behavior == {'stop_at_tool_names': ['impact_analysis_agent']}


def test_history_routing_requires_message_search_and_excludes_unrelated_tools():
    head = get_or_create_agent('history-route-boundary')
    history = agent_for_route(head, 'history')
    assert {tool.name for tool in history.tools} == {'search_chat_history', 'search_chat_files'}
    assert history.model_settings.tool_choice == 'search_chat_history'
    assert history.reset_tool_choice is True  # Only the first call is forced.
    assert 'impact_analysis_agent' in {tool.name for tool in head.tools}
    migration = agent_for_route(head, 'migration')
    assert 'generate_output' in {tool.name for tool in migration.tools}
    assert 'impact_analysis_agent' not in {tool.name for tool in migration.tools}


@pytest.mark.parametrize('state', [None, grant(phase='awaiting_sources')['state']])
def test_no_confirmation_means_no_specialist_model_or_evidence_reads(monkeypatch, state):
    storage = {'_impact_context': {'state': state, 'connections': ['github']}}
    monkeypatch.setattr(impact, 'Agent', lambda **kwargs: pytest.fail('Specialist ran before source confirmation'))
    tool = impact.create_impact_tool('chat', storage)
    result = run(tool.on_invoke_tool(context(tool), '{}'))
    assert 'which evidence sources' in result
    assert 'GitHub repositories' in result and 'dbt Cloud' in result and 'Snowflake' in result
    assert 'Readiness Check' not in result and '### 1.' not in result


def test_new_analysis_requires_fresh_confirmation_even_after_an_earlier_grant(monkeypatch):
    storage = {'_impact_context': grant(), '_impact_new': True}
    monkeypatch.setattr(impact, 'Agent', lambda **kwargs: pytest.fail('Previous grant was reused'))
    tool = impact.create_impact_tool('chat', storage)
    assert 'which evidence sources' in run(tool.on_invoke_tool(context(tool), '{}'))
    assert storage['_impact_action'] == 'request_sources'


def test_real_sdk_nested_run_returns_exact_report_to_head_and_counts_both_models(monkeypatch):
    expected = report()
    specialist_model = FakeModel([[ResponseFunctionToolCall(id='e', call_id='evidence', name='read_impact_evidence',
        arguments=json.dumps({'source': 'uploads', 'operation': 'read', 'parameters': '{"id":"file"}'}), type='function_call')], expected.model_dump_json()])
    async def evidence(*args):
        return json.dumps({'content': "select customer_id from {{ ref('stg_customers') }}"})
    monkeypatch.setattr(impact, 'evidence_read', evidence)
    original_agent = Agent
    def specialist(**kwargs):
        assert kwargs['name'] == 'Impact Analysis Agent'
        assert kwargs['model'] == impact.settings.model_name
        assert {tool.name for tool in kwargs['tools']} == {'read_impact_evidence'}
        kwargs['model'] = specialist_model
        return original_agent(**kwargs)
    monkeypatch.setattr(impact, 'Agent', specialist)
    storage = {'_impact_context': grant(), '_current_message': 'Use uploads', '_actor_id': 'alice'}
    tool = impact.create_impact_tool('chat', storage)
    head_model = FakeModel([[ResponseFunctionToolCall(id='f', call_id='call', name='impact_analysis_agent', arguments='{}', type='function_call')]])
    head = Agent(name='Head Agent', model=head_model, tools=[tool], tool_use_behavior={'stop_at_tool_names': ['impact_analysis_agent']})
    result = run(Runner.run(head, 'Analyze this change', run_config=RunConfig(tracing_disabled=True)))
    assert result.final_output == expected.markdown()
    assert result.context_wrapper.usage.input_tokens == 33
    assert result.context_wrapper.usage.output_tokens == 21
    assert len(head_model.calls) == 1 and len(specialist_model.calls) == 2
    assert 'Rename customer_id in stg_customers' in json.dumps(specialist_model.calls[0]['input'])
    assert not storage.get('turn_outputs')


def test_missing_inputs_return_only_the_missing_questions():
    value = report(ready=False, missing_information='Which column and proposed change should I analyze?')
    assert value.markdown() == 'Which column and proposed change should I analyze?'


def test_unverified_model_report_is_replaced_with_an_evidence_gap(monkeypatch):
    model = FakeModel([report().model_dump_json()])
    monkeypatch.setattr(impact, 'Agent', lambda **kwargs: Agent(**{**kwargs, 'model': model}))
    tool = impact.create_impact_tool('chat', {'_impact_context': grant(), '_current_message': 'Use uploads'})
    output = run(tool.on_invoke_tool(context(tool), '{}'))
    assert 'could not verify a dbt reference' in output
    assert 'customer_mart' not in output and '### 1.' not in output


def test_report_answers_the_users_questions_in_their_order_without_audit_scaffolding():
    rendered = report().markdown()
    assert rendered.index('### 1. What breaks downstream?') < rendered.index('### 2. How do I validate it?')
    # The citation survives; the per-finding confidence labels and the old
    # fixed-section template do not.
    assert "`ref('stg_customers')`" in rendered and 'models/customer_mart.sql:3' in rendered
    for banned in ('Evidence-backed', 'Inferred', 'Readiness Check', 'Change Summary',
                   'Hard Evidence Used', 'Lineage Summary', 'Assumptions and Gaps'):
        assert banned not in rendered
    # One warning block and one gaps line — each caveat is stated exactly once.
    assert rendered.count('### Watch out') == 1 and rendered.count('**Gaps:**') == 1


def test_optional_blocks_disappear_when_there_is_nothing_to_warn_about():
    rendered = report(critical_warnings='', gaps='  ').markdown()
    assert 'Watch out' not in rendered and 'Gaps:' not in rendered
    assert rendered.endswith('--defer --state prod`.')


def test_both_mandatory_checks_are_carried_by_the_specialist_and_the_chatbot():
    """The two findings the analyst had to add by hand stay in the prompts."""
    from routes.migration import INSTRUCTIONS
    for prompt in (impact.PROMPT, INSTRUCTIONS):
        assert 'state:modified+' in prompt and '--defer' in prompt
        assert 'dbt compile --select' in prompt
        assert 'NUMBER(38,0)' in prompt
        assert 'scale' in prompt.lower() and 'truncat' in prompt.lower()


def test_evidence_reader_cannot_broaden_sources_or_accept_model_supplied_actor(monkeypatch):
    storage = {'_impact_context': grant(), '_actor_id': 'alice'}
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={'content': 'select customer_id from customers'})
    original = httpx.AsyncClient
    monkeypatch.setattr(impact.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    denied = run(impact.evidence_read('chat', storage, 'github', 'file', {}))
    assert 'not been confirmed' in denied and not requests
    result = run(impact.evidence_read('chat', storage, 'uploads', 'read', {'id': 'f'}))
    assert 'customer_id' in result
    body = json.loads(requests[0].content)
    assert body['user_id'] == 'alice' and body['analysis_id'] == 'analysis'
    tool = impact.create_evidence_tools('chat', storage)[0]
    assert 'user_id' not in json.dumps(tool.params_json_schema)


def test_evidence_is_screened_before_entering_specialist_context(monkeypatch):
    original = httpx.AsyncClient
    def handler(request):
        return httpx.Response(200, json={'content': 'Patient NHI: ZAC5678'})
    monkeypatch.setattr(impact.httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    result = run(impact.evidence_read('chat', {'_impact_context': grant(), '_actor_id': 'alice'}, 'uploads', 'read', {}))
    assert 'ZAC5678' not in result and 'blocked' in result


def test_explicit_source_reply_continues_without_reclassifying_or_expanding_the_grant(monkeypatch):
    monkeypatch.setattr(impact, 'Agent', lambda **kwargs: pytest.fail('Unnecessary classifier call'))
    route, inputs, outputs = run(impact.route_request('Use uploads', [], {**grant(), 'just_confirmed': True}, None))
    assert route.route == 'impact' and not route.new_analysis and inputs == outputs == 0


def _routing_result(final_output, inputs=7, outputs=3):
    return SimpleNamespace(final_output=final_output, raw_responses=[],
                           context_wrapper=SimpleNamespace(usage=SimpleNamespace(
                               input_tokens=inputs, output_tokens=outputs)))


@pytest.mark.parametrize('continues, expected_new_analysis', [(False, True), (True, False)])
def test_confirmed_grant_is_rechecked_before_it_covers_a_later_turn(monkeypatch, continues, expected_new_analysis):
    """GPT-OSS reused a confirmed grant for a different target roughly half the time."""
    replies = [impact.HeadRoute(route='impact', new_analysis=False),
               impact.AnalysisContinuity(continues_confirmed_analysis=continues)]
    seen = []
    async def fake_run(agent, payload, **kwargs):
        seen.append(json.loads(payload))
        return _routing_result(replies[len(seen) - 1])
    monkeypatch.setattr(impact.Runner, 'run', fake_run)
    route, inputs, outputs = run(impact.route_request(
        'New impact analysis: what breaks if I drop customer_count from customer_mart?', [], grant(), None))
    assert route.new_analysis is expected_new_analysis
    assert len(seen) == 2
    assert seen[1]['confirmed_analysis_request'] == 'Rename customer_id in stg_customers'
    # Both classifier calls are metered, not just the router's.
    assert (inputs, outputs) == (14, 6)


@pytest.mark.parametrize('context_kwargs, router_new_analysis', [
    ({'phase': 'awaiting_sources'}, False),  # No grant exists yet to protect.
    ({}, True),                              # The router already fails closed.
])
def test_continuity_recheck_is_skipped_when_it_cannot_change_the_outcome(monkeypatch, context_kwargs, router_new_analysis):
    calls = []
    async def fake_run(agent, payload, **kwargs):
        calls.append(payload)
        return _routing_result(impact.HeadRoute(route='impact', new_analysis=router_new_analysis))
    monkeypatch.setattr(impact.Runner, 'run', fake_run)
    route, inputs, outputs = run(impact.route_request('What breaks?', [], grant(**context_kwargs), None))
    assert route.new_analysis is router_new_analysis
    assert len(calls) == 1 and (inputs, outputs) == (7, 3)


def test_continuity_recheck_does_not_run_for_non_impact_routes(monkeypatch):
    calls = []
    async def fake_run(agent, payload, **kwargs):
        calls.append(payload)
        return _routing_result(impact.HeadRoute(route='history', new_analysis=False))
    monkeypatch.setattr(impact.Runner, 'run', fake_run)
    route, _, _ = run(impact.route_request('Which file did I upload?', [], grant(), None))
    assert route.route == 'history' and len(calls) == 1
