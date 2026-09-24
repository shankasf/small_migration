"""Impact analysis: source confirmation, grounded evidence, answer format."""
import asyncio
import json

import pytest

from fakes import FakeGateway, call
from test_turn_graph import Harness, route
from workflow.agents.impact.graph import command_issues, count_substantive_reads
from workflow.agents.impact.schemas import Answer, ImpactReport
from workflow.prompts import read

MANIFEST_READ = {"content": "select customer_id from {{ ref('stg_customers') }}"}


def grant(**overrides):
    return {"id": "analysis", "userId": "alice", "phase": "confirmed", "sources": ["uploads"],
            "request": "Rename customer_id in stg_customers", **overrides}


def impact(state=None, **extra):
    return {"state": state, "connections": ["github"], "history": [], **extra}


def dossier(**overrides):
    fields = dict(ready=True, missing_information="",
                  evidence=[{"source": "uploads", "locator": "models/customer_mart.sql:3",
                             "excerpt": "select customer_id from {{ ref('stg_customers') }}"}],
                  lineage_notes="stg_customers -> customer_mart", unverified="")
    fields.update(overrides)
    return call("submit_evidence_dossier", **fields)


def report(**overrides):
    fields = dict(ready=True, missing_information="",
                  answers=[{"question": "What breaks downstream?",
                            "answer": "`customer_mart` breaks: it selects `customer_id` from `ref('stg_customers')`."},
                           {"question": "How do I validate it?",
                            "answer": "`dbt compile --select stg_customers`, then `dbt build --select stg_customers+ --defer --state prod`."}],
                  critical_warnings="- Do not validate this with one project-wide `dbt build`.",
                  gaps="Dashboard consumers are not in the manifest.")
    fields.update(overrides)
    return call("ImpactReport", **fields)


@pytest.fixture
def harness():
    return Harness(FakeGateway(**{"evidence:uploads": MANIFEST_READ}))


@pytest.mark.parametrize("state", [None, grant(phase="awaiting_sources", sources=[])])
def test_no_confirmation_means_no_specialist_model_or_evidence_reads(harness, state):
    harness.models.script("router", route("impact", new_analysis=state is None))
    result = harness.turn("What breaks if I rename customer_id?", impact_context=impact(state))
    assert result.paused
    assert "which evidence sources" in result.response
    assert "GitHub repositories" in result.response and "dbt Cloud" in result.response and "Snowflake" in result.response
    assert "(connected)" in result.response
    assert "Readiness Check" not in result.response and "### 1." not in result.response
    assert not harness.models.requests("investigator") and not harness.gateway.requests
    assert result.impact_action == ("request_sources" if state is None else "continue")


def test_new_analysis_requires_fresh_confirmation_even_after_an_earlier_grant(harness):
    """With a confirmed grant the Grant Judge decides continuity, and a different target fails closed."""
    harness.models.script("router", route("impact", new_analysis=True))
    harness.models.script("grant_judge", call("AnalysisContinuity", continues_confirmed_analysis=False))
    result = harness.turn("New impact analysis: drop customer_count", impact_context=impact(grant()))
    assert result.impact_action == "request_sources" and "which evidence sources" in result.response
    assert harness.models.requests("grant_judge") and not harness.models.requests("investigator")
    assert not harness.gateway.requests


def test_just_confirmed_sources_skip_classification_and_produce_a_grounded_report(harness):
    harness.models.script("investigator", call("read_impact_evidence", source="uploads", operation="read",
                                               parameters='{"id": "file"}'), dossier())
    harness.models.script("reporter", report())
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert not harness.models.requests("router") and not harness.models.requests("grant_judge")
    assert result.response.index("### 1. What breaks downstream?") < result.response.index("### 2. How do I validate it?")
    assert "customer_mart" in result.response and result.files == {}
    assert harness.gateway.requests == [("evidence:uploads", "read", {"id": "file"})]
    assert harness.logger.tools_called() == ["impact_analysis_agent", "read_impact_evidence"]
    brief = json.loads(harness.models.requests("investigator")[0]["messages"][-1].content)
    assert brief["request"] == "Rename customer_id in stg_customers" and brief["confirmed_sources"] == ["uploads"]
    # The investigator's only tools are the evidence reader and its result submission.
    assert set(harness.models.requests("investigator")[0]["tools"]) == {"read_impact_evidence", "submit_evidence_dossier"}


