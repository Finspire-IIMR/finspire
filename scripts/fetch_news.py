#!/usr/bin/env python3
"""Fetch market news into data/live/ (formats: ARCHITECTURE.md → data/live/news.json).

  news.json          items from the last 72 hours, newest first, max 400: cleaned headline + snippet, publisher, UTC time,
                     regions (in/us/eu/ap/me/gl), market tags (stocks, rates, cb, fx, cmd, crypto, econ, deals, policy)
                     and dictionary terms found in the text (same matching rules as Finspire.glossary.match)
  news-archive.json  30 days of items (same fields minus the snippet), merged with the previous archive
  news-terms.json    {term id: up to 6 newest archive stories that mention it}
  status.json        per-feed rows (kind "news"); the markets rows written by fetch_markets.py are kept

Previous files are read from data/live/ or, when there is no local copy and env SITE_URL is set, from the deployed site,
so a run on a fresh CI machine continues the archive. One failing or malformed feed never stops the run.

    python3 scripts/fetch_news.py --glossary dist/data/glossary/index.json

Standard library only (Python 3.9+)."""
import argparse, datetime as dt, email.utils, hashlib, html, html.entities, json, os, pathlib, re, subprocess, sys
import tempfile, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent.parent
LIVE = ROOT / "data" / "live"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
TIMEOUT = 20
UTC = dt.timezone.utc
MAX_ITEMS, NEWS_HOURS, ARCHIVE_DAYS, ARCHIVE_MAX, TERM_STORIES = 400, 72, 30, 20000, 6
SNIPPET_MAX = 260

REGIONS = {"in": "India", "us": "United States", "eu": "Europe & UK", "ap": "Asia-Pacific", "me": "Middle East & Africa",
           "gl": "Global"}
MARKETS = {"stocks": "Stocks", "rates": "Bonds & rates", "cb": "Central banks", "fx": "Currencies",
           "cmd": "Commodities & energy", "crypto": "Crypto", "econ": "Economy", "deals": "Companies & deals",
           "policy": "Policy & regulation"}

GN = "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-{0}&gl={0}&ceid={0}:en"
# id, publisher label (Google News: taken from <source>), url, default region, default market tags, options
#   gn: Google News (publisher in <source>, " - Publisher" stripped, description is a link list → empty snippet)
#   official: central-bank feed (kept even without keyword hits; routine notices filtered)
#   need_region: keep only items whose text names this region (used for the noisy search feed)
#   tz: timezone for timestamps that carry none
FEEDS = [
    ("et-markets", "Economic Times", "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", "in", ["stocks"], {}),
    ("et-economy", "Economic Times", "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms", "in", ["econ"], {}),
    ("livemint", "Livemint", "https://www.livemint.com/rss/markets", "in", ["stocks"], {}),
    ("business-standard", "Business Standard", "https://www.business-standard.com/rss/markets-106.rss", "in", ["stocks"], {}),
    ("businessline", "BusinessLine", "https://www.thehindubusinessline.com/markets/feeder/default.rss", "in", ["stocks"], {}),
    ("rbi", "RBI", "https://www.rbi.org.in/pressreleases_rss.xml", "in", ["cb"], {"official": True}),
    ("cnbc-top", "CNBC", "https://www.cnbc.com/id/100003114/device/rss/rss.html", "us", [], {"general": True}),
    ("cnbc-asia", "CNBC", "https://www.cnbc.com/id/19832390/device/rss/rss.html", "ap", [], {}),
    ("cnbc-europe", "CNBC", "https://www.cnbc.com/id/19794221/device/rss/rss.html", "eu", [], {}),
    ("marketwatch", "MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories", "us", [], {"general": True}),
    ("fed", "Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml", "us", ["cb"], {"official": True}),
    ("bbc", "BBC", "https://feeds.bbci.co.uk/news/business/rss.xml", "eu", [], {"general": True}),
    ("guardian", "The Guardian", "https://www.theguardian.com/business/economics/rss", "eu", ["econ"], {"general": True}),
    ("ecb", "ECB", "https://www.ecb.europa.eu/rss/press.html", "eu", ["cb"], {"official": True}),
    ("ft", "Financial Times", "https://www.ft.com/markets?format=rss", "gl", [], {}),
    ("nikkei", "Nikkei Asia", "https://asia.nikkei.com/rss/feed/nar", "ap", [], {}),
    ("scmp", "SCMP", "https://www.scmp.com/rss/92/feed", "ap", [], {}),
    ("coindesk", "CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/", "gl", ["crypto"], {}),
    ("investing", "Investing.com", "https://www.investing.com/rss/news_25.rss", "us", ["stocks"], {"tz": UTC}),
    ("oilprice", "OilPrice.com", "https://oilprice.com/rss/main", "gl", ["cmd"], {}),
    ("gn-in", "Google News", GN.format("IN"), "in", [], {"gn": True}),
    ("gn-us", "Google News", GN.format("US"), "us", [], {"gn": True}),
    ("gn-gb", "Google News", GN.format("GB"), "eu", [], {"gn": True}),
    ("gn-sg", "Google News", GN.format("SG"), "ap", [], {"gn": True}),
    ("gn-au", "Google News", GN.format("AU"), "ap", [], {"gn": True}),
    # There is no English UAE edition (en-AE returns the U.S. edition), so the Middle East & Africa gets a search feed.
    ("gn-mea", "Google News", "https://news.google.com/rss/search?q=" + urllib.parse.quote(
        "(UAE OR Saudi OR Qatar OR Dubai OR \"Abu Dhabi\" OR Egypt OR Nigeria OR Kenya OR \"South Africa\") "
        "(economy OR stocks OR markets OR \"central bank\" OR oil OR bank) when:2d") + "&hl=en-US&gl=US&ceid=US:en",
     "me", [], {"gn": True, "need_region": "me"}),
]
FEED_BY_ID = {f[0]: f for f in FEEDS}
PRIORITY = {f[0]: i for i, f in enumerate(FEEDS)}

