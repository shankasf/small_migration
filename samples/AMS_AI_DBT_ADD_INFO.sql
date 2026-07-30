-- AMS_AI_DBT-ADD_INFO
-- This model transforms source CLM data for the AdditionalInfo staging table
-- Last updated: 2024-01-15

{{ config(
    materialized='table',
    schema='ams_staging'
) }}

WITH contract_base AS (
    SELECT
        c.contract_id,
        c.contract_name,
        c.effective_date,
        c.expiry_date,
        c.status_code,
        c.supplier_id
    FROM {{ source('clm_db', 'contracts') }} c
    WHERE c.active = 1
),

contract_types AS (
    SELECT
        ct.contract_id,
        ct.type_code
    FROM {{ source('clm_db', 'contract_types') }} ct
),

suppliers AS (
    SELECT
        s.supplier_id,
        s.supplier_name
    FROM {{ source('clm_db', 'suppliers') }} s
),

financials AS (
    SELECT
        cf.contract_id,
        cf.total_value
    FROM {{ source('clm_db', 'contract_financials') }} cf
),

supplier_metrics AS (
    SELECT
        sm.supplier_id,
        sm.perf_score,
        sm.last_review_dt
    FROM {{ source('clm_db', 'supplier_metrics') }} sm
)

SELECT
    -- Contract identifiers
    TRIM(cb.contract_id) AS contract_id,
    UPPER(cb.contract_name) AS contract_name,

    -- Agreement type mapping
    CASE
        WHEN ct.type_code = 'LOA' THEN 'funder_2_LOA'
        WHEN ct.type_code = 'OA' THEN 'funder_2_Outcome_Agreement'
        ELSE 'funder_2_Migration_Variation'
    END AS agreement_type,

    -- Supplier information
    TRIM(s.supplier_name) AS supplier_name,

    -- Financial data
    COALESCE(f.total_value, 0) AS contract_value,

    -- Dates
    TO_DATE(cb.effective_date) AS start_date,
    TO_DATE(cb.expiry_date) AS end_date,

    -- Status mapping
    CASE
        WHEN cb.status_code = 'A' THEN 'Active'
        WHEN cb.status_code = 'I' THEN 'Inactive'
        WHEN cb.status_code = 'P' THEN 'Pending'
        ELSE 'Terminated'
    END AS status,

    -- Performance metrics
    COALESCE(sm.perf_score, 0) AS performance_score,
    TO_DATE(sm.last_review_dt) AS last_review_date

FROM contract_base cb
LEFT JOIN contract_types ct ON cb.contract_id = ct.contract_id
LEFT JOIN suppliers s ON cb.supplier_id = s.supplier_id
LEFT JOIN financials f ON cb.contract_id = f.contract_id
LEFT JOIN supplier_metrics sm ON cb.supplier_id = sm.supplier_id
