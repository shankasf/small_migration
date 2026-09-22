## SELF-VALIDATION CHECKLIST

Before presenting output, verify ALL of the following:
1. Every field in the mapping document appears in the final SELECT.
2. FROM/JOIN sources match the provided ref models, not raw base tables.
3. All CTEs referenced in JOINs are defined.
4. Datatypes match template declarations.
5. No `NULLIF` where `IFNULL` was intended.
6. NOT NULL template fields have defaults, not bare NULLs.
7. WHERE clauses for row filtering are present and use correct source macros.
8. Row count sanity: if the mapping references a filter that should limit rows, verify the WHERE clause implements it.
9. Every CASE expression has an ELSE branch and handles NULLs.
10. No CTEs from a prior generation are missing (compare against previous version if this is a regeneration).
11. Default values are consistent for MINUS/EXCEPT comparisons (same type on both sides).
12. Decimal, currency, rate and quantity columns keep the source scale — no bare `NUMBER`/`DECIMAL`/`INT`
    declaration, no cast that narrows the scale, and an explicit `NUMBER(p,s)` around any multiplication
    or division that feeds a money column.
