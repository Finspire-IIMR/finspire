#!/usr/bin/env python3
"""Fetch a markets snapshot into data/live/markets.json (format: ARCHITECTURE.md → data/live/markets.json).

  quotes  every catalog instrument: CNBC quote service, Moneycontrol for the three NSE/BSE indices
  policy  RBI (rbi.org.in home page), Fed funds target range + ECB deposit rate (FRED CSV), Bank of England
          (bankofengland.co.uk), BoJ / PBoC from data/policy-manual.json
  curve   U.S. Treasury par yield curve: latest, ~1 month ago, ~1 year ago

Every number is parsed from a source and sanity-checked. When a source fails, the previous good value is reused from
the existing data/live/markets.json (or, if there is none and env SITE_URL is set, from <SITE_URL>data/live/markets.json)
and marked "stale": true. Nothing is ever invented. Per-source results go to data/live/status.json (kind "markets").
Standard library only (Python 3.9+)."""
import argparse, csv, datetime as dt, html, io, json, os, pathlib, re, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent.parent
LIVE = ROOT / "data" / "live"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
TIMEOUT = 20
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
UTC = dt.timezone.utc

# Instrument catalog: ids, providers and symbols are IDENTICAL to ARCHITECTURE.md and site/assets/js/markets.js.
# (id, group, provider, symbol, kind)  kind: "px" price (> 0) or "yld" yield in percent
CATALOG = [
    ("NIFTY", "india", "mc", "in;NSX", "px"), ("SENSEX", "india", "mc", "in;SEN", "px"),
    ("BANKNIFTY", "india", "mc", "in;nbx", "px"), ("INDIAVIX", "india", "cnbc", ".NIFVIX", "px"),
    ("SPX", "americas", "cnbc", ".SPX", "px"), ("NDX", "americas", "cnbc", ".IXIC", "px"),
    ("DJI", "americas", "cnbc", ".DJI", "px"), ("VIX", "americas", "cnbc", ".VIX", "px"),
    ("FTSE", "europe", "cnbc", ".FTSE", "px"), ("DAX", "europe", "cnbc", ".GDAXI", "px"),
    ("CAC", "europe", "cnbc", ".FCHI", "px"), ("STOXX50", "europe", "cnbc", ".STOXX50E", "px"),
    ("N225", "asia", "cnbc", ".N225", "px"), ("HSI", "asia", "cnbc", ".HSI", "px"), ("SSEC", "asia", "cnbc", ".SSEC", "px"),
    ("KOSPI", "asia", "cnbc", ".KS11", "px"), ("ASX200", "asia", "cnbc", ".AXJO", "px"), ("STI", "asia", "cnbc", ".STI", "px"),
    ("TWSE", "asia", "cnbc", ".TWII", "px"),
    ("US2Y", "yields", "cnbc", "US2Y", "yld"), ("US10Y", "yields", "cnbc", "US10Y", "yld"), ("US30Y", "yields", "cnbc", "US30Y", "yld"),
    ("IN10Y", "yields", "cnbc", "IN10Y", "yld"), ("DE10Y", "yields", "cnbc", "DE10Y", "yld"), ("GB10Y", "yields", "cnbc", "GB10Y", "yld"),
    ("JP10Y", "yields", "cnbc", "JP10Y", "yld"), ("CN10Y", "yields", "cnbc", "CN10Y", "yld"),
    ("GOLD", "commodities", "cnbc", "@GC.1", "px"), ("SILVER", "commodities", "cnbc", "@SI.1", "px"),
    ("BRENT", "commodities", "cnbc", "@LCO.1", "px"), ("WTI", "commodities", "cnbc", "@CL.1", "px"),
    ("NATGAS", "commodities", "cnbc", "@NG.1", "px"), ("COPPER", "commodities", "cnbc", "@HG.1", "px"),
    ("USDINR", "fx", "cnbc", "INR=", "px"), ("DXY", "fx", "cnbc", ".DXY", "px"), ("EURUSD", "fx", "cnbc", "EUR=", "px"),
    ("USDJPY", "fx", "cnbc", "JPY=", "px"), ("GBPUSD", "fx", "cnbc", "GBP=", "px"), ("USDCNY", "fx", "cnbc", "CNY=", "px"),
    ("BTC", "crypto", "cnbc", "BTC.CM=", "px"), ("ETH", "crypto", "cnbc", "ETH.CM=", "px"),
]
CNBC_URL = ("https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols={}&requestMethod=itv"
            "&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1")
