// fieldMapping.js
// ----------------------------------------------------------------------------
// The ONE file you need to edit. Map each MSA payload key to the API name of the
// field in YOUR Salesforce org. Left side = our internal key (do not change).
// Right side = your Salesforce API name (change these).
//
// How to find API names: Salesforce Setup > Object Manager > (Opportunity, or your
// Proposal object) > Fields & Relationships. The "Field Name" column ending in __c
// is the API name. Standard fields (Name, Amount) have no __c.
//
// The screenshot of your Opportunity > Proposals tab shows the human labels; put
// the matching API names beside each key below. Anything you leave as null is simply
// skipped (the corresponding placeholder stays blank for a human to complete).
// ----------------------------------------------------------------------------

// The Salesforce object that holds the proposal/scoping fields. If these live on
// the Opportunity itself, set this to "Opportunity". If they live on a custom
// child object (e.g. a "Proposal__c" related list), set its API name here and set
// RELATIONSHIP_FIELD to the lookup from that object back to Opportunity.
const PROPOSAL_OBJECT = "Opportunity";          // e.g. "Proposal__c"
const RELATIONSHIP_FIELD = null;                // e.g. "Opportunity__c" (only if PROPOSAL_OBJECT is a child)

// Opportunity-level / account-level fields (standard + custom)
const OPPORTUNITY_FIELDS = {
  customer_legal_name: "Account.Name",          // customer legal entity
  effective_date:      null,                    // Date the proposal is sent (Effective Date); often set at generation time
  term_months:         "Contract_Term_Months__c",
  billing_start_date:  "Billing_Start_Date__c",
  // currency: usually CurrencyIsoCode if multi-currency is on; else hard-set in defaults
  currency:            "CurrencyIsoCode",
};

// Proposal / scoping fields. These mirror the "Proposals" tab in your screenshot.
// Replace the right-hand values with your real API names.
const PROPOSAL_FIELDS = {
  // Order Form
  facility_location:   "Customer_Site_Name__c",      // "Customer Site Name"
  station_name:        "Station_Name__c",            // "Station Name"
  station_location:    "Station_Location_Desc__c",   // "Station Location Description"
  production_lines:    "Production_Line_Names__c",    // "Production Line Names" (comma/newline separated)
  num_lines:           "Lines_In_Scope__c",           // "Number of lines in scope"

  // Context & Objectives
  application_deployed: "Application_Description__c",  // "Application Description"
  application_objectives_raw: "Application_Objectives__c", // "Application Objectives" (newline separated -> bullets)

  // Phase 1
  phase1_scope:        "Phase_1_Scope_Summary__c",
  phase1_lines:        "Phase_1_Lines_In_Scope__c",
  phase1_exclusions:   "Phase_1_Exclusions_Summary__c",
  phase1_purpose:      "Phase_1_Purpose_Summary__c",
  success_metrics:     "Phase_1_Success_Criteria_Summary__c",
  phase1_duration_val: "Phase_1_Duration__c",
  phase1_duration_unit:"Phase_1_Duration_Unit__c",
  kickoff_date:        "Phase_1_Start_Date__c",

  // SKUs / expansion (optional)
  skus:                "Phase_1_SKUs__c",
  expansion_kpis:      "Scope_Expansion_KPIs__c",

  // Pricing inputs (so the calculator can run server-side from SFDC)
  tier:                "Pricing_Tier__c",             // 'Standard' | 'Professional' | 'Enterprise'
  custom_discount_pct: "Custom_Discount_Percent__c",  // number, e.g. 5 for 5%
  annual_billing:      "Annual_Billing__c",           // checkbox

  // Activity discounts (checkboxes)
  act_customer_referral: "Activity_Customer_Referral__c",
  act_logo_rights:       "Activity_Logo_Rights__c",
  act_case_study:        "Activity_Case_Study__c",
  act_video_testimonial: "Activity_Video_Testimonial__c",
};

// Hardware line items. If you store these as a child object, set HARDWARE_OBJECT;
// otherwise leave null and pass hardware in the generate request body.
const HARDWARE_OBJECT = null;                    // e.g. "Proposal_Hardware_Item__c"
const HARDWARE_FIELDS = {
  name: "Name",
  cost: "Estimated_Cost__c",
  relationshipToProposal: "Proposal__c",
};

// Defaults applied when a field is null or the value is missing.
const DEFAULTS = {
  currency: "USD",
  annual_billing: true,
  tier: "Professional",
  hardware: { provision: "default", procurement: "purchase" }, // legal's most-preferred path
};

module.exports = {
  PROPOSAL_OBJECT, RELATIONSHIP_FIELD,
  OPPORTUNITY_FIELDS, PROPOSAL_FIELDS,
  HARDWARE_OBJECT, HARDWARE_FIELDS, DEFAULTS,
};
