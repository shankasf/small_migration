import asyncio
import json
from unittest.mock import Mock

import httpx
import pytest
from agents import Agent, ModelSettings, OpenAIChatCompletionsModel, RunConfig, Runner, function_tool
from openai import AsyncOpenAI
from pydantic import BaseModel

from bedrock import AnswerFilter, BedrockCompletions, FINAL_TOOL
from config import settings
from llm import configure_llm
import guardrails


@pytest.mark.parametrize('split', range(1, 45))
def test_reasoning_is_removed_at_every_chunk_boundary(split):
    raw = '<reasoning>private model analysis</reasoning>{"ok":true}'
    filter_ = AnswerFilter()
    result = ''.join(filter_.feed(raw[i:i + split]) for i in range(0, len(raw), split))
    result += filter_.feed('', final=True)
    assert result == '{"ok":true}'


def test_truncated_reasoning_is_not_exposed():
    assert AnswerFilter().feed('<reasoning>unfinished internal text', final=True) == ''
    assert AnswerFilter().feed('SELECT id FROM t WHERE id < 5', final=True).endswith('< 5')


def test_bedrock_credentials_are_redacted_in_both_directions():
    key = 'ABSK' + 'synthetic' * 16 + '=='
    assert key not in guardrails.screen_payload(key)['message']
    assert key not in guardrails.check_outbound(key).text


@pytest.fixture
def bedrock_settings(monkeypatch):
    for name, value in {
        'LLM_PROVIDER': 'bedrock', 'BEDROCK_REGION': 'ap-southeast-2',
        'PROCESSING_REGION': 'ap-southeast-2', 'BEDROCK_MODEL': 'openai.gpt-oss-120b-1:0',
        'APPROVED_LLM_HOST': 'bedrock-runtime.ap-southeast-2.amazonaws.com',
        'AWS_BEARER_TOKEN_BEDROCK': 'synthetic-bedrock-key',
    }.items():
        monkeypatch.setattr(settings, name, value)


@pytest.mark.parametrize('name,value', [
    ('APPROVED_LLM_HOST', 'attacker.invalid'), ('PROCESSING_REGION', 'us-east-1'),
    ('BEDROCK_REGION', 'ap-southeast-2.attacker.invalid/'), ('AWS_BEARER_TOKEN_BEDROCK', ''),
    ('BEDROCK_MODEL', 'global.anthropic.example'),
])
def test_bedrock_fails_closed(bedrock_settings, monkeypatch, name, value):
    monkeypatch.setattr(settings, name, value)
    with pytest.raises(RuntimeError):
        configure_llm()


def test_bedrock_config_uses_separate_key_and_chat_api(bedrock_settings, monkeypatch):
    import agents
    client = Mock()
    api = Mock()
    monkeypatch.setattr(agents, 'set_default_openai_client', client)
    monkeypatch.setattr(agents, 'set_default_openai_api', api)
    assert configure_llm() == 'openai.gpt-oss-120b-1:0'
    sdk = client.call_args.args[0]
    assert sdk.api_key == 'synthetic-bedrock-key'
    assert str(sdk.base_url) == 'https://bedrock-runtime.ap-southeast-2.amazonaws.com/openai/v1/'
    assert isinstance(sdk.chat.completions, BedrockCompletions)
    assert client.call_args.kwargs == {'use_for_tracing': False}
    api.assert_called_once_with('chat_completions')
    asyncio.run(sdk.close())


class FinalAnswer(BaseModel):
    value: int


def test_typed_agent_tool_roundtrip_with_bedrock_response_shapes():
    requests = []
    invoked = []

    @function_tool
    async def lookup() -> int:
        invoked.append(True)
        return 42

    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        assert 'response_format' not in body
        assert body['tools'][-1]['function']['name'] == FINAL_TOOL
        assert body['store'] is False
        name, arguments = ('lookup', '{}') if len(requests) == 1 else (FINAL_TOOL, '{"value":42}')
        return httpx.Response(200, json={
            'id': 'synthetic', 'object': 'chat.completion', 'created': 1, 'model': 'openai.gpt-oss-120b-1:0',
            'choices': [{'index': 0, 'finish_reason': 'tool_calls', 'message': {
                'role': 'assistant', 'content': '<reasoning>hidden</reasoning>',
                'tool_calls': [{'id': f'call_{len(requests)}', 'type': 'function',
                                'function': {'name': name, 'arguments': arguments}}]}}],
            'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15},
        })

    async def scenario():
        async with AsyncOpenAI(api_key='synthetic', http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
            client.chat.completions = BedrockCompletions(client)
            agent = Agent(name='test', model=OpenAIChatCompletionsModel('openai.gpt-oss-120b-1:0', client),
                          output_type=FinalAnswer, tools=[lookup], model_settings=ModelSettings(store=False))
            result = await Runner.run(agent, 'Look up the value', run_config=RunConfig(tracing_disabled=True))
            assert result.final_output.value == 42
            assert result.context_wrapper.usage.total_tokens == 30
            assert len(invoked) == 1
            assert '<reasoning>' not in json.dumps(requests[1]['messages'])
    asyncio.run(scenario())


def test_stream_preserves_tool_deltas_usage_and_closes_transport():
    seen = []
    def respond(request):
        seen.append(json.loads(request.content))
        payloads = []
        for text in ['<reas', 'oning>hidden', '</reason', 'ing>Answer']:
            payloads.append({'id': 's', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'test',
                             'choices': [{'index': 0, 'delta': {'content': text}, 'finish_reason': None}]})
        payloads.append({'id': 's', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'test',
            'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'id': 'call1', 'type': 'function',
                'function': {'name': 'lookup', 'arguments': '{}'}}]}, 'finish_reason': 'tool_calls'}]})
        payloads.append({'id': 's', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'test',
            'choices': [], 'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}})
        body = ''.join('data: ' + json.dumps(p) + '\n\n' for p in payloads) + 'data: [DONE]\n\n'
        return httpx.Response(200, text=body, headers={'content-type': 'text/event-stream'})
    async def scenario():
        async with AsyncOpenAI(api_key='synthetic', http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
            stream = await BedrockCompletions(client).create(model='test', messages=[], stream=True)
            chunks = [chunk async for chunk in stream]
            assert ''.join(c.choices[0].delta.content or '' for c in chunks if c.choices) == 'Answer'
            assert chunks[-2].choices[0].delta.tool_calls[0].function.name == 'lookup'
            assert chunks[-1].usage.total_tokens == 15
            assert seen[0]['stream_options'] == {'include_usage': True}
    asyncio.run(scenario())
