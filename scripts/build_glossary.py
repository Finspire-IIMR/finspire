#!/usr/bin/env python3
"""Build the dictionary from content/glossary/*.json into <out>/index.json and <out>/entries/<cat>.json.

Validates and normalises every entry, drops duplicates (same id or same term), resolves `related` term names to ids,
and makes auto-highlight phrases (`hl`) and acronyms (`abbr`) unique across the dictionary so a phrase in the news
always points at one term. Prints a short report; exits non-zero only if nothing usable was found."""
import argparse, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CATS = {
    "accounting": "Accounting & statements", "ratios": "Ratios & metrics", "corp-fin": "Corporate finance",
    "valuation": "Valuation", "modeling": "Modeling & Excel", "equities": "Stocks & equity markets",
    "trading": "Trading & market structure", "india-mkts": "Indian markets & regulation",
    "india-econ": "Indian economy & institutions", "bonds": "Bonds & fixed income",
    "rates": "Interest rates & money markets", "central-banks": "Central banks & monetary policy",
    "macro": "Macroeconomics & indicators", "fiscal": "Government & fiscal policy",
    "fx-trade": "Currencies & global trade", "derivatives": "Futures, forwards & swaps",
    "options": "Options & the Greeks", "commodities": "Commodities & energy", "banking": "Banking & lending",
    "credit": "Credit & ratings", "ib-deals": "Investment banking & deals", "pe-vc": "Private equity & venture capital",
    "funds": "Funds & asset management", "portfolio": "Portfolio & risk", "quant": "Quant & statistics",
    "behavioral": "Behavioural finance", "personal": "Personal finance & insurance", "tax": "Taxes",
    "fintech": "Fintech & payments", "crypto": "Crypto & digital assets", "esg": "ESG & sustainable finance",
    "real-estate": "Real estate & REITs", "history": "Crises & market history", "jargon": "Market slang & news-speak",
    "governance": "Governance, law & standards", "strategy": "Business models & strategy", "cfa": "CFA & professional exams",
}
# single words that must never auto-highlight on their own, whatever an entry says
GENERIC = set("""call calls put puts return returns yield yields spread spreads margin margins option options future futures
share shares stock stocks bond bonds capital interest rate rates market markets growth value risk balance bull bear bulls bears
rally rallies cover position exposure issue issues security bank banks fund funds note notes bill bills gold oil deal deals
credit debt loan loans trade trades order orders limit target guidance outlook rating ratings price prices cash equity
asset assets income profit loss losses tax taxes cost costs fee fees index swap swaps hedge hedges leverage liquidity default
offer offers float floats demand supply crash correction sell-off selloff policy budget economy reserve reserves money
currency dollar rupee euro yen inflationary premium premiums discount discounts duration basis spot forward forwards strike
volume volatility beta alpha delta gamma theta vega rho moat churn runway unicorn whale""".split())
# everyday number words in Indian news: explained in the dictionary, but never highlighted or counted as a concept
NEVER_HL = {"crore", "crores", "lakh", "lakhs", "lakh crore", "lakh crores", "million", "millions", "billion", "billions",
            "trillion", "trillions", "per cent", "percent", "percentage"}
BAD_ABBR = {"IT", "US", "AI", "CAT", "MAT", "PE", "IV", "OR", "AND", "ON", "IN", "AT", "ALL", "ARE", "CAN", "ONE", "NEW", "UK", "EU"}

