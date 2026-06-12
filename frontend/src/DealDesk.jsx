import React, { useState, useMemo, useEffect } from "react";
import {
  Factory, Calculator, FileText, ShieldCheck, TrendingUp, AlertTriangle,
  Plug, Check, Layers, Sparkles, ChevronRight, ArrowRight, Lock, Image as ImageIcon,
  HelpCircle, Send, Scale
} from "lucide-react";

/* ============================================================
   PRICING ENGINE  (ported 1:1 from maneva_pricing_calculator.xlsx)
   Pure math. Same numbers the spreadsheet produces.
   ============================================================ */
const RATE_TABLE = {
  standard:     [null,1500,1250,1100,1050,950,900,850,800,750,700,650,600,550,550,500],
  professional: [null,4000,3350,3050,2850,2650,2500,2350,2250,2100,2000,1900,1800,1700,1600,1500],
  enterprise:   [null,6000,5200,4850,4600,4400,4200,4050,3900,3750,3600,3450,3350,3200,3100,3000],
};
const FLOOR = { standard: 500, professional: 1500, enterprise: 3000 };

// Currency: base rates are USD. 0.72 is the CAD->USD rate, so CAD = USD / 0.72 (CAD higher).
const CAD_TO_USD = 0.72;

function quote(tier, lines, billing, activityCount, customPctRaw, currency, customDollarRaw) {
  const floor = FLOOR[tier];
  const customPricing = lines > 15;
  const idx = Math.min(Math.max(lines, 1), 15);
  const base = RATE_TABLE[tier][idx];
  const fx = String(currency).toUpperCase() === "CAD" ? (1 / CAD_TO_USD) : 1;
  const curName = fx !== 1 ? "CAD" : "USD";
  const cardPerLine = base * fx; // rate-card per-line price in the displayed currency (already volume-adjusted)

  const activityPct = Math.min(activityCount * 0.05, 0.20);

  // The custom discount can be entered as a % OR as a target $ per line per month.
  // If a $ amount is given, it wins and we back out the % from the rate-card price.
  const customDollar = Number(customDollarRaw) || 0;
  let cp;
  if (customDollar > 0) {
    cp = cardPerLine > 0 ? 1 - customDollar / cardPerLine : 0;
    if (cp < 0) cp = 0; // entered at or above rate card -> treat as no discount
  } else {
    cp = Number(customPctRaw) || 0;
    if (cp > 1) cp = cp / 100;
  }
  cp = Math.round(cp * 10000) / 10000; // avoid floating-point dust right at the approval thresholds

  const totalPct = activityPct + cp;
  const discounted = base * (1 - totalPct);
  const finalUsd = Math.max(discounted, floor);
  const floorTriggered = discounted < floor;
  const finalRate = finalUsd * fx;
  const mrr = finalRate * lines;
  const arr = mrr * 12;
  const billed = billing === "annual" ? arr : mrr;
  const savingsVsCard = (cardPerLine - finalRate) * lines * 12;
  let approval, tone;
  if (totalPct < 0.10) { approval = "No approval needed"; tone = "ok"; }
  else if (totalPct < 0.20) { approval = "RevOps approval"; tone = "warn"; }
  else { approval = "RevOps + SVP approval"; tone = "stop"; }
  return { base: cardPerLine, floor: floor * fx, currency: curName, activityPct, customPct: cp,
    totalPct, discounted: discounted * fx, finalRate, floorTriggered, mrr, arr, billed,
    savingsVsCard, approval, tone, customPricing, cardPerLine, customDollar };
}

/* ---------- helpers ---------- */
const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
const usd2 = (n) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (n) => (n * 100).toFixed(0) + "%";
const curSym = (c) => (String(c).toUpperCase() === "CAD" ? "CA$" : "$");
const money = (n, c) => curSym(c) + Math.round(n).toLocaleString("en-US");

/* ---------- backend wiring ---------- */
const API_BASE = (import.meta.env && import.meta.env.VITE_API_BASE) || "";
const TIER_FROM_SF = { Standard: "standard", Professional: "professional", Enterprise: "enterprise" };
const TIER_TO_SF = { standard: "Standard", professional: "Professional", enterprise: "Enterprise" };
const TIER_ABBR = { standard: "STD", professional: "PRO", enterprise: "ENT" };

// SKU = <APPLICATION>-<TIER>-<N>L, e.g. LABEL-PRO-3L. Application comes from the AI (1-2 words),
// tier and lines come from the calculator. Returns "" if there is no application code yet.
function buildSku(appWord, tier, lines) {
  const app = String(appWord || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (!app) return "";
  return `${app}-${TIER_ABBR[tier] || "STD"}-${Math.max(1, lines || 1)}L`;
}

const TIERS = [
  { id: "standard", label: "Standard", sub: "Low complexity" },
  { id: "professional", label: "Professional", sub: "Medium complexity" },
  { id: "enterprise", label: "Enterprise", sub: "High complexity" },
];
const ACTIVITIES = [
  { id: "referral", label: "Customer referral" },
  { id: "logo", label: "Logo rights" },
  { id: "case", label: "Case study" },
  { id: "video", label: "Video testimonial" },
];

// --- session persistence: keep the rep logged in across refreshes, but log out
// automatically after 30 minutes of no activity. ---
const SESSION_KEY = "dd_session";
const IDLE_MS = 30 * 60 * 1000; // 30 minutes
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (!s || !s.token) return null;
    if (Date.now() - (s.last || 0) > IDLE_MS) { localStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch { return null; }
}
function saveSession(token, user) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token, user, last: Date.now() })); } catch {}
}
function touchSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (s && s.token) { s.last = Date.now(); localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
  } catch {}
}
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch {} }