MC_URL = "https://priceapi.moneycontrol.com/pricefeed/notapplicable/inidicesindia/{}"
RBI_URL = "https://www.rbi.org.in/"
FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={}"
BOE_URL = "https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate"
UST_URL = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{y}/all"
           "?type=daily_treasury_yield_curve&field_tdr_date_value={y}&page&_format=csv")
TENORS = [("1M", "1 Mo"), ("3M", "3 Mo"), ("6M", "6 Mo"), ("1Y", "1 Yr"), ("2Y", "2 Yr"), ("3Y", "3 Yr"), ("5Y", "5 Yr"),
          ("7Y", "7 Yr"), ("10Y", "10 Yr"), ("20Y", "20 Yr"), ("30Y", "30 Yr")]

# RBI home page labels → policy rows. Glossary ids are best guesses, resolved against the built glossary when given.
RBI_RATES = [
    ("rbi-repo", "Policy Repo Rate", "Policy repo rate", ["repo-rate"], ["Repo rate", "Policy repo rate"]),
    ("rbi-sdf", "Standing Deposit Facility Rate", "Standing deposit facility (SDF)",
     ["standing-deposit-facility"], ["Standing deposit facility", "SDF", "Standing deposit facility rate"]),
    ("rbi-msf", "Marginal Standing Facility Rate", "Marginal standing facility (MSF)",
     ["marginal-standing-facility"], ["Marginal standing facility", "MSF", "Marginal standing facility rate"]),
    ("rbi-crr", "CRR", "Cash reserve ratio (CRR)", ["cash-reserve-ratio"], ["Cash reserve ratio", "CRR"]),
    ("rbi-slr", "SLR", "Statutory liquidity ratio (SLR)", ["statutory-liquidity-ratio"], ["Statutory liquidity ratio", "SLR"]),
]
OTHER_TERMS = {
    "fed-funds": (["federal-funds-rate", "fed-funds-rate"], ["Federal funds rate", "Fed funds rate", "Federal funds target range"]),
    "ecb-dfr": (["deposit-facility-rate", "ecb-deposit-facility-rate"], ["Deposit facility rate", "ECB deposit facility rate"]),
    "boe-bank-rate": (["bank-rate"], ["Bank Rate", "Bank of England Bank Rate"]),
}


def log(*a):
    print(*a, file=sys.stderr)


