// generate.js -- the pipeline.
// deal (from Salesforce or request body) -> run pricing -> assemble the engine
// payload -> spawn the Python fill engine -> return the generated .docx path.

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const pricing = require("./pricing");

const ENGINE = path.join(__dirname, "..", "engine", "fill_msa.py");
const PROPOSAL_ENGINE = path.join(__dirname, "..", "engine", "build_proposal.py");
const TEMPLATES = path.join(__dirname, "..", "templates");
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(os.tmpdir(), "deal-desk-output");

// number words for "one (1)" style phrasing in the Order Form
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"];
const numText = (n) => (n >= 0 && n <= 15 ? `${WORDS[n]} (${n})` : `${n}`);
const monthsText = (m) => (m ? (WORDS[m] ? `${WORDS[m]} (${m}) months` : `${m} months`) : "");

/** Build the JSON payload the Python engine expects from a normalized deal. */
function buildPayload(deal, choices = {}) {
  const p = pricing.price({
    tier: deal.pricing.tier,
    lines: deal.pricing.lines,
    annual: deal.pricing.annual,
    customDiscount: deal.pricing.customDiscount,
    activities: deal.pricing.activities,
    currency: deal.pricing.currency,
  });

  const hw = deal.hardware && deal.hardware.length ? deal.hardware : (choices.hardwareItems || []);
  const total = hw.reduce((s, i) => s + moneyToNum(i.cost), 0);
  const eff = parseEff(deal.effective_date) || todayLong();

  return {
    payload: {
      customer_legal_name: deal.customer_legal_name,
      applications: deal.applications,
      application_names: deal.application_names,
      application_deployed: deal.application_deployed,
      currency: deal.currency,
      num_lines_text: numText(deal.pricing.lines),
      price: Number(p.finalRatePerLine).toLocaleString("en-US"),
      ref_section_3: "3",
      ref_section_4: "4",
      term_text: monthsText(deal.term_months),
      billing_start_date: deal.billing_start_date || "",
      end_phase1_date: choices.end_phase1_date || "",
      eff_month: eff.month, eff_day: eff.day, eff_year: eff.year,
      facility_location: deal.facility_location,
      phase1_scope: deal.phase1_scope,
      phase1_exclusions: deal.phase1_exclusions,
      phase1_purpose: deal.phase1_purpose,
      success_metrics: deal.success_metrics,
      kickoff_date: deal.kickoff_date || deal.billing_start_date || "",
      install_timeline: choices.install_timeline || deal.install_timeline || "",
      phase1_duration: deal.phase1_duration,
      skus: deal.skus,
      expansion_kpis: deal.expansion_kpis,
      expansion_cost: deal.expansion_cost ||
        "Each Additional Deployment Line is priced per the volume schedule in the Order Form, with the per-line monthly fee decreasing as the total number of deployed lines increases",
      objectives: deal.objectives || [],
      production_lines: deal.production_lines || [],
      hardware: {
        provision: (choices.hardware && choices.hardware.provision) || "default",
        procurement: (choices.hardware && choices.hardware.procurement) || "purchase",
        items: hw,
        total: total ? `$${total.toLocaleString("en-US")}` : "",
      },
    },
    pricing: p,
  };
}

/** Run the Python engine. Returns the output file path. */
function runEngine(templatePath, payloadObj, outPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const payloadFile = outPath + ".payload.json";
    fs.writeFileSync(payloadFile, JSON.stringify(payloadObj));
    const py = process.env.PYTHON_BIN || "python3";
    execFile(py, [ENGINE, templatePath, payloadFile, outPath], (err, stdout, stderr) => {
      try { fs.unlinkSync(payloadFile); } catch (_) {}
      if (err) return reject(new Error(`fill engine failed: ${stderr || err.message}`));
      resolve(outPath);
    });
  });
}

/** Run the proposal engine: appends the proposal under Appendix 1. Returns out path. */
function runProposal(agreementPath, proposalPayloadObj, outPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const payloadFile = outPath + ".prop.json";
    fs.writeFileSync(payloadFile, JSON.stringify(proposalPayloadObj));
    const py = process.env.PYTHON_BIN || "python3";
    execFile(py, [PROPOSAL_ENGINE, agreementPath, payloadFile, outPath], (err, stdout, stderr) => {
      try { fs.unlinkSync(payloadFile); } catch (_) {}
      if (err) return reject(new Error(`proposal engine failed: ${stderr || err.message}`));
      resolve(outPath);
    });
  });
}

/**
 * Generate the single combined Word file: the Service Agreement (Order Form + Terms and
 * Conditions) with the proposal under Appendix 1. The agreement is filled deterministically;
 * the proposal content and photos come from the rep (choices.proposal).
 */
async function generateDocument(deal, choices = {}) {
  const { payload, pricing: p } = buildPayload(deal, choices);
  const template = path.join(TEMPLATES, "msa_template.docx");
  if (!fs.existsSync(template)) {
    throw new Error(`Template missing: ${template}. Copy your MSA .docx there as msa_template.docx`);
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const safeName = (deal.customer_legal_name || "customer").replace(/[^a-z0-9]+/gi, "_");
  const stamp = Date.now();

  // 1) fill the agreement
  const agreement = path.join(OUTPUT_DIR, `_agr_${safeName}_${stamp}.docx`);
  await runEngine(template, payload, agreement);

  // 2) if the rep supplied proposal content, append it under Appendix 1 -> combined file
  const proposal = choices.proposal;
  const hasProposal = proposal && ((proposal.applications && proposal.applications.length) || proposal.executive_summary);
  const finalName = `Maneva_-_${safeName}_-_Service_Agreement_${stamp}.docx`;
  const finalPath = path.join(OUTPUT_DIR, finalName);

  if (hasProposal) {
    await runProposal(agreement, { pricing: p, currency: deal.pricing.currency, proposal }, finalPath);
    try { fs.unlinkSync(agreement); } catch (_) {}
  } else {
    fs.renameSync(agreement, finalPath);
  }
  return { file: finalPath, pricing: p, payload };
}

// kept for backward-compatible imports
const generateMSA = generateDocument;

// ---- helpers ----
const moneyToNum = (v) => Number(String(v == null ? 0 : v).replace(/[^0-9.]/g, "")) || 0;
function todayLong() {
  const d = new Date();
  return {
    month: d.toLocaleDateString("en-US", { month: "long" }),
    day: String(d.getDate()),
    year: String(d.getFullYear()),
  };
}
function parseEff(v) {
  if (!v || typeof v !== "string") return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  return {
    month: d.toLocaleDateString("en-US", { month: "long" }),
    day: String(d.getDate()),
    year: String(d.getFullYear()),
  };
}

module.exports = { generateDocument, generateMSA, buildPayload, OUTPUT_DIR };
