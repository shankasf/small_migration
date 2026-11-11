"""Impact analysis edge cases: unread evidence, partial reads, honest gaps, source-question loops.

Synthetic data only.
"""
import json

from fakes import FakeGateway, call
from test_impact_pipeline import dossier, grant, impact, report
from test_turn_graph import Harness, route
from workflow.agents.impact.schemas import Answer, ImpactReport
from workflow.agents.impact.sources import SOURCE_QUESTION
from workflow.tools.evidence import remember
from workflow.tools.github import markers_first

READ_UPLOAD = call("read_impact_evidence", source="uploads", operation="read", parameters='{"id": "f"}')


def harness_with(reply):
    return Harness(FakeGateway(**{"evidence:uploads": reply}))


# --- partial reads are labelled for the reporter -------------------------------

def test_a_paged_read_is_marked_partial_but_its_content_stays_verbatim():
    evidence = []
    remember(evidence, "uploads", {"id": "f"}, json.dumps(
        {"filename": "manifest.json", "content": "L1| {", "offset": 0, "totalCharacters": 90000,
         "nextOffset": 24000, "partial": True}))
    assert evidence[0]["content"] == "L1| {"
    assert evidence[0]["locator"].startswith("manifest.json — PARTIAL: characters 0-24,000 of 90,000;")
    # A later page names its own range, not one inflated by the line-number labels.
    remember(evidence, "uploads", {"id": "f", "offset": 24000}, json.dumps(
        {"filename": "manifest.json", "content": "L900| x\nL901| y", "offset": 24000, "totalCharacters": 90000,
         "nextOffset": 48000, "partial": True}))
    assert "characters 24,000-48,000 of 90,000" in evidence[1]["locator"]


def test_a_complete_read_keeps_its_plain_locator():
    evidence = []
    remember(evidence, "uploads", {}, json.dumps({"path": "models/stg.sql", "content": "select 1",
                                                  "offset": 0, "nextOffset": None, "partial": False}))
    assert evidence[0]["locator"] == "models/stg.sql"


def test_two_target_reads_of_one_manifest_are_both_kept():
    evidence = []
    for target in ("stg_a", "stg_b"):
        remember(evidence, "uploads", {"id": "m", "target": target}, json.dumps(
            {"filename": "manifest.json", "target": target, "totalMatches": 1, "nextOffset": None,
             "matches": [{"uniqueId": f"model.p.{target}", "evidence": "{}", "truncated": False}]}))
    assert len(evidence) == 2 and "[target stg_b]" in evidence[1]["locator"]


def test_clipped_nodes_and_more_matches_are_named():
    evidence = []
    remember(evidence, "uploads", {"id": "m", "target": "stg"}, json.dumps(
        {"filename": "manifest.json", "target": "stg", "totalMatches": 9, "nextOffset": 5,
         "matches": [{"uniqueId": "model.p.stg_x", "evidence": "{}", "truncated": True}]}))
    locator = evidence[0]["locator"]
    assert "node details clipped for model.p.stg_x" in locator and "1 of 9 matching nodes" in locator


def test_budget_overflow_is_disclosed_not_silent(monkeypatch):
    import workflow.tools.evidence as module
    monkeypatch.setattr(module, "EVIDENCE_BUDGET_CHARS", 10)
    evidence = []
    remember(evidence, "uploads", {"id": "a"}, json.dumps({"filename": "a.sql", "content": "x" * 25}))
    remember(evidence, "uploads", {"id": "b"}, json.dumps({"filename": "b.sql", "content": "y"}))
    assert evidence[0]["content"] == "x" * 10 and "first 10 of 25" in evidence[0]["locator"]
    assert evidence[1]["content"] == "" and "not included here" in evidence[1]["locator"]


def test_reporter_sees_the_partial_marker():
    harness = harness_with({"filename": "manifest.json", "content": "{\"nodes\": {}}", "offset": 0,
                            "totalCharacters": 500000, "nextOffset": 24000, "partial": True})
    harness.models.script("investigator", READ_UPLOAD, dossier())
    harness.models.script("reporter", report())
    harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    brief = harness.models.requests("reporter")[0]["messages"][-1].content
    assert "=== [uploads] manifest.json — PARTIAL:" in brief and "of 500,000" in brief


# --- pagination markers survive the tool-result size clip ------------------------

def test_pagination_markers_come_before_bulky_fields():
    raw = json.dumps({"entries": [{"path": f"models/m{n}.sql"} for n in range(3)],
                      "hasMore": True, "nextOffset": 500, "truncated": True})
    reordered = markers_first(raw)
    assert reordered.index('"hasMore"') < reordered.index('"entries"')
    assert json.loads(reordered) == json.loads(raw)
    assert markers_first("not json") == "not json"