# ---------------------------------------------------------------- keyword rules
# Each rule: (case-insensitive phrases, case-sensitive tokens), "|"-separated, matched on word boundaries.
REGION_RULES = {
    "in": ("""india|indian|indians|reserve bank of india|sebi|sensex|nifty|bank nifty|nifty 50|dalal street|rupee|rupees|₹
              |crore|crores|lakh|lakh crore|mumbai|new delhi|delhi|bengaluru|bangalore|chennai|hyderabad|kolkata|pune
              |gujarat|maharashtra|karnataka|tamil nadu|kerala|modi|sitharaman|gift city|gift nifty|adani|reliance industries
              |tata|infosys|wipro|hdfc|icici|state bank of india|bharti airtel|kotak|bajaj|mahindra|hcl tech|hcltech
              |q1fy27|q2fy27|q3fy27|q4fy27|fy27|fy26|upi|dmart|nse|bse""",
           "NSE|BSE|MPC|GST|Rs|RBI|SEBI|SBI|LIC|FII|FIIs|DII|DIIs|FPI|FPIs"),
    "us": ("""u.s.|united states|america|american|americans|wall street|federal reserve|fomc|powell|s&p 500|nasdaq
              |dow jones|washington|new york|trump|white house|congress|senate|republicans|democrats|treasuries
              |u.s. treasury|bessent|california|texas|silicon valley|midterms|medicare|vance""",
           "US|USA|Fed|SEC|CFTC|Dow|DJIA|GOP|IRS"),
    "eu": ("""europe|european|eurozone|euro zone|euro area|lagarde|bank of england|britain|british|england|london
              |gilt|gilts|sterling|germany|german|bund|bunds|dax|france|french|paris|frankfurt|italy|italian|rome
              |spain|spanish|netherlands|dutch|switzerland|swiss|snb|brussels|downing street|westminster|stoxx|scotland
              |ireland|poland|sweden|norway|denmark|finland|lithuania|russia|russian|ukraine|ukrainian|kremlin|putin
              |zelenskyy|zelensky|north sea|brexit|city of london|burnham|healey""",
           "EU|UK|U.K.|BoE|BOE|ECB|FTSE|CAC"),
    "ap": ("""china|chinese|beijing|shanghai|shenzhen|hong kong|hang seng|pboc|people's bank of china|yuan|renminbi
              |japan|japanese|tokyo|nikkei 225|bank of japan|yen|topix|korea|korean|seoul|kospi|taiwan|taiwanese|taipei
              |tsmc|australia|australian|asx|sydney|melbourne|singapore|sgx|temasek|indonesia|indonesian|jakarta|vietnam
              |vietnamese|thailand|thai|bangkok|malaysia|malaysian|philippines|new zealand|asia|asian|asia-pacific
              |xi jinping|pakistan|bangladesh|sri lanka|a-share|a-shares|samsung|alibaba|tencent""",
           "BOJ|BoJ|RBA|MAS|STI|HKEX|CSI"),
    "me": ("""middle east|mideast|gulf states|gulf of oman|persian gulf|gulf oil|saudi|saudis|riyadh|aramco|uae|emirates
              |dubai|abu dhabi|qatar|doha|kuwait|oman|bahrain|iran|iranian|tehran|israel|israeli|houthi|houthis|yemen
              |red sea|hormuz|egypt|egyptian|cairo|turkey's|turkish|africa|african|nigeria|kenya|south africa
              |johannesburg|ghana|ethiopia|opec|opec+|lebanon|syria|iraq""",
           "GCC"),
    "gl": ("""global|globally|world economy|worldwide|world bank|world trade organization|emerging markets
              |developing nations|developing countries|across the world""",
           "IMF|WTO|G20|G7|BIS"),
}
MARKET_RULES = {
    "stocks": ("""stock|stocks|shares|share price|equities|equity market|equity markets|stock market|sensex|nifty|nifty 50
                  |bank nifty|s&p 500|nasdaq|dow jones|ftse 100|dax|nikkei 225|hang seng|kospi|topix|stoxx|asx
                  |sell-off|selloff|bull market|bear market|market cap|market capitalisation|market capitalization
                  |benchmark index|small-cap|mid-cap|smallcap|midcap|small caps|mid caps|blue-chip|blue chip|f&o
                  |open interest|rsi|vwap|investors|investor|portfolio|wall street|dalal street|markets|hedge fund
                  |hedge funds|fund manager|fund managers|asset manager|asset management|sovereign wealth fund|mutual fund
                  |mutual funds|brokerage|brokers""",
               "IPO|IPOs|ETF|ETFs|FII|FIIs|DII|DIIs|FPI|FPIs|FTSE|CAC|Dow",
               "rally|rallies|rallied"),
    "rates": ("""bond|bonds|yield|yields|treasury yields|treasuries|gilt|gilts|bund|bunds|g-sec|g-secs|government securities
                 |interest rate|interest rates|borrowing costs|mortgage rates|debt market|bond market|fixed income
                 |credit spreads|sovereign debt|public debt|national debt|government debt|debt crisis|t-bill|t-bills
                 |liquidity|reverse repo""",
              "SDL|VRRR|LAF"),
    "cb": ("""central bank|central banks|central banker|central bankers|federal reserve|fomc|powell|reserve bank
              |reserve bank of india|monetary policy|rate cut|rate cuts|rate hike|rate hikes|repo rate|policy rate
              |bank of england|bank of japan|lagarde|pboc|people's bank of china|swiss national bank|interest-rate decision
              |governor malhotra|federal open market committee""",
           "Fed|MPC|BoE|BOE|BOJ|BoJ|ECB|RBI|RBA|MAS|SNB"),
    "fx": ("""rupee|dollar index|forex|currency|currencies|exchange rate|exchange rates|yen|sterling|yuan|renminbi
              |greenback|forward premium|forward premiums|usd/inr|eur/usd|usd/jpy|foreign exchange|dollar requirements
              |strong dollar|weak dollar|dollar strength|dollar weakness""",
           "DXY|INR"),
    "cmd": ("""oil|crude|brent|wti|gold|silver prices|silver price|silver futures|copper|aluminium|aluminum|natural gas|lng|commodity|commodities|opec|opec+
               |metals|iron ore|steel|coal|wheat|soybean|soybeans|sugar|diesel|gasoline|petrol|refinery|refineries
               |petroleum|barrel|barrels|energy|energy prices|fuel prices|fuel costs|fuel cost|gas prices|tanker|tankers
               |electricity prices|power prices|lithium|nuclear energy|rare earths|rare-earth""",
            "", "silver|fuel|electricity|mining|miners"),
    "crypto": ("""bitcoin|ether|ethereum|crypto|cryptocurrency|cryptocurrencies|stablecoin|stablecoins|blockchain
                  |tokenized|tokenised|tokenisation|tokenization|altcoin|altcoins|coinbase|binance|digital asset
                  |digital assets|defi|solana|xrp|prediction markets""",
               "BTC|ETH"),
    "econ": ("""gdp|inflation|consumer prices|jobs|payrolls|unemployment|jobless|recession|economy|economic|economies
                |growth|slowdown|retail sales|consumer spending|trade deficit|current account deficit|deficit|deficits
                |exports|imports|exporters|industrial output|manufacturing|services sector|fiscal deficit|economist
                |economists|survey of consumer finances|household|households|wages|productivity|cost of living
                |trade talks|trade deal""",
             "GDP|CPI|WPI|PMI|IIP"),
    "deals": ("""merger|mergers|acquisition|acquisitions|acquire|acquires|acquired|buyout|takeover|takeovers|stake|deal
                 |deals|earnings|results|quarterly|profit|net profit|revenue|sales|q1|q2|q3|q4|listing|funding round
                 |raises|valuation|private equity|venture capital|startup|start-up|startups|in talks to buy|order book
                 |orders worth|rights issue|stock split|buyback|dividend|new owner|sold to|layoffs""",
              "M&A|IPO",
              # weak signals: enough to keep a business story, never the lead tag when anything stronger matched
              """buys|ceo|chief executive|chairman|company|companies|firm|firms|billion|investment|investments|chipmaker
              |carmaker|carmakers|carmaking|retailer|lender|lenders|bank|banks|banking|insurer|insurers"""),
    "policy": ("""regulator|regulators|regulation|regulations|regulatory|regulate|sebi|tariff|tariffs|tax|taxes|taxation
                  |budget|ministry|finance minister|ban|sanctions|rules|guidelines|compliance|enforcement action|antitrust
                  |windfall tax|subsidy|subsidies|legislation|supreme court|scotus|policymakers|trade policy|levy|duty""",
               "SEC|CFTC|GST",
               "government|law|laws|bill|court|judge|prime minister|chancellor|white house|minister"),
}
# central-bank and regulator notices that are routine (filtered from the official feeds)
ROUTINE = re.compile(r"""(money\s+market\s+operations|auction|treasury\s+bills?|\bt-bills?\b|state\s+government\s+securities
    |\bsdls?\b|underwriting|\bomo\b|lending\s+and\s+borrowing|borrowing\s+data|weekly\s+statistical\s+supplement
    |reserve\s+money|monetary\s+penalty|directions\s+under\s+section|certificate\s+of\s+registration|amalgamation\s+of
    |approval\s+of\s+application|enforcement\s+action|termination\s+of\s+enforcement|announces\s+the\s+results\s+of)""",
                     re.I | re.X)
