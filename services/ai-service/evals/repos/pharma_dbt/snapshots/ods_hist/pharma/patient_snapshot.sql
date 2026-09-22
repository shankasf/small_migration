{% snapshot patient_snapshot %}

select
    id,
    name,
    gender,
    nhi,
    deleted_flg
from {{ ref('land_patient') }}

{% endsnapshot %}
