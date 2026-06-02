#!/usr/bin/env python3
"""
fill_msa.py  -- Maneva MSA generation engine (data-driven, self-contained).

Usage:
    python3 fill_msa.py <template.docx> <payload.json> <output.docx>

Takes a deal payload (normally assembled by the Node backend from Salesforce +
the pricing engine) and produces a customer-ready Word document with the legal
formatting and Terms & Conditions left untouched.

Mechanism: every fill field in the template is a run highlighted yellow. We
fill / keep / cut each one per legal's rules, strip the editorial brackets,
remove the internal comments, and repack the .docx. No external dependencies
beyond lxml; does its own unzip/zip so it runs anywhere.
"""
import sys, os, json, shutil, zipfile, tempfile, re, copy
from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML = "http://www.w3.org/XML/1998/namespace"
def w(t): return f"{{{W}}}{t}"

# placeholder text (normalized) -> payload key
FIELD_MAP = {
    "insert customer legal name": "customer_legal_name",
    "insert list of applications": "applications",
    "CAD / USD": "currency",
    "insert number of lines": "num_lines_text",
    "insert application being deployed": "application_deployed",
    "insert price": "price",
    "3": "ref_section_3",
    "insert number of months": "term_text",
    "insert billing start date, which should be the same as the project kickoff date": "billing_start_date",
    "insert end of Phase 1 date": "end_phase1_date",
    "4": "ref_section_4",
    "month": "eff_month", "day": "eff_day", "year": "eff_year",
    "insert application name(s)": "application_names",
    "insert facility location": "facility_location",
    "insert scope of phase 1 services": "phase1_scope",
    "insert phase 1 exclusions": "phase1_exclusions",
    "insert phase 1 purpose": "phase1_purpose",
    "Insert specific operational metric targets": "success_metrics",
    "insert project kickoff date, which should almost always be the same as the Billing Start Date": "kickoff_date",
    "insert projected installation timeline": "install_timeline",
    "insert phase 1 period duration": "phase1_duration",
    "insert number of and description of SKUs, if applicable": "skus",
    "Insert scope expansion KPIs": "expansion_kpis",
    "Insert cost of expansions": "expansion_cost",
}
KEEP = {"Phase 1", "Phase 1 Period", "during the Phase 1 Period",
        "[, which may extend the Phase 1 Period and delay the attainment of the Phase 1 success criteria]"}
CLEAR = {"choose one of the following bullets and delete the others",
         "Default hardware provision:", "If Maneva providing hardware during Phase 1 Period:"}

def norm(s): return re.sub(r"\s+", " ", (s or "").replace("\u00a0", " ")).strip()
def ptext(p): return "".join(t.text or "" for t in p.iter(w("t")))
def strip_brk(s): return (s or "").replace("[", "").replace("]", "")

def _rpr_key(r):
    rpr = r.find(w("rPr"))
    if rpr is None or len(rpr) == 0:
        return b""
    return etree.tostring(rpr)

def _simple_run(r):
    tags = [etree.QName(c).localname for c in r]
    return "t" in tags and tags.count("t") == 1 and all(x in ("rPr", "t") for x in tags)

def merge_runs(root):
    """Merge consecutive plain-text runs that share identical run properties, so a
    placeholder fragmented across several runs becomes one matchable run."""
    for p in root.iter(w("p")):
        prev = None
        for child in list(p):
            if child.tag == w("r") and _simple_run(child):
                if prev is not None and _rpr_key(prev) == _rpr_key(child):
                    pt = prev.find(w("t")); ct = child.find(w("t"))
                    pt.text = (pt.text or "") + (ct.text or "")
                    if pt.text != pt.text.strip():
                        pt.set(w_xml_space(), "preserve")
                    p.remove(child)
                    continue
                prev = child
            else:
                prev = None

def delete_span(body, start_pred, stop_pred, include_stop=True):
    """Delete body children from the first match of start_pred through the first
    match of stop_pred (inclusive by default)."""
    kids = list(body)
    start = next((i for i, e in enumerate(kids) if start_pred(e)), None)
    if start is None:
        return
    j = start
    while j < len(kids):
        el = kids[j]
        body.remove(el)
        if stop_pred(el):
            if not include_stop:  # we already removed it; re-add if excluded
                body.insert(start, el)
            break
        j += 1

