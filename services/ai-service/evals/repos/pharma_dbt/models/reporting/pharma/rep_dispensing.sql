{{ config(materialized='table', schema='rep') }}

select *
from {{ ref('stg_dispensing') }}
