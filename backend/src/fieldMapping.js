// fieldMapping.js
// ----------------------------------------------------------------------------
// Left side = our internal key (do not change). Right side = your Salesforce API
// name, or null when the value does not come from Salesforce.
//
// Three sources feed the agreement:
//   1. Salesforce fields  -> mapped below (scope, customer, site, etc.)
//   2. The pricing calculator -> tier, lines, billing, discount, activities (NOT from Salesforce)
//   3. The screen / the AI    -> billing start date, effective date, expansion KPIs (rep enters);
//                                contract term (AI suggests, rep confirms)
// Anything set to null is simply skipped; the loader will not error on it.
// ----------------------------------------------------------------------------

const PROPOSAL_OBJECT = "Opportunity";
const RELATIONSHIP_FIELD = null;

// Opportunity / account-level fields
const OPPORTUNITY_FIELDS = {
  customer_legal_name: "Account.Name",   // the customer's NAME (via the linked Account). Not AccountId, which is just the record ID.
  currency:            "CurrencyIsoCode", // USD / CAD
  // No Salesforce field for these -> handled on the screen or by the AI:
  term_months:         null,             // AI suggests from Opportunity + Account; rep confirms on screen
  billing_start_date:  null,             // rep enters on screen
  effective_date:      null,             // rep enters on screen (defaults to the day it is generated)
};

// Proposal / scoping fields (all live on the Opportunity in your org)
const PROPOSAL_FIELDS = {
  // Order Form / site
  facility_location:   "Customer_Site_Name__c",
  station_name:        "Station_Name__c",
  station_location:    "Station_Location_Description__c",
  production_lines:    "Production_Line_Names__c",
  num_lines:           null,             // comes from the calculator

  // Context & objectives
  application_deployed:        "Application_Description__c",
  application_objectives_raw:  "Application_Objectives__c",

  // Phase 1
  phase1_scope:        "Phase_1_Scope_Summary__c",
  phase1_lines:        "Phase_1_Lines_in_Scope__c",
  phase1_exclusions:   "Phase_1_Exclusions_Summary__c",
  phase1_purpose:      "Phase_1_Purpose_Summary__c",
  success_metrics:     "Phase_1_Success_Criteria_Summary__c",
  phase1_duration_val: null,             // no separate number field; unit field below carries the duration
  phase1_duration_unit:"Phase_1_Duration_Unit__c",
  kickoff_date:        "Phase_1_Start_Date__c",

  // Optional
  skus:                null,             // from the calculator/config, not a Salesforce field
  expansion_kpis:      null,             // rep enters on screen

  // Pricing inputs all come from the CALCULATOR, not Salesforce:
  tier:                null,
  custom_discount_pct: null,
  annual_billing:      null,
  act_customer_referral: null,
  act_logo_rights:       null,
  act_case_study:        null,
  act_video_testimonial: null,
};

const HARDWARE_OBJECT = null;            // hardware is entered on the screen
const HARDWARE_FIELDS = { name: "Name", cost: "Estimated_Cost__c", relationshipToProposal: "Proposal__c" };

const DEFAULTS = {
  currency: "USD",
  annual_billing: true,
  tier: "Professional",
  hardware: { provision: "default", procurement: "purchase" },
};

module.exports = {
  PROPOSAL_OBJECT, RELATIONSHIP_FIELD,
  OPPORTUNITY_FIELDS, PROPOSAL_FIELDS,
  HARDWARE_OBJECT, HARDWARE_FIELDS, DEFAULTS,
};
