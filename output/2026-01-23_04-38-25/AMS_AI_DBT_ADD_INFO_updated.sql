-- ============================================================================
-- UPDATED: 2026-01-23 04:38:25
-- Added Supplier Performance Reports field for AMS migration
-- Source: CLM.public.contracts.Supplier_Performance_Reports
-- ============================================================================

select
sc.contractid,
sc.version,
mdc.division_description,
mgr.name mgr_name,
mgr.firstname1 mgr_firstname1,
mgr.firstname2 mgr_firstname2,
trim(mgr.email, ' \t\n\r') mgr_email,
mgr.phonemain mgr_phonemain,
mgr.phoneother mgr_phoneother,
depmgr.name dep_name,
depmgr.firstname1 dep_firstname1,
depmgr.firstname2 dep_firstname2,
trim(depmgr.email, ' \t\n\r') dep_email,
depmgr.phonemain dep_phonemain,
depmgr.phoneother dep_phoneother,
mntr.name mntr_name,
mntr.firstname1 mntr_firstname1,
mntr.firstname2 mntr_firstname2,
trim(mntr.email, ' \t\n\r') mntr_email,
mntr.phonemain mntr_phonemain,
mntr.phoneother mntr_phoneother,
rptmgr.name rpt_name,
rptmgr.firstname1 rpt_firstname1,
rptmgr.firstname2 rpt_firstname2,
trim(rptmgr.email, ' \t\n\r') rpt_email,
rptmgr.phonemain rpt_phonemain,
rptmgr.phoneother rpt_phoneother,
finmgr.name fin_name,
finmgr.firstname1 fin_firstname1,
finmgr.firstname2 fin_firstname2,
trim(finmgr.email, ' \t\n\r') fin_email,
finmgr.phonemain fin_phonemain,
finmgr.phoneother fin_phoneother,
supmgr.name sup_name,
supmgr.firstname1 sup_firstname1,
supmgr.firstname2 sup_firstname2,
trim(supmgr.email, ' \t\n\r') sup_email,
supmgr.phonemain sup_phonemain,
supmgr.phoneother sup_phoneother,
e.RAcode,
sc.variationstartdate,
e.contractid validation_contract,
mdm_division.division_code,
e.id validation_id,
case when e."CABS_Candidate?" = 'Block only' 
then 'CABS'
else 'CAPI' end cabs_capi,
case 
    when rollup_sc_lines.cabs_count * rollup_sc_lines.capi_count > 0 then 'Scheduled Payments,Invoice-Based Payments'
    when rollup_sc_lines.cabs_count > 0 then 'Scheduled Payments'
    when rollup_sc_lines.capi_count > 0 then 'Invoice-Based Payments'
    else null 
end rollup_payment_type,
    -- Supplier Performance Reports field (added for AMS migration)
    -- Source: CLM.public.contracts.Supplier_Performance_Reports
    select Supplier_Performance_Reports from source AS supplier_performance_reports

from {{ref('in_scope_contracts')}} e
inner join {{ref('sys_contract')}} sc on e.contractid = sc.contractid and e.version = sc.version
left join {{ref('sys_supplier')}} mgr on mgr.id = sc.contractmngr
left join {{ref('sys_supplier')}} depmgr on depmgr.id = sc.contractdeputy
left join {{ref('sys_supplier')}} mntr on mntr.id = sc.contractmntr
left join {{ref('sys_supplier')}} rptmgr on rptmgr.id = sc.SUPPLIERMNTRCONTACT
left join {{ref('sys_supplier')}} finmgr on finmgr.id = sc.financemngr
left join {{ref('sys_supplier')}} supmgr on supmgr.id = sc.suprcontact
left join {{ref('mdm_division')}} mdc on mdc.funder = sc.transitionalfunder
left outer join {{ref('mdm_division')}} mdm_division on mdm_division.funder = sc.transitionalfunder
left join (select contractid, 
                  sum(case when cabs_capi = 'CABS' then 1 else 0 end) cabs_count,
                  sum(case when cabs_capi = 'CAPI' then 1 else 0 end) capi_count from {{ref('pricelist')}}
            group by all  ) rollup_sc_lines on rollup_sc_lines.contractid = e.contractid