# circini_dbt_test_repo

Blank Snowflake dbt project template for GitLab.

## Directories

- `analyses/`
- `macros/`
- `models/`
- `seeds/`
- `snapshots/`
- `tests/`

Each standard directory includes `.gitkeep`. The `models` directory also has template model and source YAML files.

## Local setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install "dbt-snowflake>=1.8,<2.0"
```

Set the connection variables:

```bash
export DBT_SNOWFLAKE_ACCOUNT="your_account"
export DBT_SNOWFLAKE_USER="your_username"
export DBT_SNOWFLAKE_PASSWORD="your_password"
export DBT_SNOWFLAKE_ROLE="your_role"
export DBT_SNOWFLAKE_DATABASE="your_database"
export DBT_SNOWFLAKE_WAREHOUSE="your_warehouse"
export DBT_SNOWFLAKE_SCHEMA="your_schema"
export DBT_THREADS="4"
```

Validate the project:

```bash
dbt deps
dbt debug
dbt parse
```

## Building the pharma pipeline

The pharma landing models (`land_drugs`, `land_patient`, `land_prescription`) read their raw data via `source('land_raw', ...)`, but in this repo that data is actually populated by the `seeds/pharma/*.csv` seeds landing in the same location. dbt has no way to know a seed backs a source, so it won't order them relative to each other — and because seeds are configured with `+full_refresh: true`, every seed run drops and recreates its table. Combined, a single `dbt build` (or `dbt build --full-refresh`) can race the seed reload against a landing model reading the same table mid-recreation, causing intermittent `does not exist or not authorized` errors.

**Do not run `dbt build --full-refresh` for this pipeline.** Besides the race above, `--full-refresh` also applies to snapshots, which drops and recreates the snapshot tables — destroying all accumulated SCD history (`dbt_valid_from`/`dbt_valid_to` versions) instead of just refreshing values.

Instead, run each stage as a separate command, in this order:

```bash
dbt seed --select drugs patient prescription --full-refresh
dbt run --select land_drugs land_patient land_prescription
dbt snapshot --select drugs_snapshot patient_snapshot prescription_snapshot
dbt run --select stg_dispensing rep_dispensing
```

Note `dbt snapshot` is run **without** `--full-refresh` — that flag should only ever be used deliberately to discard snapshot history, not as part of routine rebuilds.

## GitLab CI/CD

Add the Snowflake values under **Settings > CI/CD > Variables**. Mark the password as masked and protected where appropriate. Do not commit credentials; `profiles.yml` only references environment variables.
