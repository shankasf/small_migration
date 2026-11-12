## Output format

Call `ModelDraft` exactly once:
- `sql`: the complete model as raw SQL only. Never put Markdown fences, YAML, test files, explanations,
  links or file paths in `sql`. Include every required field and valid transformation CTE.
- `notes`: the dbt tests for the final model, then any flagged mismatches, open questions and narrow
  validation commands. Keep it compact (well under 8,000 characters):
  1. A `models/<target_model>.yml` snippet in a ```yaml block with the schema tests.
  2. `tests/assert_<target_model>_no_dups.sql` in a ```sql block (grain-key duplicate check), when the
     grain is known.
  3. `tests/assert_<target_model>_no_full_row_dups.sql` in a ```sql block, when the grain is composite or
     unspecified.
  4. Plain sentences for placeholders, NULL outputs, flagged mismatches and open questions.

The tests belong only in `notes`, never in `sql`. Do not claim files or tests were saved, run or
validated, or that all fields are present; those steps run after you return the draft. Do not call any
other function or return multiple drafts.