def delete_paragraph_if(body, pred):
    for el in list(body):
        if el.tag == w("p") and pred(norm(ptext(el))):
            body.remove(el)

def fill(template_path, payload, output_path):
    tmp = tempfile.mkdtemp(prefix="msa_")
    try:
        with zipfile.ZipFile(template_path) as z:
            names = z.namelist()
            z.extractall(tmp)

        doc_path = os.path.join(tmp, "word", "document.xml")
        tree = etree.parse(doc_path)
        root = tree.getroot()
        body = root.find(w("body"))
        merge_runs(root)

        hw = payload.get("hardware", {})
        provision = hw.get("provision", "default")      # 'default' | 'maneva'
        procurement = hw.get("procurement", "purchase")  # 'purchase' | 'procure' | 'rent'
        objectives = payload.get("objectives", [])
        prod_lines = payload.get("production_lines", [])
        has_skus = bool(payload.get("skus"))

        # ---- 1. conditional deletions ----
        is_tbl = lambda e: e.tag == w("tbl")
        if provision == "default":
            # remove the "Maneva provides hardware" block (heading -> its table)
            delete_span(body,
                lambda e: e.tag == w("p") and "if maneva providing hardware" in norm(ptext(e)).lower(),
                is_tbl)
        else:
            # remove the default block (intro paragraph -> install-coordination paragraph)
            delete_span(body,
                lambda e: e.tag == w("p") and norm(ptext(e)).startswith("The hardware required for Maneva to deploy"),
                lambda e: e.tag == w("p") and norm(ptext(e)).startswith("Hardware installation will be coordinated"))

        # procurement: keep one bullet, drop the other two (only relevant for default block)
        proc_text = {"purchase": "Purchase hardware directly through preferred vendors",
                     "procure": "Procure hardware through vendors recommended by Maneva",
                     "rent": "Rent hardware through Maneva"}
        for key, marker in proc_text.items():
            if key != procurement:
                delete_paragraph_if(body, lambda t, m=marker: t.startswith(m))

        # objectives / production lines: delete the optional bullets we are not using
        for n in (2, 3):
            if len(objectives) < n:
                delete_paragraph_if(body, lambda t, n=n: f"insert application objective {n}" in t.lower())
            if len(prod_lines) < n:
                delete_paragraph_if(body, lambda t, n=n: f"insert production line {n}" in t.lower())

        # SKU section (2.5): delete entirely if no SKUs
        if not has_skus:
            delete_span(body,
                lambda e: e.tag == w("p") and "sku scope" in norm(ptext(e)).lower(),
                lambda e: e.tag == w("p") and norm(ptext(e)).lower().startswith("2.6"),
                include_stop=False)

        # ---- 2. fill / keep / clear highlighted runs ----
        # First, make the surviving hardware table's placeholder rows match the item count.
        hw_items_pre = [i for i in hw.get("items", []) if i.get("name")]
        n_items = len(hw_items_pre)
        def _is_hw_row(tr):
            return "insert hardware" in norm("".join(t.text or "" for t in tr.iter(w("t")))).lower()
        hw_rows = [tr for tr in root.iter(w("tr")) if _is_hw_row(tr)]
        if hw_rows:
            keep = n_items if n_items > 0 else 1   # keep one placeholder row if no items given
            while len(hw_rows) > keep:             # too many rows -> drop extras
                extra = hw_rows.pop()
                extra.getparent().remove(extra)
            if len(hw_rows) < keep:                # too few rows -> clone the last one
                last = hw_rows[-1]
                parent = last.getparent()
                idx = list(parent).index(last)
                for _ in range(keep - len(hw_rows)):
                    clone = copy.deepcopy(last)
                    idx += 1
                    parent.insert(idx, clone)
                    hw_rows.append(clone)

        obj_q = list(objectives)
        line_q = list(prod_lines)
        hw_items = hw.get("items", [])
        hw_names = [i.get("name", "") for i in hw_items]
        hw_costs = [i.get("cost", "") for i in hw_items]
        ni = {"i": 0}; ci = {"i": 0}

        for r in root.iter(w("r")):
            rpr = r.find(w("rPr"))
            if rpr is None: continue
            hl = rpr.find(w("highlight"))
            if hl is None or hl.get(w("val")) != "yellow": continue
            tnode = r.find(w("t"))
            if tnode is None: continue
            t = tnode.text or ""; tn = norm(t)

            if tn == "[Insert hardware]":
                val = hw_names[ni["i"]] if ni["i"] < len(hw_names) else "[Insert hardware]"; ni["i"] += 1
            elif tn == "[Insert [estimated] cost]":
                val = hw_costs[ci["i"]] if ci["i"] < len(hw_costs) else "[Insert estimated cost]"; ci["i"] += 1
            elif tn == "[Insert total [estimated] cost]":
                val = hw.get("total", "[Insert total estimated cost]")
            elif tn in ("Estimated", "Total"):
                val = t
            elif tn.lower().startswith("insert application objective"):
                idx = 0 if "objective 1" in tn.lower() else (1 if "objective 2" in tn.lower() else 2)
                val = objectives[idx] if idx < len(objectives) else ""
            elif tn.lower().startswith("insert production line"):
                idx = 0 if "line 1" in tn.lower() else (1 if "line 2" in tn.lower() else 2)
                val = prod_lines[idx] if idx < len(prod_lines) else ""
            elif tn in KEEP:
                val = strip_brk(t)
            elif tn in {norm(x) for x in CLEAR}:
                val = ""
            elif tn in FIELD_MAP:
                val = str(payload.get(FIELD_MAP[tn], ""))
            else:
                val = strip_brk(t)
            tnode.text = val
            rpr.remove(hl)

        # ---- 2b. text fallback for placeholders not highlighted in the source ----
        for r in root.iter(w("r")):
            tnode = r.find(w("t"))
            if tnode is None:
                continue
            low = norm(tnode.text or "").lower()
            if low.startswith("insert application objective"):
                idx = 0 if "objective 1" in low else (1 if "objective 2" in low else 2)
                tnode.text = objectives[idx] if idx < len(objectives) else ""
            elif low.startswith("insert production line"):
                idx = 0 if "line 1" in low else (1 if "line 2" in low else 2)
                tnode.text = prod_lines[idx] if idx < len(prod_lines) else ""

        # ---- 3. cleanup: leftover yellow, brackets, comments ----
        for x in list(root.iter(w("highlight"))):
            if x.get(w("val")) == "yellow":
                x.getparent().remove(x)
        for tnode in root.iter(w("t")):
            if tnode.text and ("[" in tnode.text or "]" in tnode.text):
                tnode.text = tnode.text.replace("[", "").replace("]", "")
        for tag in ("commentRangeStart", "commentRangeEnd"):
            for el in list(root.iter(w(tag))):
                el.getparent().remove(el)
        for r in list(root.iter(w("r"))):
            if r.find(w("commentReference")) is not None:
                r.getparent().remove(r)
        # preserve meaningful whitespace
        for tnode in root.iter(w("t")):
            if tnode.text and tnode.text != tnode.text.strip():
                tnode.set(w_xml_space(), "preserve")

        tree.write(doc_path, xml_declaration=True, encoding="UTF-8", standalone=True)

        # empty the comment + task parts so none surface in the output
        for part in ("comments.xml", "commentsExtended.xml", "commentsExtensible.xml",
                     "commentsIds.xml", os.path.join("documenttasks", "documenttasks1.xml")):
            p = os.path.join(tmp, "word", part)
            if os.path.exists(p):
                t = etree.parse(p); rt = t.getroot()
                for ch in list(rt): rt.remove(ch)
                t.write(p, xml_declaration=True, encoding="UTF-8", standalone=True)

        # ---- 4. repack ----
        _zip_dir(tmp, names, output_path)
        return output_path
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

def w_xml_space():
    return f"{{{XML}}}space"

def _zip_dir(src_dir, ordered_names, output_path):
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as z:
        # [Content_Types].xml first for maximum reader compatibility
        for name in (["[Content_Types].xml"] + [n for n in ordered_names if n != "[Content_Types].xml"]):
            fp = os.path.join(src_dir, name)
            if os.path.isfile(fp):
                z.write(fp, name)

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("usage: python3 fill_msa.py <template.docx> <payload.json> <output.docx>", file=sys.stderr)
        sys.exit(2)
    tpl, pj, out = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(pj, encoding="utf-8") as f:
        data = json.load(f)
    fill(tpl, data, out)
    print(out)
