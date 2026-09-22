{{ config(materialized='table', schema='land') }}

select
    cast(id as number) as id,
    cast(name as varchar) as name,
    cast(gender as varchar) as gender,
    cast(nhi as varchar) as nhi,
    cast(deleted_flg as boolean) as deleted_flg
from {{ source('land_raw', 'patient') }}
