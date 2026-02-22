-- ============================================================================
-- UPDATED: 2026-01-23 04:38:26
-- Added Supplier_Performance_Reports field for AMS vendor consumption
-- Type: VARCHAR | Nullable: True
-- ============================================================================

select
    concat(ai.contractid,'-',ai.version) internalreference
   ,ai.division_description funder_1_division
   ,{{assemble_name('ai.mgr_firstname1', 'ai.mgr_firstname2', 'ai.mgr_name')}} agree_mang_name
   ,{{assemble_name('ai.dep_firstname1', 'ai.dep_firstname2', 'ai.dep_name')}} agree_dept_name
   ,ai.dep_email agree_dept_email
   ,null  agree_req_form
   ,null /*'2024-07-01'*/ agree_agree_reciept
   ,{{assemble_name('ai.sup_firstname1', 'ai.sup_firstname2', 'ai.sup_name')}} funder_1_contract_manager_name
   ,nvl(nullif(ai.sup_email,''),'Not In AMS') funder_1_contract_manager_email
   ,{{assemble_name('ai.rpt_firstname1', 'ai.rpt_firstname2', 'ai.rpt_name')}} funder_1_perform_manager_name
   ,nvl(nullif(ai.rpt_email,''),'Not In AMS') funder_1_perform_manager_email
   ,'No' variation_agreement
   ,null variation_purpose
   ,null sow_start_date
   ,null original_clause_subject_to_variation
   ,'No' sf_required
   ,null sf_number_of_links
   ,null sf_schedule_name_1
   ,null sf_publishing_date_1
   ,null sf_schedule_name_2
   ,null sf_publishing_date_2
   ,null sf_schedule_name_3
   ,null sf_publishing_date_3
   ,null sf_schedule_name_4
   ,null sf_publishing_date_4
   ,null sf_schedule_name_5
   ,null sf_publishing_date_5
   ,null sf_schedule_name_6
   ,null sf_publishing_date_6
   ,null sf_schedule_name_7
   ,null sf_publishing_date_7
   ,null sf_schedule_name_8
   ,null sf_publishing_date_8
   ,null sf_schedule_name_9
   ,null sf_publishing_date_9
   ,null sf_schedule_name_10
   ,null sf_publishing_date_10
   ,null local_service_specifications
   --,rollup_payment_type funder_1_payment_type 
   ,ifnull(rollup_payment_type, 
        case 
            when ifnull(scope.umbrella,'')  = 'umbrella parent' then 'Invoice-Based Payments' 
            else null 
        end) as funder_1_payment_type
   ,null approved_subcontractors
   ,null subcontractor_responsibilities
   ,case when ai.RAcode = 'HM' then 'Aotearoa'
    else 'Region,District' end  geographical_area
   ,case 
        when ai.RAcode in ('CAK', 'SAK', 'NLD', 'NWA') then 'Northern'
        when ai.RAcode in ('BOP', 'LKS', 'TRW', 'TKI', 'WKO') then 'Midlands'
        when ai.RAcode in ('CAP', 'HWB', 'HUT', 'MWU', 'WRP', 'WNI') then 'Central'
        when ai.RAcode in ('CTY', 'NLM', 'SCY', 'OTA', 'WCO') then 'South'
        when ai.RAcode = 'HM' then null
        else null 
   end geographical_region
   ,decode(ai.RAcode, 
         'HM' ,null,
         'BOP' ,'Bay of Plenty',
         'CAK' ,'Auckland',
         'CAP' ,'Wellington',
         'CTY' ,'Canterbury',
         'HUT' ,'Hutt Valley',
         'HWB' ,'Hawke’s Bay',
         'LKS' ,'Lakes',
         'MWU' ,'MidCentral',
         'NLD' ,'Northland',
         'NLM' ,'Nelson Marlborough',
         'NWA' ,'Waitematā',
         'OTA' ,'Southern',
         'SAK' ,'Counties Manukau',
         'SCY' ,'South Canterbury',
         'TKI' ,'Taranaki',
         'TRW' ,'Tairāwhiti',
         'WCO' ,'West Coast',
     'WKO' ,'Waikato',
     'WRP' ,'Wairarapa',
     'WNI' ,'Whanganui'
   ) geographical_district
   , null geographical_localities
  ,null funder_1_related_agreement_title
  ,null funder_1_related_agreement_start_date
  ,null related_agreement_number
  ,null funder_1_agreement_background
  ,null funder_1_agreement_renewal
  ,null funder_1_agreement_renewal_period
  ,null funder_1_required_meeting_presence
  ,null funder_1_required_meeting_times
  ,null funder_1_reporting
  ,null funder_1_reporting_frequency
  ,null funder_1_assistance_resources
  ,null funder_1_resource_conditions
  ,null tasks_and_responsibilities
  ,null description_of_tasks_and_responsibilities
  ,null special_terms
  ,null initial_agreement_term
  ,null rate_type
  ,null funder_1_supplier_background
  ,null funder_1_service_schedule_title
  ,null funder_1_parent_agreement_number
  ,null funder_1_service_schedule_number
  ,null funder_1_contribution_outcome_objectives
  ,null funder_1_target_population
  ,null funder_1_supplier_activities_contributions
  ,null funder_1_non_financial_activities_contributions
  ,null funder_1_indemnity_clause_enhancements
  ,null funder_1_parties_obligations
  ,null funder_1_relevant_quality_standards
  ,null funder_1_target_population_detail
  ,null funder_1_variation_clause
  ,null funder_1_service_name
  ,null funder_1_service_description
  ,null funder_1_approved_personnel_name
  ,null funder_1_approved_personnel_position
  ,null funder_1_approved_personnel_specialisation
  ,null funder_1_approved_subcontractor_name
  ,null funder_1_approved_subcontractor_position
  ,null new_ip_bespoke_clause
  ,null privacy_of_personal_information_bespoke_clause
  ,null bespoke_ts_and_cs
  ,null additional_terms_bespoke_clause
  ,null funder_1_invoice_reference
  ,null funder_1_invoicing_osa
  ,null funder_1_specify_dates
  ,ai.validation_contract
  ,ai.validation_org
  ,null variation_change
  ,null which_module_applies_to_this_pic
  ,null options_to_renew
  ,null related_master_terms_number
  ,null related_master_terms_name
  ,null module_special_terms
  ,null module_specific_definitions_and_interpretations
  ,null variation_amendment
  ,null hm_services_clauses
  ,null variation_agreement_change
  ,ai.mgr_email agreement_manager_email
  ,null additional_service_specifications
  ,case when ai.division_code = 'funder_2' and sc.ctypeid = 'OUT' then 'NA' else null end intellectual_property_name
  ,case when ai.division_code = 'funder_2' and sc.ctypeid = 'OUT' then 'NA' else null end intellectual_property_uses
  ,null changes_to_the_framework_terms_and_conditions
  ,null reporting
  ,null enter_new_services
  ,null letter_of_agreement_date
  ,case when ai.division_code <> 'funder_2' then null else 'No' end additional_supplier_specific_terms_and_conditions,
    -- Supplier Performance Reports (new field for AMS)
    supplier_performance_reports AS Supplier_Performance_Reports

from {{ref('additional_info')}} ai
    inner join {{ref('in_scope_contracts')}} scope on scope.contractid = ai.contractid
     inner join {{ref('sys_contract')}} sc on scope.contractid = sc.contractid and scope.version = sc.version
