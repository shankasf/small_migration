"""Router continuity guards for follow-ups about a file attached to this chat.

UAT: a design .md was attached, a dbt model generated from it, and the user's
follow-ups about the file's content were sent to the History Agent (chat search
only) or to impact, whose pending evidence-source question then swallowed every
later reply. Synthetic data only.
"""
import pytest

from workflow.agents.router import HAND_IT_OVER, RouterAgent
from workflow.state import Route

SOURCES_PENDING = {"kind": "impact_sources", "route": "impact",
                   "question": "Before I analyze the impact, which evidence sources should I use?"}
CLARIFICATION = {"kind": "clarification", "route": "generate",
                 "question": "Which model is the base ref for stg_widgets?"}
IMPACT_QUESTION = {"kind": "impact_question", "route": "impact", "question": "Which column are you renaming?"}

COMPLAINTS = [
    "why does the code not populate payload_data",
    "Are you not able to read the attached markdown file?",
    "How did you generate the code if you cant access the file? what was it based on?",
    "I didnt give you a high-level description I just gave you the file which you parsed. "
    "so why cant you read it now",
]
SECTION_CORRECTION = ('The fields for the JSON are described in the "Payload Data (JSON)" section, '
                      "do you not understand what it says")


def routed(route, message, *, pending=None, last=None, attached=True, new_analysis=False):
    state = {"message": message, "pending": pending, "last_route": last}
    return RouterAgent.continuity(state, {"route": route, "new_analysis": new_analysis}, attached=attached)["route"]


@pytest.mark.parametrize("message", COMPLAINTS)
def test_a_question_about_the_attached_file_is_not_a_history_search(message):
    assert routed("history", message, last=Route.GENERATE) == Route.CONSULT
    assert routed("history", message, last=Route.CONSULT) == Route.CONSULT


def test_a_complaint_right_after_a_history_turn_still_leaves_history():
    assert routed("history", COMPLAINTS[1], last=Route.HISTORY) == Route.CONSULT


def test_a_correction_stated_after_a_generated_model_goes_back_to_generation():
    assert routed("history", "You missed payload_data, it is listed in the Payload section",
                  last=Route.GENERATE) == Route.GENERATE
    assert routed("impact", "The mapping says customer_ref should be populated from cust_no",
                  last=Route.GENERATE) == Route.GENERATE


def test_the_section_complaint_is_never_impact():
    # It ends with a question to the assistant, so it is explained, not regenerated.
    assert routed("impact", SECTION_CORRECTION, last=Route.GENERATE) != Route.IMPACT
    assert routed("history", SECTION_CORRECTION, last=Route.GENERATE) != Route.HISTORY


@pytest.mark.parametrize("message", [
    "Can you find the mapping sheet I shared in an earlier chat?",
    "Which files did I upload last week?",
    "give me the file to download",
    "No, from the chat. Give me its exact filename.",
])
def test_real_history_requests_stay_with_history_even_with_files_attached(message):
    assert routed("history", message, last=Route.GENERATE) == Route.HISTORY


def test_without_attachments_the_history_choice_is_untouched():
    assert routed("history", COMPLAINTS[1], attached=False) == Route.HISTORY


def test_follow_up_to_a_history_answer_stays_history():
    assert routed("history", "what about the other one", last=Route.HISTORY) == Route.HISTORY


def test_an_attached_file_question_is_not_pinned_to_history_after_a_history_turn():
    """The bare word "attached" used to count as asking for the file to be handed over."""
    assert not HAND_IT_OVER.search(COMPLAINTS[1])
    assert routed("consult", COMPLAINTS[1], last=Route.HISTORY, attached=False) == Route.CONSULT
    assert routed("repository", "give me that file, i wana download it", last=Route.HISTORY) == Route.HISTORY


@pytest.mark.parametrize("message", [*COMPLAINTS, SECTION_CORRECTION,
                                     "What's the difference between IFNULL and NULLIF in Snowflake?"])
def test_a_reply_that_does_not_answer_the_source_question_escapes_it(message):
    assert routed("consult", message, pending=SOURCES_PENDING, last=Route.IMPACT) == Route.CONSULT


@pytest.mark.parametrize("message", [*COMPLAINTS, SECTION_CORRECTION])
def test_a_complaint_the_model_reads_as_impact_escapes_the_source_question(message):
    assert routed("impact", message, pending=SOURCES_PENDING, last=Route.IMPACT) != Route.IMPACT