def slug(s): return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")
def key(s): return re.sub(r"[^a-z0-9]+", "", re.sub(r"\([^)]*\)", " ", s.lower().replace("&", " and ")))
def clean(s): return re.sub(r"\s+", " ", str(s or "")).strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(ROOT / "content/glossary"))
    ap.add_argument("--out", default=str(ROOT / "dist/data/glossary"))
    a = ap.parse_args()
    src, out = pathlib.Path(a.src), pathlib.Path(a.out)
    if not any(f for f in src.glob("*.json") if not f.name.startswith("_")):
        src = ROOT / "tests/fixtures/glossary"   # no real content yet: build the small test fixture instead
        print("glossary: content/glossary is empty, using tests/fixtures/glossary", file=sys.stderr)
    entries, seen_id, seen_term, problems = [], {}, {}, []
    for f in sorted(src.glob("*.json")):
        if f.name.startswith("_"): continue
        try:
            rows = json.loads(f.read_text())
        except Exception as e:
            problems.append(f"{f.name}: unreadable ({e})"); continue
        if not isinstance(rows, list):
            problems.append(f"{f.name}: not a list"); continue
        for r in rows:
            if not isinstance(r, dict): continue
            term = clean(r.get("term")); cat = r.get("cat")
            short = clean(r.get("short"))
            if not term or cat not in CATS or not short:
                problems.append(f"{f.name}: skipped {term or '?'} (missing term/cat/short)"); continue
            eid = slug(r.get("id") or term) or slug(term)
            e = {"id": eid, "term": term, "cat": cat, "level": r.get("level") if r.get("level") in ("b", "i", "a") else "i",
                 "aliases": [clean(x) for x in (r.get("aliases") or []) if clean(x) and clean(x).lower() != term.lower()][:12],
                 "hl": [clean(x).lower() for x in (r.get("hl") or []) if clean(x)],
                 "abbr": [clean(x) for x in (r.get("abbr") or []) if clean(x)],
                 "short": short, "kid": clean(r.get("kid")), "detail": clean(r.get("detail")),
                 "example": clean(r.get("example")), "formula": clean(r.get("formula")),
                 "related": [clean(x) for x in (r.get("related") or []) if clean(x)][:8], "_file": f.name}
            k = key(term)
            if eid in seen_id or k in seen_term:
                prev = seen_id.get(eid) or seen_term.get(k)
                if len(e["detail"]) > len(prev["detail"]) + 80:   # keep the richer duplicate
                    entries[entries.index(prev)] = e; seen_id[eid] = e; seen_term[k] = e
                continue
            seen_id[eid] = e; seen_term[k] = e; entries.append(e)
    if not entries:
        print("no glossary entries found in", src, file=sys.stderr)
        out.mkdir(parents=True, exist_ok=True)
        (out / "index.json").write_text(json.dumps({"v": 1, "n": 0, "cats": {}, "t": []}))
        return

    # resolve related names → ids
    by_name = {}
    for e in entries:
        by_name.setdefault(key(e["term"]), e["id"])
    for e in entries:
        for al in e["aliases"]:
            by_name.setdefault(key(al), e["id"])
    unresolved = 0
    for e in entries:
        ids = []
        for name in e["related"]:
            rid = by_name.get(key(name)) or (name if name in seen_id else None)
            if rid and rid != e["id"] and rid not in ids: ids.append(rid)
            elif not rid: unresolved += 1
        e["related"] = ids[:6]

    # highlight phrases and acronyms: safe and unique dictionary-wide
    owner_hl, owner_ab = {}, {}
    def claim(table, phrase, e):
        cur = table.get(phrase)
        if cur is None: table[phrase] = e; return
        # prefer the entry whose own term (or acronym) is the phrase
        if key(e["term"]) == key(phrase) and key(cur["term"]) != key(phrase): table[phrase] = e
    for e in entries:
        for p in dict.fromkeys(e["hl"]):
            if len(p) < 3 or p in NEVER_HL or (" " not in p and "-" not in p and p in GENERIC): continue
            claim(owner_hl, p, e)
        for ab in dict.fromkeys(e["abbr"]):
            if ab.upper() in BAD_ABBR or len(ab) < 2 or not re.search(r"[A-Z]", ab): continue
            claim(owner_ab, ab, e)
    # the term name itself is also a safe highlight when it is multi-word
    for e in entries:
        t = e["term"].lower()
        if (" " in t or "-" in t) and len(t) > 6:
            owner_hl.setdefault(t, e)
    hl_of, ab_of = {}, {}
    for p, e in owner_hl.items(): hl_of.setdefault(e["id"], []).append(p)
    for p, e in owner_ab.items(): ab_of.setdefault(e["id"], []).append(p)

    entries.sort(key=lambda e: e["term"].lower())
    cats = {}
    for e in entries:
        cats.setdefault(e["cat"], 0); cats[e["cat"]] += 1
    index = {"v": 1, "n": len(entries),
             "cats": {c: {"name": CATS[c], "n": cats[c]} for c in CATS if c in cats},
             "t": [[e["id"], e["term"], e["cat"], e["level"], e["short"], e["aliases"],
                    sorted(hl_of.get(e["id"], []), key=len, reverse=True), sorted(ab_of.get(e["id"], []))] for e in entries]}
    (out / "entries").mkdir(parents=True, exist_ok=True)
    for old in (out / "entries").glob("*.json"): old.unlink()
    enc = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))
    (out / "index.json").write_text(enc(index))
    (out / "meta.json").write_text(enc({"n": len(entries), "cats": len(cats)}))   # tiny file for counts on other pages
    for c in cats:
        (out / "entries" / f"{c}.json").write_text(enc({e["id"]: {k: e[k] for k in ("kid", "detail", "example", "formula", "related")}
                                                        for e in entries if e["cat"] == c}))
    size = (out / "index.json").stat().st_size
    print(f"glossary: {len(entries)} terms in {len(cats)} categories; {len(owner_hl)} highlight phrases, {len(owner_ab)} acronyms; "
          f"index {size//1024} KB; {unresolved} related names unresolved; {len(problems)} problems")
    for p in problems[:20]: print("  -", p)

if __name__ == "__main__":
    main()
