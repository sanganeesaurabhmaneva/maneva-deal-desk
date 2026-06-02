// scripts/smoke.js -- end-to-end check with a sample deal (no Salesforce).
// Run: node scripts/smoke.js
const generate = require("../src/generate");

const deal = {
  opportunityId: "SAMPLE",
  customer_legal_name: "Northwind Foods Inc.",
  currency: "USD",
  term_months: 12,
  billing_start_date: "July 1, 2026",
  effective_date: null, // -> defaults to today at generation time
  pricing: {
    tier: "Professional",
    lines: 1,
    annual: true,
    customDiscount: 0,
    activities: { customerReferral: false, logoRights: false, caseStudy: false, videoTestimonial: false },
  },
  facility_location: "Columbus, Ohio",
  application_deployed: "Label Placement & Date-Code Verification",
  application_names: "Label Placement & Date-Code Verification",
  applications: "Label Placement & Date-Code Verification",
  production_lines: ["Canning Line 3"],
  objectives: [
    "Detect mislabeled, missing, or skewed product labels in real time on every unit",
    "Verify date-code presence and legibility on every unit produced",
    "Reduce mislabeled-product holds and downstream rework",
  ],
  phase1_scope: "Continuous monitoring of label placement and date-code verification on all units produced on the Initial Deployment Line, with real-time defect alerts and a Maneva dashboard summarizing defect rates by shift and by SKU",
  phase1_exclusions: "Inspection of secondary packaging (cases, trays, and pallets); upstream filling or capping defects; and any production line not listed above",
  phase1_purpose: "validate the accuracy and reliability of the Application under live production conditions",
  success_metrics: "Target detection rate of 95% or greater for missing or mislabeled units, subject to data quality and available production conditions",
  kickoff_date: "July 1, 2026",
  phase1_duration: "eight to twelve weeks",
  skus: "twelve (12) representative canned-beverage SKUs",
  expansion_kpis: "additional defect classes such as dent and seam-integrity detection and cap/closure verification",
  hardware: [
    { name: "Industrial vision camera (washdown-rated)", cost: "$3,500" },
    { name: "NVIDIA Jetson edge compute device", cost: "$2,200" },
    { name: "Supplemental LED lighting, mounting, and washdown enclosures", cost: "$1,500" },
  ],
};

(async () => {
  const r = await generate.generateMSA(deal, {
    install_timeline: "two to three weeks",
    end_phase1_date: "September 30, 2026",
    hardware: { provision: "default", procurement: "purchase" },
  });
  console.log("Generated:", r.file);
  console.log("Pricing:", JSON.stringify(r.pricing, null, 2));
})().catch((e) => { console.error("SMOKE FAILED:", e.message); process.exit(1); });