# personal-finance columns, lifestyle and sponsored pieces: dropped unless they carry strong market words
NOISE_TEXT = re.compile(r"""\b(my\s+(wife|husband|sister|brother|brother-in-law|sister-in-law|mother|father|mom|dad|aunt|uncle
    |son|daughter|kids|children|girlfriend|boyfriend|partner|parents|family|stepchildren|stepson|stepdaughter)
    |i\s+have\s+no\s+children|i'm\s+a\s+\d{2}-year-old|i\s+am\s+\d{2}|widow|horoscope|recipe|celebrity|bollywood|cricket
    |box\s+office|wedding|salmonella|dating|skincare|fashion\s+week|personal\s+history|sponsored|partner\s+content
    |brandpost|advertorial|shop\s+now|discounts\s+to\s+shop|last-chance|deals\s+event|gift\s+guide|black\s+friday
    |cyber\s+monday|prime\s+day|big\s+billion\s+days|top\s+deals|explore\s+all|kerb\s+weight|test\s+drive|\d+bhp|bhp
    |launch\s+price|variants\s+explained|nba|nfl|premier\s+league|world\s+cup|olympics|ipl)\b""", re.I | re.X)
NOISE_URL = re.compile(r"/(my-personal-history|lifestyle|life-arts|life|sport|sports|entertainment|travel|food|style|"
                       r"culture|magazine|podcasts?|video|videos|photos|gallery|opinion/letters|presented|sponsored|"
                       r"native|branded|special-reports/hkicc)/", re.I)
TIE = ["cb", "crypto", "cmd", "fx", "rates", "econ", "policy", "deals", "stocks"]   # lead tag when scores tie
STRONG = {"stocks", "rates", "cb", "fx", "cmd", "crypto"}
TRACKING = re.compile(r"^(utm_[a-z_]+|at_medium|at_campaign|at_link_id|at_ptr_name|mod|ref|cmpid|smid|ito|sr_share)$", re.I)


def _rule_regex(phrases, ci):
    """One regex for a "|"-separated phrase list; word boundaries only on edges that are word characters (so "₹"
    matches in "₹124")."""
    words = sorted({w.strip() for w in phrases.split("|") if w.strip()}, key=len, reverse=True)
    if not words:
        return None
    parts = []
    for w in words:
        pre = r"(?<![\w&])" if re.match(r"\w", w) else ""
        post = r"(?![\w&])" if re.search(r"\w$", w) else ""
        parts.append(pre + re.escape(w) + post)
    return re.compile("|".join(parts), re.I if ci else 0)


class Rules:
    def __init__(self, table):
        self.rx = {}
        for key, spec in table.items():
            ci, cs = spec[0], spec[1]
            weak = spec[2] if len(spec) > 2 else ""
            self.rx[key] = (_rule_regex(ci, True), _rule_regex(cs, False), _rule_regex(weak, True))

    def score(self, title, body):
        """{key: score}: a phrase hit counts 1 (2 in the headline); a weak hit 0.1 (0.2 in the headline)."""
        out = {}
        for key, (a, b, w) in self.rx.items():
            s = 0.0
            for rx in (a, b):
                if rx is not None:
                    s += 2 * len(rx.findall(title)) + len(rx.findall(body))
            if w is not None:
                s += 0.2 * len(w.findall(title)) + 0.1 * len(w.findall(body))
            if s:
                out[key] = round(s, 2)
        return out


REGION_RX = Rules(REGION_RULES)
MARKET_RX = Rules(MARKET_RULES)