def test_the_pause_resumes_into_a_fresh_routing_of_the_reply(harness):
    harness.models.script("router", route("impact", new_analysis=True))
    assert harness.turn("What breaks if I rename customer_id?", impact_context=impact()).paused
    harness.models.script("investigator", dossier())
    harness.models.script("reporter", report())
    result = harness.turn("Use uploads", impact_context=impact(
        grant(request="What breaks if I rename customer_id?", sources=["uploads"]), just_confirmed=True,
        history=[{"role": "user", "content": "```sql\nselect customer_id from x\n```"}]))
    assert not result.paused and "### 1." in result.response


def test_evidence_reads_cannot_broaden_sources(harness):
    harness.models.script("investigator",
                          call("read_impact_evidence", source="github", operation="file", parameters='{"path": "a.sql"}'),
                          dossier(), dossier())
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert not harness.gateway.requests
    refusal = next(m for m in harness.models.requests("investigator")[1]["messages"] if m.type == "tool")
    assert "not been confirmed" in refusal.content
    # Nothing substantive was read and nothing was pasted, so no report is written.
    assert "could not verify a dbt reference" in result.response
    assert not harness.models.requests("reporter")


def test_confirmed_grant_is_rechecked_for_a_different_target(harness):
    harness.models.script("router", route("impact", new_analysis=False))
    harness.models.script("grant_judge", call("AnalysisContinuity", continues_confirmed_analysis=False))
    result = harness.turn("What breaks if I drop customer_count from customer_mart?", impact_context=impact(grant()))
    assert result.impact_action == "request_sources" and result.paused
    judge = json.loads(harness.models.requests("grant_judge")[0]["messages"][-1].content)
    assert judge["confirmed_analysis_request"] == "Rename customer_id in stg_customers"
    assert not harness.gateway.requests


def test_same_analysis_follow_up_keeps_the_grant(harness):
    harness.models.script("router", route("impact", new_analysis=False))
    harness.models.script("grant_judge", call("AnalysisContinuity", continues_confirmed_analysis=True))
    harness.models.script("investigator", call("read_impact_evidence", source="uploads", operation="read",
                                               parameters="{}"), dossier())
    harness.models.script("reporter", report())
    result = harness.turn("And which tests cover that column?", impact_context=impact(grant()))
    assert not result.paused and "### 1." in result.response


def test_investigator_asking_for_inputs_returns_only_the_questions(harness):
    not_ready = dossier(ready=False, missing_information="Which column should I analyse?", evidence=[])
    # One self-serve pass first; the question reaches the user only if it survives it.
    harness.models.script("investigator", call("read_impact_evidence", source="uploads", operation="read",
                                               parameters="{}"), not_ready, not_ready)
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert result.response == "Which column should I analyse?"
    assert not harness.models.requests("reporter")


def test_substantive_reads_are_counted_from_the_raw_transcript():
    from langchain_core.messages import AIMessage, ToolMessage
    messages = [AIMessage("", tool_calls=[
        {"name": "read_impact_evidence", "args": {"source": "uploads", "operation": "list"}, "id": "1"},
        {"name": "read_impact_evidence", "args": {"source": "uploads", "operation": "read"}, "id": "2"},
        {"name": "read_impact_evidence", "args": {"source": "uploads", "operation": "read"}, "id": "3"}]),
        ToolMessage(json.dumps({"files": ["a"]}), tool_call_id="1"),
        ToolMessage(json.dumps({"content": "select 1"}), tool_call_id="2"),
        ToolMessage(json.dumps({"error": "unavailable"}), tool_call_id="3")]
    assert count_substantive_reads(messages) == 1


def test_missing_inputs_render_as_only_the_questions():
    value = ImpactReport(ready=False, missing_information="Which column?", answers=[], critical_warnings="", gaps="")
    assert value.markdown() == "Which column?"


def test_report_answers_in_order_without_audit_scaffolding():
    rendered = ImpactReport(ready=True, missing_information="", answers=[
        Answer(question="What breaks downstream?", answer="`customer_mart` (models/customer_mart.sql:3)."),
        Answer(question="How do I validate it?", answer="`dbt compile --select stg_customers`.")],
        critical_warnings="- Do not run one project-wide build.", gaps="Dashboards are not in the manifest.").markdown()
    assert rendered.index("### 1. What breaks downstream?") < rendered.index("### 2. How do I validate it?")
    for banned in ("Evidence-backed", "Inferred", "Readiness Check", "Change Summary", "Lineage Summary"):
        assert banned not in rendered
    assert rendered.count("### Watch out") == 1 and rendered.count("**Gaps:**") == 1
    bare = ImpactReport(ready=True, missing_information="", answers=[Answer(question="Q", answer="A.")],
                        critical_warnings="", gaps=" ").markdown()
    assert "Watch out" not in bare and "Gaps:" not in bare


