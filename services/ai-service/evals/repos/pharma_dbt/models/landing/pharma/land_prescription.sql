{{ config(materialized='table', schema='land') }}

select
    cast(id as number) as id,
    cast(drug_id as number) as drug_id,
    cast(patient_id as number) as patient_id,
    cast(drug_frequency as number) as drug_frequency,
    cast(total_cost as decimal(18,2)) as total_cost,
    cast(subsidy_amount as decimal(18,2)) as subsidy_amount,
    cast(prescription_dt as timestamp_tz) as prescription_dt,
    cast(deleted_flg as boolean) as deleted_flg
from {{ source('land_raw', 'prescription') }}
