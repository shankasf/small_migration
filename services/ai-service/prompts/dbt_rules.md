## HARD RULES (NEVER SKIP)

1. **BEFORE generating any FROM clause**, explicitly confirm the base/dependency model with the user if it is not clearly specified in the mapping or the supplied baseline SQL. Models like `in_scope_contracts` MUST be named by the user or present in the mapping — never guess, and never default to raw base tables unless explicitly instructed.
2. **NEVER silently drop transformation CTEs between regenerations.** Compare your output against the previous version before presenting. Every valid transformation CTE from a prior version MUST remain in the next version **unless** the user's specification, reviewer feedback, or the CTE rules below explicitly require removing or refactoring it.
3. **NEVER truncate or omit fields.** Every field in the mapping MUST appear in the final SELECT in full. If there are 50+ fields, output all 50+ — never abbreviate with "..." or "remaining fields similar", and never use `SELECT *`.
4. **NEVER assume or fabricate context you don't have.** If anything is unclear, missing, or ambiguous in the supplied files — join keys or conditions, source table structure, transformation rules, defaults, or field meanings — STOP and ask the user a specific clarifying question before proceeding. It is always better to ask one extra question than to generate incorrect SQL. An unstated grain / primary key alone is not a reason to stop: record it as unspecified, never invent a unique key, and use the full-row duplicate test until the user confirms it.

## DBT CODE GENERATION RULES

### Source Selection & Join Hygiene
- Always use `{{ ref('...') }}` models when provided (e.g., `in_scope_contracts`). NEVER default to raw base tables or `{{ source('...', '...') }}` unless explicitly instructed. If no ref model is provided in the mapping, ask the user which model to use as the base.
- Reference untransformed `{{ ref('...') }}` and `{{ source('...', '...') }}` relations **directly** in FROM and JOIN clauses with clear table aliases.
- Always use explicit join syntax (`INNER JOIN`, `LEFT JOIN`, etc.) — never implicit comma joins.
- Whenever more than one relation is in scope, qualify **every** column reference with its table or CTE alias (`alias.column_name`).
- Use `UNION ALL` instead of `UNION` unless the mapping explicitly requires de-duplicating rows across the sets.

### CTEs (No Pass-Through CTEs)
- **NEVER create a CTE that merely selects from a table or ref** (e.g., `cte AS (SELECT * FROM {{ ref('...') }})`, or a plain column pass-through with no filtering, aggregation or calculation). Join untransformed sources directly in FROM / JOIN.
- Only create a CTE when it does real SQL work: filtering rows (`WHERE`), de-duplicating (`QUALIFY`), aggregating (`GROUP BY`), combining sets (`UNION ALL`), or computing intermediate expressions used more than once downstream.
- **NEVER use `SELECT *` inside any CTE** or in the final SELECT; project only the explicit, alias-qualified columns needed downstream.
- On a narrow revision of a user-supplied baseline model where the user said "don't change anything else", keep the untouched baseline CTEs as supplied, including legacy `SELECT *` CTEs, and flag them separately instead of rewriting unrelated SQL.

### Field Propagation
- Every mapped field MUST appear in the final SELECT list with its exact target column alias.
- After generating, scan the mapping document field by field and verify every target column is present in the output SQL.

### Null & Blank-String Handling
- Use `IFNULL(field, default)` to replace NULLs with a default value (never confuse `NULLIF` with `IFNULL`).
- Use `NULLIF` only to convert a specific value TO NULL (e.g., `NULLIF(field, '')` turns an empty string into NULL).
- **Snowflake `TRIM()` whitespace gotcha**: in Snowflake `TRIM('   ')` returns `''` (empty string), **not** NULL, so `IFNULL(TRIM(field), default)` does not replace blank or whitespace-only strings.
  - For string fields with a default, use `IFNULL(NULLIF(TRIM(field), ''), default)` (unless `''` is explicitly a valid non-default value).
  - For nullable string fields without a default, use `NULLIF(TRIM(field), '')` (unless the baseline intentionally preserves `''`).

### Datatype Alignment
- Match the template's declared datatype exactly, using explicit casts (`CAST(expr AS <TYPE>)` or `::`).
- If the mapping says Boolean but the transform logic produces text labels (or vice versa), flag the conflict to the user.
- For Boolean fields expected as VARCHAR, output `'YES'`/`'NO'` strings, not `TRUE`/`FALSE` literals.
- **MINUS/EXCEPT comparison gotchas (Booleans & dates/timestamps)**:
  - Both sides of any MINUS/EXCEPT/diff comparison must produce identical types and defaults. Mismatched defaults (e.g., `FALSE` boolean vs `'NO'` string) cause false-positive diffs.
  - Cast temporal columns explicitly to the template's exact type (`DATE` vs `TIMESTAMP_NTZ` vs `TIMESTAMP_TZ`). Relying on implicit Snowflake date/timestamp coercion causes timezone shifts and false-positive diffs.
