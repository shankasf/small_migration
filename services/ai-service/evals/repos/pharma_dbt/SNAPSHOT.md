Snapshot of the synthetic Circini dbt test project used for impact-analysis evals
(commit 4ec576647ca442f21b645712059b7c3e6afe1bae). Seed data is invented. `seeds/pharma/patient.csv` is
not stored: it holds NHI-shaped identifiers, so in production the data policy
blocks it — the eval gateway returns that same blocked result for it.