def test_both_mandatory_checks_are_carried_by_the_prompts():
    """The staged build plan and the Snowflake scale check stay in every prompt that needs them."""
    for text in (read("impact_analysis") + read("reporter"), read("dbt_rules")):
        assert "state:modified+" in text and "--defer" in text
        assert "dbt compile" in text
        assert "NUMBER(38,0)" in read("dbt_rules") and "NUMBER(38,0)" in read("impact_analysis")
        assert "scale" in text.lower() and "truncat" in text.lower()


def test_an_investigator_that_read_nothing_is_sent_back_once_to_read(harness):
    harness.models.script("investigator",
                          dossier(ready=False, missing_information="Please upload manifest.json.", evidence=[]),
                          call("read_impact_evidence", source="uploads", operation="read", parameters='{"id": "f"}'),
                          dossier())
    harness.models.script("reporter", report())
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert "### 1." in result.response and "upload manifest" not in result.response
    reread = harness.models.requests("investigator")[1]["messages"][-1].content
    assert "without reading any of the confirmed evidence" in reread
    assert harness.logger.tools_called().count("impact_analysis_agent") == 1


def test_a_second_ungrounded_conclusion_is_answered_not_looped(harness):
    harness.models.script("investigator", dossier(ready=False, missing_information="Which column?", evidence=[]),
                          dossier(ready=False, missing_information="Which column?", evidence=[]))
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert result.response == "Which column?"
    assert len(harness.models.requests("investigator")) == 2 and not harness.models.requests("reporter")


# --- production feedback: GitHub-based impact analysis -----------------------

def test_an_invented_tool_name_is_an_error_the_investigator_recovers_from(harness):
    """The old runtime failed the turn with "Tool github.tree not found"."""
    harness.models.script("investigator",
                          call("github.tree", path="models"),
                          call("read_impact_evidence<|channel|>commentary", source="uploads", operation="read",
                               parameters="{}"),
                          dossier())
    harness.models.script("reporter", report())
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert "### 1." in result.response
    invalid = next(m for m in harness.models.requests("investigator")[1]["messages"] if m.type == "tool")
    assert invalid.status == "error" and "not a valid tool" in invalid.content
    # The Harmony-suffixed name was cleaned and dispatched.
    assert harness.gateway.requests == [("evidence:uploads", "read", {})]


def test_the_brief_keeps_the_users_question_when_the_request_is_a_follow_up(harness):
    question = "Trace the impact of changing Losartan cost to $15 on rep_dispensing, citing file:line."
    harness.models.script("investigator", call("read_impact_evidence", source="uploads", operation="read",
                                               parameters="{}"), dossier())
    harness.models.script("reporter", report())
    harness.turn("3", history=[{"role": "user", "content": question},
                               {"role": "assistant", "content": "Before I analyze the impact, which evidence sources?"}],
                 impact_context=impact(grant(request="use the integrated dbt repository in github"), just_confirmed=True))
    brief = json.loads(harness.models.requests("investigator")[0]["messages"][1].content)
    assert brief["earlier_user_messages"] == [question]
    assert "which evidence sources" not in json.dumps(brief["earlier_user_messages"])


def test_an_investigator_question_pauses_and_the_answer_resumes_the_analysis(harness):
    """Production feedback: the answer "<repo> using the main branch" went to the Repository Agent."""
    which = dossier(ready=False, missing_information="Which repository holds the dbt project?", evidence=[])
    harness.models.script("investigator", call("read_impact_evidence", source="uploads", operation="read",
                                               parameters="{}"), which, which)
    first = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert first.paused and first.response == "Which repository holds the dbt project?"

    harness.models.script("router", route("repository"))  # the misreading seen in production
    harness.models.script("grant_judge", call("AnalysisContinuity", continues_confirmed_analysis=True))
    harness.models.script("investigator", call("read_impact_evidence", source="uploads", operation="read",
                                               parameters="{}"), dossier())
    harness.models.script("reporter", report())
    second = harness.turn("circini-demo/pharma_dbt_repo using the main branch", impact_context=impact(grant()))
    assert second.route == "impact" and "### 1." in second.response
    assert not harness.models.requests("repository")
    router_brief = json.loads(harness.models.requests("router")[0]["messages"][-1].content)
    assert router_brief["pending_question"]["kind"] == "impact_question"