# ---------------------------------------------------------------- small helpers
def log(*a):
    print(*a, file=sys.stderr)


def now_utc():
    return dt.datetime.now(UTC).replace(microsecond=0)


def iso(t):
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    try:
        return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except Exception:
        return None


class _Redirects(urllib.request.HTTPRedirectHandler):
    """Python 3.9's urllib does not follow 308 Permanent Redirect (CoinDesk uses it)."""
    def http_error_308(self, req, fp, code, msg, headers):
        return self.http_error_301(req, fp, 301, msg, headers)


_OPENER = urllib.request.build_opener(_Redirects)


def http_get(url, accept="application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5", timeout=TIMEOUT,
             limit=8_000_000):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Language": "en-US,en;q=0.9"})
    with _OPENER.open(req, timeout=timeout) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"response larger than {limit // 1_000_000} MB")
    return data


def parse_date(s, tz=None):
    """RFC 822 (RSS), ISO 8601 (Atom, dc:date) or 'YYYY-MM-DD HH:MM:SS' → aware UTC datetime, or None."""
    if not s:
        return None
    s = s.strip()
    try:
        t = email.utils.parsedate_to_datetime(s)
        if t is not None:
            if t.tzinfo is None:
                t = t.replace(tzinfo=tz or UTC)
            return t.astimezone(UTC)
    except Exception:
        pass
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$", s)
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
    try:
        return dt.datetime(int(y), int(mo), int(d), int(h or 0), int(mi or 0), int(sec or 0), tzinfo=z).astimezone(UTC)
    except ValueError:
        return None


# ---------------------------------------------------------------- text cleaning
TAG = re.compile(r"<[^>]*>")
BOILER = [
    re.compile(r"\s*The post .{0,300}? appeared first on .{0,120}?$", re.I | re.S),
    re.compile(r"\s*(Continue reading|Read more|Read the full (story|article)|Click here)\b.*$", re.I | re.S),
    re.compile(r"\s*\[(…|\.\.\.|&hellip;)\]\s*$"),
    re.compile(r"^\s*(?:[A-Z][A-Za-z .,'-]{1,40})?\((?:Reuters|AP|AFP|Bloomberg)\)\s*[-–—]+\s*"),
    re.compile(r"^\s*(?:Updated|Published):?\s+\w+ \d{1,2},? \d{4}.*?(?:IST|GMT|ET)\s*", re.I),
]


def clean_text(s):
    if not s:
        return ""
    s = str(s)
    for _ in range(2):                       # some feeds double-escape (&amp;#x2018;)
        if "&" not in s:
            break
        s = html.unescape(s)
    s = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", s)
    s = TAG.sub(" ", s)
    s = s.replace(" ", " ").replace("​", "").replace("⁠", "").replace("﻿", "")
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_title(s):
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[‘’'`´]", "", s)
    s = re.sub(r"[^\w]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def clean_snippet(desc, title):
    s = clean_text(desc)
    for rx in BOILER:
        s = rx.sub("", s).strip()
    if not s:
        return ""
    nt, ns = norm_title(title), norm_title(s)
    if not ns or ns == nt or nt.startswith(ns) or (len(ns) < 40 and ns in nt):
        return ""
    if len(s) > SNIPPET_MAX:
        cut = s[:SNIPPET_MAX - 1]
        sp = cut.rfind(" ")
        if sp > SNIPPET_MAX * 0.6:
            cut = cut[:sp]
        s = cut.rstrip(" ,;:-–—.(") + "…"
    return s


def clean_url(u):
    u = (u or "").strip()
    if not re.match(r"https?://", u, re.I):
        return ""
    try:
        p = urllib.parse.urlsplit(u)
    except ValueError:
        return ""
    if not p.netloc:
        return ""
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True) if not TRACKING.match(k)]
    path = re.sub(r"(?<=[^:])//+", "/", p.path) or "/"
    return urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower(), path, urllib.parse.urlencode(q), ""))


def url_key(u):
    p = urllib.parse.urlsplit(u)
    host = p.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    q = "&".join(sorted(k + "=" + v for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True)
                        if not TRACKING.match(k) and not k.startswith("syn-")))
    return host + p.path.rstrip("/") + ("?" + q if q else "")


def item_id(u):
    return hashlib.sha1(url_key(u).encode()).hexdigest()[:12]


# ---------------------------------------------------------------- XML parsing
def _local(tag):
    return tag.rsplit("}", 1)[-1].split(":")[-1].lower() if isinstance(tag, str) else ""


def _repair_xml(raw):
    """Best-effort fixes for feeds that are not well-formed: BOM/junk before the prolog, control characters, HTML named
    entities XML does not know, and bare ampersands."""
    t = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    t = t.lstrip("﻿ \r\n\t")
    i = t.find("<")
    t = t[i:] if i > 0 else t
    t = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", t)
    t = re.sub(r"^<\?xml[^>]*\?>", '<?xml version="1.0" encoding="utf-8"?>', t)

    def ent(m):
        name = m.group(1)
        if name in ("amp", "lt", "gt", "quot", "apos"):
            return m.group(0)
        cp = html.entities.name2codepoint.get(name)
        return f"&#{cp};" if cp else "&amp;" + name + ";"
    t = re.sub(r"&([A-Za-z][A-Za-z0-9]*);", ent, t)
    t = re.sub(r"&(?!(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9A-Fa-f]+);)", "&amp;", t)
    return t.encode("utf-8")


def _regex_items(raw):
    """Last resort for XML that still does not parse: pull <item>/<entry> blocks out with regular expressions."""
    t = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    out = []
    for m in re.finditer(r"<(item|entry)\b[^>]*>(.*?)</\1>", t, re.S | re.I):
        blk = m.group(2)

        def g(*names):
            for n in names:
                mm = re.search(r"<(?:\w+:)?" + n + r"\b[^>]*>(.*?)</(?:\w+:)?" + n + ">", blk, re.S | re.I)
                if mm:
                    v = mm.group(1).strip()
                    cd = re.fullmatch(r"<!\[CDATA\[(.*?)\]\]>", v, re.S)
                    return cd.group(1) if cd else v
            return ""
        link = g("link")
        if not link:
            mm = re.search(r"<link\b[^>]*href=\"([^\"]+)\"", blk)
            link = mm.group(1) if mm else ""
        out.append({"title": g("title"), "link": html.unescape(link), "desc": g("description", "summary", "content"),
                    "date": g("pubDate", "published", "updated", "date"), "source": g("source"), "guid": g("guid", "id"),
                    "sponsored": g("sponsored")})
    return out


