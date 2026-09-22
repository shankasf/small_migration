{{ config(materialized='table', schema='stage') }}

with prescription_at_dispensing as (
    select
        cast(id as number) as id,
        cast(patient_id as number) as patient_id,
        cast(drug_id as number) as drug_id,
        cast(drug_frequency as decimal(18,2)) as drug_frequency,
        cast(total_cost as decimal(18,2)) as total_cost,
        cast(subsidy_amount as decimal(18,2)) as subsidy_amount,
        cast(prescription_dt as timestamp_tz) as prescription_dt
    from {{ ref('prescription_snapshot') }}
    where prescription_dt >= dbt_valid_from
      and prescription_dt < dbt_valid_to
),

patient_at_dispensing as (
    select
        cast(p.id as number) as id,
        cast(p.name as varchar) as name,
        cast(p.gender as varchar) as gender,
        cast(p.nhi as varchar) as nhi,
        rx.drug_id,
        rx.id as prescription_id,
        rx.drug_frequency,
        rx.total_cost,
        rx.subsidy_amount,
        rx.prescription_dt
    from {{ ref('patient_snapshot') }} as p
    inner join prescription_at_dispensing as rx
        on rx.patient_id = p.id
       and rx.prescription_dt >= p.dbt_valid_from
       and rx.prescription_dt < p.dbt_valid_to
),

current_patients_without_prescriptions as (
    select
        cast(p.id as number) as id,
        cast(p.name as varchar) as name,
        cast(p.gender as varchar) as gender,
        cast(p.nhi as varchar) as nhi,
        cast(null as number) as drug_id,
        cast(null as number) as prescription_id,
        cast(null as decimal(18,2)) as drug_frequency,
        cast(null as decimal(18,2)) as total_cost,
        cast(null as decimal(18,2)) as subsidy_amount,
        cast(null as timestamp_tz) as prescription_dt
    from {{ ref('patient_snapshot') }} as p
    where p.dbt_valid_to::date = '9999-12-31'::date
      and not exists (
          select 1
          from prescription_at_dispensing as rx
          where rx.patient_id = p.id
      )
),

patient_population as (
    select
        id,
        name,
        gender,
        nhi,
        drug_id,
        prescription_id,
        drug_frequency,
        total_cost,
        subsidy_amount,
        prescription_dt
    from patient_at_dispensing

    union all

    select
        id,
        name,
        gender,
        nhi,
        drug_id,
        prescription_id,
        drug_frequency,
        total_cost,
        subsidy_amount,
        prescription_dt
    from current_patients_without_prescriptions
),

drug_current as (
    select
        cast(id as number) as id,
        cast(name as varchar) as name,
        cast(cost as decimal(18,2)) as cost
    from {{ ref('drugs_snapshot') }}
    where dbt_valid_to::date = '9999-12-31'::date
),

reporting_enriched as (
    select
        cast(p.id as number) as patient_id,
        cast(p.name as varchar) as patient_name,
        cast(p.gender as varchar) as gender,
        cast(p.nhi as varchar) as nhi,
        cast(d.name as varchar) as drug_name,
        cast(d.cost as decimal(18,2)) as drug_cost,
        cast(p.prescription_id as number) as prescription_id,
        cast(p.drug_frequency as decimal(18,2)) as drug_frequency,
        cast(p.total_cost as decimal(18,2)) as prescription_cost,
        cast(p.subsidy_amount as decimal(18,2)) as subsidy_amount
    from patient_population as p
    left join drug_current as d
        on d.id = p.drug_id
)

select
    patient_id,
    patient_name,
    gender,
    nhi,
    drug_name,
    drug_cost,
    prescription_id,
    drug_frequency,
    prescription_cost,
    subsidy_amount
from reporting_enriched
