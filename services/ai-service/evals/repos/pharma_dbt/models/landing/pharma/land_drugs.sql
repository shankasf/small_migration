{{ config(materialized='table', schema='land') }}

select
    cast(id as number) as id,
    cast(name as varchar) as name,
    cast(cost as decimal(18,2)) as cost,
    cast(unit as decimal(18,2)) as unit,
    cast(type as varchar) as type,
    cast(deleted_flg as boolean) as deleted_flg
from {{ source('land_raw', 'drugs') }}
