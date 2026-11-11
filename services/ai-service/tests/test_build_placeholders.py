"""Placeholders, unused/dropped CTEs and honest build replies (synthetic data only).

Regression for a build that shipped ``PARSE_JSON('{}') AS entitlement_data``
although the attached mapping specified every payload key, kept an unused CTE,
and whose notes still said "All required fields are present."
"""
import asyncio

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from fakes import FakeGateway, FakeRegistry, RecordingLogger, call
from validation import audit_draft, mapped_subkeys
from workflow.agents.migration.analyst import STALLED_NOTICE
from workflow.context import TurnRequest
from workflow.orchestrator import build_turn_graph
from workflow.runner import TurnRunner
from workflow.tracing import TraceExporter


class Harness:
    def __init__(self):
        self.models = FakeRegistry()
        self.logger = RecordingLogger()
        self.runner = TurnRunner(build_turn_graph(InMemorySaver()), self.models, TraceExporter(),
                                 gateway_factory=lambda session, actor: FakeGateway())

    def turn(self, message, **request):
        return asyncio.run(self.runner.run(TurnRequest(message=message, **request), session_id="chat-1",
                                           actor_id="alice", turn_id="turn", logger=self.logger))

    def brief(self, role, index=-1):
        return self.models.requests(role)[index]["messages"][-1].content


@pytest.fixture
def harness():
    return Harness()


MAPPING = """# Widget design (synthetic)
| Target | Source |
| --- | --- |
| widget_id | WIDGETS.w01_id |
| Order Data.header.orderType | WIDGETS.w02_type |
| Order Data.header.orderNumber | WIDGETS.w03_number |
| Order Data.lines.partCode | PARTS.part_code |
| Order Data.header.ownerRef | TBD |
"""
FILES = {"widget_design.md": MAPPING}
TARGET = [{"file_name": "stg_widgets.sql", "purpose": "Widget orders", "revision_of": ""}]

EMPTY_PAYLOAD = """with widgets as (select * from {{ ref('widgets') }}),
part_agg as (select widget_id, array_agg(part_code) as parts from {{ ref('parts') }} group by widget_id)
select w01_id as widget_id, cast(parse_json('{}') as variant) as order_data,
       'TBD' as owner_ref
from widgets"""

BUILT_PAYLOAD = """with widgets as (select * from {{ ref('widgets') }}),
part_agg as (select widget_id, array_agg(object_construct('partCode', part_code)) as parts
             from {{ ref('parts') }} group by widget_id)
select w.w01_id as widget_id,
       object_construct('header', object_construct('orderType', w.w02_type, 'orderNumber', w.w03_number,
                                                   'ownerRef', 'TBD'),
                        'lines', p.parts) as order_data,
       'TBD' as owner_ref
from widgets as w left join part_agg as p on p.widget_id = w.w01_id"""

FALSE_CLAIM = "All required fields are present."


def route(name):
    return call("RouteChoice", route=name, new_analysis=False)


def spec(**overrides):
    fields = dict(ready=True, findings="Widget mapping reviewed.", questions=[], targets=TARGET,
                  requirements="widget_id from WIDGETS.w01_id; order_data VARIANT built from the "
                               "Order Data.* key paths in the mapping; owner_ref TBD",
                  decisions=["Q4 owner reference: user said leave Owner Ref as TBD"],
                  placeholders=["Owner Ref"])
    fields.update(overrides)
    return call("submit_migration_spec", **fields)


def draft(sql, notes=""):
    return call("ModelDraft", sql=sql, notes=notes)


APPROVE = call("ModelReview", approved=True, issues=[])


# --- deterministic audit -----------------------------------------------------

def test_audit_flags_an_empty_payload_whose_keys_the_mapping_specifies():
    audit = audit_draft(EMPTY_PAYLOAD, mapping_text=MAPPING, approved_placeholders=["Owner Ref"])
    defects = " ".join(audit["defects"])
    assert "order_data is an empty JSON placeholder" in defects and "header.orderType" in defects
    assert "CTE part_agg is defined but never used" in defects
    assert "owner_ref" not in defects  # approved by the user
    assert "owner_ref ('TBD' literal, placeholder you approved)" in audit["placeholders"]


