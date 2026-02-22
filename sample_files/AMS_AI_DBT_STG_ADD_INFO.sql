-- AMS_AI_DBT_STG_ADD_INFO
-- Staging model for AdditionalInfo table - consumed by AMS vendor
-- Last updated: 2024-01-15

{{ config(
    materialized='table',
    schema='ams_vendor_staging'
) }}

SELECT
    -- Primary key
    contract_id AS Contract_ID,

    -- Contract details
    contract_name AS Contract_Name,
    agreement_type AS Agreement_Type,
    supplier_name AS Supplier_Name,
    contract_value AS Contract_Value,

    -- Dates
    start_date AS Start_Date,
    end_date AS End_Date,

    -- Status
    status AS Status,

    -- Performance fields
    performance_score AS Performance_Score,
    last_review_date AS Last_Review_Date

FROM {{ ref('AMS_AI_DBT_ADD_INFO') }}