def test_a_large_read_clipped_by_the_tool_guard_still_counts_as_read():
    """A page of manifest nodes exceeds the 60k tool-result cap; it was still read."""
    big = {"filename": "manifest.json", "target": "stg", "totalMatches": 5, "nextOffset": None,
           "matches": [{"uniqueId": f"model.p.n{i}", "evidence": "z" * 30000, "truncated": False}
                       for i in range(5)]}
    harness = harness_with(big)
    harness.models.script("investigator", call("read_impact_evidence", source="uploads", operation="read",
                                               parameters='{"id": "m", "target": "stg"}'), dossier())
    harness.models.script("reporter", report())
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert "could not verify a dbt reference" not in result.response
    assert "### 1." in result.response and len(harness.models.requests("investigator")) == 2
    seen = next(m for m in harness.models.requests("investigator")[1]["messages"] if m.type == "tool")
    assert "[truncated" in seen.content  # the guard really clipped it, so the old count was zero


# --- never claim no access to a confirmed source that was never opened ---------------

def test_a_no_access_claim_for_a_never_opened_source_is_not_passed_on():
    harness = harness_with({"content": "unused"})
    claim = dossier(ready=False, evidence=[],
                    missing_information="I don't have access to the file. Please paste the manifest.json contents.")
    harness.models.script("investigator", claim, claim)
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert "don't have access" not in result.response and "please paste" not in result.response.lower()
    assert "I have not read anything yet from Uploaded files" in result.response
    # The re-read instruction named the unopened source.
    assert "not opened at all yet: uploads" in harness.models.requests("investigator")[1]["messages"][-1].content


def test_a_failed_read_lets_an_honest_unavailability_message_through():
    harness = harness_with({"error": "Evidence source is unavailable."})
    claim = dossier(ready=False, evidence=[], missing_information="The uploaded file could not be accessed; please re-upload it.")
    harness.models.script("investigator", READ_UPLOAD, claim, claim)
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert result.response == "The uploaded file could not be accessed; please re-upload it."


def test_attached_file_names_reach_the_investigator():
    harness = harness_with({"content": "select 1"})
    harness.models.script("investigator", READ_UPLOAD, dossier())
    harness.models.script("reporter", report())
    harness.turn("Use uploads", files={"manifest.json": "{}"}, impact_context=impact(grant(), just_confirmed=True))
    brief = json.loads(harness.models.requests("investigator")[0]["messages"][1].content)
    assert brief["attached_files"] == ["manifest.json"]


def test_a_long_earlier_message_is_marked_truncated_in_the_brief():
    harness = harness_with({"content": "select 1"})
    harness.models.script("investigator", READ_UPLOAD, dossier())
    harness.models.script("reporter", report())
    pasted = "```sql\n" + "select a from b\n" * 400 + "```"
    harness.turn("Use uploads", history=[{"role": "user", "content": pasted}],
                 impact_context=impact(grant(), just_confirmed=True))
    earlier = json.loads(harness.models.requests("investigator")[0]["messages"][1].content)["earlier_user_messages"]
    assert earlier[0].endswith("this is not the full message]") and f"of {len(pasted):,}" in earlier[0]


# --- the reporter cannot turn a grounded dossier into a file request or an empty reply ---

def test_reporter_asking_for_files_after_a_grounded_dossier_is_repaired_once():
    harness = harness_with({"content": "select customer_id from x"})
    harness.models.script("investigator", READ_UPLOAD, dossier())
    harness.models.script("reporter", report(ready=False, answers=[],
                                             missing_information="I don't have access to the file; please paste it."),
                          report())
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert "### 1. What breaks downstream?" in result.response and "paste" not in result.response
    assert "Do not ask the user for files" in harness.models.requests("reporter")[1]["messages"][-1].content


def test_reporter_that_still_cannot_answer_falls_back_to_the_dossier_honestly():
    harness = harness_with({"content": "select customer_id from x"})
    harness.models.script("investigator", READ_UPLOAD, dossier(unverified="Dashboards are not in the manifest."))
    not_ready = report(ready=False, answers=[], missing_information="Please paste the file.")
    harness.models.script("reporter", not_ready, not_ready)
    result = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert "paste" not in result.response.lower()
    assert "stg_customers -> customer_mart" in result.response and "Dashboards are not in the manifest." in result.response


def test_a_blank_answer_is_shown_as_unanswered_not_dropped():
    rendered = ImpactReport(ready=True, missing_information="", answers=[
        Answer(question="What breaks?", answer="`customer_mart`."),
        Answer(question="Which dashboards?", answer=" "),
        Answer(question="How to validate?", answer="`dbt compile --select stg`.")],
        critical_warnings="", gaps="").markdown()
    assert "### 2. Which dashboards?\n\nNot answered:" in rendered and "### 3. How to validate?" in rendered


def test_empty_reports_never_render_as_a_blank_reply():
    assert ImpactReport(ready=True, missing_information="", answers=[], critical_warnings="", gaps="").markdown()
    assert ImpactReport(ready=False, missing_information=" ", answers=[], critical_warnings="", gaps="").markdown()


# --- the source question does not loop forever ---------------------------------------

AWAITING = grant(phase="awaiting_sources", sources=[])


def menu_history(times):
    history = [{"role": "user", "content": "the file I attached"}]
    for _ in range(times):
        history += [{"role": "assistant", "content": SOURCE_QUESTION + "\n\n1. **Uploaded files**"},
                    {"role": "user", "content": "why didn't you read my attached file?"}]
    return history[:-1]