def test_audit_accepts_a_built_payload_and_only_discloses_approved_placeholders():
    audit = audit_draft(BUILT_PAYLOAD, mapping_text=MAPPING, approved_placeholders=["Owner Ref"])
    assert audit["defects"] == []
    assert {p.split(" ")[0] for p in audit["placeholders"]} == {"order_data.header.ownerRef", "owner_ref"}


def test_a_placeholder_allowance_for_one_field_does_not_cover_others():
    audit = audit_draft("select 'TBD' as owner_ref, 'TBD' as order_type from t",
                        approved_placeholders=["Owner Ref"])
    assert len(audit["defects"]) == 1 and audit["defects"][0].startswith("order_type is a 'TBD' literal")


def test_an_approved_empty_payload_is_still_a_defect_when_the_mapping_specifies_it():
    audit = audit_draft(EMPTY_PAYLOAD, mapping_text=MAPPING, approved_placeholders=["order_data", "Owner Ref"])
    assert any(d.startswith("order_data is an empty JSON placeholder") for d in audit["defects"])


def test_null_is_listed_apart_and_empty_constructors_are_caught():
    audit = audit_draft("select null as end_date, object_construct() as meta, array_construct() as tags from t")
    assert audit["nulls"] == ["end_date"]
    assert audit["placeholders"] == ["meta (empty JSON)", "tags (empty JSON)"]
    assert len(audit["defects"]) == 2


def test_one_allow_list_entry_may_name_several_fields_or_a_key_path():
    audit = audit_draft("select 'TBD' as entitlement_type, 'TBD' as practitioner_id_type, "
                        "object_construct('practitioner', object_construct('practitionerId', 'TBD')) as p from t",
                        approved_placeholders=["Entitlement Type, Practitioner ID Type and Practitioner ID"])
    assert audit["defects"] == [] and len(audit["placeholders"]) == 3


def test_placeholders_and_unused_ctes_in_the_users_own_sql_are_kept_not_flagged():
    supplied = ("Please fix only the amount rule:\n```sql\nwith spare as (select 1 as one)\n"
                "select 'TBD' as status, amount from t\n```")
    audit = audit_draft("with spare as (select 1 as one) select 'TBD' as status, ifnull(amount, 0) as amount from t",
                        supplied=[supplied])
    assert audit["defects"] == []
    assert audit["placeholders"] == ["status ('TBD' literal, kept from your SQL)"]


def test_a_cte_the_previous_version_used_is_a_reviewer_notice_not_an_automatic_defect():
    previous = ("with a as (select 1 as x), b as (select 2 as y), spare as (select 3 as z) "
                "select * from a join b on true")
    audit = audit_draft("with a as (select 1 as x) select * from a", previous=previous)
    assert audit["defects"] == []
    assert len(audit["notices"]) == 1 and audit["notices"][0].startswith("CTE b, used by the previous version")


def test_placeholder_ref_names_are_disclosed():
    audit = audit_draft("select app_id from {{ ref('placeholder_pt_application') }}")
    assert audit["placeholders"] == ["ref placeholder_pt_application (placeholder model name)"] and not audit["defects"]


def test_a_self_reference_inside_its_own_body_is_not_a_use():
    audit = audit_draft("with recursive r as (select 1 as n union all select n + 1 from r where n < 3) "
                        "select 1 as one from t")
    assert any("CTE r is defined but never used" in d for d in audit["defects"])


def test_mapped_subkeys_match_spaced_snake_and_camel_names():
    assert mapped_subkeys("order_data", MAPPING)[:2] == ["header.orderType", "header.orderNumber"]
    assert mapped_subkeys("orderData", MAPPING)
    assert mapped_subkeys("widget_id", MAPPING) == []


# --- build loop --------------------------------------------------------------