def _text(el):
    if el is None:
        return ""
    return "".join(el.itertext()) if len(el) else (el.text or "")


def parse_feed(raw):
    """RSS 2.0, RSS 1.0 (RDF) or Atom bytes → list of raw dicts {title, link, desc, date, source, guid, sponsored}.
    Raises ValueError when nothing usable can be read."""
    root = None
    for attempt in (lambda r: r, _repair_xml):
        try:
            root = ET.fromstring(attempt(raw))
            break
        except ET.ParseError:
            continue
        except Exception:
            continue
    if root is None:
        items = _regex_items(raw)
        if not items:
            raise ValueError("not a readable RSS/Atom document")
        return items
    out = []
    for el in root.iter():
        name = _local(el.tag)
        if name not in ("item", "entry"):
            continue
        d = {"title": "", "link": "", "desc": "", "date": "", "source": "", "guid": "", "sponsored": ""}
        alt_link = ""
        for c in el:
            n = _local(c.tag)
            if n == "title":
                d["title"] = _text(c)
            elif n == "link":
                href = c.get("href")
                if href:                                   # Atom
                    rel = c.get("rel", "alternate")
                    if rel == "alternate" and not d["link"]:
                        d["link"] = href
                    elif not alt_link:
                        alt_link = href
                elif (c.text or "").strip() and not d["link"]:
                    d["link"] = c.text.strip()
            elif n in ("description", "summary") and not d["desc"]:
                d["desc"] = _text(c)
            elif n in ("content", "encoded") and not d["desc"]:
                d["desc"] = _text(c)
            elif n in ("pubdate", "published", "date", "issued") and not d["date"]:
                d["date"] = _text(c)
            elif n in ("updated", "modified") and not d["date"]:
                d["updated"] = _text(c)
            elif n == "source":
                d["source"] = _text(c) or ""
                d["source_url"] = c.get("url") or ""
            elif n in ("guid", "id"):
                d["guid"] = _text(c)
            elif n == "sponsored":
                d["sponsored"] = _text(c)
        if not d["link"]:
            d["link"] = alt_link or el.get("{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about") or ""
        if not d["link"] and re.match(r"https?://", d["guid"].strip()):
            d["link"] = d["guid"].strip()
        if not d["date"]:
            d["date"] = d.pop("updated", "")
        d.pop("updated", None)
        out.append(d)
    if not out and _local(root.tag) not in ("rss", "rdf", "feed"):
        raise ValueError(f"unexpected document <{_local(root.tag)}>")
    return out


# ---------------------------------------------------------------- glossary term matching (port of Finspire.glossary.match)
class Glossary:
    """Python port of Finspire.glossary.match (site/assets/js/finspire.js) so news.json terms equal what the page
    highlights. Highlight phrases (hl) match case-insensitively, acronyms (abbr) case-sensitively, both on word boundaries
    (a letter or digit on either side blocks a match), no automatic plurals. Each list is scanned left to right taking
    the longest phrase at each position; overlaps resolve to the longest; each term counts once per text."""

    def __init__(self, index=None):
        self.ids, self.terms = set(), {}
        hl, ab = {}, {}
        for row in (index or {}).get("t", []):
            if not isinstance(row, list) or len(row) < 8:
                continue
            self.ids.add(row[0])
            self.terms[row[0]] = row[1]
            for p in row[6] or []:
                k = str(p).lower().strip()
                if k and k not in hl:          # first row to claim a phrase owns it (as in the JS)
                    hl[k] = row[0]
            for x in row[7] or []:
                k = str(x).strip()
                if k and k not in ab:
                    ab[k] = row[0]
        self.hl, self.ab = hl, ab
        self.hl_first, self.ab_first = self._by_first(hl), self._by_first(ab)

    @staticmethod
    def _by_first(table):
        out = {}
        for k in table:
            out.setdefault(k[0], []).append(k)
        for v in out.values():
            v.sort(key=len, reverse=True)
        return out

    @staticmethod
    def _scan(text, src, first, table):
        out, i, n = [], 0, len(text)
        while i < n:
            if i == 0 or not text[i - 1].isalnum():
                for k in first.get(src[i], ()):
                    j = i + len(k)
                    if src.startswith(k, i) and (j >= n or not text[j].isalnum()):
                        out.append({"id": table[k], "start": i, "end": j})
                        i = j
                        break
                else:
                    i += 1
                continue
            i += 1
        return out

    def match(self, text):
        """[{id, start, end}] like the JS: first occurrence of each term, longest within an overlap cluster."""
        if not text or not (self.hl or self.ab):
            return []
        text = str(text)
        low = text.lower()
        if len(low) != len(text):
            low = "".join(ch.lower() if len(ch.lower()) == 1 else ch for ch in text)
        c = self._scan(text, low, self.hl_first, self.hl) + self._scan(text, text, self.ab_first, self.ab)
        c.sort(key=lambda m: (m["start"], -(m["end"] - m["start"])))
        seen, res, last_end = set(), [], -1
        for i, m in enumerate(c):
            if m["start"] < last_end or m["id"] in seen:
                continue
            best = m
            j = i + 1
            while j < len(c) and c[j]["start"] < best["end"]:
                if c[j]["end"] - c[j]["start"] > best["end"] - best["start"] and c[j]["id"] not in seen:
                    best = c[j]
                j += 1
            seen.add(best["id"])
            res.append(dict(best))
            last_end = best["end"]
        return res

    def terms_in(self, *texts):
        """Term ids in order of first appearance across the texts (headline, then snippet)."""
        ids = []
        for tx in texts:
            for r in self.match(tx):
                if r["id"] not in ids:
                    ids.append(r["id"])
        return ids


def _read_index(path):
    """index.json plus, since glossary v2, the highlight phrases from phrases.json next to it (merged back into row[6])."""
    path = pathlib.Path(path)
    ix = json.loads(path.read_text())
    ph = path.with_name("phrases.json")
    if ph.exists():
        hl = (json.loads(ph.read_text()) or {}).get("hl") or {}
        for row in ix.get("t", []):
            if isinstance(row, list) and len(row) >= 8 and not row[6]:
                row[6] = hl.get(row[0], [])
    return ix

