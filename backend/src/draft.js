// draft.js -- uses the Platform (Anthropic API) to DRAFT the proposal content from every
// populated Salesforce field on the Opportunity (standard, custom, MEDDPICC, Proposals
// section). The draft is returned to the screen for the rep to review and edit before
// generating. This is the only AI step; pricing and the agreement stay deterministic.
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

async function composeProposalDraft(fields, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set; the AI draft needs it.");
  }
  const client = new Anthropic();
  const system =
    "You draft Maneva sales proposals from Salesforce data. Maneva sells AI vision inspection " +
    "for manufacturing. Return ONLY valid JSON (no prose, no markdown fences) matching exactly:\n" +
    '{ "executive_summary": string,\n' +
    '  "suggested_term_months": integer,\n' +
    '  "sku_application": string,\n' +
    '  "applications": [ { "name": string, "problem": string, "solution": string,\n' +
    '     "inspection_points": [string], "before_after": [[string, string]],\n' +
    '     "hardware": [[string, string, string]],\n' +   // Item, Qty, Description
    '     "preventative_benefits": [string], "upside_benefits": [string],\n' +
    '     "assumptions": [string], "timeline": [string], "risks": [[string, string]] } ] }\n' +
    "Ground every sentence in the provided Salesforce fields. Use the pain / 'Identify Pain' " +
    "fields for the Problem Statement, the Metrics / success fields for benefits and ROI framing, " +
    "the decision-criteria and competition fields to sharpen the solution and risks. Do NOT invent " +
    "specific numbers, dates, or metrics that the fields do not support; where a detail is unknown, " +
    "write a sensible general statement instead of a fabricated figure. Do NOT put any price, " +
    "monthly fee, ARR, or subscription number in the body (the price comes from the calculator). " +
    "Use the customer COMPANY name only; never invent individual names, quotes, emails, or phones. " +
    "Produce one application unless the fields clearly describe several. Keep it concrete and concise. " +
    "Fields prefixed 'Account:' are company-level facts about the customer (industry, size, location); use them for context. " +
    "For suggested_term_months, infer the contract length in whole months from any term, contract-length, or " +
    "subscription-period signal on the Opportunity or Account; if there is no clear signal, use 12. " +
    "For sku_application, read the application use-case field (which is usually a long description) and " +
    "distill what the application DOES into ONE word, two words at most, suitable for a product code " +
    "(for example 'Labeling', 'WeldInspect', 'FillLevel'). Never more than two words.";
  const user =
    "Customer: " + (opts.customer || "") + "\n" +
    "Currency for any contextual figures: " + (opts.currency || "USD") + "\n\n" +
    "Salesforce fields (populated only, label: value):\n" +
    JSON.stringify(fields, null, 2) + "\n\n" +
    "Draft the proposal JSON now.";

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = (resp.content || [])
    .filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const clean = text
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new Error("The draft model did not return valid JSON. Raw start: " + clean.slice(0, 200));
  }
}

module.exports = { composeProposalDraft };
