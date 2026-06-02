// pricing.js -- Maneva pricing engine (JS port of the calculator).
// Verified against the spreadsheet: volume baked into the per-line rate tables,
// activity + custom discounts stack toward the approval threshold, floors cap the
// discount, and 15+ lines fall to custom pricing (rate is already the floor at 15).

const RATES = {
  Standard:     [1500, 1250, 1100, 1050, 950, 900, 850, 800, 750, 700, 650, 600, 550, 550, 500],
  Professional: [4000, 3350, 3050, 2850, 2650, 2500, 2350, 2250, 2100, 2000, 1900, 1800, 1700, 1600, 1500],
  Enterprise:   [6000, 5200, 4850, 4600, 4400, 4200, 4050, 3900, 3750, 3600, 3450, 3350, 3200, 3100, 3000],
};
const FLOORS = { Standard: 500, Professional: 1500, Enterprise: 3000 };

// Currency: base rates are USD. 0.72 is the CAD->USD rate (1 CAD = 0.72 USD), so a USD
// amount divided by 0.72 gives the CAD figure (CAD comes out higher than USD).
const CAD_TO_USD = 0.72;

const ACTIVITIES = {           // each worth 5%, stackable, capped at 20%
  customerReferral: 0.05,
  logoRights:       0.05,
  caseStudy:        0.05,
  videoTestimonial: 0.05,
};
const ACTIVITY_CAP = 0.20;

/**
 * @param {object} o
 * @param {('Standard'|'Professional'|'Enterprise')} o.tier
 * @param {number} o.lines           number of production lines in scope
 * @param {object} [o.activities]    {customerReferral, logoRights, caseStudy, videoTestimonial}: booleans
 * @param {number} [o.customDiscount] extra discount as a fraction (e.g. 0.05 for 5%)
 * @param {boolean} [o.annual]        annual (true) vs monthly billing
 */
function price(o) {
  const tier = o.tier;
  const lines = Math.max(1, parseInt(o.lines, 10) || 1);
  if (!RATES[tier]) throw new Error(`Unknown tier: ${tier}`);

  const customPancake = true; // (named for clarity below)
  const idx = Math.min(lines, 15) - 1;
  const baseRate = RATES[tier][idx];
  const floor = FLOORS[tier];

  let activityPct = 0;
  const acts = o.activities || {};
  for (const k of Object.keys(ACTIVITIES)) if (acts[k]) activityPct += ACTIVITIES[k];
  activityPct = Math.min(activityPct, ACTIVITY_CAP);

  const customPct = Math.max(0, o.customDiscount || 0);
  const totalPct = activityPct + customPct;            // volume is NOT counted toward approval

  const discounted = baseRate * (1 - totalPct);
  const finalRateUsd = Math.max(discounted, floor);    // floor caps the discount (USD)
  const flooredApplied = discounted < floor;

  // currency: USD is the base; CAD = USD / 0.72 (CAD higher than USD)
  const currency = (o.currency || "USD").toUpperCase() === "CAD" ? "CAD" : "USD";
  const fx = currency === "CAD" ? (1 / CAD_TO_USD) : 1;
  const finalRate = finalRateUsd * fx;
  const baseDisp = baseRate * fx;
  const floorDisp = floor * fx;

  const mrr = finalRate * lines;
  const arr = mrr * 12;
  const billedAnnual = !!o.annual;
  const billedAmount = billedAnnual ? arr : mrr;

  // approval is driven by the discretionary discount only (not volume)
  let approval = "none";
  if (totalPct >= 0.20) approval = "RevOps + SVP";
  else if (totalPct >= 0.10) approval = "RevOps";

  const customPricing = lines >= 15;                   // 15+ lines: custom pricing

  return {
    tier, lines, annual: billedAnnual, currency, conversionRate: +fx.toFixed(4),
    baseRatePerLine: round(baseDisp),
    floorPerLine: round(floorDisp),
    activityDiscountPct: +(activityPct * 100).toFixed(1),
    customDiscountPct: +(customPct * 100).toFixed(1),
    totalDiscountPct: +(totalPct * 100).toFixed(1),
    finalRatePerLine: round(finalRate),
    floorApplied: flooredApplied,
    mrr: round(mrr),
    arr: round(arr),
    billedAmount: round(billedAmount),
    approvalRequired: approval,
    customPricing,
  };
}

/** ROI / business case. Maneva price flows in as monthlyCost; the rest are
 *  customer value drivers captured at intake. All inputs are monthly unless noted. */
function roi({ monthlyCost, annualLaborSaved = 0, annualScrapAvoided = 0,
               annualReworkAvoided = 0, annualRevenueProtected = 0 }) {
  const annualCost = monthlyCost * 12;
  const annualValue = annualLaborSaved + annualScrapAvoided + annualReworkAvoided + annualRevenueProtected;
  const netAnnualValue = annualValue - annualCost;
  const valueToCost = annualCost > 0 ? annualValue / annualCost : 0;
  const paybackMonths = annualValue > 0 ? annualCost / (annualValue / 12) : null;
  return {
    annualCost: round(annualCost),
    annualValue: round(annualValue),
    netAnnualValue: round(netAnnualValue),
    valueToCostRatio: +valueToCost.toFixed(2),
    paybackMonths: paybackMonths === null ? null : +paybackMonths.toFixed(1),
  };
}

const round = (n) => Math.round(n * 100) / 100;

module.exports = { price, roi, RATES, FLOORS };
