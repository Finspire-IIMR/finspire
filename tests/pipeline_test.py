#!/usr/bin/env python3
"""Tests for the data pipeline (scripts/fetch_markets.py, scripts/fetch_news.py).

    python3 tests/pipeline_test.py            unit tests on saved samples, then a real run of both fetchers
                                              (writes data/live/) with the outputs validated against ARCHITECTURE.md,
                                              then a Python ↔ JavaScript term-matching parity check in headless Chrome
    python3 tests/pipeline_test.py --offline  unit tests only (no network)

Samples live in tests/fixtures/feeds (RSS 2.0, RSS 1.0/RDF, Atom, Google News, broken XML) and tests/fixtures/markets.
Exit code is non-zero on any failure. Standard library only (plus node + Chrome for the optional parity check)."""
import datetime as dt, json, pathlib, re, shutil, socket, subprocess, sys, tempfile, time, unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import fetch_markets as fm  # noqa: E402
import fetch_news as fn     # noqa: E402

FEEDS = ROOT / "tests/fixtures/feeds"
MKT = ROOT / "tests/fixtures/markets"
NOW = dt.datetime(2026, 10, 12, 4, 0, tzinfo=dt.timezone.utc)
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

GLOSS = {"v": 1, "n": 6, "cats": {}, "t": [
    ["repo-rate", "Repo rate", "central-banks", "b", "", ["policy repo rate"], ["policy repo rate", "repo rate", "repo rates"], []],
    ["reserve-bank-of-india", "Reserve Bank of India", "india-econ", "b", "", [], ["reserve bank of india"], ["RBI"]],
    ["ipo", "Initial public offering", "ib-deals", "b", "", ["IPO"], ["initial public offering"], ["IPO"]],
    ["gdp", "Gross domestic product", "macro", "b", "", ["GDP"], ["gross domestic product"], ["GDP"]],
    ["inflation", "Inflation", "macro", "b", "", [], ["inflation"], []],
    ["bond-yield", "Bond yield", "bonds", "b", "", [], ["bond yield", "bond yields"], []],
]}


def feed(fid):
    return fn.FEED_BY_ID[fid]


def items_of(fixture, fid):
    return fn.normalise(fn.parse_feed((FEEDS / fixture).read_bytes()), feed(fid), NOW)