def http_get(url, ua=UA, accept="*/*", timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": accept, "Accept-Language": "en-US,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def num(s):
    """'7,811.54' / '+0.59%' / '5.242%' / 'UNCH' / '' → float or None."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    s = str(s).strip().replace(",", "").replace("%", "").replace("+", "")
    if s.upper() == "UNCH":
        return 0.0
    try:
        v = float(s)
    except ValueError:
        return None
    return v if v == v and abs(v) != float("inf") else None


def iso_any(s, tz=None):
    """Parse ISO-ish timestamps ('2026-10-09T17:01:34.000-0400', '2026-10-12 08:51:28', '2026-10-09') → UTC ISO string.
    tz is used when the string carries no offset. Date-only strings stay date-only."""
    if not s:
        return None
    s = str(s).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return s
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$", s)
    if not m:
        return None
    y, mo, d, h, mi, sec, off = m.groups()
    if off in (None, ""):
        z = tz or UTC
    elif off == "Z":
        z = UTC
    else:
        sign = 1 if off[0] == "+" else -1
        off = off[1:].replace(":", "")
        z = dt.timezone(sign * dt.timedelta(hours=int(off[:2]), minutes=int(off[2:])))
    t = dt.datetime(int(y), int(mo), int(d), int(h), int(mi), int(sec or 0), tzinfo=z)
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_iso():
    return dt.datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def sane(v, kind):
    if v is None:
        return False
    if kind == "yld":
        return -1.0 < v < 25.0   # government bond yields can dip below zero (JGBs did)
    if kind == "rate":
        return 0.0 < v < 25.0
    return v > 0


# ---------------------------------------------------------------- quotes
def parse_cnbc(payload):
    """CNBC restQuote JSON → {symbol: quote dict}. Rows with code != 0 or failing sanity checks are skipped."""
    d = json.loads(payload) if isinstance(payload, (bytes, str)) else payload
    rows = ((d or {}).get("FormattedQuoteResult") or {}).get("FormattedQuote") or []
    if isinstance(rows, dict):
        rows = [rows]
    kinds = {sym: kind for _, _, prov, sym, kind in CATALOG if prov == "cnbc"}
    out = {}
    for r in rows:
        sym = r.get("symbol")
        if sym not in kinds or str(r.get("code")) != "0":
            continue
        kind = kinds[sym]
        last = num(r.get("last"))
        if not sane(last, kind):
            continue
        q = {"last": last, "chg": num(r.get("change")), "pct": num(r.get("change_pct")),
             "prev": num(r.get("previous_day_closing"))}
        for k in ("open", "high", "low"):
            v = num(r.get(k))
            q[k] = v if sane(v, kind) and v != 0 else None
        if q["prev"] is not None and not sane(q["prev"], kind):
            q["prev"] = None
        if q["chg"] is None and q["prev"] is not None:
            q["chg"] = round(last - q["prev"], 6)
        if str(r.get("change")).upper() == "UNCH" and not any(q[k] for k in ("open", "high", "low")):
            # CNBC prints UNCH with zero open/high/low when it has no session data for the symbol
            # (seen for .GDAXI, .FCHI, .STOXX50E, INR=): the change is unknown, not zero
            q["chg"] = q["pct"] = None
        if kind == "yld" and q["chg"] is not None and last - q["chg"] > 0:
            # CNBC's change_pct for yields is not always the relative change of the yield; derive it from the change
            q["pct"] = round(q["chg"] / (last - q["chg"]) * 100, 4)
        lt = str(r.get("last_time") or "")
        if str(r.get("last_timedate") or "").endswith("IST") and re.search(r"\+05:?00$", lt):
            lt = re.sub(r"\+05:?00$", "+0530", lt)   # CNBC labels Indian times IST but writes the offset as +0500
        q["asOf"] = iso_any(lt)
        q["rt"] = str(r.get("realTime")).lower() == "true"
        q["src"] = "cnbc"
        out[sym] = q
    return out


def parse_mc(payload):
    d = json.loads(payload) if isinstance(payload, (bytes, str)) else payload
    r = (d or {}).get("data") or {}
    last = num(r.get("pricecurrent"))
    if not sane(last, "px"):
        return None
    q = {"last": last, "chg": num(r.get("pricechange")), "pct": num(r.get("pricepercentchange")),
         "prev": num(r.get("priceprevclose"))}
    for k, src in (("open", "OPEN"), ("high", "HIGH"), ("low", "LOW")):
        v = num(r.get(src))
        q[k] = v if sane(v, "px") else None   # "0.00" before the open → null
    if q["prev"] is not None and not sane(q["prev"], "px"):
        q["prev"] = None
    q["asOf"] = iso_any(r.get("lastupdate") or r.get("lastupd"), IST)
    q["rt"] = True
    q["src"] = "mc"
    return q


def fetch_quotes():
    status = []
    quotes = {}
    cnbc_syms = [sym for _, _, prov, sym, _ in CATALOG if prov == "cnbc"]
    got, err, t0 = {}, [], time.time()
    for i in range(0, len(cnbc_syms), 14):
        chunk = cnbc_syms[i:i + 14]
        try:
            got.update(parse_cnbc(http_get(CNBC_URL.format(urllib.parse.quote("|".join(chunk), safe="")), accept="application/json")))
        except Exception as e:
            err.append(f"{chunk[0]}…: {e}")
    status.append({"id": "cnbc", "name": "CNBC quotes", "ok": bool(got), "n": len(got), "of": len(cnbc_syms),
                   "ms": int((time.time() - t0) * 1000), "error": "; ".join(err)[:300] or None,
                   "missing": [s for s in cnbc_syms if s not in got]})
    mc_got, mc_err, t0 = {}, [], time.time()
    for _, _, prov, sym, _ in CATALOG:
        if prov != "mc":
            continue
        try:
            q = parse_mc(http_get(MC_URL.format(urllib.parse.quote(sym, safe="")), accept="application/json"))
            if q:
                mc_got[sym] = q
            else:
                mc_err.append(f"{sym}: no usable price")
        except Exception as e:
            mc_err.append(f"{sym}: {e}")
    status.append({"id": "moneycontrol", "name": "Moneycontrol indices", "ok": bool(mc_got), "n": len(mc_got), "of": 3,
                   "ms": int((time.time() - t0) * 1000), "error": "; ".join(mc_err)[:300] or None})
    for iid, _, prov, sym, _ in CATALOG:
        q = (got if prov == "cnbc" else mc_got).get(sym)
        if q:
            quotes[iid] = q
    return quotes, status


# ---------------------------------------------------------------- policy rates
def page_text(raw):
    t = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    t = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", t)
    t = html.unescape(re.sub(r"<[^>]+>", " ", t))
    return re.sub(r"\s+", " ", t)


def parse_rbi(raw):
    """rbi.org.in home page → {label: value}. Labels as printed on the page ('Policy Repo Rate : 5.50%')."""
    text = page_text(raw)
    out = {}
    for _, label, *_ in RBI_RATES:
        m = re.search(r"(?<![A-Za-z])" + re.escape(label) + r"\s*:\s*(\d{1,2}(?:\.\d{1,2})?)\s*%", text)
        if m:
            v = float(m.group(1))
            if sane(v, "rate"):
                out[label] = v
    return out


def parse_fred(raw):
    """FRED graph CSV → (date, value) of the latest observation that is not '.'."""
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    rows = list(csv.reader(io.StringIO(text)))
    for row in reversed(rows[1:]):
        if len(row) >= 2 and re.fullmatch(r"\d{4}-\d{2}-\d{2}", row[0].strip()):
            v = num(row[1])
            if v is not None and row[1].strip() != ".":
                return row[0].strip(), v
    return None


def parse_boe(raw):
    text = page_text(raw)
    m = re.search(r"Current Bank Rate\s*(\d{1,2}(?:\.\d{1,2})?)\s*%", text)
    if not m:
        return None
    v = float(m.group(1))
    if not sane(v, "rate"):
        return None
    nxt = re.search(r"Next due:?\s*(\d{1,2} [A-Z][a-z]+ \d{4})", text)
    return {"value": v, "next": nxt.group(1) if nxt else None}


def pct2(v):
    return f"{v:.2f}%"


class Terms:
    """Resolves a policy row's glossary id against the built index (optional)."""
    def __init__(self, path):
        self.ids, self.by_name = set(), {}
        if not path:
            return
        try:
            idx = json.loads(pathlib.Path(path).read_text())
            for row in idx.get("t", []):
                self.ids.add(row[0])
                for name in [row[1]] + list(row[5] or []) + list(row[7] or []):
                    self.by_name.setdefault(self.key(name), row[0])
        except Exception as e:
            log("glossary not readable:", e)

    @staticmethod
    def key(s):
        return re.sub(r"[^a-z0-9]+", "", str(s).lower())

    def pick(self, ids, names):
        if not self.ids:
            return ids[0]
        for i in ids:
            if i in self.ids:
                return i
        for n in names:
            hit = self.by_name.get(self.key(n))
            if hit:
                return hit
        return ids[0]


def fetch_policy(terms):
    status, rows = [], []
    today = dt.datetime.now(IST).strftime("%Y-%m-%d")
    # RBI
    t0 = time.time()
    try:
        vals = parse_rbi(http_get(RBI_URL, accept="text/html"))
        for rid, label, name, ids, names in RBI_RATES:
            if label in vals:
                v = vals[label]
                rows.append({"id": rid, "bank": "Reserve Bank of India", "short": "RBI", "name": name, "value": v,
                             "display": pct2(v), "asOf": today, "src": "rbi.org.in", "term": terms.pick(ids, names)})
        status.append({"id": "rbi", "name": "RBI policy rates", "ok": len(vals) == len(RBI_RATES), "n": len(vals),
                       "of": len(RBI_RATES), "ms": int((time.time() - t0) * 1000),
                       "error": None if len(vals) == len(RBI_RATES) else "some labels not found on rbi.org.in"})
    except Exception as e:
        status.append({"id": "rbi", "name": "RBI policy rates", "ok": False, "n": 0, "of": len(RBI_RATES),
                       "ms": int((time.time() - t0) * 1000), "error": str(e)[:300]})
    # FRED: Fed funds target range + ECB deposit facility rate. FRED stalls on browser user-agents; use the default.
    t0, fred, ferr = time.time(), {}, []
    for sid in ("DFEDTARL", "DFEDTARU", "ECBDFR"):
        for ua in ("Python-urllib/3", "curl/8.7.1"):
            try:
                r = parse_fred(http_get(FRED_URL.format(sid), ua=ua, accept="text/csv,*/*"))
                if r and sane(r[1], "rate"):
                    fred[sid] = r
                    break
                ferr.append(f"{sid}: no usable value")
                break
            except Exception as e:
                ferr.append(f"{sid}: {e}")
    if "DFEDTARL" in fred and "DFEDTARU" in fred:
        (dl, lo), (du, hi) = fred["DFEDTARL"], fred["DFEDTARU"]
        if lo <= hi:
            ids, names = OTHER_TERMS["fed-funds"]
            rows.append({"id": "fed-funds", "bank": "Federal Reserve", "short": "Fed", "name": "Federal funds target range",
                         "value": hi, "lo": lo, "hi": hi, "display": f"{lo:.2f}% – {hi:.2f}%", "asOf": max(dl, du),
                         "src": "fred.stlouisfed.org", "term": terms.pick(ids, names)})
    if "ECBDFR" in fred:
        d, v = fred["ECBDFR"]
        ids, names = OTHER_TERMS["ecb-dfr"]
        rows.append({"id": "ecb-dfr", "bank": "European Central Bank", "short": "ECB", "name": "Deposit facility rate",
                     "value": v, "display": pct2(v), "asOf": d, "src": "fred.stlouisfed.org", "term": terms.pick(ids, names)})
    status.append({"id": "fred", "name": "FRED (Fed, ECB)", "ok": len(fred) == 3, "n": len(fred), "of": 3,
                   "ms": int((time.time() - t0) * 1000), "error": "; ".join(e for e in ferr if e.split(":")[0] not in fred)[:300] or None})
    # Bank of England
    t0 = time.time()
    try:
        b = parse_boe(http_get(BOE_URL, accept="text/html"))
        if not b:
            raise ValueError("Bank Rate not found on page")
        ids, names = OTHER_TERMS["boe-bank-rate"]
        row = {"id": "boe-bank-rate", "bank": "Bank of England", "short": "BoE", "name": "Bank Rate", "value": b["value"],
               "display": pct2(b["value"]), "asOf": today, "src": "bankofengland.co.uk", "term": terms.pick(ids, names)}
        if b["next"]:
            row["next"] = "Next decision " + b["next"]
        rows.append(row)
        status.append({"id": "boe", "name": "Bank of England", "ok": True, "n": 1, "of": 1, "ms": int((time.time() - t0) * 1000), "error": None})
    except Exception as e:
        status.append({"id": "boe", "name": "Bank of England", "ok": False, "n": 0, "of": 1, "ms": int((time.time() - t0) * 1000), "error": str(e)[:300]})
    # manual file (BoJ, PBoC …): copied as written; a null value stays null and displays as a dash
    n_manual = 0
    try:
        man = json.loads((ROOT / "data" / "policy-manual.json").read_text())
        for r in man.get("rates", []):
            if not isinstance(r, dict) or not r.get("id"):
                continue
            v = r.get("value")
            v = float(v) if isinstance(v, (int, float)) and sane(float(v), "rate") else None
            row = {k: r.get(k) for k in ("id", "bank", "short", "name", "src", "term")}
            row.update({"value": v, "display": (r.get("display") or pct2(v)) if v is not None else "—",
                        "asOf": r.get("asOf") or "", "manual": True})
            if r.get("next"):
                row["next"] = r["next"]
            rows.append(row)
            n_manual += v is not None
        status.append({"id": "manual", "name": "Manual rates file", "ok": True, "n": n_manual, "of": len(man.get("rates", [])),
                       "ms": 0, "error": None if n_manual else "values not filled in yet"})
    except Exception as e:
        status.append({"id": "manual", "name": "Manual rates file", "ok": False, "n": 0, "of": 0, "ms": 0, "error": str(e)[:300]})
    return rows, status


# ---------------------------------------------------------------- treasury curve
def parse_ust(raw):
    """Treasury daily par yield curve CSV → {date 'YYYY-MM-DD': [11 yields or None]}."""
    text = raw.decode("utf-8-sig", "replace") if isinstance(raw, bytes) else raw
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        m = re.fullmatch(r"(\d{2})/(\d{2})/(\d{4})", (r.get("Date") or "").strip())
        if not m:
            continue
        y = []
        for _, col in TENORS:
            v = num(r.get(col))
            y.append(v if sane(v, "yld") else None)
        if sum(v is not None for v in y) >= 8:
            out[f"{m.group(3)}-{m.group(1)}-{m.group(2)}"] = y
    return out


def pick_curve(rows):
    if not rows:
        return None
    dates = sorted(rows)
    latest = dates[-1]
    ld = dt.date.fromisoformat(latest)

    def on_or_before(target):
        c = [d for d in dates if d <= target.isoformat()]
        return c[-1] if c else None
    series = [{"key": "latest", "date": latest, "y": rows[latest]}]
    for key, delta in (("m1", dt.timedelta(days=30)), ("y1", dt.timedelta(days=365))):
        d = on_or_before(ld - delta)
        # accept only a date reasonably close to the target (holidays/weekends), never a far older one
        if d and (ld - delta - dt.date.fromisoformat(d)).days <= 7:
            series.append({"key": key, "date": d, "y": rows[d]})
    return {"src": "U.S. Treasury", "tenors": [t for t, _ in TENORS], "series": series}


def fetch_curve():
    t0, rows, err = time.time(), {}, []
    year = dt.datetime.now(UTC).year
    for y in (year, year - 1):
        try:
            rows.update(parse_ust(http_get(UST_URL.format(y=y), accept="text/csv,*/*")))
        except Exception as e:
            err.append(f"{y}: {e}")
    curve = pick_curve(rows)
    ok = bool(curve) and len(curve["series"]) == 3
    return curve, {"id": "treasury", "name": "U.S. Treasury yield curve", "ok": ok,
                   "n": len(curve["series"]) if curve else 0, "of": 3, "ms": int((time.time() - t0) * 1000),
                   "error": "; ".join(err)[:300] or (None if ok else "curve incomplete")}


# ---------------------------------------------------------------- previous snapshot + status
def load_previous(name):
    p = LIVE / name
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception as e:
            log(f"previous {name} unreadable: {e}")
    site = os.environ.get("SITE_URL", "").strip()
    if site:
        url = site.rstrip("/") + "/data/live/" + name
        try:
            return json.loads(http_get(url, accept="application/json"))
        except Exception as e:
            log(f"no previous {name} at {url}: {e}")
    return None


def write_status(kind, sources):
    """Replace this script's rows in data/live/status.json, keeping the other script's rows."""
    p = LIVE / "status.json"
    try:
        cur = json.loads(p.read_text()) if p.exists() else {}
    except Exception:
        cur = {}
    keep = [s for s in cur.get("sources", []) if s.get("kind") != kind]
    for s in sources:
        s["kind"] = kind
    out = {"updated": now_iso(), "sources": keep + sources}
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=str(LIVE / "markets.json"))
    ap.add_argument("--glossary", help="built glossary index.json, to check policy-rate term ids")
    a = ap.parse_args()
    LIVE.mkdir(parents=True, exist_ok=True)
    prev = load_previous("markets.json") or {}
    terms = Terms(a.glossary)

    with ThreadPoolExecutor(3) as ex:
        fq, fp, fc = ex.submit(fetch_quotes), ex.submit(fetch_policy, terms), ex.submit(fetch_curve)
        (quotes, qs), (policy, ps), (curve, cs) = fq.result(), fp.result(), fc.result()

    # fall back to the previous good value per instrument / per rate / for the curve
    reused = []
    for iid, *_ in CATALOG:
        if iid not in quotes and isinstance((prev.get("quotes") or {}).get(iid), dict):
            q = dict(prev["quotes"][iid]); q["stale"] = True
            quotes[iid] = q; reused.append(iid)
    have = {r["id"] for r in policy}
    for r in prev.get("policy") or []:
        if isinstance(r, dict) and r.get("id") and r["id"] not in have and not r.get("manual"):
            r = dict(r); r["stale"] = True
            policy.append(r); reused.append(r["id"])
    if (not curve or len(curve.get("series", [])) < 3) and isinstance(prev.get("curve"), dict):
        if not curve or len(prev["curve"].get("series", [])) > len(curve.get("series", [])):
            curve = dict(prev["curve"]); curve["stale"] = True; reused.append("curve")
    order = [r[0] for r in RBI_RATES] + ["fed-funds", "ecb-dfr", "boe-bank-rate"]
    policy.sort(key=lambda r: order.index(r["id"]) if r["id"] in order else 99)
    quotes = {iid: quotes[iid] for iid, *_ in CATALOG if iid in quotes}

    out = {"updated": now_iso(), "quotes": quotes, "policy": policy, "curve": curve}
    pathlib.Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    sources = qs + ps + [cs]
    write_status("markets", sources)

    print(f"markets: {len(quotes)}/{len(CATALOG)} quotes, {sum(1 for r in policy if r.get('value') is not None)}/{len(policy)} policy rates, "
          f"curve {'+'.join(s['key'] for s in (curve or {}).get('series', [])) or 'none'}; reused previous: {', '.join(reused) or 'nothing'}")
    for s in sources:
        print(f"  {'ok  ' if s['ok'] else 'FAIL'} {s['name']:<28} {s['n']}/{s['of']} {s['ms']:>5} ms  {s.get('error') or ''}")
    missing = [iid for iid, *_ in CATALOG if iid not in quotes]
    if missing:
        print("  missing instruments:", ", ".join(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
