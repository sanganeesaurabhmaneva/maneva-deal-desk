// server.js -- Deal Desk backend API.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const pricing = require("./pricing");
const generate = require("./generate");
const auth = require("./auth");

const app = express();
app.use(express.json({ limit: "40mb" })); // room for base64 photos
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// --- per-rep sign-in (public) ---
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await auth.login(email, password);
    if (!result) return res.status(401).json({ error: "Wrong email or password." });
    res.json(result); // { token, user }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Everything below requires a signed-in rep.
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/api/login") return next();
  if (!req.path.startsWith("/api/")) return next(); // static assets
  return auth.requireAuth(req, res, next);
});

// Live pricing for the frontend calculator (no Salesforce needed).
app.post("/api/price", (req, res) => {
  try {
    const p = pricing.price(req.body || {});
    const r = req.body.roi ? pricing.roi({ monthlyCost: p.mrr, ...req.body.roi }) : null;
    res.json({ pricing: p, roi: r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Fetch a deal from Salesforce and return it + a pricing preview.
app.get("/api/opportunity/:id", async (req, res) => {
  try {
    const sf = require("./salesforce"); // lazy require so the server boots without SF creds
    const deal = await sf.getDeal(req.params.id);
    const preview = pricing.price({
      tier: deal.pricing.tier, lines: deal.pricing.lines, annual: deal.pricing.annual,
      customDiscount: deal.pricing.customDiscount, activities: deal.pricing.activities,
      currency: deal.pricing.currency,
    });
    res.json({ deal, pricing: preview });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Generate the MSA (+ Order Form). Accepts either:
//   { opportunityId, choices }              -> pull the deal from Salesforce, or
//   { deal, choices }                       -> use a deal object sent by the client
// Read the Opportunity, pull EVERY populated field, and AI-draft the proposal from them.
// Returns { deal, pricing, draft } so the screen can pre-fill and let the rep review/edit.
app.post("/api/draft", async (req, res) => {
  try {
    const id = req.body.opportunityId;
    if (!id) return res.status(400).json({ error: "provide opportunityId" });
    const sf = require("./salesforce");
    const deal = await sf.getDeal(id);
    const cur = (deal.pricing && deal.pricing.currency) || deal.currency || "USD";
    const preview = pricing.price({
      tier: deal.pricing.tier, lines: deal.pricing.lines, annual: deal.pricing.annual,
      customDiscount: deal.pricing.customDiscount, activities: deal.pricing.activities, currency: cur,
    });
    let draft = null, draftError = null;
    try {
      const fields = await sf.readAllOpportunityFields(id);
      draft = await require("./draft").composeProposalDraft(fields, { customer: deal.customer_legal_name, currency: cur });
    } catch (e) {
      draftError = e.message; // the deal still loads; the rep can fill the proposal manually
    }
    res.json({ deal, pricing: preview, draft, draftError });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
// Conditions) with the proposal under Appendix 1. Accepts:
//   { deal | opportunityId, choices, proposal, photos }
//   proposal = { executive_summary, applications:[...] } typed by the rep
//   photos   = [{ label, application?, dataUrl }]  (base64 data URLs)
function savePhotos(photos, dir) {
  const out = [];
  (photos || []).forEach((ph, i) => {
    const m = /^data:(image\/[a-z.+-]+);base64,(.+)$/i.exec(ph.dataUrl || "");
    if (!m) return;
    const ext = (m[1].split("/")[1] || "png").replace("jpeg", "jpg").split("+")[0];
    const file = path.join(dir, `photo_${Date.now()}_${i}.${ext}`);
    fs.writeFileSync(file, Buffer.from(m[2], "base64"));
    out.push({ label: ph.label || "", application: ph.application, path: file });
  });
  return out;
}

app.post("/api/generate", async (req, res) => {
  const cleanup = [];
  try {
    let deal = req.body.deal;
    if (!deal && req.body.opportunityId) {
      const sf = require("./salesforce");
      deal = await sf.getDeal(req.body.opportunityId);
    }
    if (!deal) return res.status(400).json({ error: "provide either opportunityId or deal" });

    const choices = req.body.choices || {};
    const proposal = req.body.proposal ? { ...req.body.proposal } : null;
    if (proposal) {
      const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "dd-photos-"));
      cleanup.push(tmpDir);
      proposal.photos = savePhotos(req.body.photos, tmpDir);
      choices.proposal = proposal;
    }

    const result = await generate.generateDocument(deal, choices);
    if (req.query.json) {
      return res.json({ pricing: result.pricing, file: path.basename(result.file) });
    }
    res.download(result.file, path.basename(result.file));
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    // best-effort cleanup of temp photo dirs after the response is sent
    res.on("finish", () => cleanup.forEach((d) => fs.rm(d, { recursive: true, force: true }, () => {})));
  }
});

// Preview: build the same document, but return it rendered as HTML for an in-app popup
// instead of downloading the file. Lets the rep eyeball it before generating.
app.post("/api/preview", async (req, res) => {
  const cleanup = [];
  try {
    let deal = req.body.deal;
    if (!deal && req.body.opportunityId) {
      const sf = require("./salesforce");
      deal = await sf.getDeal(req.body.opportunityId);
    }
    if (!deal) return res.status(400).json({ error: "provide either opportunityId or deal" });

    const choices = req.body.choices || {};
    const proposal = req.body.proposal ? { ...req.body.proposal } : null;
    if (proposal) {
      const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "dd-photos-"));
      cleanup.push(tmpDir);
      proposal.photos = savePhotos(req.body.photos, tmpDir);
      choices.proposal = proposal;
    }
    const result = await generate.generateDocument(deal, choices);
    const mammoth = require("mammoth");
    const conv = await mammoth.convertToHtml({ path: result.file });
    try { fs.unlinkSync(result.file); } catch (_) {}
    res.json({ html: conv.value || "" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    res.on("finish", () => cleanup.forEach((d) => fs.rm(d, { recursive: true, force: true }, () => {})));
  }
});

// Serve the built frontend if present (single-service deploy option).
const FRONTEND = path.join(__dirname, "..", "public");
if (fs.existsSync(FRONTEND)) app.use(express.static(FRONTEND));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Deal Desk backend listening on :${PORT}`));