# ====================================================================== news: parsing
class FeedParsing(unittest.TestCase):
    def test_rss_cdata_and_ist_dates(self):
        its = items_of("rss_cdata_et.xml", "et-markets")
        self.assertEqual(len(its), 3)
        it = its[0]
        self.assertTrue(it["t"].startswith("Zetwerk Manufacturing Business IPO price band"))
        self.assertNotIn("<![CDATA[", it["t"] + it["s"])
        self.assertTrue(ISO.match(it["ts"]), it["ts"])
        # "Mon, 12 Oct 2026 09:xx:xx +0530" → 03:xx UTC
        self.assertTrue(it["ts"].startswith("2026-10-12T0"), it["ts"])
        self.assertEqual(it["src"], "Economic Times")
        self.assertEqual(len(it["id"]), 12)
        self.assertTrue(re.fullmatch(r"[0-9a-f]{12}", it["id"]))

    def test_numeric_entities_and_tracking_params(self):
        its = items_of("rss_entities_marketwatch.xml", "marketwatch")
        self.assertTrue(its)
        self.assertTrue(any("‘" in i["t"] or "’" in i["t"] for i in its), [i["t"] for i in its])
        self.assertFalse(any("&#x" in i["t"] or "&amp;" in i["t"] for i in its))
        self.assertFalse(any("mod=" in i["u"] for i in its), [i["u"] for i in its])

    def test_rdf_rss1_without_dates(self):
        raw = fn.parse_feed((FEEDS / "rdf_nikkei.xml").read_bytes())
        self.assertEqual(len(raw), 3)
        self.assertTrue(all(r["link"].startswith("https://asia.nikkei.com/") for r in raw))
        its = fn.normalise(raw, feed("nikkei"), NOW)
        self.assertTrue(all(i["ts"] is None for i in its))       # never invented; filled from the article page later

    def test_google_news_publisher_and_empty_snippet(self):
        its = items_of("rss_googlenews_in.xml", "gn-in")
        self.assertEqual(len(its), 3)
        for i in its:
            self.assertEqual(i["s"], "")
            self.assertNotEqual(i["src"], "Google News")
            self.assertFalse(i["t"].endswith(" - " + i["src"]), i["t"])
            self.assertTrue(i["u"].startswith("https://news.google.com/"))

    def test_atom_with_html_and_xhtml(self):
        its = fn.normalise(fn.parse_feed((FEEDS / "atom_sample.xml").read_bytes()), feed("ecb"), NOW)
        self.assertEqual(len(its), 2, its)                      # javascript: link dropped
        a, b = its
        self.assertEqual(a["t"], "Bank holds policy rate at 4.00% & signals patience")
        self.assertEqual(a["ts"], "2026-10-11T06:30:00Z")        # +02:00 → UTC, <published> preferred over <updated>
        self.assertNotIn("utm_source", a["u"])
        self.assertIn("id=7", a["u"])
        self.assertIn("repo rate", a["s"])
        self.assertNotIn("<", a["s"])
        self.assertEqual(b["t"], "Bond yields fall as GDP data disappoints")
        self.assertIn("8 basis points", b["s"])

    def test_broken_xml_is_recovered(self):
        raw = fn.parse_feed((FEEDS / "bad_xml.xml").read_bytes())
        titles = [fn.clean_text(r["title"]) for r in raw]
        self.assertIn("Sensex & Nifty rally 1% as FIIs return", titles)
        self.assertTrue(any(t.startswith("Rupee hits record low") for t in titles), titles)

    def test_garbage_raises(self):
        with self.assertRaises(ValueError):
            fn.parse_feed(b"<html><body>Service unavailable</body></html>")
        with self.assertRaises(ValueError):
            fn.parse_feed(b"\x00\x01 not xml at all")

    def test_naive_dates_use_feed_timezone(self):
        its = items_of("rss_naive_dates_investing.xml", "investing")
        self.assertTrue(its)
        self.assertTrue(all(ISO.match(i["ts"]) for i in its))

    def test_future_dates_are_clamped(self):
        raw = [{"title": "Sensex jumps 500 points in early trade", "link": "https://example.com/a",
                "desc": "", "date": "Tue, 13 Oct 2026 09:00:00 +0530"}]
        it = fn.normalise(raw, feed("et-markets"), NOW)[0]
        self.assertEqual(it["ts"], "2026-10-12T04:00:00Z")

    def test_wordpress_boilerplate_and_length(self):
        its = fn.normalise(fn.parse_feed((FEEDS / "rss_wordpress.xml").read_bytes()), feed("oilprice"), NOW)
        s = its[0]["s"]
        self.assertNotIn("appeared first on", s)
        self.assertNotIn("The post", s)
        self.assertLessEqual(len(s), 260)
        self.assertTrue(s.endswith("…"), s)
        self.assertFalse(s[:-1].endswith(" "))

    def test_snippet_rules(self):
        self.assertEqual(fn.clean_snippet("Fed holds rates", "Fed holds rates"), "")
        self.assertEqual(fn.clean_snippet("<p>Shares rose.</p><p>Continue reading...</p>", "x"), "Shares rose.")
        self.assertEqual(fn.clean_snippet("MUMBAI (Reuters) - Bonds fell on Monday.", "x"), "Bonds fell on Monday.")
        long = "word " * 120
        out = fn.clean_snippet(long, "t")
        self.assertLessEqual(len(out), 260)
        self.assertTrue(out.endswith("word…"))

    def test_url_cleaning(self):
        self.assertEqual(fn.clean_url("javascript:alert(1)"), "")
        self.assertEqual(fn.clean_url("/relative/path"), "")
        self.assertEqual(fn.clean_url("https://WWW.Example.com/a?utm_source=x&id=3&at_medium=RSS"), "https://www.example.com/a?id=3")
        self.assertNotEqual(fn.item_id("https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=1"),
                            fn.item_id("https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=2"))
        self.assertEqual(fn.item_id("https://www.bbc.co.uk/news/x"), fn.item_id("https://bbc.co.uk/news/x/"))


