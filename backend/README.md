# Maneva Deal Desk - Backend

Reads a deal from Salesforce, prices it with the Maneva calculator, and generates the
customer-ready **Service Agreement (MSA) + Order Form** as a Word document, with the
legal Terms & Conditions and all formatting left untouched.

This is the server half of the Deal Desk. The browser frontend (`maneva-deal-desk.jsx`)
talks to it over three endpoints. The reason a server exists at all: a browser cannot
do formatting-preserving `.docx` surgery and cannot safely hold Salesforce OAuth
secrets. Both of those live here.

## Architecture

```
Salesforce  ──(jsforce, OAuth)──►  salesforce.js ──► normalized deal
                                                         │
Attention ─┐ (native CRM sync)                           ▼
Flowlinker ┘ feed Salesforce upstream            pricing.js  (calculator)
                                                         │
                                                         ▼
                                  generate.js ──► payload ──► engine/fill_msa.py
                                                                     │
                                                                     ▼
                                                        Maneva_MSA_<customer>.docx
```

- **`engine/fill_msa.py`** - the document engine. Self-contained (lxml only), data-driven,
  applies the legal conditional rules (hardware provision/procurement, phases, SKUs,
  repeatable bullets). Verified to leave the T&C and formatting intact.
- **`src/pricing.js`** - the calculator, ported 1:1 from the spreadsheet and unit-checked.
- **`src/salesforce.js`** - jsforce read layer; returns a normalized deal.
- **`src/fieldMapping.js`** - **the one file you edit** (your Salesforce API names).
- **`src/generate.js`** - the pipeline that ties them together.
- **`src/server.js`** - the API.

## Setup

```bash
npm install
cp .env.example .env          # fill in Salesforce creds (see the runbook)
cp /path/to/your/MSA.docx templates/msa_template.docx
```

Then edit **`src/fieldMapping.js`**: put your real Salesforce field API names beside each
key. Anything you leave `null` is skipped and that placeholder is left blank for a human.

## Run

```bash
npm start                     # http://localhost:8080
node scripts/smoke.js         # full pipeline with a sample deal, no Salesforce needed
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health` | liveness |
| `POST` | `/api/price` | live calculator for the frontend; body = `{tier, lines, annual, customDiscount, activities, roi?}` |
| `GET`  | `/api/opportunity/:id` | fetch + map a deal from Salesforce, with a pricing preview |
| `POST` | `/api/generate` | generate the MSA. Body = `{opportunityId, choices}` or `{deal, choices}`. Returns the `.docx` (add `?json=1` to get pricing + filename instead) |

`choices` carries the few human decisions the contract needs that may not be in Salesforce:
`{ hardware: {provision:'default'|'maneva', procurement:'purchase'|'procure'|'rent'}, install_timeline, end_phase1_date }`.

## Security

Set `API_TOKEN` in `.env` to require `Authorization: Bearer <token>` on every call, and set
`CORS_ORIGIN` to your frontend URL. Salesforce secrets never leave the server.

## What's next

Proposal generation is wired the same way (`generate.generateProposal`) and switches on
once the de-identified, single project-block proposal template is finalized.