def load_glossary(path):
    if path:
        try:
            return _read_index(path)
        except Exception as e:
            log(f"glossary {path} not readable: {e}")
    for cand in (ROOT / "dist/data/glossary/index.json",):
        if cand.exists():
            try:
                return _read_index(cand)
            except Exception:
                pass
    bg = ROOT / "scripts/build_glossary.py"
    if bg.exists():                       # build one on the fly so a bare local run still extracts terms
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="fs-gloss-"))
        try:
            subprocess.run([sys.executable, str(bg), "--out", str(tmp)], check=True, capture_output=True, timeout=120)
            return _read_index(tmp / "index.json")
        except Exception as e:
            log("could not build a glossary:", e)
    return None


# ---------------------------------------------------------------- classification
# "paddy stocks", "buffer stocks", "coal stocks" are supplies, not shares: neutralise before market scoring
_GOODS_STOCK = re.compile(r"\b(paddy|grains?|foodgrains?|wheat|rice|food|buffer|fertili[sz]ers?|sugar|coal|onions?|pulses|edible oil|"
                          r"inventor(?:y|ies)|warehouse|vaccine|blood|fish|cotton)\s+stocks?\b", re.I)
_GOODS_MARKET = re.compile(r"\b(grain|vegetable|fruit|agricultural|agri|wholesale|food|fish|farm|cattle|flower|street|property|housing|job|labour|labor)\s+markets?\b", re.I)
def unstock(text):
    text = _GOODS_STOCK.sub(lambda m: m.group(1) + " supplies", text or "")
    return _GOODS_MARKET.sub(lambda m: m.group(1) + " mandis", text)

def classify(item, feed):
    """→ (regions, markets, keep?) for an item dict with t, s, u."""
    fid, _, _, region, mk_default, opt = feed
    title, body = item["t"], item.get("s", "")
    rs = REGION_RX.score(title, body)
    ms = MARKET_RX.score(unstock(title), unstock(body))
    # "Gulf" alone is ambiguous (Gulf of Mexico): only the explicit phrases are listed in the rules.
    strong = sum(1 for k in rs if k != "gl")
    if strong >= 3:
        rs["gl"] = rs.get("gl", 0) + 2
    regions = sorted(rs, key=lambda k: (-rs[k], k != region))
    # a single passing mention in the snippet does not make a second region (or "Global")
    regions = [k for i, k in enumerate(regions) if i == 0 or rs[k] >= 2]
    if not regions:
        regions = [region]
    markets = [k for k in sorted(ms, key=lambda k: (-ms[k], TIE.index(k))) if ms[k] >= 1]
    if not markets:
        markets = list(mk_default) + [k for k in ms if k not in mk_default]
    return regions[:3], markets[:4], ms


def keep_item(item, feed, mscore, terms):
    """Drop routine central-bank notices and items with nothing market-related in them."""
    fid, _, _, _, _, opt = feed
    text = item["t"] + " " + item.get("s", "")
    if opt.get("official"):
        return not ROUTINE.search(item["t"])
    if str(item.get("_sponsored", "")).lower() == "true":
        return False
    if NOISE_URL.search(urllib.parse.urlsplit(item["u"]).path + "/"):
        return False
    if NOISE_TEXT.search(text) and not (STRONG & set(mscore)) :
        return False
    if opt.get("need_region") and opt["need_region"] not in REGION_RX.score(item["t"], item.get("s", "")):
        return False
    # a feed's default market only labels a story; it never makes an off-topic story (defence, weather, crime) relevant
    if opt.get("general"):
        # general business desks also run consumer, politics and social stories: ask for a clear market signal
        hit = {k for k, v in mscore.items() if v >= 1}
        return bool(STRONG & hit) or max(mscore.values(), default=0) >= 2 or len(terms) >= 2
    return max(mscore.values(), default=0) >= 1 or bool(terms)


# ---------------------------------------------------------------- feed → items
def normalise(raw_items, feed, fetched_at):
    fid, label, _, _, _, opt = feed
    out = []
    for r in raw_items:
        title = clean_text(r.get("title"))
        src = label
        if opt.get("gn"):
            pub = clean_text(r.get("source"))
            if pub and sum(ch.isascii() or "\u00c0" <= ch <= "\u024f" for ch in pub) < len(pub) * 0.8:
                host = urllib.parse.urlsplit(r.get("source_url") or "").netloc.lower()
                stripped = pub
                pub = host[4:] if host.startswith("www.") else host
                if title.endswith(" - " + stripped):
                    title = title[: -len(" - " + stripped)].strip()
            if pub:
                src = pub
                for sep in (" - ", " – ", " — ", " | "):
                    if title.endswith(sep + pub):
                        title = title[: -len(sep + pub)].strip()
                        break
            else:
                m = re.match(r"(.+) - ([^-]{2,60})$", title)
                if m:
                    title, src = m.group(1).strip(), m.group(2).strip()
            snippet = ""
        else:
            snippet = clean_snippet(r.get("desc"), title)
        u = clean_url(html.unescape(r.get("link") or ""))
        if not title or not u or len(title) < 12:
            continue
        t = parse_date(r.get("date"), opt.get("tz"))
        if t and t > fetched_at + dt.timedelta(minutes=10):
            t = fetched_at                     # publisher clocks/timezones sometimes run ahead: never show the future
        out.append({"id": item_id(u), "t": title, "s": snippet, "u": u, "src": src[:60],
                    "ts": iso(t) if t else None, "_feed": fid, "_sponsored": r.get("sponsored", "")})
    return out


def fetch_feed(feed, fetched_at):
    fid, label, url = feed[0], feed[1], feed[2]
    t0 = time.time()
    row = {"id": fid, "name": label if label != "Google News" else "Google News · " + fid[3:].upper(), "url": url,
           "ok": False, "n": 0, "kept": 0, "fresh": 0, "ms": 0, "error": None}
    try:
        raw = http_get(url)
        items = normalise(parse_feed(raw), feed, fetched_at)
        row.update(ok=True, n=len(items))
        if not items:
            row["error"] = "no items"
    except Exception as e:
        items = []
        row["error"] = (type(e).__name__ + ": " + str(e))[:300]
    row["ms"] = int((time.time() - t0) * 1000)
    return items, row