def test_reviewer_approval_does_not_ship_an_empty_payload_the_mapping_specifies(harness):
    harness.models.script("router", route("generate"))
    harness.models.script("analyst", spec())
    harness.models.script("author", draft(EMPTY_PAYLOAD, FALSE_CLAIM), draft(BUILT_PAYLOAD))
    harness.models.script("reviewer", APPROVE, APPROVE)
    result = harness.turn("Generate stg_widgets from the design doc", files=FILES)
    assert len(harness.models.requests("author")) == 2
    feedback = harness.brief("author", 1)
    assert "order_data is an empty JSON placeholder" in feedback and "part_agg is defined but never used" in feedback
    assert "object_construct" in result.files["stg_widgets.sql"]
    assert "Checked against the 12-point" in result.response
    assert "Placeholders in this model" in result.response and "owner_ref" in result.response
    assert any(e["step"] == "model.audit" for e in harness.logger.events)


def test_exhausted_review_never_claims_every_field_is_present(harness):
    harness.models.script("router", route("generate"))
    harness.models.script("analyst", spec())
    harness.models.script("author", *[draft(EMPTY_PAYLOAD, FALSE_CLAIM)] * 3)
    harness.models.script("reviewer", *[APPROVE] * 3)
    result = harness.turn("Generate stg_widgets", files=FILES)
    assert "stg_widgets.sql" in result.files  # still delivered, with its issues stated
    assert FALSE_CLAIM not in result.response
    assert "Checked against" not in result.response
    assert "Still open after review" in result.response and "order_data is an empty JSON placeholder" in result.response
    assert "order_data (empty JSON)" in result.response


def test_completeness_claims_are_removed_when_approved_placeholders_remain(harness):
    harness.models.script("router", route("generate"))
    harness.models.script("analyst", spec())
    harness.models.script("author", draft(BUILT_PAYLOAD, "Parts are aggregated per widget. " + FALSE_CLAIM))
    harness.models.script("reviewer", APPROVE)
    result = harness.turn("Generate stg_widgets", files=FILES)
    assert "Parts are aggregated per widget." in result.response and FALSE_CLAIM not in result.response
    assert "owner_ref ('TBD' literal, placeholder you approved)" in result.response


def test_a_rejection_without_issues_is_not_reported_as_approved(harness):
    harness.models.script("router", route("generate"))
    harness.models.script("analyst", spec())
    harness.models.script("author", draft(BUILT_PAYLOAD, "Looks complete."))
    harness.models.script("reviewer", call("ModelReview", approved=False, issues=[]))
    result = harness.turn("Generate stg_widgets", files=FILES)
    assert "Checked against" not in result.response and "named no specific defect" in result.response
    assert "Looks complete." not in result.response


def test_a_failed_final_revision_keeps_the_last_valid_draft_and_its_open_issues(harness):
    issue = "widget_id is missing its IFNULL default"
    harness.models.script("router", route("generate"))
    harness.models.script("analyst", spec())
    harness.models.script("author", draft(BUILT_PAYLOAD), draft("drop table widgets"), draft("drop table widgets"))
    harness.models.script("reviewer", call("ModelReview", approved=False, issues=[issue]))
    result = harness.turn("Generate stg_widgets", files=FILES)
    assert result.files["stg_widgets.sql"].strip() == BUILT_PAYLOAD
    assert issue in result.response and "last draft that passed the static checks" in result.response
    # The reviewer's defect is still in front of the author after an unusable revision.
    assert issue in harness.brief("author", 2) and "Static validation failed" in harness.brief("author", 2)


def test_author_and_reviewer_see_the_user_decisions_and_approved_placeholders(harness):
    harness.models.script("router", route("generate"))
    harness.models.script("analyst", spec())
    harness.models.script("author", draft(BUILT_PAYLOAD))
    harness.models.script("reviewer", APPROVE)
    harness.turn("Generate stg_widgets", files=FILES)
    for role in ("author", "reviewer"):
        brief = harness.brief(role)
        assert "user said leave Owner Ref as TBD" in brief
        assert "## Placeholders the user approved\n- Owner Ref" in brief
    assert "order_data.header.ownerRef" in harness.brief("reviewer")