# ====================================================================== news: filtering and classification
class Classification(unittest.TestCase):
    def tag(self, title, snippet="", fid="gn-us"):
        it = {"t": title, "s": snippet, "u": "https://example.com/n/" + str(abs(hash(title))), "id": "x"}
        rg, mk, ms = fn.classify(it, feed(fid))
        return rg, mk, fn.keep_item(it, feed(fid), ms, [])

    def test_regions(self):
        self.assertEqual(self.tag("Rupee opens 1% higher on RBI measures")[0][0], "in")
        self.assertEqual(self.tag("Wall Street ends higher as Fed signals patience")[0][0], "us")
        self.assertEqual(self.tag("ECB holds deposit rate; Lagarde warns on energy")[0][0], "eu")
        self.assertEqual(self.tag("Kospi and Nikkei 225 slip as yen firms", fid="gn-in")[0][0], "ap")
        self.assertEqual(self.tag("Saudi Aramco raises oil prices for Asia")[0][0], "me")
        self.assertIn("gl", self.tag("IMF cuts world economy growth forecast")[0])
        # feed default when nothing is named
        self.assertEqual(self.tag("Acme Robotics IPO price band set; issue opens on Thursday", fid="gn-sg")[0], ["ap"])
        self.assertEqual(self.tag("Premier Energies shares in focus after fresh orders worth Rs 4,000 crore")[0][0], "in")
        self.assertEqual(self.tag("New vape tax made me swap e-cigs for dartboards", fid="bbc")[0], ["eu"])

    def test_markets_multi_label(self):
        _, mk, _ = self.tag("RBI cuts repo rate; bond yields fall and rupee firms")
        self.assertEqual(mk[0], "cb")
        self.assertTrue({"cb", "rates", "fx"} <= set(mk), mk)
        self.assertEqual(self.tag("Bitcoin tops $90,000 as stablecoin inflows jump")[1][0], "crypto")
        self.assertEqual(self.tag("Brent crude falls 2% as OPEC+ weighs output")[1][0], "cmd")
        self.assertIn("deals", self.tag("Amazon in talks to buy AI startup for $7 billion")[1])
        self.assertIn("econ", self.tag("India's GDP growth slows to 5.1% as exports weaken")[1])
        self.assertIn("policy", self.tag("Sebi tightens F&O rules for retail traders")[1])
        self.assertIn("stocks", self.tag("Sensex, Nifty open higher; IT stocks lead")[1])

    def test_noise_is_dropped(self):
        self.assertFalse(self.tag("My aunt gave me $50,000 for a down payment. Now she wants it back")[2])
        self.assertFalse(self.tag("Citroen revives the 2CV for an electric age", fid="bbc")[2])
        self.assertFalse(self.tag("NBA commissioner Adam Silver says league could add a smart ball")[2])
        self.assertFalse(self.tag("The Walmart Deals event ends today — 40+ last-chance discounts to shop now")[2])
        self.assertTrue(self.tag("My stock portfolio is swinging wildly as the S&P 500 falls 3%")[2])
        it = {"t": "Bandai gains ground in Asia", "s": "", "u": "https://asia.nikkei.com/spotlight/my-personal-history/x", "id": "x"}
        self.assertFalse(fn.keep_item(it, feed("nikkei"), {"stocks": 3}, []))
        # a glossary term is enough to keep an otherwise quiet story
        self.assertTrue(fn.keep_item({"t": "What a primary deficit means", "s": "", "u": "https://e.com/x"}, feed("gn-us"), {}, ["gdp"]))

    def test_routine_central_bank_notices(self):
        its = items_of("rss_rbi.xml", "rbi")
        kept = [i["t"] for i in its if fn.keep_item(i, feed("rbi"), {}, [])]
        dropped = [i["t"] for i in its if i["t"] not in kept]
        for t in ("Money Market Operations", "Auction of State Government Securities", "Treasury Bills",
                  "Variable Rate Reverse Repo", "OMO Sale", "Weekly Statistical Supplement"):
            self.assertTrue(any(t in d for d in dropped), (t, dropped))
        self.assertTrue(any("Foreign Exchange Market" in k for k in kept), kept)
        fed = items_of("rss_fed.xml", "fed")
        fed_kept = [i["t"] for i in fed if fn.keep_item(i, feed("fed"), {}, [])]
        self.assertFalse(any("approval of application" in t for t in fed_kept))
        self.assertFalse(any("enforcement action" in t for t in fed_kept))
        self.assertTrue(fed_kept)

    def test_google_news_middle_east_search_needs_region(self):
        it = {"t": "Baton Rouge regular gas stays about $3.92 as oil production recovers", "s": "",
              "u": "https://news.google.com/rss/articles/abc", "id": "x"}
        _, _, ms = fn.classify(it, feed("gn-mea"))
        self.assertFalse(fn.keep_item(it, feed("gn-mea"), ms, []))
        it["t"] = "Saudi Arabia raises crude exports as Hormuz shipments recover"
        _, _, ms = fn.classify(it, feed("gn-mea"))
        self.assertTrue(fn.keep_item(it, feed("gn-mea"), ms, []))


# ====================================================================== news: term matching (same rules as the JS)
class TermMatching(unittest.TestCase):
    g = fn.Glossary(GLOSS)

    def ids(self, text):
        return [m["id"] for m in self.g.match(text)]

    def test_case_rules(self):
        self.assertEqual(self.ids("RBI holds the Repo Rate"), ["reserve-bank-of-india", "repo-rate"])
        self.assertEqual(self.ids("rbi holds"), [])                       # acronyms are case-sensitive
        self.assertEqual(self.ids("Gdp and gdp"), [])

    def test_word_boundaries_and_no_plurals(self):
        self.assertEqual(self.ids("IPOs flood the market"), [])
        self.assertEqual(self.ids("IPO-bound firms"), ["ipo"])
        self.assertEqual(self.ids("hyperinflation"), [])
        self.assertEqual(self.ids("non-inflation"), ["inflation"])         # a hyphen is a boundary
        self.assertEqual(self.ids("GDP2 RBI3"), [])

    def test_longest_wins_and_once_per_term(self):
        m = self.g.match("The policy repo rate and the repo rate again")
        self.assertEqual([x["id"] for x in m], ["repo-rate"])
        self.assertEqual((m[0]["start"], m[0]["end"]), (4, 20))
        self.assertEqual(self.ids("bond yields rise; bond yield falls"), ["bond-yield"])

    def test_terms_across_headline_and_snippet(self):
        self.assertEqual(self.g.terms_in("RBI flags inflation", "Inflation and GDP; the RBI again"),
                         ["reserve-bank-of-india", "inflation", "gdp"])

    def test_empty_glossary(self):
        self.assertEqual(fn.Glossary(None).match("RBI repo rate"), [])