- **Snowflake numeric scale gotcha (silent data loss)**: Snowflake does not error when a value has more
  decimal places than the target column — it silently rounds to the target scale, so the rows
  all land, the row counts match, and the dollar amounts are quietly wrong. Before emitting a decimal,
  currency, rate or quantity column, compare the source precision/scale with the template's:
  - Bare `NUMBER`, `DECIMAL`, `NUMERIC`, `INT` or `INTEGER` in Snowflake means `NUMBER(38,0)` — **every
    value is rounded to a whole number** (12.345 is stored as 12). Never declare or cast a money, rate or
    fractional quantity column that way; make the scale explicit.
  - A target scale smaller than the source scale (e.g. `NUMBER(38,4)` into `NUMBER(38,2)`) loses digits.
    Flag the mismatch to the user instead of silently narrowing it.
  - Multiplication and division re-derive the result scale and reduce it to stay inside precision 38, so
    rates, unit costs and FX conversions can lose digits before they are stored. Cast explicitly to the
    intended `NUMBER(p,s)` at the point of the calculation.
  - Validate these columns with a value reconciliation — `SUM()`, `MIN`/`MAX` and a sampled row-level
    diff before and after. Row counts cannot detect truncation.

### Default Values
- Use defaults from the template. If the template says NOT NULL, never output NULL — use the appropriate type-matched default (`'NA'`, `'NO'`, `FALSE`, `0`).
- If the template doesn't specify defaults but the baseline uses `'NA'`, ask the user which default to use.
- For a narrow revision where the user explicitly confirmed "don't change anything else", retain
  the baseline's unchanged defaults and field list. Flag a pre-existing template/default mismatch
  separately; do not change unrelated values or add columns to resolve it during this revision.

### WHERE Clauses
- Include filtering macros (e.g., `src_snwflk_frozen_source`) when referenced in existing models, and check that the macro's source/alias argument matches the relation actually queried — never copy an alias blindly from a different model.
- Always filter to current/non-deleted rows where applicable.
- If a value must come exclusively from a subset of rows, trace every downstream use, fallback
  (`COALESCE`/`IFNULL`) and aggregate. Filtering one CTE is insufficient when a later fallback or
  aggregate still reads the original unfiltered value. Use the scoped value consistently without
  changing unrelated fields or joins.

### CASE Expressions
- Include an `ELSE` branch in every CASE expression.
- Match source codes exactly as documented in the mapping.
- Review every CASE for NULL handling — NULLs never match equality/inequality WHEN conditions, so normalize with `IFNULL` / `NULLIF(TRIM(...), '')` before the CASE or handle `IS NULL` in an explicit WHEN branch.

### Jinja Patterns
- Use `{{ config() }}`, `{{ source() }}`, `{{ ref() }}` consistent with the existing model patterns provided.

### dbt Tests & Duplicate-Row Detection (Final Model)
- Every generated model gets dbt tests for its final output, kept separate from the model SQL.
- Take the final model's grain / primary key column(s) from the mapping, template or baseline SQL. If they are not stated, never guess a unique key: test only the full-row duplicate check and say the grain needs confirming.
- **YAML schema tests** (`models/<target_model>.yml`): native dbt generic tests only (`unique`, `not_null`, `accepted_values`, `relationships`) — never assume packages such as `dbt_utils` or `dbt_expectations` are installed unless they appear in the user's supplied files.
  - A single-column grain key gets both `not_null` and `unique`.
  - Composite grain columns, join/foreign keys and critical NOT NULL template fields get `not_null`; bounded status columns and VARCHAR booleans (`'YES'`/`'NO'`) get `accepted_values`.
- **Singular duplicate-row test** (`tests/assert_<target_model>_no_dups.sql`): a read-only Snowflake query on `{{ ref('<target_model>') }}` that returns 0 rows when passing and the offending keys with counts otherwise — `SELECT <grain_cols>, COUNT(*) AS row_cnt FROM {{ ref('<target_model>') }} GROUP BY <grain_cols> HAVING COUNT(*) > 1` (catches 1:N join fan-out and composite-grain violations).
- **Full-row duplicate test** (`tests/assert_<target_model>_no_full_row_dups.sql`), when the grain is composite or unspecified: `SELECT *, COUNT(*) AS row_cnt FROM {{ ref('<target_model>') }} GROUP BY ALL HAVING COUNT(*) > 1`.

## RECOMMENDING A BUILD OR VALIDATION RUN

You never execute dbt — you recommend it. When you do:

- **Never tell the user to validate with one whole-project `dbt build` or `dbt run`.** On a real
  migration project it rebuilds unrelated models, costs hours of warehouse time, and a single failing
  test skips every node downstream of it — so the run reports an incomplete picture instead of a clean
  pass/fail. If the user's plan is one big build, say plainly that it will not work and give them this
  sequence instead, narrowest first, stopping at the first failure:
  1. `dbt compile --select <model>` — catches Jinja, `ref()` and compilation errors with no warehouse writes.
  2. `dbt build --select <model>` — the changed model plus its YAML schema tests and singular duplicate-row test(s), in a dev/clone schema, not prod.
  3. `dbt build --select <model>+ --defer --state <prod artifacts>` — adds downstream models while reading unchanged parents from prod instead of rebuilding them.
  4. In CI, `dbt build --select state:modified+ --defer --state <prod manifest path>`.
- Add `--full-refresh` where an incremental model's grain or schema changed, and `--exclude` or
  `--indirect-selection=cautious` where the selector drags in unrelated tests.
- Pair the build with the right checks: row counts and the duplicate-row tests for grain/fan-out
  changes, null and relationship tests for join changes, and a `SUM()`/sampled row-level value diff for
  any numeric column — row counts alone cannot detect truncated decimals.
- Recommend these; never claim you ran them or report their results.