@pytest.mark.parametrize("message", ["yes go ahead", "1 and 3", "GitHub", "all sources", "use the uploaded files",
                                     "can you use the uploaded files?", "the second one"])
def test_a_source_selection_still_answers_the_source_question(message):
    assert routed("consult", message, pending=SOURCES_PENDING, last=Route.IMPACT) == Route.IMPACT
    assert routed("repository", message, pending=SOURCES_PENDING, last=Route.IMPACT) == Route.IMPACT
    assert routed("impact", message, pending=SOURCES_PENDING, last=Route.IMPACT) == Route.IMPACT


def test_impact_follow_ups_and_impact_questions_keep_impact():
    assert routed("impact", "why did you say customer_mart breaks?", last=Route.IMPACT) == Route.IMPACT
    assert routed("impact", "Why can't you just tell me which models?", last=Route.IMPACT) == Route.IMPACT
    assert routed("consult", "customer_id", pending=IMPACT_QUESTION, last=Route.IMPACT) == Route.IMPACT
    assert routed("impact", "What breaks if I rename customer_id?", last=Route.GENERATE,
                  new_analysis=True) == Route.IMPACT


def test_a_complaint_without_impact_words_is_not_a_new_impact_analysis():
    assert routed("impact", "how did you generate the code if you can't read the file?",
                  last=Route.GENERATE) == Route.CONSULT


def test_a_clarification_answer_still_resumes_generation():
    assert routed("consult", "Use in_scope_widgets as the base model.", pending=CLARIFICATION) == Route.GENERATE


def test_end_to_end_a_complaint_after_the_source_question_reaches_the_consultant():
    """Turn 1 is misread as impact and asks for sources; turn 2 must not get the same question again."""
    from fakes import call
    from test_turn_graph import Harness, route

    design = {"widget_design.md": "## Payload Data (JSON)\n- colour: string\n- size: number\n"}
    awaiting = {"id": "analysis", "userId": "alice", "phase": "awaiting_sources", "sources": [],
                "request": "fields are described in the Payload section", "startedAt": "2026-09-01T00:00:00Z"}
    harness = Harness()
    harness.models.script("router", route("impact", new_analysis=True), route("consult"))
    harness.models.script("consultant", call("get_file_content", file_name="widget_design.md"),
                          "The Payload Data (JSON) section lists colour and size.")
    first = harness.turn('look at the "Payload Data (JSON)" section', files=design,
                         impact_context={"state": None, "connections": [], "history": []})
    assert "which evidence sources" in first.response
    second = harness.turn("Are you not able to read the attached markdown file?", files=design,
                          impact_context={"state": awaiting, "connections": [], "history": []})
    assert second.route == Route.CONSULT
    assert "which evidence sources" not in second.response and "colour and size" in second.response


def test_a_validation_error_question_is_still_consult():
    assert routed("generate", "can you tell me which sql is invalid", attached=False) == Route.CONSULT


@pytest.mark.parametrize("last", [None, Route.CONSULT, Route.GENERATE])
@pytest.mark.parametrize("message", [
    "Can you tell me which tests fail if I change the grain of stg_orders?",
    "Could you check what uses fct_orders.order_total?",
    "Would you list everything that reads stg_customers if I change its key?",
    "What should be validated if I change the type of amount in stg_payments?",
    "Do you know which models select customer_id from stg_customers?",
])
def test_polite_impact_requests_keep_the_models_impact_route(message, last):
    assert routed("impact", message, last=last, new_analysis=True) == Route.IMPACT


@pytest.mark.parametrize("message", [
    "What was the Kestrel mapping workbook called?",
    "Did I share a crosswalk for the claims project?",
    "Can you show me the discussion about widget keys?",
    "what was the mapping sheet?",
])
@pytest.mark.parametrize("last", [None, Route.CONSULT, Route.GENERATE])
def test_history_recalls_in_a_chat_with_an_upload_keep_history(message, last):
    """The backend re-sends the chat's files every turn, so attachments alone prove nothing."""
    assert routed("history", message, last=last, attached=True) == Route.HISTORY


def test_a_complaint_during_a_pending_clarification_still_resumes_generation():
    """Audited, unchanged: a pending analyst question keeps consult readings (nodes.py clears it otherwise)."""
    assert routed("history", COMPLAINTS[1], pending=CLARIFICATION, last=Route.GENERATE) == Route.GENERATE
