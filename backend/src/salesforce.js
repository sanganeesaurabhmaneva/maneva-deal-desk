// salesforce.js -- thin Salesforce read layer using jsforce.
// Supports two auth modes via .env:
//   (A) OAuth2 refresh token  (recommended for a server): SF_CLIENT_ID, SF_CLIENT_SECRET, SF_REFRESH_TOKEN, SF_LOGIN_URL
//   (B) Username/password+token (quick start):            SF_USERNAME, SF_PASSWORD, SF_TOKEN, SF_LOGIN_URL
//
// Exposes getDeal(opportunityId) which returns a normalized deal object ready for
// pricing + document generation.

const jsforce = require("jsforce");
const M = require("./fieldMapping");

let _conn = null;

async function connection() {
  if (_conn) return _conn;
  const loginUrl = process.env.SF_LOGIN_URL || "https://login.salesforce.com";

  if (process.env.SF_REFRESH_TOKEN) {
    const conn = new jsforce.Connection({
      oauth2: {
        loginUrl,
        clientId: process.env.SF_CLIENT_ID,
        clientSecret: process.env.SF_CLIENT_SECRET,
      },
      instanceUrl: process.env.SF_INSTANCE_URL,
      refreshToken: process.env.SF_REFRESH_TOKEN,
    });
    // force a token refresh so we have a live access token
    await conn.oauth2.refreshToken(process.env.SF_REFRESH_TOKEN).then((res) => {
      conn.accessToken = res.access_token;
      conn.instanceUrl = res.instance_url || conn.instanceUrl;
    });
    _conn = conn;
    return _conn;
  }

  // username/password fallback
  const conn = new jsforce.Connection({ loginUrl });
  await conn.login(process.env.SF_USERNAME, (process.env.SF_PASSWORD || "") + (process.env.SF_TOKEN || ""));
  _conn = conn;
  return _conn;
}

// Build the field list to SELECT, skipping any mapping the user left null.
function selectFields(map) {
  return Object.values(map).filter(Boolean);
}

async function fetchProposalRecord(conn, opportunityId) {
  const oppFields = selectFields(M.OPPORTUNITY_FIELDS);
  const propFields = selectFields(M.PROPOSAL_FIELDS);

  if (M.PROPOSAL_OBJECT === "Opportunity") {
    const fields = Array.from(new Set([...oppFields, ...propFields, "Id"]));
    const soql = `SELECT ${fields.join(", ")} FROM Opportunity WHERE Id = '${escapeId(opportunityId)}' LIMIT 1`;
    const r = await conn.query(soql);
    if (!r.records.length) throw new Error(`No Opportunity found for Id ${opportunityId}`);
    return { opp: r.records[0], prop: r.records[0] };
  }

  // proposal fields live on a child object related to the opportunity
  const oppSoql = `SELECT ${Array.from(new Set([...oppFields, "Id"])).join(", ")} FROM Opportunity WHERE Id = '${escapeId(opportunityId)}' LIMIT 1`;
  const oppRes = await conn.query(oppSoql);
  if (!oppRes.records.length) throw new Error(`No Opportunity found for Id ${opportunityId}`);

  const rel = M.RELATIONSHIP_FIELD;
  const propSoql = `SELECT ${Array.from(new Set([...propFields, "Id"])).join(", ")} FROM ${M.PROPOSAL_OBJECT} WHERE ${rel} = '${escapeId(opportunityId)}' ORDER BY LastModifiedDate DESC LIMIT 1`;
  const propRes = await conn.query(propSoql);
  return { opp: oppRes.records[0], prop: propRes.records[0] || {} };
}

async function fetchHardware(conn, proposalId) {
  if (!M.HARDWARE_OBJECT || !proposalId) return [];
  const f = M.HARDWARE_FIELDS;
  const soql = `SELECT ${f.name}, ${f.cost} FROM ${M.HARDWARE_OBJECT} WHERE ${f.relationshipToProposal} = '${escapeId(proposalId)}'`;
  const r = await conn.query(soql);
  return r.records.map((rec) => ({ name: get(rec, f.name), cost: formatMoney(get(rec, f.cost)) }));
}