# ====================================================================== news: dedupe, selection
class DedupeSelect(unittest.TestCase):
    def it(self, t, u, fid, s="", ts="2026-10-12T03:00:00Z", src=None):
        return {"id": fn.item_id(u), "t": t, "s": s, "u": u, "src": src or fn.FEED_BY_ID[fid][1], "ts": ts, "_feed": fid}

    def test_same_url_and_near_identical_titles(self):
        a = self.it("Oil falls on hopes Russia-Ukraine energy ceasefire will boost supplies",
                    "https://news.google.com/rss/articles/1", "gn-us", src="Reuters")
        b = self.it("Oil falls on hopes Russia–Ukraine energy ceasefire will boost supplies",
                    "https://www.business-standard.com/markets/oil-falls.html", "business-standard", s="Brent fell.")
        c = self.it("Oil falls on hopes Russia-Ukraine energy ceasefire boost supplies",
                    "https://example.org/oil", "oilprice")
        d = self.it("Something else entirely about gold", "https://www.business-standard.com/markets/oil-falls.html?utm_source=x",
                    "livemint")
        out = fn.dedupe([a, b, c, d])
        self.assertEqual(len(out), 1, [o["t"] for o in out])
        self.assertEqual(out[0]["src"], "Business Standard")         # direct publisher beats Google News
        self.assertEqual(out[0]["s"], "Brent fell.")

    def test_snippet_filled_from_duplicate(self):
        a = self.it("Fed minutes show officials split on December cut", "https://a.example/x", "cnbc-top")
        b = self.it("Fed minutes show officials split on December cut", "https://b.example/y", "marketwatch", s="Minutes showed…")
        out = fn.dedupe([a, b])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["s"], "Minutes showed…")

    def test_distinct_stories_survive(self):
        a = self.it("Sensex rises 300 points; Nifty near 22,600", "https://a.example/1", "et-markets")
        b = self.it("Sensex falls 300 points; Nifty near 22,400", "https://a.example/2", "et-markets")
        self.assertEqual(len(fn.dedupe([a, b])), 2)

    def test_select_keeps_variety(self):
        items = []
        for i in range(500):
            items.append({"id": f"e{i}", "src": "Economic Times", "ts": f"2026-10-12T03:{i % 60:02d}:00Z", "rg": ["in"], "mk": ["stocks"]})
        items.append({"id": "rbi", "src": "RBI", "ts": "2026-10-10T00:00:00Z", "rg": ["in"], "mk": ["cb"]})
        items.append({"id": "me", "src": "Gulf News", "ts": "2026-10-09T12:00:00Z", "rg": ["me"], "mk": ["cmd"]})
        out = fn.select(items, 400)
        self.assertEqual(len(out), 400)
        ids = {o["id"] for o in out}
        self.assertIn("rbi", ids)
        self.assertIn("me", ids)
        self.assertEqual([o["ts"] for o in out], sorted((o["ts"] for o in out), reverse=True))