# Pages for items whose feed has no dates (Nikkei Asia's RSS 1.0 feed): read the article page once for its published
# time and summary. Results are carried forward in news.json / news-archive.json, so each page is read only once.
def enrich_from_page(item):
    try:
        page = http_get(item["u"], accept="text/html,*/*;q=0.8").decode("utf-8", "replace")[:600000]
    except Exception:
        return item
    m = (re.search(r'"datePublished"\s*:\s*"([^"]+)"', page)
         or re.search(r'<meta[^>]+(?:property|name)="(?:article:published_time|pubdate|publishdate|date)"[^>]+content="([^"]+)"', page, re.I)
         or re.search(r'<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="article:published_time"', page, re.I))
    if m:
        t = parse_date(m.group(1))
        if t:
            item["ts"] = iso(min(t, now_utc()))
    if not item.get("s"):
        d = (re.search(r'<meta[^>]+property="og:description"[^>]+content="([^"]*)"', page, re.I)
             or re.search(r'<meta[^>]+name="description"[^>]+content="([^"]*)"', page, re.I))
        if d:
            item["s"] = clean_snippet(d.group(1), item["t"])
    return item


# ---------------------------------------------------------------- dedupe
def _tokens(t):
    return set(w for w in norm_title(t).split() if len(w) > 2 or w.isdigit())


def dedupe(items):
    """Same URL or near-identical headline → one item. Direct publisher feeds beat Google News; among direct feeds the
    earlier feed in FEEDS wins. A missing snippet is filled from a duplicate."""
    def rank(it):
        gn = urllib.parse.urlsplit(it["u"]).netloc.endswith("news.google.com")
        return (gn, not it.get("s"), "_carried" in it, PRIORITY.get(it.get("_feed"), 999))
    items = sorted(items, key=rank)
    kept, by_url, by_title, toks = [], {}, {}, []
    for it in items:
        uk, tk = url_key(it["u"]), norm_title(it["t"])
        dup = by_url.get(uk)
        if dup is None:
            dup = by_title.get(tk)
        if dup is None:
            ts = _tokens(it["t"])
            if len(ts) >= 4:
                for j, other in toks:
                    if other and abs(len(other) - len(ts)) <= 4:
                        inter = len(ts & other)
                        if inter / len(ts | other) >= 0.8:
                            dup = j
                            break
        if dup is not None:
            k = kept[dup]
            if not k.get("s") and it.get("s"):
                k["s"] = it["s"]
            if not k.get("ts") and it.get("ts"):
                k["ts"] = it["ts"]
            by_url.setdefault(uk, dup)
            continue
        idx = len(kept)
        kept.append(it)
        by_url[uk] = idx
        by_title.setdefault(tk, idx)
        toks.append((idx, _tokens(it["t"])))
    return kept


# ---------------------------------------------------------------- previous files
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
            return json.loads(http_get(url, accept="application/json", timeout=60, limit=64_000_000))
        except Exception as e:
            log(f"no previous {name} at {url}: {e}")
    return None


def write_status(kind, sources):
    p = LIVE / "status.json"
    try:
        cur = json.loads(p.read_text()) if p.exists() else {}
    except Exception:
        cur = {}
    keep = [s for s in cur.get("sources", []) if s.get("kind") != kind]
    for s in sources:
        s["kind"] = kind
    p.write_text(json.dumps({"updated": iso(now_utc()), "sources": keep + sources}, ensure_ascii=False, indent=1))


def dump(path, obj):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    tmp.replace(path)