export default function DealDesk() {
  // per-rep sign-in (restored from a saved session if one is still active)
  const [token, setToken] = useState(() => loadSession()?.token || "");
  const [me, setMe] = useState(() => loadSession()?.user || null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const [customer, setCustomer] = useState("Northwind Foods Inc.");
  const [tier, setTier] = useState("professional");
  const [lines, setLines] = useState(3);
  const [billing, setBilling] = useState("annual");
  const [currency, setCurrency] = useState("USD");
  const [acts, setActs] = useState({});
  const [custom, setCustom] = useState(0);
  const [customDollar, setCustomDollar] = useState(""); // target $ per line per month (optional)
  const [discountMode, setDiscountMode] = useState("pct"); // which field drives: "pct" | "dollar"
  const [annualSavings, setAnnualSavings] = useState(300000);
  const [revenueProtected, setRevenueProtected] = useState(2000000);
  const [generated, setGenerated] = useState(false);

  // backend-connected state
  const [oppId, setOppId] = useState("");
  const [loadedDeal, setLoadedDeal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(null); // mode currently generating
  const [previewing, setPreviewing] = useState(null); // mode currently previewing
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewMode, setPreviewMode] = useState("pdf");
  const [previewDegraded, setPreviewDegraded] = useState(false);
  const [status, setStatus] = useState(null); // { type: 'ok'|'err', msg }
  // decisions not stored in Salesforce
  const [provision, setProvision] = useState("default");
  const [procurement, setProcurement] = useState("purchase");
  const [installTimeline, setInstallTimeline] = useState("two to three weeks");
  const [endPhase1, setEndPhase1] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");      // agreement date; blank -> today at generate
  const [billingStartDate, setBillingStartDate] = useState("");
  const [contractTerm, setContractTerm] = useState(12);        // months; AI suggests, rep confirms
  const [expansionKpis, setExpansionKpis] = useState("");
  const [skuApplication, setSkuApplication] = useState("");    // 1-2 word app code from AI; rep can edit
  const [hardware, setHardware] = useState([{ item: "", qty: "", description: "", cost: "" }]);

  // proposal content the rep types in (goes under Appendix 1)
  const [execSummary, setExecSummary] = useState("");
  const [appName, setAppName] = useState("");
  const [problem, setProblem] = useState("");
  const [solution, setSolution] = useState("");
  const [inspection, setInspection] = useState("");        // one per line
  const [beforeAfter, setBeforeAfter] = useState([{ before: "", after: "" }]);
  const [preventative, setPreventative] = useState("");    // one per line
  const [upside, setUpside] = useState("");                // one per line
  const [assumptions, setAssumptions] = useState("");      // one per line
  const [propTimeline, setPropTimeline] = useState("");    // one per line
  const [risks, setRisks] = useState([{ risk: "", mitigation: "" }]);
  const [photos, setPhotos] = useState([]);                // [{label, dataUrl, name}]

  // pre-flight questions (go into the approval Teams message + email, not the document)
  const [qPilot, setQPilot] = useState("");
  const [qOptOut, setQOptOut] = useState("");
  const [qInstaller, setQInstaller] = useState("");
  const [qImplFees, setQImplFees] = useState("");
  const [qExpansion, setQExpansion] = useState("");

  // approval / review sending
  const [approving, setApproving] = useState(null);        // "revops" | "svp" | "legal"
  const [approvalStatus, setApprovalStatus] = useState(null);

  const authHeaders = () => ({
    "Content-Type": "application/json",
    ...(token ? { Authorization: "Bearer " + token } : {}),
  });

  // If the server ever rejects our token (expired or server restarted), sign out cleanly.
  function check401(res) {
    if (res.status === 401) { logout(); throw new Error("Your session expired. Please sign in again."); }
    return res;
  }

  async function login() {
    if (!email.trim() || !password) { setLoginError("Enter your email and password."); return; }
    setLoggingIn(true); setLoginError("");
    try {
      const res = await fetch(API_BASE + "/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || ("Sign-in failed (" + res.status + ")"));
      saveSession(j.token, j.user);
      setToken(j.token); setMe(j.user); setPassword("");
    } catch (e) { setLoginError(e.message); }
    finally { setLoggingIn(false); }
  }
  function logout() { setToken(""); setMe(null); setStatus(null); clearSession(); }

  // Stay signed in while the rep is active; auto sign-out after 30 minutes idle.
  useEffect(() => {
    if (!token) return;
    let timer;
    let lastTouch = 0;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(logout, IDLE_MS);
      const now = Date.now();
      if (now - lastTouch > 20000) { lastTouch = now; touchSession(); }
    };
    const events = ["mousedown", "keydown", "scroll", "touchstart", "click", "mousemove"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    const onVisible = () => {
      if (document.visibilityState === "visible" && !loadSession()) logout();
      else if (document.visibilityState === "visible") reset();
    };
    document.addEventListener("visibilitychange", onVisible);
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token]);

  const activeActs = Object.values(acts).filter(Boolean).length;
  const q = useMemo(() => quote(tier, Math.max(1, lines || 1), billing, activeActs, custom, currency,
    discountMode === "dollar" ? customDollar : ""),
    [tier, lines, billing, activeActs, custom, currency, customDollar, discountMode]);
  const FX = currency === "CAD" ? (1 / CAD_TO_USD) : 1;
  const sku = buildSku(skuApplication, tier, Math.max(1, lines || 1));

  const annualCost = q.arr;
  const netValue = annualSavings - annualCost;
  const paybackMonths = annualSavings > 0 ? (annualCost / annualSavings) * 12 : null;
  const ratio = annualCost > 0 ? annualSavings / annualCost : 0;

  const toneColor = { ok: "var(--good)", warn: "var(--amber)", stop: "var(--stop)" };

  const arrToLines = (a) => (Array.isArray(a) ? a.join("\n") : (a || ""));

  function applyDraft(draft, deal) {
    const app = (draft && draft.applications && draft.applications[0]) || {};
    if (draft && draft.executive_summary) setExecSummary(draft.executive_summary);
    if (draft && Number(draft.suggested_term_months)) setContractTerm(Number(draft.suggested_term_months));
    if (draft && draft.sku_application) setSkuApplication(draft.sku_application);
    if (app.name) setAppName(app.name);
    if (app.problem) setProblem(app.problem);
    if (app.solution) setSolution(app.solution);
    if (app.inspection_points) setInspection(arrToLines(app.inspection_points));
    if (app.before_after && app.before_after.length)
      setBeforeAfter(app.before_after.map((r) => ({ before: r[0] || "", after: r[1] || "" })));
    if (app.preventative_benefits) setPreventative(arrToLines(app.preventative_benefits));
    if (app.upside_benefits) setUpside(arrToLines(app.upside_benefits));
    if (app.assumptions) setAssumptions(arrToLines(app.assumptions));
    if (app.timeline) setPropTimeline(arrToLines(app.timeline));
    if (app.risks && app.risks.length)
      setRisks(app.risks.map((r) => ({ risk: r[0] || "", mitigation: r[1] || "" })));
    // hardware: merge the draft's Item/Qty/Description with any costs from Salesforce
    if (app.hardware && app.hardware.length) {
      const costs = (deal && deal.hardware) || [];
      setHardware(app.hardware.map((h, i) => ({
        item: h[0] || "", qty: h[1] || "", description: h[2] || "",
        cost: (costs[i] && costs[i].cost) || "",
      })));
    }
  }

  async function loadOpportunity() {
    if (!oppId.trim()) { setStatus({ type: "err", msg: "Enter a Salesforce Opportunity ID first." }); return; }
    setLoading(true); setStatus(null);
    try {
      const res = await fetch(API_BASE + "/api/draft", {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ opportunityId: oppId.trim() }),
      });
      check401(res);
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || ("Load failed (" + res.status + ")")); }
      const data = await res.json();
      const d = data.deal || {};
      setLoadedDeal(d);
      if (d.customer_legal_name) setCustomer(d.customer_legal_name);
      if (d.pricing) {
        if (d.pricing.tier) setTier(TIER_FROM_SF[d.pricing.tier] || "professional");
        if (d.pricing.lines) setLines(d.pricing.lines);
        setBilling(d.pricing.annual ? "annual" : "monthly");
        if (d.pricing.currency) setCurrency(String(d.pricing.currency).toUpperCase() === "CAD" ? "CAD" : "USD");
        if (typeof d.pricing.customDiscount === "number") setCustom(Math.round(d.pricing.customDiscount * 100));
        const a = d.pricing.activities || {};
        setActs({ referral: !!a.customerReferral, logo: !!a.logoRights, case: !!a.caseStudy, video: !!a.videoTestimonial });
      }
      if (d.hardware && d.hardware.length) setHardware(d.hardware.map((h) => ({ item: h.item || h.name || "", qty: h.qty || "", description: h.description || "", cost: h.cost || "" })));

      if (data.draft) {
        applyDraft(data.draft, d);
        setStatus({ type: "ok", msg: "Loaded " + (d.customer_legal_name || "opportunity") + " and drafted the proposal from Salesforce. Review and edit below, then generate." });
      } else {
        setStatus({ type: data.draftError ? "err" : "ok", msg: data.draftError
          ? ("Loaded the deal, but the AI draft did not run (" + data.draftError + "). You can fill the proposal manually.")
          : ("Loaded " + (d.customer_legal_name || "opportunity") + " from Salesforce.") });
      }
    } catch (e) { setStatus({ type: "err", msg: e.message }); }
    finally { setLoading(false); }
  }

  async function downloadDoc(path, body, filename, label) {
    const res = await fetch(API_BASE + path, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
    check401(res);
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error((label ? label + ": " : "") + (j.error || ("failed (" + res.status + ")"))); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  const linesToArr = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);

  function buildGenerateBody(mode = "combined") {
    const hw = hardware.filter((h) => h.item || h.name);
    const deal = {
      ...(loadedDeal || {}),
      customer_legal_name: customer,
      term_months: Number(contractTerm) || 12,
      billing_start_date: billingStartDate || "",
      effective_date: effectiveDate || "",
      expansion_kpis: expansionKpis || "",
      skus: sku,
      pricing: {
        tier: TIER_TO_SF[tier], lines: Math.max(1, lines || 1), annual: billing === "annual",
        customDiscount: q.customPct, currency,
        activities: { customerReferral: !!acts.referral, logoRights: !!acts.logo, caseStudy: !!acts.case, videoTestimonial: !!acts.video },
      },
      hardware: hw.map((h) => ({ name: h.item || h.name, cost: h.cost })),
    };
    const choices = { mode, hardware: { provision, procurement }, install_timeline: installTimeline, end_phase1_date: endPhase1 };
    const proposal = {
      executive_summary: execSummary,
      applications: [{
        name: appName || "Application",
        problem, solution,
        inspection_points: linesToArr(inspection),
        before_after: beforeAfter.filter((r) => r.before || r.after).map((r) => [r.before, r.after]),
        hardware: hw.map((h) => [h.item || h.name, h.qty, h.description]),
        impact: { total_annual_value: Number(annualSavings) || undefined },
        preventative_benefits: linesToArr(preventative),
        upside_benefits: linesToArr(upside),
        assumptions: linesToArr(assumptions),
        timeline: linesToArr(propTimeline),
        risks: risks.filter((r) => r.risk || r.mitigation).map((r) => [r.risk, r.mitigation]),
      }],
    };
    return { deal, choices, proposal, photos };
  }

  const DOC_SLUG = { agreement: "Service_Agreement", proposal: "Proposal", combined: "Service_Agreement_and_Proposal" };

  async function generateDocuments(mode = "combined") {
    setGenerating(mode); setStatus(null);
    try {
      const safe = (customer || "customer").replace(/[^a-z0-9]+/gi, "_");
      const slug = DOC_SLUG[mode] || "Document";
      // Version is remembered per deal AND per document type in this browser.
      const verKey = "ddver:" + (oppId.trim() || safe || "deal") + ":" + mode;
      const nextV = (parseInt(localStorage.getItem(verKey) || "0", 10) || 0) + 1;
      const d = new Date();
      const dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      const filename = "Maneva_-_" + safe + "_-_" + slug + "_-_" + dateStr + "_V" + nextV + ".docx";
      setStatus({ type: "ok", msg: "Generating " + filename + " (" + currency + ")..." });
      await downloadDoc("/api/generate", buildGenerateBody(mode), filename, "Document");
      try { localStorage.setItem(verKey, String(nextV)); } catch {}
      setGenerated(true);
      setStatus({ type: "ok", msg: "Generated and downloaded " + filename });
    } catch (e) { setStatus({ type: "err", msg: e.message }); }
    finally { setGenerating(null); }
  }

  async function previewDocument(mode = "combined") {
    setPreviewing(mode); setStatus(null);
    try {
      if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(""); }
      const res = await fetch(API_BASE + "/api/preview", {
        method: "POST", headers: authHeaders(), body: JSON.stringify(buildGenerateBody(mode)),
      });
      check401(res);
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || ("Preview failed (" + res.status + ")")); }
      const ctype = res.headers.get("content-type") || "";
      if (ctype.includes("application/pdf")) {
        const blob = await res.blob();
        setPreviewUrl(URL.createObjectURL(blob));
        setPreviewMode("pdf");
        setPreviewDegraded(false);
      } else {
        // HTML fallback. Also tolerate an older engine that replies with {"html":"..."} JSON,
        // so the popup never shows raw JSON text.
        const text = await res.text();
        let html = text;
        if (ctype.includes("application/json") || /^\s*\{/.test(text)) {
          try { const j = JSON.parse(text); if (j && typeof j.html === "string") html = j.html; } catch {}
        }
        setPreviewHtml(html || "<p>(nothing to preview)</p>");
        setPreviewMode("html");
        setPreviewDegraded(true);
      }
      setPreviewOpen(true);
    } catch (e) { setStatus({ type: "err", msg: e.message }); }
    finally { setPreviewing(null); }
  }

  function closePreview() {
    setPreviewOpen(false);
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(""); }
  }

  async function sendApproval(type) {
    setApproving(type); setApprovalStatus(null);
    try {
      const body = buildGenerateBody("combined"); // approvals always send the combined document
      body.approval = {
        type,
        answers: {
          pilot_period: qPilot, opt_out: qOptOut, hardware_installer: qInstaller,
          implementation_fees: qImplFees, expansion: qExpansion,
        },
      };
      const res = await fetch(API_BASE + "/api/approve", {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      check401(res);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || ("Request failed (" + res.status + ")"));
      setApprovalStatus({ type: "ok", msg: j.message || "Sent." });
    } catch (e) { setApprovalStatus({ type: "err", msg: e.message }); }
    finally { setApproving(null); }
  }

  function addPhotos(fileList) {
    Array.from(fileList || []).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => setPhotos((ps) => [...ps, { label: file.name.replace(/\.[^.]+$/, ""), dataUrl: reader.result, name: file.name }]);
      reader.readAsDataURL(file);
    });
  }

  // ---------- sign-in gate ----------
  if (!token) {
    return (
      <div className="login-screen">
        <style>{CSS}</style>
        <div className="login-card">
          <div className="login-logo">
            <div className="login-mark"><Factory size={20} /></div>
            <div>
              <div className="login-title">MANEVA <span style={{ color: "var(--amber)" }}>/</span> Deal Desk</div>
              <div className="login-sub">Sign in to continue</div>
            </div>
          </div>
          <label className="login-l">Email</label>
          <input className="login-in" type="email" autoComplete="username" value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") login(); }} placeholder="you@maneva.ai" />
          <label className="login-l">Password</label>
          <input className="login-in" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") login(); }} placeholder="••••••••" />
          {loginError && <div className="login-err">{loginError}</div>}
          <button className="login-btn" onClick={login} disabled={loggingIn}>
            {loggingIn ? "Signing in…" : "Sign in"}
          </button>
          <div className="login-foot">Each rep has their own login. Ask your admin if you need access.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "var(--body)", background: "var(--paper)", color: "var(--ink)",
      minHeight: "100vh", padding: "0 0 64px" }}>
      <style>{CSS}</style>

      {/* top bar */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 28px", borderBottom: "1px solid var(--line)", background: "var(--panel)",
        position: "sticky", top: 0, zIndex: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 34, height: 34, background: "var(--ink)", color: "var(--paper)",
            display: "grid", placeItems: "center", borderRadius: 7 }}>
            <Factory size={18} />
          </div>
          <div style={{ lineHeight: 1 }}>
            <div style={{ fontFamily: "var(--display)", fontWeight: 800, fontSize: 17, letterSpacing: "-0.02em" }}>
              MANEVA <span style={{ color: "var(--amber)" }}>/</span> Deal Desk
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 3, letterSpacing: "0.04em",
              textTransform: "uppercase" }}>Configure · Price · Quote</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="chip"><span className="dot" /> Salesforce connected</span>
          <input className="inp mono loadinp" placeholder="Opportunity ID" value={oppId}
            onChange={(e) => setOppId(e.target.value)} />
          <button className="ghost" onClick={loadOpportunity} disabled={loading}>
            {loading ? "Loading & drafting…" : <>Load &amp; draft from Salesforce <ChevronRight size={14} /></>}
          </button>
          <span className="who">{me && me.name}</span>
          <button className="ghost" onClick={logout} title="Sign out">Sign out</button>
        </div>
      </header>

      <div className="wrap">
        {/* ============ LEFT: INPUTS ============ */}
        <div className="col">
          <Panel icon={<Layers size={15} />} title="Deal" step="01">
            <Field label="Customer legal name">
              <input className="inp" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            </Field>
            <div className="row2">
              <Field label="Production lines in scope">
                <input className="inp mono" type="number" min={1} value={lines}
                  onChange={(e) => setLines(parseInt(e.target.value || "0", 10))} />
              </Field>
              <Field label="Billing">
                <div className="seg">
                  {["annual", "monthly"].map((b) => (
                    <button key={b} className={"seg-b" + (billing === b ? " on" : "")}
                      onClick={() => setBilling(b)}>{b[0].toUpperCase() + b.slice(1)}</button>
                  ))}
                </div>
              </Field>
              <Field label="Currency">
                <div className="seg">
                  {["USD", "CAD"].map((c) => (
                    <button key={c} className={"seg-b" + (currency === c ? " on" : "")}
                      onClick={() => setCurrency(c)}>{c}</button>
                  ))}
                </div>
              </Field>
            </div>
            <Field label="Complexity tier">
              <div className="tiers">
                {TIERS.map((t) => (
                  <button key={t.id} className={"tier" + (tier === t.id ? " on" : "")}
                    onClick={() => setTier(t.id)}>
                    <span className="tier-l">{t.label}</span>
                    <span className="tier-s">{t.sub}</span>
                    <span className="tier-p mono">{money(RATE_TABLE[t.id][1]*FX, currency)}<i>/line/mo</i></span>
                  </button>
                ))}
              </div>
            </Field>
          </Panel>

          <Panel icon={<Calculator size={15} />} title="Discount levers" step="02">
            <Field label="Activity discounts · 5% each, 20% cap">
              <div className="acts">
                {ACTIVITIES.map((a) => (
                  <button key={a.id} className={"act" + (acts[a.id] ? " on" : "")}
                    onClick={() => setActs((s) => ({ ...s, [a.id]: !s[a.id] }))}>
                    <span className="box">{acts[a.id] && <Check size={12} strokeWidth={3} />}</span>
                    {a.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Custom discount %">
              <input className="inp mono" type="number" min={0} max={100}
                value={discountMode === "dollar" ? (q.customPct > 0 ? +(q.customPct * 100).toFixed(1) : "") : custom}
                onChange={(e) => { setCustom(parseFloat(e.target.value || "0")); setDiscountMode("pct"); }} />
            </Field>
            <Field label="Custom discount $ (Add the per line per month value here)">
              <input className="inp mono" type="number" min={0} step={50}
                value={discountMode === "dollar" ? customDollar : (custom > 0 ? +(q.cardPerLine * (1 - q.customPct)).toFixed(2) : "")}
                onChange={(e) => { setCustomDollar(e.target.value); setDiscountMode("dollar"); }}
                placeholder="e.g., 3000" />
              {q.customPct > 0 && (
                <div className="hint-calc">
                  {money(q.cardPerLine, currency)}/line rate card · <b>{+(q.customPct * 100).toFixed(1)}% off</b> · {q.approval}
                </div>
              )}
            </Field>
          </Panel>

          <Panel icon={<TrendingUp size={15} />} title="Value drivers" step="03"
            note="Feeds the business case. The cost side comes straight from pricing.">
            <div className="row2">
              <Field label="Annual savings ($/yr)">
                <input className="inp mono" type="number" value={annualSavings}
                  onChange={(e) => setAnnualSavings(parseFloat(e.target.value || "0"))} />
              </Field>
              <Field label="Revenue protected ($)">
                <input className="inp mono" type="number" value={revenueProtected}
                  onChange={(e) => setRevenueProtected(parseFloat(e.target.value || "0"))} />
              </Field>
            </div>
          </Panel>

          <Panel icon={<ShieldCheck size={15} />} title="Agreement inputs" step="04"
            note="The few decisions not stored in Salesforce.">
            <div className="row2">
              <Field label="Hardware provision">
                <select className="inp" value={provision} onChange={(e) => setProvision(e.target.value)}>
                  <option value="default">Customer procures &amp; owns</option>
                  <option value="maneva">Maneva sources / owns (rental)</option>
                </select>
              </Field>
              <Field label="Procurement">
                <select className="inp" value={procurement} onChange={(e) => setProcurement(e.target.value)}>
                  <option value="purchase">Purchase (preferred vendors)</option>
                  <option value="procure">Procure (Maneva-recommended)</option>
                  <option value="rent">Rent through Maneva</option>
                </select>
              </Field>
            </div>
            <div className="row2">
              <Field label="Install timeline">
                <input className="inp" value={installTimeline} onChange={(e) => setInstallTimeline(e.target.value)} />
              </Field>
              <Field label="End of Phase 1 date">
                <input className="inp" placeholder="e.g. September 30, 2026" value={endPhase1}
                  onChange={(e) => setEndPhase1(e.target.value)} />
              </Field>
            </div>
            <div className="row2">
              <Field label="Effective date (agreement date; blank uses today)">
                <input className="inp" placeholder="e.g. June 2, 2026" value={effectiveDate}
                  onChange={(e) => setEffectiveDate(e.target.value)} />
              </Field>
              <Field label="Billing start date">
                <input className="inp" placeholder="e.g. July 1, 2026" value={billingStartDate}
                  onChange={(e) => setBillingStartDate(e.target.value)} />
              </Field>
            </div>
            <div className="row2">
              <Field label="Contract term in months (AI-suggested, edit if needed)">
                <input className="inp mono" type="number" min="1" value={contractTerm}
                  onChange={(e) => setContractTerm(e.target.value)} />
              </Field>
              <Field label="Scope expansion KPIs">
                <input className="inp" placeholder="e.g. defect escape rate, throughput" value={expansionKpis}
                  onChange={(e) => setExpansionKpis(e.target.value)} />
              </Field>
            </div>
            <div className="row2">
              <Field label="Application code for the SKU (AI-summarized, edit if needed)">
                <input className="inp mono" placeholder="e.g. LABEL" value={skuApplication}
                  onChange={(e) => setSkuApplication(e.target.value)} />
              </Field>
              <Field label="Product SKU (auto from application, tier, lines)">
                <input className="inp mono" value={sku} readOnly placeholder="LABEL-PRO-3L" />
              </Field>
            </div>
            <Field label="Hardware (feeds the agreement table and the proposal Hardware Requirements)">
              <div className="hw">
                {hardware.map((h, i) => (
                  <div className="hw-row4" key={i}>
                    <input className="inp" placeholder="Item" value={h.item}
                      onChange={(e) => setHardware((hw) => hw.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)))} />
                    <input className="inp mono" placeholder="Qty" value={h.qty}
                      onChange={(e) => setHardware((hw) => hw.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                    <input className="inp" placeholder="Description" value={h.description}
                      onChange={(e) => setHardware((hw) => hw.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                    <input className="inp mono" placeholder="$ cost" value={h.cost}
                      onChange={(e) => setHardware((hw) => hw.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))} />
                    <button className="hw-x" onClick={() => setHardware((hw) => hw.filter((_, j) => j !== i))} aria-label="remove">×</button>
                  </div>
                ))}
                <button className="hw-add" onClick={() => setHardware((hw) => [...hw, { item: "", qty: "", description: "", cost: "" }])}>+ add hardware</button>
              </div>
            </Field>
          </Panel>

          <Panel icon={<FileText size={15} />} title="Proposal content" step="05"
            note="AI-drafted from your Salesforce fields when you load the opportunity. Review and edit anything here; it fills the proposal under Appendix 1.">
            <Field label="Executive summary">
              <textarea className="inp ta" rows={3} value={execSummary} onChange={(e) => setExecSummary(e.target.value)} />
            </Field>
            <Field label="Application name">
              <input className="inp" placeholder="e.g. Workforce Optimization (Labor & Production Monitoring)" value={appName} onChange={(e) => setAppName(e.target.value)} />
            </Field>
            <Field label="Problem statement">
              <textarea className="inp ta" rows={3} value={problem} onChange={(e) => setProblem(e.target.value)} />
            </Field>
            <Field label="Proposed solution">
              <textarea className="inp ta" rows={3} value={solution} onChange={(e) => setSolution(e.target.value)} />
            </Field>
            <Field label="The AI model will inspect each unit for (one per line)">
              <textarea className="inp ta" rows={3} value={inspection} onChange={(e) => setInspection(e.target.value)} />
            </Field>
            <Field label="Process comparison · Before vs. After">
              <div className="hw">
                {beforeAfter.map((r, i) => (
                  <div className="hw-row" key={i}>
                    <input className="inp" placeholder="Before (current process)" value={r.before}
                      onChange={(e) => setBeforeAfter((rows) => rows.map((x, j) => (j === i ? { ...x, before: e.target.value } : x)))} />
                    <input className="inp" placeholder="After (with Maneva)" value={r.after}
                      onChange={(e) => setBeforeAfter((rows) => rows.map((x, j) => (j === i ? { ...x, after: e.target.value } : x)))} />
                    <button className="hw-x" onClick={() => setBeforeAfter((rows) => rows.filter((_, j) => j !== i))} aria-label="remove">×</button>
                  </div>
                ))}
                <button className="hw-add" onClick={() => setBeforeAfter((rows) => [...rows, { before: "", after: "" }])}>+ add row</button>
              </div>
            </Field>
            <Field label="Preventative benefits · cost avoidance (one per line)">
              <textarea className="inp ta" rows={2} value={preventative} onChange={(e) => setPreventative(e.target.value)} />
            </Field>
            <Field label="Upside benefits · value creation (one per line)">
              <textarea className="inp ta" rows={2} value={upside} onChange={(e) => setUpside(e.target.value)} />
            </Field>
            <Field label="Key assumptions & data sources (one per line)">
              <textarea className="inp ta" rows={2} value={assumptions} onChange={(e) => setAssumptions(e.target.value)} />
            </Field>
            <Field label="Implementation timeline (one per line)">
              <textarea className="inp ta" rows={2} value={propTimeline} onChange={(e) => setPropTimeline(e.target.value)} />
            </Field>
            <Field label="Risks & mitigations">
              <div className="hw">
                {risks.map((r, i) => (
                  <div className="hw-row" key={i}>
                    <input className="inp" placeholder="Risk" value={r.risk}
                      onChange={(e) => setRisks((rows) => rows.map((x, j) => (j === i ? { ...x, risk: e.target.value } : x)))} />
                    <input className="inp" placeholder="Mitigation" value={r.mitigation}
                      onChange={(e) => setRisks((rows) => rows.map((x, j) => (j === i ? { ...x, mitigation: e.target.value } : x)))} />
                    <button className="hw-x" onClick={() => setRisks((rows) => rows.filter((_, j) => j !== i))} aria-label="remove">×</button>
                  </div>
                ))}
                <button className="hw-add" onClick={() => setRisks((rows) => [...rows, { risk: "", mitigation: "" }])}>+ add risk</button>
              </div>
            </Field>
            <div className="muted2">The Estimated Pricing table and Total Annual Value come from the calculator and the Value drivers above; you do not type the price here.</div>
          </Panel>

          <Panel icon={<ImageIcon size={15} />} title="Photos" step="06"
            note="Optional. Attach labelled photos; they appear under Supporting Photos in the proposal.">
            <input className="file" type="file" accept="image/*" multiple onChange={(e) => { addPhotos(e.target.files); e.target.value = ""; }} />
            {photos.length > 0 && (
              <div className="hw" style={{ marginTop: 10 }}>
                {photos.map((p, i) => (
                  <div className="hw-row" key={i}>
                    <input className="inp" placeholder="Caption / label" value={p.label}
                      onChange={(e) => setPhotos((ps) => ps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                    <span className="ph-name">{p.name}</span>
                    <button className="hw-x" onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))} aria-label="remove">×</button>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel icon={<HelpCircle size={15} />} title="Have you answered the following questions?" step="07"
            note="These are not added to the document. They go in the Teams message and email to RevOps, SVP, and Legal.">
            <Field label="How long is the pilot period?">
              <input className="inp" value={qPilot} onChange={(e) => setQPilot(e.target.value)} placeholder="e.g., 8 weeks" />
            </Field>
            <Field label="Will the customer have an opt-out at the pilot period end date?">
              <input className="inp" value={qOptOut} onChange={(e) => setQOptOut(e.target.value)} placeholder="e.g., Yes, with 30 days notice before the end date" />
            </Field>
            <Field label="Who is installing the hardware?">
              <input className="inp" value={qInstaller} onChange={(e) => setQInstaller(e.target.value)} placeholder="e.g., Customer, with Maneva guidance" />
            </Field>
            <Field label="Have we talked about implementation fees?">
              <input className="inp" value={qImplFees} onChange={(e) => setQImplFees(e.target.value)} placeholder="e.g., Yes, waived for Phase 1" />
            </Field>
            <Field label="How many expansion lines are there, and what is the expansion pricing?">
              <input className="inp" value={qExpansion} onChange={(e) => setQExpansion(e.target.value)} placeholder="e.g., 4 additional lines per the Order Form volume schedule" />
            </Field>
          </Panel>
        </div>

        {/* ============ RIGHT: LIVE OUTPUT ============ */}
        <div className="col">
          {/* pricing */}
          <div className="out">
            <div className="out-head">
              <span>Pricing output</span>
              <span className="live"><span className="dot" /> live</span>
            </div>
            <div className="hero">
              <div>
                <div className="hero-n mono">{money(q.finalRate, currency)}</div>
                <div className="hero-l">final / line / mo</div>
              </div>
              <div className="hero-meta">
                <Stat k="Rate card / line" v={money(q.base, currency)} sub={lines > 1 ? `volume rate · ${lines} lines` : "1-line rate"} />
                <Stat k="Total discount" v={pct(q.totalPct)} sub={q.activityPct > 0 ? `${pct(q.activityPct)} activity + ${pct(q.customPct)} custom` : "off rate card"} />
              </div>
            </div>

            {q.floorTriggered && (
              <div className="flag stop"><AlertTriangle size={14} /> Discount pushed below the {money(q.floor, currency)} floor. Price held at the floor.</div>
            )}
            {q.customPricing && (
              <div className="flag warn"><AlertTriangle size={14} /> 15+ lines is custom-pricing territory. Confirm with RevOps.</div>
            )}

            <div className="grid3">
              <Big k="MRR" v={money(q.mrr, currency)} />
              <Big k="ARR" v={money(q.arr, currency)} />
              <Big k={billing === "annual" ? "Billed / year" : "Billed / month"} v={money(q.billed, currency)} />
            </div>

            <div className="approval" style={{ borderColor: toneColor[q.tone] }}>
              <ShieldCheck size={16} color={toneColor[q.tone]} />
              <span style={{ color: toneColor[q.tone], fontWeight: 700 }}>{q.approval}</span>
              <span className="approval-sub">
                {q.tone === "ok" ? "Standard quote." : q.tone === "warn" ? "10–20% off rate card." : "20%+ off rate card."}
              </span>
            </div>
          </div>

          {/* ROI */}
          <div className="out">
            <div className="out-head"><span>Business case</span>
              <span className="muted">cost from calculator → ROI</span></div>
            <div className="roi">
              <RoiCell k="Annual cost" v={money(annualCost, currency)} tone="ink" />
              <RoiCell k="Annual savings" v={money(annualSavings, currency)} tone="good" />
              <RoiCell k="Net annual value" v={(netValue >= 0 ? "+" : "−") + money(Math.abs(netValue), currency)} tone={netValue >= 0 ? "good" : "stop"} />
              <RoiCell k="Payback" v={paybackMonths == null ? "—" : paybackMonths.toFixed(1) + " mo"} tone="ink" />
              <RoiCell k="Value-to-cost" v={ratio ? ratio.toFixed(1) + "×" : "—"} tone="amber" />
              <RoiCell k="Revenue protected" v={money(revenueProtected, currency)} tone="ink" />
            </div>
          </div>

          {/* document */}
          <div className="out">
            <div className="out-head"><span>Document</span><span className="muted">filled from one deal</span></div>
            {loadedDeal && (
              <div className="loaded"><Check size={12} strokeWidth={3} /> Loaded from Salesforce: scope, objectives, and dates for {customer}</div>
            )}
            {[
              { mode: "agreement", title: "Service Agreement", sub: "Order Form, Terms & Conditions, and the project scope." },
              { mode: "proposal", title: "Proposal", sub: "The sales proposal on its own: summary, solution, pricing, and ROI." },
              { mode: "combined", title: "Combined", sub: "The Service Agreement with the proposal under Appendix 1." },
            ].map((row) => {
              const busy = !!generating || !!previewing;
              return (
                <div className="docrow" key={row.mode}>
                  <div className="docrow-t">{row.title}</div>
                  <div className="docrow-sub">{row.sub}</div>
                  <div className="docrow-btns">
                    <button className="gen2 ghost2" onClick={() => previewDocument(row.mode)} disabled={busy}>
                      <FileText size={14} /> {previewing === row.mode ? "Building…" : "Preview"}
                    </button>
                    <button className="gen2" onClick={() => generateDocuments(row.mode)} disabled={busy}>
                      <Sparkles size={14} /> {generating === row.mode ? "Generating…" : "Generate"}
                    </button>
                  </div>
                </div>
              );
            })}
            {status && (
              <div className={"status " + (status.type === "err" ? "status-err" : "status-ok")}>
                {status.type === "err" ? <AlertTriangle size={13} /> : <Check size={13} strokeWidth={3} />}
                <span>{status.msg}</span>
              </div>
            )}
          </div>

          {/* approval & review */}
          <div className="out">
            <div className="out-head"><span>Approval &amp; review</span><span className="muted">Teams + email</span></div>
            <div className="apprv">
              {(q.tone === "warn" || q.tone === "stop") && (
                <div className="apprv-row">
                  <div className="apprv-c">
                    <div className="apprv-t">RevOps Approval <span className="apprv-req">required for this discount</span></div>
                    <div className="apprv-sub">Sends to RevOps with the combined document and your answers.</div>
                  </div>
                  <button className="gen2" disabled={!!approving} onClick={() => sendApproval("revops")}>
                    <Send size={14} /> {approving === "revops" ? "Sending…" : "Request"}
                  </button>
                </div>
              )}
              <div className="apprv-row">
                <div className="apprv-c">
                  <div className="apprv-t">SVP Approval {q.tone === "stop" && <span className="apprv-req">required for this discount</span>}</div>
                  <div className="apprv-sub">Routes to the right SVP based on who is signed in.</div>
                </div>
                <button className="gen2" disabled={!!approving} onClick={() => sendApproval("svp")}>
                  <Send size={14} /> {approving === "svp" ? "Sending…" : "Request"}
                </button>
              </div>
              <div className="apprv-row">
                <div className="apprv-c">
                  <div className="apprv-t">Legal Review</div>
                  <div className="apprv-sub">Sends to Legal with the combined document and your answers.</div>
                </div>
                <button className="gen2 ghost2" disabled={!!approving} onClick={() => sendApproval("legal")}>
                  <Scale size={14} /> {approving === "legal" ? "Sending…" : "Request"}
                </button>
              </div>
            </div>
            {approvalStatus && (
              <div className={"status " + (approvalStatus.type === "err" ? "status-err" : "status-ok")}>
                {approvalStatus.type === "err" ? <AlertTriangle size={13} /> : <Check size={13} strokeWidth={3} />}
                <span>{approvalStatus.msg}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {previewOpen && (
        <div className="modal-ov" onClick={closePreview}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
              <div style={{ fontWeight: 700, fontFamily: "var(--display)" }}>
                Document preview {previewMode === "pdf" ? "(exact)" : ""}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="modal-btn" onClick={() => {
                  const f = document.getElementById("preview-frame");
                  if (f && f.contentWindow) f.contentWindow.print();
                }}>Print / Save as PDF</button>
                <button className="modal-x" onClick={closePreview}>Close</button>
              </div>
            </div>
            {previewDegraded && (
              <div className="modal-warn">
                Showing a simplified preview — the server ran low on memory rendering the exact PDF.
                The downloaded Word file is unaffected. (Bumping the Render plan fixes this.)
              </div>
            )}
            {previewMode === "pdf"
              ? <iframe id="preview-frame" className="modal-frame" title="Document preview" src={previewUrl} />
              : <iframe id="preview-frame" className="modal-frame" title="Document preview"
                  srcDoc={"<style>body{font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;max-width:780px;margin:24px auto;padding:0 28px;line-height:1.5}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ccc;padding:6px 9px;font-size:13px;text-align:left;vertical-align:top}h1,h2,h3{font-family:Arial,Helvetica,sans-serif;line-height:1.25}img{max-width:100%;height:auto}</style>" + previewHtml} />}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- small components ---------- */
function Panel({ icon, title, step, note, children }) {
  return (
    <section className="panel">
      <div className="panel-h">
        <span className="panel-ic">{icon}</span>
        <span className="panel-t">{title}</span>
        <span className="panel-step mono">{step}</span>
      </div>
      {note && <div className="panel-note">{note}</div>}
      <div className="panel-b">{children}</div>
    </section>
  );
}
function Field({ label, children }) {
  return (<label className="field"><span className="field-l">{label}</span>{children}</label>);
}
function Stat({ k, v, sub }) {
  return (<div className="sstat"><div className="sstat-k">{k}</div>
    <div className="sstat-v mono">{v}</div><div className="sstat-s">{sub}</div></div>);
}
function Big({ k, v }) {
  return (<div className="big"><div className="big-k">{k}</div><div className="big-v mono">{v}</div></div>);
}
function RoiCell({ k, v, tone }) {
  const c = { ink: "var(--ink)", good: "var(--good)", stop: "var(--stop)", amber: "var(--amber)" }[tone];
  return (<div className="roi-c"><div className="roi-k">{k}</div>
    <div className="roi-v mono" style={{ color: c }}>{v}</div></div>);
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');
:root{
  --paper:#F4F2EC; --panel:#FBFAF6; --ink:#16191E; --ink-soft:#6B7178;
  --line:#DED9CE; --line-2:#CDC7B9; --amber:#D9480F; --amber-soft:#FBEAE0;
  --good:#2B8A3E; --stop:#C0341A;
  --display:'Archivo',sans-serif; --body:'Archivo',sans-serif; --mono:'JetBrains Mono',monospace;
}
*{box-sizing:border-box}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}

/* sign-in */
.login-screen{min-height:100vh;display:grid;place-items:center;background:var(--paper);
  font-family:var(--body);color:var(--ink);padding:24px}
.login-card{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--line);
  border-radius:14px;padding:28px;box-shadow:0 12px 40px rgba(0,0,0,.06)}
.login-logo{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.login-mark{width:38px;height:38px;background:var(--ink);color:var(--paper);display:grid;place-items:center;border-radius:8px}
.login-title{font-family:var(--display);font-weight:800;font-size:17px;letter-spacing:-.02em}
.login-sub{font-size:12px;color:var(--ink-soft);margin-top:2px}
.login-l{display:block;font-size:12px;font-weight:600;color:var(--ink-soft);margin:12px 0 5px}
.login-in{width:100%;font-family:var(--body);font-size:14px;color:var(--ink);background:var(--paper);
  border:1px solid var(--line-2);border-radius:8px;padding:10px 12px}
.login-in:focus{outline:none;border-color:var(--ink)}
.login-btn{width:100%;margin-top:18px;font-family:var(--body);font-size:14px;font-weight:700;
  color:var(--paper);background:var(--ink);border:none;border-radius:8px;padding:11px;cursor:pointer}
.login-btn:disabled{opacity:.6;cursor:default}
.login-err{margin-top:12px;font-size:12.5px;color:var(--stop);background:#FBE9E6;border:1px solid #F1C4BC;border-radius:7px;padding:8px 10px}
.login-foot{margin-top:16px;font-size:11.5px;color:var(--ink-soft);text-align:center}
.who{font-size:12.5px;color:var(--ink-soft);font-weight:600}

.wrap{max-width:1340px;margin:0 auto;padding:28px;display:grid;grid-template-columns:1.55fr 1fr;gap:22px}
@media(max-width:900px){.wrap{grid-template-columns:1fr}.col:nth-child(2){position:static}}
.col{display:flex;flex-direction:column;gap:18px;animation:rise .5s ease both}
.col:nth-child(2){animation-delay:.08s;position:sticky;top:86px;align-self:start}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}

.chip{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;color:var(--ink-soft);
  border:1px solid var(--line);padding:5px 10px;border-radius:20px;background:var(--paper)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--good);box-shadow:0 0 0 3px rgba(43,138,62,.15)}
.ghost{display:inline-flex;align-items:center;gap:5px;font-family:var(--body);font-size:12.5px;font-weight:600;
  color:var(--ink);background:transparent;border:1px solid var(--line-2);padding:7px 12px;border-radius:8px;cursor:pointer}
.ghost:hover{background:var(--paper);border-color:var(--ink)}

.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.panel-h{display:flex;align-items:center;gap:9px;padding:13px 16px;border-bottom:1px solid var(--line)}
.panel-ic{display:grid;place-items:center;width:24px;height:24px;border-radius:6px;background:var(--ink);color:var(--paper)}
.panel-t{font-family:var(--display);font-weight:700;font-size:14px;flex:1}
.panel-step{font-size:11px;color:var(--ink-soft);letter-spacing:.1em}
.panel-note{padding:9px 16px;font-size:11.5px;color:var(--ink-soft);background:var(--paper);border-bottom:1px solid var(--line)}
.panel-b{padding:16px;display:flex;flex-direction:column;gap:14px}

.field{display:flex;flex-direction:column;gap:6px}
.field-l{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-soft)}
.row2{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.inp{font-family:var(--body);font-size:14px;color:var(--ink);background:var(--paper);
  border:1px solid var(--line-2);border-radius:8px;padding:9px 11px;width:100%;outline:none}
.inp:focus{border-color:var(--amber);box-shadow:0 0 0 3px var(--amber-soft)}

.seg{display:flex;border:1px solid var(--line-2);border-radius:8px;overflow:hidden;height:38px}
.seg-b{flex:1;font-family:var(--body);font-size:13px;font-weight:600;color:var(--ink-soft);
  background:var(--paper);border:none;cursor:pointer}
.seg-b.on{background:var(--ink);color:var(--paper)}

.tiers{display:flex;flex-direction:column;gap:8px}
.tier{display:grid;grid-template-columns:1fr auto;grid-template-rows:auto auto;gap:1px 0;text-align:left;
  background:var(--paper);border:1px solid var(--line-2);border-radius:9px;padding:11px 13px;cursor:pointer;transition:.12s}
.tier:hover{border-color:var(--ink-soft)}
.tier.on{border-color:var(--amber);background:var(--amber-soft)}
.tier-l{font-weight:700;font-size:13.5px}
.tier-s{grid-row:2;font-size:11px;color:var(--ink-soft)}
.tier-p{grid-row:1/3;grid-column:2;align-self:center;font-size:13px;font-weight:700}
.tier-p i{font-style:normal;font-size:10px;color:var(--ink-soft);font-weight:400;margin-left:2px}

.acts{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.act{display:flex;align-items:center;gap:8px;font-family:var(--body);font-size:12.5px;font-weight:500;color:var(--ink);
  background:var(--paper);border:1px solid var(--line-2);border-radius:8px;padding:9px 11px;cursor:pointer;text-align:left}
.act.on{border-color:var(--amber);background:var(--amber-soft)}
.box{width:16px;height:16px;border-radius:4px;border:1.5px solid var(--line-2);display:grid;place-items:center;color:#fff;flex:none}
.act.on .box{background:var(--amber);border-color:var(--amber)}

.out{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;
  box-shadow:0 1px 2px rgba(20,25,30,.03)}
.out-head{display:flex;align-items:center;justify-content:space-between;padding:11px 16px;
  border-bottom:1px solid var(--line);font-family:var(--display);font-weight:700;font-size:13px}
.live{display:inline-flex;align-items:center;gap:6px;font-family:var(--body);font-weight:500;font-size:11px;color:var(--ink-soft)}
.muted{font-family:var(--body);font-weight:500;font-size:11px;color:var(--ink-soft)}
.hint-calc{margin-top:7px;font-size:11.5px;color:var(--ink-soft);line-height:1.4}
.hint-calc b{color:var(--ink);font-weight:700}

.hero{display:flex;align-items:center;justify-content:space-between;padding:18px 16px;gap:16px;
  background:linear-gradient(180deg,#fff, var(--paper))}
.hero-n{font-size:42px;font-weight:700;letter-spacing:-.03em;line-height:1}
.hero-l{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-soft);margin-top:6px}
.hero-meta{display:flex;gap:22px}
.sstat-k{font-size:10.5px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.04em}
.sstat-v{font-size:18px;font-weight:700;margin-top:3px}
.sstat-s{font-size:10.5px;color:var(--ink-soft);margin-top:2px}

.flag{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;padding:9px 16px}
.flag.stop{color:var(--stop);background:#FBE9E6}
.flag.warn{color:var(--amber);background:var(--amber-soft)}

.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;border-top:1px solid var(--line)}
.big{padding:13px 16px;border-right:1px solid var(--line)}
.big:last-child{border-right:none}
.big-k{font-size:10.5px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.04em}
.big-v{font-size:19px;font-weight:700;margin-top:4px}

.approval{display:flex;align-items:center;gap:9px;margin:14px 16px 16px;padding:11px 13px;
  border:1.5px solid;border-radius:9px;font-size:13px}
.approval-sub{color:var(--ink-soft);font-size:11.5px;margin-left:auto}

.roi{display:grid;grid-template-columns:1fr 1fr 1fr}
.roi-c{padding:14px 16px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.roi-c:nth-child(3n){border-right:none}
.roi-c:nth-child(n+4){border-bottom:none}
.roi-k{font-size:10.5px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.04em}
.roi-v{font-size:22px;font-weight:700;margin-top:5px;letter-spacing:-.01em}

.docs{display:flex;flex-direction:column}
.doc{display:flex;align-items:center;gap:11px;padding:12px 16px;border-bottom:1px solid var(--line)}
.ready{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:var(--good)}
.pend{font-size:11px;color:var(--ink-soft)}
.gen{display:flex;align-items:center;justify-content:center;gap:9px;width:calc(100% - 32px);margin:14px 16px;
  font-family:var(--display);font-weight:700;font-size:14px;color:#fff;background:var(--ink);
  border:none;border-radius:9px;padding:13px;cursor:pointer;transition:.15s}
.gen:hover{background:var(--amber)}
.gen.ghostbtn{color:var(--ink);background:transparent;border:1px solid var(--line-2);margin-bottom:0;padding-top:11px;padding-bottom:11px}
.gen.ghostbtn:hover{background:var(--paper);border-color:var(--ink)}
.gen:disabled{opacity:.55;cursor:default}

/* three document rows (Service Agreement / Proposal / Combined) */
.docrow{border:1px solid var(--line);border-radius:10px;padding:11px 13px;margin:0 16px 10px;background:var(--paper)}
.docrow:first-of-type{margin-top:6px}
.docrow-t{font-family:var(--display);font-weight:700;font-size:13.5px;color:var(--ink)}
.docrow-sub{font-size:11.5px;color:var(--ink-soft);margin:2px 0 10px;line-height:1.4}
.docrow-btns{display:flex;gap:8px}
.gen2{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;font-family:var(--display);
  font-weight:700;font-size:12.5px;color:#fff;background:var(--ink);border:none;border-radius:8px;padding:9px;cursor:pointer;transition:.15s}
.gen2:hover{background:var(--amber)}
.gen2.ghost2{color:var(--ink);background:transparent;border:1px solid var(--line-2)}
.gen2.ghost2:hover{background:#fff;border-color:var(--ink)}
.gen2:disabled{opacity:.5;cursor:default}

/* approval & review rows */
.apprv{display:flex;flex-direction:column;gap:9px;margin:12px 16px 4px}
.apprv-row{display:flex;align-items:center;gap:12px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--paper)}
.apprv-c{flex:1;min-width:0}
.apprv-t{font-family:var(--display);font-weight:700;font-size:13px;color:var(--ink);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.apprv-sub{font-size:11px;color:var(--ink-soft);margin-top:2px;line-height:1.35}
.apprv-req{font-family:var(--body);font-weight:700;font-size:9.5px;letter-spacing:.03em;text-transform:uppercase;color:#8a5a00;background:#FBEFD6;border:1px solid #EAD9A8;border-radius:5px;padding:2px 6px}
.apprv .gen2{flex:0 0 auto;width:auto;padding:9px 16px}

/* preview popup */
.modal-ov{position:fixed;inset:0;background:rgba(20,25,30,.45);display:grid;place-items:center;z-index:60;padding:24px;animation:rise .15s ease both}
.modal{width:100%;max-width:920px;height:86vh;background:var(--panel);border-radius:14px;overflow:hidden;
  display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,.3)}
.modal-h{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
.modal-btn{font-family:var(--body);font-weight:700;font-size:12.5px;color:#fff;background:var(--ink);border:none;border-radius:8px;padding:8px 14px;cursor:pointer}
.modal-btn:hover{background:var(--amber)}
.modal-x{font-family:var(--body);font-weight:600;font-size:12.5px;color:var(--ink);background:transparent;border:1px solid var(--line-2);border-radius:8px;padding:8px 14px;cursor:pointer}
.modal-x:hover{border-color:var(--ink)}
.modal-frame{flex:1;width:100%;border:none;background:#fff}
.modal-warn{padding:9px 16px;font-size:12px;font-weight:600;color:#8a5a00;background:#FBEFD6;border-bottom:1px solid #EAD9A8}
.payload{margin:0 16px 16px;border:1px solid var(--line-2);border-radius:9px;overflow:hidden;animation:rise .3s ease both}
.payload-h{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;letter-spacing:.04em;
  text-transform:uppercase;color:var(--ink-soft);padding:8px 12px;background:var(--paper);border-bottom:1px solid var(--line)}
.payload pre{margin:0;padding:12px;font-family:var(--mono);font-size:11.5px;line-height:1.55;color:var(--ink);
  white-space:pre-wrap;background:#fff}
.payload-f{padding:9px 12px;font-size:11px;color:var(--ink-soft);background:var(--paper);border-top:1px solid var(--line)}
.loadinp{width:130px;padding:7px 10px;font-size:12.5px}
.hw{display:flex;flex-direction:column;gap:8px}
.hw-row{display:grid;grid-template-columns:1fr 1fr 32px;gap:8px;align-items:center}
.hw-row4{display:grid;grid-template-columns:1.3fr 60px 1.6fr 90px 32px;gap:8px;align-items:center}
.ta{resize:vertical;line-height:1.5;min-height:104px}
.file{font-family:var(--body);font-size:13px;color:var(--ink)}
.ph-name{font-size:11px;color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.muted2{font-family:var(--body);font-size:11.5px;color:var(--ink-soft);margin-top:6px;font-style:italic}
.hw-x{border:1px solid var(--line-2);background:var(--paper);border-radius:8px;height:38px;cursor:pointer;font-size:18px;color:var(--ink-soft);line-height:1}
.hw-x:hover{border-color:var(--stop);color:var(--stop)}
.hw-add{align-self:flex-start;font-family:var(--body);font-size:12px;font-weight:600;color:var(--amber);background:transparent;border:1px dashed var(--line-2);border-radius:8px;padding:7px 11px;cursor:pointer}
.hw-add:hover{border-color:var(--amber)}
.loaded{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--good);padding:10px 16px;background:#EEF6EF;border-bottom:1px solid var(--line)}
.status{display:flex;align-items:center;gap:8px;margin:0 16px 16px;padding:10px 12px;border-radius:9px;font-size:12.5px;font-weight:600}
.status-ok{color:var(--good);background:#EEF6EF;border:1px solid #CDE6D2}
.status-err{color:var(--stop);background:#FBE9E6;border:1px solid #F1C9C1}
select.inp{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236B7178' fill='none' stroke-width='1.5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center;padding-right:28px}
`;