def test_first_non_answer_re_asks_with_a_note_not_verbatim():
    harness = Harness()
    harness.models.script("router", route("impact", new_analysis=False))
    result = harness.turn("hmm, not sure yet", history=menu_history(1),
                          impact_context=impact(AWAITING))
    assert result.paused and result.response.startswith("I could not find a source selection")
    assert SOURCE_QUESTION in result.response and result.impact_action == "continue"


def test_second_non_answer_clears_the_pending_analysis_instead_of_looping():
    harness = Harness()
    harness.models.script("router", route("impact", new_analysis=False))
    result = harness.turn("hmm, still thinking", history=menu_history(2), impact_context=impact(AWAITING))
    assert not result.paused and result.impact_action == "clear"
    assert SOURCE_QUESTION not in result.response and "set the impact analysis aside" in result.response
    assert not harness.models.requests("investigator") and not harness.gateway.requests


def test_a_new_analysis_after_repeated_menus_is_also_not_looped():
    harness = Harness()
    harness.models.script("router", route("impact", new_analysis=True))
    result = harness.turn("hmm, let me think", history=menu_history(2), impact_context=impact(AWAITING))
    assert result.impact_action == "clear" and SOURCE_QUESTION not in result.response


def test_awaiting_grant_without_earlier_menus_still_gets_the_normal_question():
    harness = Harness()
    harness.models.script("router", route("impact", new_analysis=False))
    result = harness.turn("hmm", impact_context=impact(AWAITING))
    assert result.paused and result.response.startswith(SOURCE_QUESTION) and result.impact_action == "continue"


# --- several confirmed sources: an unopened one is never silently skipped -------------

TWO_SOURCES = grant(sources=["uploads", "github"])


def test_no_access_claim_about_an_unopened_second_source_is_not_passed_on():
    harness = harness_with({"content": "select customer_id from x"})
    claim = dossier(ready=False, missing_information="I can't access the repository; please paste the model SQL.")
    harness.models.script("investigator", READ_UPLOAD, claim, claim)
    result = harness.turn("Use uploads and github", impact_context=impact(TWO_SOURCES, just_confirmed=True))
    assert "can't access" not in result.response and "I have not read anything yet from GitHub repositories" in result.response
    deepen = harness.models.requests("investigator")[2]["messages"][-1].content
    assert "not opened at all yet: github" in deepen


def test_a_report_that_never_opened_a_confirmed_source_says_so():
    harness = harness_with({"content": "select customer_id from x"})
    harness.models.script("investigator", READ_UPLOAD, dossier())
    harness.models.script("reporter", report())
    result = harness.turn("Use uploads and github", impact_context=impact(TWO_SOURCES, just_confirmed=True))
    assert "### 1." in result.response and "**Not opened:** GitHub repositories." in result.response
    assert len(harness.models.requests("reporter")) == 1


def test_a_report_that_opened_every_source_has_no_disclosure_line():
    harness = Harness(FakeGateway(**{"evidence:uploads": {"content": "select 1"},
                                     "evidence:github": {"path": "models/a.sql", "content": "select 2"}}))
    harness.models.script("investigator", READ_UPLOAD, call("read_impact_evidence", source="github",
                                                            operation="file", parameters='{"path": "models/a.sql"}'),
                          dossier())
    harness.models.script("reporter", report())
    result = harness.turn("Use uploads and github", impact_context=impact(TWO_SOURCES, just_confirmed=True))
    assert "Not opened" not in result.response


def test_continue_after_a_not_opened_question_resumes_the_analysis_and_reads():
    harness = harness_with({"content": "select customer_id from x"})
    claim = dossier(ready=False, evidence=[], missing_information="Please paste the manifest file.")
    harness.models.script("investigator", claim, claim)
    first = harness.turn("Use uploads", impact_context=impact(grant(), just_confirmed=True))
    assert first.paused and "Reply **continue**" in first.response
    harness.models.script("router", route("impact", new_analysis=False))
    harness.models.script("grant_judge", call("AnalysisContinuity", continues_confirmed_analysis=True))
    harness.models.script("investigator", READ_UPLOAD, dossier())
    harness.models.script("reporter", report())
    second = harness.turn("continue", impact_context=impact(grant()))
    assert second.route == "impact" and "### 1." in second.response
    assert harness.gateway.requests == [("evidence:uploads", "read", {"id": "f"})]


def test_source_question_loop_through_real_pauses():
    harness = Harness()
    history = []

    def say(message, new_analysis=False):
        harness.models.script("router", route("impact", new_analysis=new_analysis))
        result = harness.turn(message, history=list(history), impact_context=impact(AWAITING if history else None))
        history.extend([{"role": "user", "content": message}, {"role": "assistant", "content": result.response}])
        return result

    first = say("what breaks if I rename customer_id?", new_analysis=True)
    assert first.paused and first.response.startswith(SOURCE_QUESTION)
    second = say("hmm, not sure yet")
    assert second.paused and second.response.startswith("I could not find a source selection")
    third = say("hmm, still thinking")
    assert not third.paused and third.impact_action == "clear" and SOURCE_QUESTION not in third.response
