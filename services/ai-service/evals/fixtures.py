"""Synthetic artefacts shared by the datasets.

Everything here is invented: no customer data, names, emails or health
identifiers. Identifiers deliberately avoid the shapes the guardrails treat as
PII (three capitals + four digits, long digit runs), so a case is never blocked
for the wrong reason.

Datasets refer to these as ``"@fixture:NAME"``; ``resolve`` substitutes them.
"""
from __future__ import annotations

import json
from typing import Any

# The same synthetic dbt project the production impact check uploads
# (scripts/check-impact-agent-live.cjs).
IMPACT_MANIFEST = {
    "metadata": {"project_name": "impact_demo"},
    "nodes": {
        "model.impact_demo.stg_customers": {
            "name": "stg_customers", "resource_type": "model", "original_file_path": "models/stg_customers.sql",
            "raw_code": "select customer_id, cast(order_amount as number(38,2)) as order_amount "
                        "from {{ source('crm', 'customers') }}",
            "depends_on": {"nodes": ["source.impact_demo.crm.customers"]},
            "columns": {"customer_id": {"name": "customer_id", "description": "Customer join key"},
                        "order_amount": {"name": "order_amount", "description": "Order value in dollars and cents"}}},
        "model.impact_demo.customer_revenue": {
            "name": "customer_revenue", "resource_type": "model", "original_file_path": "models/customer_revenue.sql",
            "raw_code": "select customer_id, cast(sum(order_amount) as number(38,0)) as revenue_amount "
                        "from {{ ref('stg_customers') }} group by customer_id",
            "depends_on": {"nodes": ["model.impact_demo.stg_customers"]},
            "columns": {"customer_id": {"name": "customer_id"},
                        "revenue_amount": {"name": "revenue_amount", "description": "Revenue in dollars"}}},
        "model.impact_demo.customer_mart": {
            "name": "customer_mart", "resource_type": "model", "original_file_path": "models/customer_mart.sql",
            "raw_code": "select customer_id, count(*) as customer_count from {{ ref('stg_customers') }} "
                        "group by customer_id",
            "depends_on": {"nodes": ["model.impact_demo.stg_customers"]},
            "columns": {"customer_id": {"name": "customer_id"}}},
        "test.impact_demo.not_null_customer_id": {
            "name": "not_null_customer_id", "resource_type": "test",
            "depends_on": {"nodes": ["model.impact_demo.stg_customers"]},
            "test_metadata": {"name": "not_null", "kwargs": {"column_name": "customer_id"}}},
    },
    "sources": {"source.impact_demo.crm.customers": {
        "name": "customers", "source_name": "crm", "resource_type": "source",
        "columns": {"customer_id": {"name": "customer_id"}}}},
    "exposures": {"exposure.impact_demo.customer_dashboard": {
        "name": "customer_dashboard", "resource_type": "exposure", "type": "dashboard",
        "depends_on": {"nodes": ["model.impact_demo.customer_mart"]}}},
}

POLICY_MAPPING = """target_field,source_table,source_field,transformation,datatype,nullable,default
policy_id,in_scope_policies,pol_id,direct,NUMBER(38,0),N,
policy_number,in_scope_policies,pol_num,TRIM,VARCHAR(20),N,NA
premium_amount,in_scope_policies,prem_amt,IFNULL to 0,NUMBER(18,2),N,0
effective_date,in_scope_policies,eff_dt,CAST to DATE,DATE,Y,
is_active,in_scope_policies,active_ind,CASE WHEN 'Y' THEN 'YES' ELSE 'NO',VARCHAR(3),N,NO
Row filter: in_scope_policies.deleted_ind = 'N'
"""

POLICY_TEMPLATE = """column_name,data_type,nullable,default,description
POLICY_ID,NUMBER(38,0),NOT NULL,,Policy surrogate key
POLICY_NUMBER,VARCHAR(20),NOT NULL,NA,Business policy number
PREMIUM_AMOUNT,NUMBER(18,2),NOT NULL,0,Annual premium in dollars and cents
EFFECTIVE_DATE,DATE,NULL,,Policy start date
IS_ACTIVE,VARCHAR(3),NOT NULL,NO,YES/NO active flag
"""

CLAIMS_MAPPING = """target_field,source_table,source_field,transformation,datatype,nullable,default
claim_id,claims_raw,clm_id,direct,NUMBER(38,0),N,
claim_status,claims_raw,clm_stat,map codes O->OPEN C->CLOSED,VARCHAR(10),N,UNKNOWN
broker_code,TBD,TBD,awaiting template,TBD,,
is_reopened,claims_raw,reopen_flag,direct,Boolean,N,FALSE
paid_amount,claims_raw,paid_amt,,NUMBER,N,
"""

CLAIMS_TEMPLATE = """column_name,data_type,nullable,default
CLAIM_ID,NUMBER(38,0),NOT NULL,
CLAIM_STATUS,VARCHAR(10),NOT NULL,UNKNOWN
IS_REOPENED,VARCHAR(3),NOT NULL,NO
PAID_AMOUNT,NUMBER(18,2),NOT NULL,0
"""

ACCOUNTS_MAPPING = """target_field,source_table,source_field,transformation,datatype,nullable,default
account_id,legacy_accounts,acct_id,direct,NUMBER(38,0),N,
account_name,legacy_accounts,acct_nm,TRIM,VARCHAR(100),N,NA
opened_date,legacy_accounts,open_dt,CAST to DATE,DATE,Y,
"""

ACCOUNTS_TEMPLATE = """column_name,data_type,nullable,default
ACCOUNT_ID,NUMBER(38,0),NOT NULL,
ACCOUNT_NAME,VARCHAR(100),NOT NULL,NA
OPENED_DATE,DATE,NULL,
"""

STG_ORDERS_SQL = """{{ config(materialized='view') }}
with orders as (
    select * from {{ source('shop', 'orders') }}
)
select
    order_id,
    customer_id,
    cast(order_total as number(18, 2)) as order_total,
    ifnull(trim(order_status), 'NA') as order_status
from orders
where is_deleted = false
"""

# Hex without long digit runs, so the phone/IRD recognisers never touch it.
REPO_SHA = "a3f9c1e7b2d4f6a8c0e2b4d6f8a1c3e5b7d9facb"

FIXTURES: dict[str, Any] = {
    "impact_manifest": json.dumps(IMPACT_MANIFEST),
    "policy_mapping": POLICY_MAPPING,
    "policy_template": POLICY_TEMPLATE,
    "claims_mapping": CLAIMS_MAPPING,
    "claims_template": CLAIMS_TEMPLATE,
    "accounts_mapping": ACCOUNTS_MAPPING,
    "accounts_template": ACCOUNTS_TEMPLATE,
    "stg_orders_sql": STG_ORDERS_SQL,
    "repo_sha": REPO_SHA,
}


def resolve(value: Any) -> Any:
    """Replace ``"@fixture:NAME"`` strings, recursively."""
    if isinstance(value, str) and value.startswith("@fixture:"):
        return FIXTURES[value.split(":", 1)[1]]
    if isinstance(value, dict):
        return {key: resolve(item) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve(item) for item in value]
    return value