def test_the_reporter_reads_the_evidence_verbatim_with_line_numbers(harness):
    harness.gateway.replies["evidence:uploads"] = {"path": "models/stg.sql", "content": "select cost\nfrom drugs\nwhere current"}
    harness.models.script("investigator", call("read_impact_evidence", source="uploads", operation="read",
                                               parameters='{"id": "f"}'), dossier())
    harness.models.script("reporter", report())
    harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    brief = harness.models.requests("reporter")[0]["messages"][-1].content
    assert "=== [uploads] models/stg.sql" in brief and "L3| where current" in brief


def test_open_questions_in_the_dossier_send_the_investigator_back_once(harness):
    """Production feedback: rows were never listed because the data file was never read."""
    open_q = dossier(coverage=[{"question": "Which rows are affected?", "evidence": [],
                                "open": "needs seeds/pharma/prescription.csv"}])
    harness.models.script("investigator",
                          call("read_impact_evidence", source="uploads", operation="read", parameters="{}"), open_q,
                          call("read_impact_evidence", source="uploads", operation="read", parameters='{"id": "rx"}'),
                          dossier(), dossier())
    harness.models.script("reporter", report())
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert "### 1." in result.response
    second_pass = harness.models.requests("investigator")[2]["messages"]
    assert any("needs seeds/pharma/prescription.csv" in m.content for m in second_pass if m.type == "human")
    assert len(harness.gateway.requests) == 2


@pytest.mark.parametrize("first_answer", [
    "`dbt snapshot --select drugs_snapshot`",
    "`dbt seed --select drugs`, then `dbt snapshot --select drugs_snapshot`",
    "`dbt run --select land_drugs`, then `dbt seed --select drugs`, then `dbt snapshot --select drugs_snapshot`",
])
def test_a_seed_change_report_with_missing_stages_is_sent_back_once(harness, first_answer):
    harness.gateway.replies["evidence:uploads"] = {
        "filename": "snapshots/drugs_snapshot.sql",
        "content": "{% snapshot drugs_snapshot %}\nselect * from {{ ref('land_drugs') }}\n{% endsnapshot %}",
    }
    seed_change = dossier(change_kind="seed_or_source_data", changed_file="seeds/pharma/drugs.csv")
    harness.models.script("investigator", call("read_impact_evidence", source="uploads", operation="read",
                                               parameters="{}"), seed_change)
    harness.models.script("reporter", report(answers=[{"question": "Which commands?", "answer": first_answer}]), report(answers=[
        {"question": "Which commands?", "answer": "`dbt seed --select drugs`, then `dbt run --select land_drugs`, "
         "then `dbt snapshot --select drugs_snapshot`, then `dbt build --select stg_dispensing rep_dispensing`."}]))
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert "dbt seed --select drugs" in result.response
    first_brief = harness.models.requests("reporter")[0]["messages"][-1].content
    assert "`dbt seed --select drugs`" in first_brief
    assert "source() reference" in first_brief and "proves it selects all intended nodes" in first_brief
    assert len(harness.models.requests("reporter")) == 2
    assert "dbt run --select land_drugs" in result.response


def test_repeated_command_omission_withholds_commands_but_preserves_analysis(harness):
    harness.models.script("investigator", call("read_impact_evidence", source="uploads", operation="read",
                                               parameters="{}"),
                          dossier(change_kind="seed_or_source_data", changed_file="seeds/pharma/drugs.csv"))
    harness.models.script("reporter", report(), report())
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert "customer_mart" in result.response
    assert "withheld the commands" in result.response
    assert "dbt build" not in result.response and "dbt compile" not in result.response
    assert len(harness.models.requests("reporter")) == 2


def test_snapshot_command_check_uses_read_refs_and_ignores_commented_refs():
    evidence = [{"locator": "snapshots/drugs_snapshot.sql", "content":
                 "L1| {% snapshot drugs_snapshot %}\nL2| -- {{ ref('old_model') }}\n"
                 "L3| select * from {{ ref('land_drugs') }}\nL4| {% endsnapshot %}"}]
    fields = report(answers=[{"question": "Commands", "answer":
                    "`dbt seed --select drugs`; `dbt run --select land_drugs`; "
                    "`dbt snapshot --select drugs_snapshot`"}], critical_warnings="", gaps="").tool_calls[0]["args"]
    assert command_issues(ImpactReport.model_validate(fields), evidence) == []


@pytest.mark.parametrize("message", ["check GitHub too", "use Snowflake metadata as well", "switch to the dbt Cloud run"])
def test_naming_an_unconfirmed_source_needs_fresh_confirmation_without_a_model_call(harness, message):
    harness.models.script("router", route("impact", new_analysis=False))
    result = harness.turn(message, impact_context=impact(grant()))
    assert result.impact_action == "request_sources" and result.paused
    assert not harness.models.requests("grant_judge")
