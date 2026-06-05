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

// Convert a .docx to .pdf with LibreOffice so the preview matches the Word file exactly.
function docxToPdf(docxPath) {
  return new Promise((resolve, reject) => {
    const { execFile } = require("child_process");
    const outDir = path.dirname(docxPath);
    const soffice = process.env.SOFFICE_BIN || "soffice";
    execFile(
      soffice,
      ["--headless", "--norestore", "--nolockcheck",
       "-env:UserInstallation=file:///tmp/lo_profile",
       "--convert-to", "pdf:writer_pdf_Export", "--outdir", outDir, docxPath],
      { timeout: 120000 },
      (err, _stdout, stderr) => {
        if (err) return reject(new Error("PDF render failed: " + (stderr || err.message)));
        const pdf = docxPath.replace(/\.docx$/i, ".pdf");
        if (!fs.existsSync(pdf)) return reject(new Error("PDF was not produced"));
        resolve(pdf);
      }
    );
  });
}

// Preview: build the real document, render it to a PDF, and return that PDF so the popup
// looks exactly like the downloaded Word file. If the renderer fails (e.g. the server is
// low on memory), fall back to a simplified HTML view so preview never hard-fails.
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

    try {
      const pdf = await docxToPdf(result.file);
      const buf = fs.readFileSync(pdf);
      try { fs.unlinkSync(result.file); fs.unlinkSync(pdf); } catch (_) {}
      res.setHeader("Content-Type", "application/pdf");
      return res.send(buf);
    } catch (convErr) {
      // Graceful fallback so the rep still sees content on a low-memory host.
      const mammoth = require("mammoth");
      const conv = await mammoth.convertToHtml({ path: result.file });
      try { fs.unlinkSync(result.file); } catch (_) {}
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Preview-Degraded", "1");
      return res.send(conv.value || "<p>(nothing to preview)</p>");
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    res.on("finish", () => cleanup.forEach((d) => fs.rm(d, { recursive: true, force: true }, () => {})));
  }
});

// ---- Approval & review routing ----
const APPROVAL_FLOW_URL = process.env.APPROVAL_FLOW_URL || "";
// AEs whose SVP approval routes to the primary SVP (Ben Coulombe).
// Everyone else routes to the secondary SVP (Osvaldo Granillo).
const SVP_PRIMARY_AES = [
  "michael wiora", "april rachjgot", "susan chen", "faith hruska", "christian tubbs",
  "remii rivers", "jeff nasser", "caam finch", "stephen temple",
];
function approvalRecipient(type, aeName) {
  const n = String(aeName || "").trim().toLowerCase();
  if (type === "revops") return process.env.APPROVAL_REVOPS_EMAIL || "";     // RevOps (Saurabh Sanganee)
  if (type === "legal") return process.env.APPROVAL_LEGAL_EMAIL || "";       // Legal (Artem Chaykovskyy)
  if (type === "svp") {
    return SVP_PRIMARY_AES.includes(n)
      ? (process.env.APPROVAL_SVP_PRIMARY_EMAIL || "")    // listed AEs -> Ben Coulombe
      : (process.env.APPROVAL_SVP_SECONDARY_EMAIL || ""); // everyone else -> Osvaldo Granillo
  }
  return "";
}
const APPROVAL_LABEL = { revops: "RevOps Approval", svp: "SVP Approval", legal: "Legal Review" };

// Build the combined document, then hand it (with the rep's pre-flight answers) to the
// Microsoft flow that sends the Teams message and the email to the right person.
app.post("/api/approve", async (req, res) => {
  const cleanup = [];
  try {
    const approval = req.body.approval || {};
    const type = approval.type;
    if (!APPROVAL_LABEL[type]) return res.status(400).json({ error: "Unknown approval type." });

    const aeName = (req.user && req.user.name) || "";
    const recipient = approvalRecipient(type, aeName);
    if (!APPROVAL_FLOW_URL || !recipient) {
      return res.status(503).json({ error: "Approval routing isn't connected yet. Ask IT to set up the Teams/email flow and the recipient addresses." });
    }

    let deal = req.body.deal;
    if (!deal && req.body.opportunityId) { const sf = require("./salesforce"); deal = await sf.getDeal(req.body.opportunityId); }
    if (!deal) return res.status(400).json({ error: "Provide a deal (load an opportunity first)." });

    const choices = { ...(req.body.choices || {}), mode: "combined" };
    const proposal = req.body.proposal ? { ...req.body.proposal } : null;
    if (proposal) {
      const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "dd-photos-"));
      cleanup.push(tmpDir);
      proposal.photos = savePhotos(req.body.photos, tmpDir);
      choices.proposal = proposal;
    }
    const result = await generate.generateDocument(deal, choices);
    const fileBuf = fs.readFileSync(result.file);
    const fileName = path.basename(result.file);
    try { fs.unlinkSync(result.file); } catch (_) {}

    const customer = deal.customer_legal_name || "the customer";
    const a = approval.answers || {};
    const qa = [
      ["How long is the pilot period?", a.pilot_period],
      ["Will the customer have an opt-out at the pilot period end date?", a.opt_out],
      ["Who is installing the hardware?", a.hardware_installer],
      ["Have we talked about implementation fees?", a.implementation_fees],
      ["How many expansion lines / expansion pricing?", a.expansion],
    ].map(([q, ans]) => `- ${q}\n  ${ans && String(ans).trim() ? String(ans).trim() : "(not answered)"}`).join("\n");

    const subject = `${APPROVAL_LABEL[type]} requested - ${customer}`;
    const body =
`${APPROVAL_LABEL[type]} has been requested by ${aeName} for ${customer}.
Discount approval status: ${result.pricing.approvalRequired}.

Pre-flight questions:
${qa}

The combined Service Agreement and proposal is attached.`;

    const flowRes = await fetch(APPROVAL_FLOW_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approvalType: type, requestedBy: aeName, customer,
        recipientEmail: recipient, subject, body,
        fileName, fileContentBase64: fileBuf.toString("base64"),
      }),
    });
    if (!flowRes.ok) {
      const tx = await flowRes.text().catch(() => "");
      return res.status(502).json({ error: "The notification service rejected the request: " + (tx || flowRes.status) });
    }
    res.json({ message: `${APPROVAL_LABEL[type]} sent, with the document and your answers.` });
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