# ====================================================================== markets parsing
class MarketsParsing(unittest.TestCase):
    def test_catalog_matches_architecture(self):
        t = (ROOT / "ARCHITECTURE.md").read_text()
        sec = t[t.index("### Instrument catalog"):t.index("Live sources")]
        spec = []
        for line in sec.splitlines():
            m = re.match(r"- (\w+): (.*)", line)
            if m:
                for mm in re.finditer(r"([A-Z][A-Z0-9]+)\s*(?:\((mc|cnbc)\s*|→ use\s*)?`([^`]+)`", m.group(2)):
                    spec.append((mm.group(1), m.group(1), mm.group(2) or "cnbc", mm.group(3)))
        self.assertEqual(len(spec), 41)
        self.assertEqual([c[:4] for c in fm.CATALOG], spec)
        js = ROOT / "site/assets/js/markets.js"
        if js.exists():                                          # keep markets.js in step too
            src = js.read_text()
            for iid, _, _, sym in spec:
                self.assertRegex(src, r"[\"']" + re.escape(iid) + r"[\"']", f"{iid} missing from markets.js")
                self.assertIn(sym, src, f"{sym} missing from markets.js")

    def test_cnbc(self):
        q = fm.parse_cnbc((MKT / "cnbc.json").read_bytes())
        self.assertNotIn("NOPE.X", q)
        spx = q[".SPX"]
        self.assertGreater(spx["last"], 0)
        self.assertEqual(spx["src"], "cnbc")
        self.assertIsInstance(spx["rt"], bool)
        self.assertTrue(spx["asOf"])
        y = q["US10Y"]
        self.assertTrue(0 < y["last"] < 25)
        if y["chg"] is not None and y["prev"]:
            self.assertAlmostEqual(y["pct"], y["chg"] / y["prev"] * 100, places=2)
        if "+" in json.dumps(q[".NIFVIX"]["asOf"]):
            self.fail("asOf must be UTC")

    def test_cnbc_unch_without_session_is_unknown(self):
        payload = {"FormattedQuoteResult": {"FormattedQuote": [
            {"symbol": ".GDAXI", "code": 0, "last": "25,087.27", "change": "UNCH", "change_pct": "UNCH",
             "previous_day_closing": "25,087.27", "open": "0.00", "high": "0.00", "low": "0.00", "last_time": "2026-10-09",
             "realTime": "false"},
            {"symbol": ".SPX", "code": 0, "last": "-5", "change": "1"},
            {"symbol": ".VIX", "code": 1, "last": "15"},
            {"symbol": "US2Y", "code": 0, "last": "4.791%", "change": "+0.035", "change_pct": "+0.74%",
             "previous_day_closing": "4.756%", "open": "4.766%", "high": "4.821%", "low": "4.747%",
             "last_time": "2026-10-09T17:05:00.000-0400", "realTime": "true"}]}}
        q = fm.parse_cnbc(payload)
        self.assertIsNone(q[".GDAXI"]["chg"])
        self.assertIsNone(q[".GDAXI"]["open"])
        self.assertNotIn(".SPX", q)          # negative price rejected
        self.assertNotIn(".VIX", q)          # error code
        self.assertEqual(q["US2Y"]["asOf"], "2026-10-09T21:05:00Z")
        self.assertEqual(q["US2Y"]["last"], 4.791)

    def test_moneycontrol(self):
        q = fm.parse_mc((MKT / "mc_sensex.json").read_bytes())
        self.assertGreater(q["last"], 1000)
        self.assertEqual(q["src"], "mc")
        self.assertTrue(ISO.match(q["asOf"]))
        self.assertIsNone(fm.parse_mc({"data": {"pricecurrent": "0.00"}}))

    def test_rbi_boe_fred(self):
        r = fm.parse_rbi((MKT / "rbi_home_excerpt.html").read_bytes())
        self.assertEqual(set(r), {"Policy Repo Rate", "Standing Deposit Facility Rate", "Marginal Standing Facility Rate", "CRR", "SLR"})
        self.assertTrue(all(0 < v < 25 for v in r.values()))
        self.assertEqual(fm.parse_rbi("Policy Repo Rate : 55.00% CRR : 3.00%"), {"CRR": 3.0})   # sanity check
        b = fm.parse_boe((MKT / "boe_excerpt.html").read_bytes())
        self.assertTrue(0 < b["value"] < 25)
        self.assertRegex(b["next"] or "", r"\d{1,2} [A-Z][a-z]+ \d{4}")
        d, v = fm.parse_fred((MKT / "fred_ecbdfr.csv").read_bytes())
        self.assertRegex(d, r"^\d{4}-\d{2}-\d{2}$")
        self.assertEqual(fm.parse_fred("observation_date,X\n2026-10-08,2.50\n2026-10-09,.\n"), ("2026-10-08", 2.5))
        self.assertIsNone(fm.parse_fred("observation_date,X\n2026-10-09,.\n"))

    def test_treasury_curve(self):
        rows = fm.parse_ust((MKT / "ust_2026.csv").read_bytes())
        rows.update(fm.parse_ust((MKT / "ust_2025.csv").read_bytes()))
        c = fm.pick_curve(rows)
        self.assertEqual(c["tenors"], ["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"])
        self.assertEqual([s["key"] for s in c["series"]], ["latest", "m1", "y1"])
        latest = dt.date.fromisoformat(c["series"][0]["date"])
        self.assertLessEqual((latest - dt.date.fromisoformat(c["series"][1]["date"])).days, 37)
        self.assertGreaterEqual((latest - dt.date.fromisoformat(c["series"][2]["date"])).days, 365)
        self.assertTrue(all(len(s["y"]) == 11 for s in c["series"]))
        # a curve with no history a year back does not invent one
        only = {k: v for k, v in rows.items() if k >= "2026-08-01"}
        self.assertEqual([s["key"] for s in fm.pick_curve(only)["series"]], ["latest", "m1"])

    def test_number_parsing(self):
        self.assertEqual(fm.num("7,811.54"), 7811.54)
        self.assertEqual(fm.num("+0.59%"), 0.59)
        self.assertEqual(fm.num("UNCH"), 0.0)
        self.assertIsNone(fm.num("N/A"))
        self.assertIsNone(fm.num("nan"))
        self.assertFalse(fm.sane(0, "px"))
        self.assertFalse(fm.sane(30, "rate"))
        self.assertTrue(fm.sane(-0.1, "yld"))


