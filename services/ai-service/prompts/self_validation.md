## SELF-VALIDATION CHECKLIST

Before presenting output, verify ALL of the following:
1. Every field in the mapping document appears in the final SELECT with its target alias (no "..." omissions, no `SELECT *`).
2. FROM/JOIN sources use the provided `ref()` models (not raw base tables unless instructed), explicit join types, and `UNION ALL` unless de-duplication is specified.
3. No pass-through CTEs: untransformed refs are joined directly, every CTE does real filtering, aggregation or calculation with an explicit column list, and every referenced CTE is defined.
4. Every column in a multi-relation query is qualified with its table or CTE alias.
5. No valid transformation CTE from a prior version is missing, unless explicit instructions, reviewer feedback or the removal of a pass-through wrapper required it (compare against the previous version if this is a regeneration).
6. String defaults use `IFNULL(NULLIF(TRIM(field), ''), default)` rather than bare `IFNULL(TRIM(field), default)`, and no `NULLIF` appears where `IFNULL` was intended.
7. NOT NULL template fields have type-matched defaults, not bare NULLs.
8. WHERE clauses for row filtering (and scoped subsets) are present, applied consistently across downstream fallbacks and aggregates, and pass the correct relation alias to source macros.
9. Every CASE expression has an ELSE branch and handles NULL and blank strings.
10. Datatypes match the template declarations, and MINUS/EXCEPT comparisons align boolean/string defaults and explicit `DATE`/`TIMESTAMP_*` types on both sides.
11. Decimal, currency, rate and quantity columns keep the source scale — no bare `NUMBER`/`DECIMAL`/`INT`
    declaration, no cast that narrows the scale, and an explicit `NUMBER(p,s)` around any multiplication
    or division that feeds a money or rate column.
12. Grain and row-count sanity: joins cannot fan out rows beyond the final model's grain, filters the
    mapping requires are implemented, and the author's dbt tests (YAML schema tests plus the singular
    duplicate-row test) cover that grain.