# ---------------------------------------------------------------- main
def run(glossary_path=None, out_dir=LIVE, feeds=FEEDS, enrich_limit=60):
    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    fetched_at = now_utc()
    gl = Glossary(load_glossary(glossary_path))
    prev_news = load_previous("news.json") or {}
    prev_arch = load_previous("news-archive.json") or {}
    prev_by_id = {}
    for it in (prev_arch.get("items") or []) + (prev_news.get("items") or []):   # news.json last: it has snippets
        if isinstance(it, dict) and it.get("id"):
            prev_by_id[it["id"]] = {**prev_by_id.get(it["id"], {}), **it}

    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(lambda f: fetch_feed(f, fetched_at), feeds))
    rows, fresh = [], []
    for items, row in results:
        rows.append(row)
        fresh.extend(items)

    # undated items: reuse what an earlier run learned, else read the article page (bounded per run)
    need = []
    for it in fresh:
        old = prev_by_id.get(it["id"])
        if not it["ts"] and old and old.get("ts"):
            it["ts"] = old["ts"]
            if not it["s"] and old.get("s"):
                it["s"] = old["s"]
        if not it["ts"]:
            need.append(it)
    if need:
        with ThreadPoolExecutor(8) as ex:
            list(ex.map(enrich_from_page, need[:enrich_limit]))
    undated = [it for it in fresh if not it["ts"]]
    fresh = [it for it in fresh if it["ts"]]          # never invent a time: undated items wait for a later run

    # carry forward recent items from the previous news.json (feeds only list their latest few dozen stories)
    fresh_ids = {it["id"] for it in fresh}
    carried = []
    for it in prev_news.get("items") or []:
        if isinstance(it, dict) and it.get("id") not in fresh_ids and it.get("u") and it.get("t") and it.get("ts"):
            c = {k: it.get(k) for k in ("id", "t", "s", "u", "src", "ts")}
            c["s"] = c["s"] or ""
            c["_carried"] = list(it.get("rg") or [])
            carried.append(c)

    merged = dedupe(fresh + carried)
    horizon = fetched_at - dt.timedelta(hours=NEWS_HOURS)
    news, per_feed_kept, per_feed_fresh, id_feed = [], {}, {}, {}
    for it in merged:
        terms = gl.terms_in(it["t"], it.get("s", ""))
        feed = FEED_BY_ID[it["_feed"]] if it.get("_feed") else carried_feed(it)
        rg, mk, mscore = classify(it, feed)
        if not keep_item(it, feed, mscore, terms):
            continue
        t = parse_iso(it["ts"])
        if not t:
            continue
        rec = {"id": it["id"], "t": it["t"], "s": it.get("s", ""), "u": it["u"], "src": it["src"], "ts": it["ts"],
               "rg": rg, "mk": mk, "terms": terms[:8]}
        if t >= horizon:
            news.append(rec)
            id_feed[rec["id"]] = it.get("_feed")
        it["_rec"] = rec
    news = select(news, MAX_ITEMS)
    for rec in news:
        f = id_feed.get(rec["id"])
        if f:
            per_feed_kept[f] = per_feed_kept.get(f, 0) + 1
            if rec["id"] not in prev_by_id:
                per_feed_fresh[f] = per_feed_fresh.get(f, 0) + 1

    # archive: previous archive + everything kept this run, 30 days
    arch_horizon = fetched_at - dt.timedelta(days=ARCHIVE_DAYS)
    arch = {}
    for it in prev_arch.get("items") or []:
        if not (isinstance(it, dict) and it.get("id") and it.get("u") and it.get("t") and it.get("ts")):
            continue
        t = parse_iso(it["ts"])
        if not t or t < arch_horizon or not clean_url(it["u"]):
            continue
        if NOISE_URL.search(urllib.parse.urlsplit(it["u"]).path + "/") or NOISE_TEXT.search(it["t"]):
            continue
        old_terms = [x for x in (it.get("terms") or []) if x in gl.ids] if gl.ids else list(it.get("terms") or [])
        new_terms = gl.terms_in(it["t"])
        arch[it["id"]] = {"id": it["id"], "t": it["t"], "u": it["u"], "src": it.get("src", ""), "ts": it["ts"],
                          "rg": it.get("rg") or [], "mk": it.get("mk") or [],
                          "terms": list(dict.fromkeys(new_terms + old_terms))[:8]}
    for it in merged:
        rec = it.get("_rec")
        if rec and parse_iso(rec["ts"]) >= arch_horizon:
            arch[rec["id"]] = {k: rec[k] for k in ("id", "t", "u", "src", "ts", "rg", "mk", "terms")}
    # titles already archived under another URL (e.g. Google News link first, publisher link later) collapse
    seen_t, arch_items = set(), []
    for r in sorted(arch.values(), key=lambda r: r["ts"], reverse=True):
        k = norm_title(r["t"])
        if k in seen_t:
            continue
        seen_t.add(k)
        arch_items.append(r)
    arch_items = arch_items[:ARCHIVE_MAX]

    term_map = {}
    for r in arch_items:
        for tid in r["terms"]:
            lst = term_map.setdefault(tid, [])
            if len(lst) < TERM_STORIES and all(x["u"] != r["u"] for x in lst):
                lst.append({"t": r["t"], "u": r["u"], "src": r["src"], "ts": r["ts"]})

    updated = iso(fetched_at)
    dump(out_dir / "news.json", {"updated": updated, "items": news, "regions": REGIONS, "markets": MARKETS})
    dump(out_dir / "news-archive.json", {"updated": updated, "items": arch_items})
    dump(out_dir / "news-terms.json", term_map)

    for row in rows:
        row["kept"] = per_feed_kept.get(row["id"], 0)
        row["fresh"] = per_feed_fresh.get(row["id"], 0)
    if out_dir == LIVE:
        write_status("news", [dict(r) for r in rows])
    return {"news": news, "archive": arch_items, "terms": term_map, "rows": rows, "undated": len(undated),
            "carried": len(carried), "glossary_terms": len(gl.ids)}


_BY_LABEL = {}
for _f in FEEDS:
    if not _f[5].get("gn"):
        _BY_LABEL.setdefault(_f[1], _f)


def carried_feed(it):
    """Feed settings for an item carried over from the previous news.json (re-tagged with the current rules)."""
    f = _BY_LABEL.get(it.get("src"))
    if f:
        return f
    prev = it.get("_carried") or []
    return ("carried", it.get("src") or "", "", prev[0] if prev else "gl", [], {"gn": True})


def select(items, cap):
    """Newest first, but busy publishers cannot crowd out the rest: each publisher keeps its newest few, each region
    and market tag its newest couple of dozen, then the remaining room goes by recency."""
    items = sorted(items, key=lambda r: r["ts"], reverse=True)
    if len(items) <= cap:
        return items
    chosen, quota = set(), {}

    def take(key, n, it):
        if quota.get(key, 0) < n:
            quota[key] = quota.get(key, 0) + 1
            chosen.add(it["id"])
    for it in items:
        take(("src", it["src"]), 4, it)
        for r in it["rg"]:
            take(("rg", r), 25, it)
        for m in it["mk"][:1]:
            take(("mk", m), 15, it)
    for it in items:
        if len(chosen) >= cap:
            break
        chosen.add(it["id"])
    out = [it for it in items if it["id"] in chosen]
    return out[:cap] if len(out) > cap else out


def report(res):
    news, rows = res["news"], res["rows"]
    print(f"news: {len(news)} items in the last {NEWS_HOURS} h (carried forward {res['carried']}, undated skipped "
          f"{res['undated']}); archive {len(res['archive'])}; {len(res['terms'])} terms with stories; "
          f"glossary {res['glossary_terms']} terms")
    print(f"  {'feed':<22} {'ok':<4} {'parsed':>6} {'kept':>5} {'new':>4} {'ms':>6}  error")
    for r in rows:
        print(f"  {r['id']:<22} {'ok' if r['ok'] else 'FAIL':<4} {r['n']:>6} {r['kept']:>5} {r['fresh']:>4} {r['ms']:>6}  "
              f"{r['error'] or ''}")
    rg, mk = {}, {}
    for it in news:
        for x in it["rg"]:
            rg[x] = rg.get(x, 0) + 1
        for x in it["mk"]:
            mk[x] = mk.get(x, 0) + 1
    print("  regions:", ", ".join(f"{k} {rg.get(k, 0)}" for k in REGIONS))
    print("  markets:", ", ".join(f"{k} {mk.get(k, 0)}" for k in MARKETS))
    print("  with terms:", sum(1 for it in news if it["terms"]), "of", len(news))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--glossary", help="built glossary index.json (dist/data/glossary/index.json)")
    ap.add_argument("--out-dir", default=str(LIVE))
    a = ap.parse_args()
    res = run(a.glossary, pathlib.Path(a.out_dir).resolve())
    report(res)
    ok = sum(1 for r in res["rows"] if r["ok"])
    if not ok:
        print("no feed could be read", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