# ====================================================================== live run + validation
def validate_markets(m, report):
    errs = []
    if not (isinstance(m.get("updated"), str) and ISO.match(m["updated"])):
        errs.append("markets.updated not ISO")
    q = m.get("quotes") or {}
    ids = [c[0] for c in fm.CATALOG]
    kinds = {c[0]: c[4] for c in fm.CATALOG}
    for k, v in q.items():
        if k not in ids:
            errs.append(f"unknown instrument {k}")
            continue
        if not isinstance(v.get("last"), (int, float)) or not fm.sane(v["last"], kinds[k]):
            errs.append(f"{k}: bad last {v.get('last')}")
        if v.get("src") not in ("cnbc", "mc"):
            errs.append(f"{k}: bad src")
        for f in ("chg", "pct", "prev", "open", "high", "low"):
            if v.get(f) is not None and not isinstance(v[f], (int, float)):
                errs.append(f"{k}.{f} not a number")
        if not isinstance(v.get("rt"), bool):
            errs.append(f"{k}.rt not bool")
        if v.get("asOf") and not re.match(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$", v["asOf"]):
            errs.append(f"{k}.asOf {v['asOf']}")
    missing = [i for i in ids if i not in q]
    if len(missing) > 4:
        errs.append(f"too many instruments missing: {missing}")
    pol = m.get("policy") or []
    need = {"rbi-repo", "rbi-sdf", "rbi-msf", "rbi-crr", "rbi-slr", "fed-funds", "ecb-dfr", "boe-bank-rate", "boj", "pboc-lpr"}
    have = {p.get("id") for p in pol}
    if need - have:
        errs.append(f"policy rows missing: {sorted(need - have)}")
    for p in pol:
        for f in ("id", "bank", "short", "name", "display", "src", "term"):
            if not isinstance(p.get(f), str) or not p[f]:
                errs.append(f"policy {p.get('id')}: {f} missing")
        v = p.get("value")
        if v is not None and not (0 < v < 25):
            errs.append(f"policy {p['id']}: value {v}")
        if v is None and p.get("display") != "—":
            errs.append(f"policy {p['id']}: null value must display as a dash")
        if v is not None and not re.match(r"^\d{4}-\d{2}-\d{2}$", p.get("asOf") or ""):
            errs.append(f"policy {p['id']}: asOf {p.get('asOf')}")
    c = m.get("curve")
    if not c or c.get("tenors") != [t for t, _ in fm.TENORS]:
        errs.append("curve tenors")
    else:
        for s in c.get("series", []):
            if len(s.get("y", [])) != 11 or not re.match(r"^\d{4}-\d{2}-\d{2}$", s.get("date", "")):
                errs.append(f"curve series {s.get('key')}")
        if [s["key"] for s in c["series"]][:1] != ["latest"]:
            errs.append("curve without latest")
    report.append(f"markets: {len(q)}/{len(ids)} instruments ({sum(1 for v in q.values() if v.get('stale'))} reused); "
                  f"missing: {', '.join(missing) or 'none'}")
    by_src = {}
    for k, v in q.items():
        by_src.setdefault(v["src"], []).append(k)
    for s, ks in by_src.items():
        report.append(f"  {s}: {', '.join(ks)}")
    report.append("  policy: " + "; ".join(f"{p['short']} {p['name']} {p['display']}" + (" (stale)" if p.get("stale") else "")
                                          for p in pol))
    if c:
        report.append("  curve: " + ", ".join(f"{s['key']} {s['date']} 10Y {s['y'][8]}" for s in c["series"]))
    return errs


def validate_news(n, arch, terms, gl_ids, report):
    errs = []
    now = dt.datetime.now(dt.timezone.utc)
    items = n.get("items") or []
    if n.get("regions") != fn.REGIONS or n.get("markets") != fn.MARKETS:
        errs.append("regions/markets labels differ from the spec")
    if not (50 <= len(items) <= 400):
        errs.append(f"news count {len(items)} outside 50..400")
    ids = set()
    prev_ts = "9999"
    for it in items:
        if set(it) != {"id", "t", "s", "u", "src", "ts", "rg", "mk", "terms"}:
            errs.append(f"fields {sorted(it)}")
        if not re.fullmatch(r"[0-9a-f]{12}", it.get("id", "")) or it["id"] in ids:
            errs.append(f"bad or duplicate id {it.get('id')}")
        ids.add(it.get("id"))
        if not it.get("t") or "<" in it["t"] or "&amp;" in it["t"]:
            errs.append(f"bad title {it.get('t')!r}")
        if not isinstance(it.get("s"), str) or len(it["s"]) > 260 or "<" in it["s"]:
            errs.append(f"bad snippet {it.get('s')!r}")
        if not re.match(r"^https?://", it.get("u", "")):
            errs.append(f"bad url {it.get('u')}")
        if not it.get("src"):
            errs.append("no publisher")
        ts = it.get("ts", "")
        if not ISO.match(ts):
            errs.append(f"bad ts {ts}")
        else:
            t = dt.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
            if t > now + dt.timedelta(minutes=10) or t < now - dt.timedelta(hours=72, minutes=30):
                errs.append(f"ts outside 72 h: {ts}")
            if ts > prev_ts:
                errs.append("not sorted newest first")
            prev_ts = ts
        if not it.get("rg") or not set(it["rg"]) <= set(fn.REGIONS):
            errs.append(f"bad regions {it.get('rg')}")
        if not set(it.get("mk") or []) <= set(fn.MARKETS):
            errs.append(f"bad markets {it.get('mk')}")
        if gl_ids and not set(it.get("terms") or []) <= gl_ids:
            errs.append(f"unknown terms {it.get('terms')}")
    newest = max((it["ts"] for it in items), default="")
    if newest and newest < (now - dt.timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%SZ"):
        errs.append(f"newest story is old: {newest}")
    a = arch.get("items") or []
    if len(a) < len(items) * 0.5:
        errs.append("archive smaller than expected")
    for it in a[:2000]:
        if "s" in it:
            errs.append("archive items must not carry snippets")
            break
    horizon = (now - dt.timedelta(days=30, hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    if any(it["ts"] < horizon for it in a):
        errs.append("archive has items older than 30 days")
    for tid, lst in terms.items():
        if len(lst) > 6 or any(set(x) != {"t", "u", "src", "ts"} for x in lst):
            errs.append(f"news-terms {tid} malformed")
        if [x["ts"] for x in lst] != sorted((x["ts"] for x in lst), reverse=True):
            errs.append(f"news-terms {tid} not newest first")
    rg, mk = {}, {}
    for it in items:
        for x in it["rg"]:
            rg[x] = rg.get(x, 0) + 1
        for x in it["mk"]:
            mk[x] = mk.get(x, 0) + 1
    for r in fn.REGIONS:
        if not rg.get(r):
            errs.append(f"no stories for region {r}")
    report.append(f"news: {len(items)} stories in 72 h (newest {newest}), archive {len(a)}, {len(terms)} terms with stories, "
                  f"{sum(1 for i in items if i['terms'])} stories with terms, {sum(1 for i in items if i['s'])} with snippets")
    report.append("  per region: " + ", ".join(f"{k} {rg.get(k, 0)}" for k in fn.REGIONS))
    report.append("  per market: " + ", ".join(f"{k} {mk.get(k, 0)}" for k in fn.MARKETS))
    srcs = {}
    for it in items:
        srcs[it["src"]] = srcs.get(it["src"], 0) + 1
    report.append("  top publishers: " + ", ".join(f"{k} {v}" for k, v in sorted(srcs.items(), key=lambda x: -x[1])[:14]))
    return errs


def parity_check(gl_dir, items, report):
    """Run Finspire.glossary.match in headless Chrome on the same texts and compare with the Python port."""
    js = ROOT / "site/assets/js/finspire.js"
    chrome = pathlib.Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    if not (js.exists() and chrome.exists() and shutil.which("node")):
        report.append("parity: skipped (finspire.js, Chrome or node missing)")
        return []
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="fs-parity-"))
    (tmp / "assets/js").mkdir(parents=True)
    shutil.copy2(js, tmp / "assets/js/finspire.js")
    shutil.copy2(ROOT / "site/config.js", tmp / "config.js")
    shutil.copytree(gl_dir, tmp / "data/glossary")
    (tmp / "index.html").write_text('<!doctype html><meta charset="utf-8"><meta name="fs-root" content="./"><title>parity</title><link rel="icon" href="data:,">'
                                    '<script src="config.js"></script><script src="assets/js/finspire.js"></script>')
    texts = [x for it in items[:400] for x in (it["t"], it["s"]) if x]
    (tmp / "texts.json").write_text(json.dumps(texts))
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "-d", str(tmp), "--bind", "127.0.0.1"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    script = tmp / "parity.mjs"
    script.write_text(f"""import {{ launch }} from {json.dumps((ROOT / 'tests/lib/cdp.mjs').as_uri())};
const b = await launch({{port: 9482}});
try {{
  const p = await b.page("http://127.0.0.1:{port}/index.html", {{wait: 1200}});
  const out = await p.js(`(async()=>{{ await Finspire.glossary.load(); const t = await (await fetch("texts.json")).json();
    return t.map(x => Finspire.glossary.match(x).map(m => [m.id, m.start, m.end])); }})()`);
  console.log(JSON.stringify({{out, errors: p.errors}}));
}} finally {{ await b.close(); }}""")
    try:
        time.sleep(0.4)
        r = subprocess.run(["node", "--experimental-websocket", str(script)], capture_output=True, text=True, timeout=90)
        res = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception as e:
        report.append(f"parity: could not run ({e})")
        return []
    finally:
        srv.kill()
    g = fn.Glossary(fn.load_glossary(str(gl_dir / "index.json")))   # index + phrases.json, as fetch_news.py reads them
    diffs = []
    for t, js_m in zip(texts, res["out"]):
        py = [[m["id"], m["start"], m["end"]] for m in g.match(t)]
        if py != js_m:
            diffs.append((t[:80], py, js_m))
    report.append(f"parity ({gl_dir.name}): {len(texts)} texts, {sum(len(x) for x in res['out'])} matches in JS, "
                  f"{len(diffs)} differences")
    errs = [f"JS/Python term mismatch: {d}" for d in diffs[:5]]
    errs += [f"parity page error: {e}" for e in res.get("errors", [])]
    return errs


def live():
    report, errs = [], []
    gl_dir = pathlib.Path(tempfile.mkdtemp(prefix="fs-gloss-"))
    subprocess.run([sys.executable, str(ROOT / "scripts/build_glossary.py"), "--out", str(gl_dir)], check=True)
    gl_ids = {r[0] for r in json.loads((gl_dir / "index.json").read_text())["t"]}
    t0 = time.time()
    r1 = subprocess.run([sys.executable, str(ROOT / "scripts/fetch_markets.py"), "--glossary", str(gl_dir / "index.json")],
                        capture_output=True, text=True, timeout=300)
    print(r1.stdout + r1.stderr)
    t1 = time.time()
    r2 = subprocess.run([sys.executable, str(ROOT / "scripts/fetch_news.py"), "--glossary", str(gl_dir / "index.json")],
                        capture_output=True, text=True, timeout=600)
    print(r2.stdout + r2.stderr)
    report.append(f"fetch_markets exit {r1.returncode} in {t1 - t0:.1f}s; fetch_news exit {r2.returncode} in {time.time() - t1:.1f}s")
    if r1.returncode or r2.returncode:
        errs.append("a fetcher exited non-zero")
    live_dir = ROOT / "data/live"
    m = json.loads((live_dir / "markets.json").read_text())
    n = json.loads((live_dir / "news.json").read_text())
    a = json.loads((live_dir / "news-archive.json").read_text())
    t = json.loads((live_dir / "news-terms.json").read_text())
    st = json.loads((live_dir / "status.json").read_text())
    errs += validate_markets(m, report)
    errs += validate_news(n, a, t, gl_ids, report)
    kinds = {s.get("kind") for s in st.get("sources", [])}
    if kinds != {"markets", "news"}:
        errs.append(f"status.json kinds {kinds}")
    bad = [s["id"] for s in st["sources"] if not s.get("ok")]
    report.append(f"status: {len(st['sources'])} sources, failing: {', '.join(bad) or 'none'}")
    feeds_ok = sum(1 for s in st["sources"] if s.get("kind") == "news" and s.get("ok"))
    if feeds_ok < len(fn.FEEDS) - 4:
        errs.append(f"only {feeds_ok} feeds readable")
    errs += parity_check(gl_dir, n["items"], report)
    # the small fixture dictionary (repo rate, Sensex, Nifty, IPO …) gives many more matches on real headlines
    fx_dir = pathlib.Path(tempfile.mkdtemp(prefix="fs-gloss-fixture-"))
    subprocess.run([sys.executable, str(ROOT / "scripts/build_glossary.py"), "--src", str(ROOT / "tests/fixtures/glossary"),
                    "--out", str(fx_dir)], check=True, capture_output=True)
    errs += parity_check(fx_dir, n["items"], report)
    return report, errs


if __name__ == "__main__":
    offline = "--offline" in sys.argv
    argv = [a for a in sys.argv if a != "--offline"]
    res = unittest.main(argv=argv, exit=False, verbosity=1).result
    ok = res.wasSuccessful()
    if not offline:
        print("\n— live run —")
        report, errs = live()
        print("\n".join(report))
        for e in errs:
            print("FAIL", e)
        ok = ok and not errs
        print("\nlive checks:", "PASS" if not errs else f"{len(errs)} problem(s)")
    sys.exit(0 if ok else 1)
