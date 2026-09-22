{% snapshot prescription_snapshot %}

select
    id,
    drug_id,
    patient_id,
    drug_frequency,
    total_cost,
    subsidy_amount,
    prescription_dt,
    deleted_flg
from {{ ref('land_prescription') }}

{% endsnapshot %}
