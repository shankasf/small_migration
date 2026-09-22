{% snapshot drugs_snapshot %}

select
    id,
    name,
    cost,
    unit,
    type,
    deleted_flg
from {{ ref('land_drugs') }}

{% endsnapshot %}
