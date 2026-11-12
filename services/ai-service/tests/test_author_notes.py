"""The author's dbt tests travel in notes and must reach the user intact."""

from workflow.agents.migration.graph import honest_notes
from workflow.agents.migration.schemas import ModelDraft

TESTS = ("```yaml\nversion: 2\nmodels:\n  - name: stg_contracts\n    columns:\n      - name: contract_id\n"
         "        tests: [not_null, unique]\n```\n\n```sql\nSELECT contract_id, COUNT(*) AS row_cnt\n"
         "FROM {{ ref('stg_contracts') }}\nGROUP BY contract_id\nHAVING COUNT(*) > 1\n```")


def test_tests_survive_open_issues_and_placeholders():
    notes = TESTS + "\n\nAll fields are mapped. Amount keeps 2 decimals."
    shown = honest_notes({"notes": notes, "placeholders": ["x (TBD)"]})
    assert TESTS in shown and "All fields are mapped" not in shown and "Amount keeps 2 decimals." in shown
    shown = honest_notes({"notes": notes, "open_issues": ["fix x"]})
    assert TESTS in shown and "Amount" not in shown


def test_plain_notes_unchanged():
    assert honest_notes({"notes": "Amount keeps 2 decimals."}) == "Amount keeps 2 decimals."
    assert honest_notes({"notes": "Looks fine.", "open_issues": ["x"]}) == ""


def test_draft_accepts_test_definitions_longer_than_old_limit():
    draft = ModelDraft(sql="select 1 as a from {{ ref('t') }}", notes=TESTS * 30)
    assert len(draft.notes) > 4000