// Map a Salesforce record pair into our normalized deal object.
function mapToDeal({ opp, prop }) {
  const O = M.OPPORTUNITY_FIELDS, P = M.PROPOSAL_FIELDS, D = M.DEFAULTS;

  const lines = parseList(get(prop, P.production_lines));
  const objectives = parseList(get(prop, P.application_objectives_raw));
  const numLines = toInt(get(prop, P.num_lines)) || lines.length || 1;

  return {
    opportunityId: opp.Id,
    // identity + commercial
    customer_legal_name: get(opp, O.customer_legal_name) || "",
    currency: get(opp, O.currency) || D.currency,
    term_months: toInt(get(opp, O.term_months)) || null,
    billing_start_date: formatDate(get(opp, O.billing_start_date)),
    effective_date: formatDate(get(opp, O.effective_date)),  // may be null -> set at generation
    // pricing inputs
    pricing: {
      tier: get(prop, P.tier) || D.tier,
      lines: numLines,
      annual: toBool(get(prop, P.annual_billing), D.annual_billing),
      customDiscount: pct(get(prop, P.custom_discount_pct)),
      activities: {
        customerReferral: toBool(get(prop, P.act_customer_referral), false),
        logoRights:       toBool(get(prop, P.act_logo_rights), false),
        caseStudy:        toBool(get(prop, P.act_case_study), false),
        videoTestimonial: toBool(get(prop, P.act_video_testimonial), false),
      },
    },
    // scope narrative
    facility_location: get(prop, P.facility_location) || "",
    application_deployed: get(prop, P.application_deployed) || "",
    application_names: get(prop, P.application_deployed) || "",
    applications: get(prop, P.application_deployed) || "",
    production_lines: lines,
    objectives,
    phase1_scope: get(prop, P.phase1_scope) || "",
    phase1_exclusions: get(prop, P.phase1_exclusions) || "",
    phase1_purpose: get(prop, P.phase1_purpose) || "",
    success_metrics: get(prop, P.success_metrics) || "",
    kickoff_date: formatDate(get(prop, P.kickoff_date)),
    phase1_duration: joinDuration(get(prop, P.phase1_duration_val), get(prop, P.phase1_duration_unit)),
    skus: get(prop, P.skus) || "",
    expansion_kpis: get(prop, P.expansion_kpis) || "",
  };
}

async function getDeal(opportunityId) {
  const conn = await connection();
  const { opp, prop } = await fetchProposalRecord(conn, opportunityId);
  const deal = mapToDeal({ opp, prop });
  deal.hardware = await fetchHardware(conn, prop.Id);
  return deal;
}

/**
 * Read EVERY populated field on the Opportunity (standard + custom, including MEDDPICC and
 * the Proposals-section fields). Returns a clean { "Field Label": value } map of non-empty
 * fields, which is what the AI uses to draft the proposal.
 */
async function readAllOpportunityFields(opportunityId) {
  const conn = await connection();
  const meta = await conn.sobject("Opportunity").describe();
  const skip = new Set(["address", "location", "base64", "complexvalue"]);
  const fields = meta.fields.filter((f) => !skip.has((f.type || "").toLowerCase()));
  const names = fields.map((f) => f.name);
  const labels = {}; fields.forEach((f) => { labels[f.name] = f.label || f.name; });

  // SOQL caps query length, so select in chunks and merge the single record.
  const record = {};
  for (let i = 0; i < names.length; i += 150) {
    const chunk = names.slice(i, i + 150);
    const soql = `SELECT ${chunk.join(", ")} FROM Opportunity WHERE Id = '${escapeId(opportunityId)}' LIMIT 1`;
    const r = await conn.query(soql);
    if (r.records.length) Object.assign(record, r.records[0]);
  }
  const populated = {};
  for (const name of names) {
    const v = record[name];
    if (v != null && v !== "" && name !== "attributes") populated[labels[name]] = v;
  }
  return populated;
}

// ---- helpers ----
const get = (rec, path) => {
  if (!rec || !path) return undefined;
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), rec);
};
const escapeId = (s) => String(s).replace(/'/g, "\\'");
const toInt = (v) => (v == null || v === "" ? null : parseInt(v, 10));
const toBool = (v, dflt) => (v == null ? dflt : v === true || v === "true" || v === 1);
const pct = (v) => (v == null || v === "" ? 0 : Number(v) / 100);
const parseList = (v) => (v ? String(v).split(/\r?\n|;|,/).map((s) => s.trim()).filter(Boolean) : []);
const formatMoney = (v) => (v == null ? "" : `$${Number(v).toLocaleString("en-US")}`);
const joinDuration = (val, unit) => [val, unit].filter(Boolean).join(" ").trim();
function formatDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

module.exports = { getDeal, readAllOpportunityFields, mapToDeal, connection };