def test_targets_beyond_the_limit_are_reported_not_silently_dropped(harness):
    targets = [{"file_name": f"stg_w{n}.sql", "purpose": "w", "revision_of": ""} for n in range(7)]
    harness.models.script("router", route("generate"))
    harness.models.script("analyst", spec(targets=targets, placeholders=[], decisions=[]))
    harness.models.script("author", *[draft("select 1 as widget_id from {{ ref('widgets') }}")] * 6)
    harness.models.script("reviewer", *[APPROVE] * 6)
    result = harness.turn("Generate all seven models")
    assert len(result.files) == 6 and "stg_w6.sql" not in result.files
    assert "Not generated this turn" in result.response and "`stg_w6.sql`" in result.response
    assert "Other models in this build" in harness.brief("author")


# --- answered clarifications -------------------------------------------------

QUESTIONS = ["Which source ref names should the CTEs use?", "Should Owner Ref stay TBD for now?",
             "How should Order Data be built - JSON or separate columns?"]
ANSWERS = "1. put in placeholders for the moment 2 make it TBD for the moment 3 either its JSONB"


def ask_first(harness):
    harness.models.script("router", route("generate"))
    harness.models.script("analyst", spec(ready=False, questions=QUESTIONS, targets=[], placeholders=[]))
    first = harness.turn("Generate stg_widgets from the design doc", files=FILES)
    assert first.paused
    harness.models.script("router", route("generate"))


def test_answered_questions_are_not_asked_again_and_the_model_is_built(harness):
    ask_first(harness)
    # The analyst re-asks a paraphrase and builds nothing; it is nudged once, then builds.
    harness.models.script("analyst",
                          spec(ready=False, targets=[], questions=["Which source ref names should these CTEs use?"]),
                          spec())
    harness.models.script("author", draft(BUILT_PAYLOAD))
    harness.models.script("reviewer", APPROVE)
    result = harness.turn(ANSWERS, files=FILES)
    assert not result.paused and "stg_widgets.sql" in result.files
    assert len(harness.models.requests("analyst")) == 3
    first_brief = harness.brief("analyst", 1)
    assert "The current request answers the questions you asked" in first_brief and QUESTIONS[1] in first_brief
    assert "you returned no model to build" in harness.brief("analyst", 2)


def test_answers_with_no_new_questions_proceed_even_if_ready_is_false(harness):
    ask_first(harness)
    harness.models.script("analyst", spec(ready=False, questions=[QUESTIONS[0]]))
    harness.models.script("author", draft(BUILT_PAYLOAD))
    harness.models.script("reviewer", APPROVE)
    result = harness.turn(ANSWERS, files=FILES)
    assert not result.paused and "stg_widgets.sql" in result.files
    assert len(harness.models.requests("analyst")) == 2  # no nudge needed


def test_a_genuinely_new_question_survives_a_second_look_and_is_asked(harness):
    ask_first(harness)
    new = spec(ready=False, targets=[], questions=["Which column joins PARTS to WIDGETS?"])
    harness.models.script("analyst", new, new)
    result = harness.turn(ANSWERS, files=FILES)
    assert result.paused and "Which column joins PARTS to WIDGETS?" in result.response
    assert QUESTIONS[0] not in result.response
    assert "Which column joins PARTS to WIDGETS?" in harness.brief("analyst", 2)  # the nudge names it


def test_a_loosely_reworded_repeat_is_reconsidered_before_reaching_the_user(harness):
    ask_first(harness)
    harness.models.script("analyst",
                          spec(ready=False, targets=[], questions=["Before I build it: Order Data as one JSON "
                                                                   "column, or flattened?"]),
                          spec())
    harness.models.script("author", draft(BUILT_PAYLOAD))
    harness.models.script("reviewer", APPROVE)
    result = harness.turn(ANSWERS, files=FILES)
    assert not result.paused and "stg_widgets.sql" in result.files
    assert "Wherever the reply answers a question, that question is settled" in harness.brief("analyst", 2)


def test_a_plan_that_stalls_twice_says_so_instead_of_re_asking(harness):
    ask_first(harness)
    stalled = spec(ready=False, targets=[], questions=QUESTIONS,
                   findings="Prepared a full migration spec outline, but a few inputs are still needed.")
    harness.models.script("analyst", stalled, stalled)
    result = harness.turn(ANSWERS, files=FILES)
    assert not result.paused and STALLED_NOTICE in result.response
    assert not any(question in result.response for question in QUESTIONS)
