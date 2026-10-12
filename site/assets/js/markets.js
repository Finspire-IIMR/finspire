/* Finspire Markets: live quotes hub, ticker, markets board, rates board (policy rates, bond yields, U.S. Treasury
   yield curve), commodities / currencies / crypto rows, and the home-page mini board.
   Needs finspire.js (window.Finspire). Styles: assets/css/markets.css (every class prefixed mk-).

   window.FinspireMarkets
     mountTicker(el)            continuous scrolling ticker of every catalog instrument (links to markets/#mk-<ID>)
     mountMini(el, ids)         compact live board (home page), default ids NIFTY SENSEX SPX US10Y BRENT USDINR
     mountStatus(el)            "Live · updated 10:42 IST" line (role=status; only the state sentence is announced)
     mountPage(root)            the Markets page (auto-runs for <main data-mk-page>)
     refresh() → Promise        poll the live sources now
     state()                    {state, liveAt, snapAt, failures, quotes}
     catalog                    the instrument list (same ids/groups/symbols as scripts/fetch_markets.py)

   Data: render at once from data/live/markets.json (snapshot), then poll CNBC (one batched request) and Moneycontrol
   (three requests) every cfg.marketsPollSeconds while the tab is visible. If live calls fail, the snapshot stays and
   the status line says so. Missing values show "—"; nothing is ever made up. */
(() => {
"use strict";
if (window.FinspireMarkets) return;
const F = window.Finspire;
if (!F) return;
const D = document, W = window, h = F.dom.h, fmt = F.fmt;
const IST = "Asia/Kolkata";
/* link to an instrument on the Markets page (null when that page is switched off) */
const pageOn = () => !F.feature || F.feature("markets");
const mkHref = id => pageOn() ? F.url((F.cfg.pages && F.cfg.pages.markets || "markets/") + "#mk-" + id) : null;

/* ------------------------------------------------------------------ catalog
   id, group, provider, symbol, kind, name, ticker label, sub line, decimals, session, glossary id candidates */
const RAW = [
  ["NIFTY", "india", "mc", "in;NSX", "px", "Nifty 50", "NIFTY 50", "50 large NSE companies", 2, "in", ["nifty-50", "nifty"]],
  ["SENSEX", "india", "mc", "in;SEN", "px", "Sensex", "SENSEX", "30 large BSE companies", 2, "in", ["sensex", "bse-sensex"]],
  ["BANKNIFTY", "india", "mc", "in;nbx", "px", "Nifty Bank", "NIFTY BANK", "Bank stocks on the NSE", 2, "in", ["nifty-bank", "bank-nifty"]],
  ["INDIAVIX", "india", "cnbc", ".NIFVIX", "px", "India VIX", "INDIA VIX", "Expected Nifty volatility", 2, "in", ["india-vix", "volatility-index", "vix"]],
  ["SPX", "americas", "cnbc", ".SPX", "px", "S&P 500", "S&P 500", "500 large U.S. companies", 2, "us", ["s-and-p-500", "sp-500", "s-p-500"]],
  ["NDX", "americas", "cnbc", ".IXIC", "px", "Nasdaq Composite", "NASDAQ", "Nasdaq-listed stocks, tech-heavy", 2, "us", ["nasdaq-composite", "nasdaq"]],
  ["DJI", "americas", "cnbc", ".DJI", "px", "Dow Jones", "DOW", "30 U.S. blue chips", 2, "us", ["dow-jones-industrial-average", "dow-jones"]],
  ["VIX", "americas", "cnbc", ".VIX", "px", "VIX", "VIX", "Expected S&P 500 volatility", 2, "us", ["vix", "cboe-volatility-index", "volatility-index"]],
  ["FTSE", "europe", "cnbc", ".FTSE", "px", "FTSE 100", "FTSE 100", "100 large London-listed firms", 2, "ldn", ["ftse-100"]],
  ["DAX", "europe", "cnbc", ".GDAXI", "px", "DAX", "DAX", "40 large German companies", 2, "eu", ["dax", "dax-40"]],
  ["CAC", "europe", "cnbc", ".FCHI", "px", "CAC 40", "CAC 40", "40 large French companies", 2, "eu", ["cac-40"]],
  ["STOXX50", "europe", "cnbc", ".STOXX50E", "px", "Euro Stoxx 50", "STOXX 50", "50 large euro-area companies", 2, "eu", ["euro-stoxx-50"]],
  ["N225", "asia", "cnbc", ".N225", "px", "Nikkei 225", "NIKKEI", "225 Tokyo-listed stocks", 2, "tyo", ["nikkei-225", "nikkei"]],
  ["HSI", "asia", "cnbc", ".HSI", "px", "Hang Seng", "HANG SENG", "Largest Hong Kong stocks", 2, "hk", ["hang-seng-index", "hang-seng"]],
  ["SSEC", "asia", "cnbc", ".SSEC", "px", "Shanghai Composite", "SHANGHAI", "Stocks listed in Shanghai", 2, "sh", ["shanghai-composite", "sse-composite"]],
  ["KOSPI", "asia", "cnbc", ".KS11", "px", "KOSPI", "KOSPI", "Korea's main stock board", 2, "seo", ["kospi"]],
  ["ASX200", "asia", "cnbc", ".AXJO", "px", "S&P/ASX 200", "ASX 200", "200 large Australian stocks", 2, "syd", ["asx-200", "s-and-p-asx-200"]],
  ["STI", "asia", "cnbc", ".STI", "px", "Straits Times", "STI", "30 large Singapore stocks", 2, "sg", ["straits-times-index"]],
  ["TWSE", "asia", "cnbc", ".TWII", "px", "Taiex", "TAIEX", "Stocks listed in Taiwan", 2, "tpe", ["taiex", "twse"]],
  ["US2Y", "yields", "cnbc", "US2Y", "yld", "U.S. 2-year", "US 2Y", "Treasury note", 3, "h24", ["treasury-yield", "us-treasury", "government-bond-yield", "bond-yield"]],
  ["US10Y", "yields", "cnbc", "US10Y", "yld", "U.S. 10-year", "US 10Y", "Benchmark Treasury note", 3, "h24", ["us-10-year-treasury-yield", "treasury-yield", "benchmark-yield", "bond-yield"]],
  ["US30Y", "yields", "cnbc", "US30Y", "yld", "U.S. 30-year", "US 30Y", "Treasury bond", 3, "h24", ["treasury-yield", "long-bond", "bond-yield"]],
  ["IN10Y", "yields", "cnbc", "IN10Y", "yld", "India 10-year", "IN 10Y", "Government security (G-sec)", 3, "h24", ["g-sec", "government-securities", "benchmark-yield", "bond-yield"]],
  ["DE10Y", "yields", "cnbc", "DE10Y", "yld", "Germany 10-year", "DE 10Y", "Bund", 3, "h24", ["bund", "bond-yield"]],
  ["GB10Y", "yields", "cnbc", "GB10Y", "yld", "U.K. 10-year", "UK 10Y", "Gilt", 3, "h24", ["gilt", "gilts", "bond-yield"]],
  ["JP10Y", "yields", "cnbc", "JP10Y", "yld", "Japan 10-year", "JP 10Y", "Japanese government bond (JGB)", 3, "h24", ["japanese-government-bond", "jgb", "bond-yield"]],
  ["CN10Y", "yields", "cnbc", "CN10Y", "yld", "China 10-year", "CN 10Y", "Chinese government bond", 3, "h24", ["bond-yield"]],
  ["GOLD", "commodities", "cnbc", "@GC.1", "px", "Gold", "GOLD", "Futures · $ per ounce", 2, "h24", ["gold"]],
  ["SILVER", "commodities", "cnbc", "@SI.1", "px", "Silver", "SILVER", "Futures · $ per ounce", 3, "h24", ["silver"]],
  ["BRENT", "commodities", "cnbc", "@LCO.1", "px", "Brent crude", "BRENT", "Futures · $ per barrel", 2, "h24", ["brent-crude", "brent"]],
  ["WTI", "commodities", "cnbc", "@CL.1", "px", "WTI crude", "WTI", "Futures · $ per barrel", 2, "h24", ["wti-crude", "west-texas-intermediate", "wti"]],
  ["NATGAS", "commodities", "cnbc", "@NG.1", "px", "Natural gas", "NAT GAS", "Futures · $ per MMBtu", 3, "h24", ["natural-gas"]],
  ["COPPER", "commodities", "cnbc", "@HG.1", "px", "Copper", "COPPER", "Futures · $ per pound", 3, "h24", ["copper"]],
  ["USDINR", "fx", "cnbc", "INR=", "px", "USD/INR", "USD/INR", "Rupees per U.S. dollar", 3, "h24", ["usd-inr", "exchange-rate"]],
  ["DXY", "fx", "cnbc", ".DXY", "px", "Dollar index", "DXY", "Dollar vs six currencies", 2, "h24", ["us-dollar-index", "dollar-index", "dxy"]],
  ["EURUSD", "fx", "cnbc", "EUR=", "px", "EUR/USD", "EUR/USD", "Dollars per euro", 4, "h24", ["currency-pair", "exchange-rate"]],
  ["USDJPY", "fx", "cnbc", "JPY=", "px", "USD/JPY", "USD/JPY", "Yen per dollar", 2, "h24", ["currency-pair", "exchange-rate"]],
  ["GBPUSD", "fx", "cnbc", "GBP=", "px", "GBP/USD", "GBP/USD", "Dollars per pound", 4, "h24", ["currency-pair", "exchange-rate"]],
  ["USDCNY", "fx", "cnbc", "CNY=", "px", "USD/CNY", "USD/CNY", "Yuan per dollar", 4, "h24", ["currency-pair", "exchange-rate"]],
  ["BTC", "crypto", "cnbc", "BTC.CM=", "px", "Bitcoin", "BTC", "US dollars", 0, "c24", ["bitcoin"]],
  ["ETH", "crypto", "cnbc", "ETH.CM=", "px", "Ether", "ETH", "US dollars", 2, "c24", ["ether", "ethereum"]]
];
const CAT = RAW.map(r => Object.freeze({ id: r[0], group: r[1], prov: r[2], sym: r[3], kind: r[4], name: r[5], tick: r[6], sub: r[7], dp: r[8], sess: r[9], terms: r[10] }));
const BY = Object.fromEntries(CAT.map(c => [c.id, c]));
const REGIONS = [
  { id: "india", name: "India", lead: ["NIFTY"] },
  { id: "americas", name: "Americas", lead: ["SPX"] },
  { id: "europe", name: "Europe", lead: ["STOXX50", "FTSE", "DAX"] },
  { id: "asia", name: "Asia-Pacific", short: "Asia", lead: ["N225", "HSI"],
    info: ["Asia-Pacific trades first", "Sydney, Tokyo and Seoul open hours before Mumbai, so their moves often set the mood for the Nifty's open."] }
];
const hm = s => { const [a, b] = s.split(":").map(Number); return a * 60 + b; };
const SESS = {
  in: { tz: "Asia/Kolkata", o: "09:15", c: "15:30", where: "NSE/BSE" }, us: { tz: "America/New_York", o: "09:30", c: "16:00", where: "New York" },
  ldn: { tz: "Europe/London", o: "08:00", c: "16:30", where: "London" }, eu: { tz: "Europe/Berlin", o: "09:00", c: "17:30", where: "Frankfurt/Paris" },
  tyo: { tz: "Asia/Tokyo", o: "09:00", c: "15:30", where: "Tokyo" }, hk: { tz: "Asia/Hong_Kong", o: "09:30", c: "16:00", where: "Hong Kong" },
  sh: { tz: "Asia/Shanghai", o: "09:30", c: "15:00", where: "Shanghai" }, seo: { tz: "Asia/Seoul", o: "09:00", c: "15:30", where: "Seoul" },
  syd: { tz: "Australia/Sydney", o: "10:00", c: "16:00", where: "Sydney" }, sg: { tz: "Asia/Singapore", o: "09:00", c: "17:00", where: "Singapore" },
  tpe: { tz: "Asia/Taipei", o: "09:00", c: "13:30", where: "Taipei" },
  h24: { tz: "America/New_York", fx: true }, c24: { always: true }
};

/* ------------------------------------------------------------------ time helpers */
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PF = {};
function tzParts(ms, tz) {
  let f = PF[tz];
  if (!f) {
    try { f = PF[tz] = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }); }
    catch (e) { return null; }
  }
  const o = {};
  for (const p of f.formatToParts(ms)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, mi: +o.minute, wd: WD.indexOf(o.weekday) };
}
const istDay = ms => { const p = tzParts(ms, IST); return p ? p.y * 10000 + p.m * 100 + p.d : 0; };
const istWd = ms => { const p = tzParts(ms, IST); return p ? WD[p.wd] : ""; };
let secFmt = null;
function istClock(ms) {
  try { secFmt = secFmt || new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); return secFmt.format(ms); }
  catch (e) { return fmt.time(ms); }
}
const istHM = ms => fmt.time(ms, IST) + " IST";
function whenIST(ms, now) {
  now = now || Date.now();
  if (istDay(ms) === istDay(now)) return istHM(ms);
  return fmt.date(ms, { year: undefined, timeZone: IST }) + ", " + istHM(ms);
}
/* Exchange session from local hours (holidays not modelled). → {open, at (ms of next close/open), kind} */
function session(inst, now) {
  const S = SESS[inst.sess];
  if (!S) return null;
  if (S.always) return { open: true, kind: "always" };
  const p = tzParts(now, S.tz);
  if (!p) return null;
  const mins = p.h * 60 + p.mi;
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi), off = wall - Math.floor(now / 60000) * 60000;
  const at = (k, m) => Date.UTC(p.y, p.m - 1, p.d + k, 0, m) - off;
  if (S.fx) {   // around the clock on weekdays: Sunday 18:00 to Friday 17:00 New York time
    const open = (p.wd >= 1 && p.wd <= 4) || (p.wd === 5 && mins < 1020) || (p.wd === 0 && mins >= 1080);
    let next = null;
    if (open) next = at((5 - p.wd + 7) % 7, 1020);
    else next = at(p.wd === 6 ? 1 : (p.wd === 0 ? 0 : 2), 1080);
    return { open, at: next, kind: "24h" };
  }
  const o = hm(S.o), c = hm(S.c), wk = p.wd >= 1 && p.wd <= 5;
  const open = wk && mins >= o && mins < c;
  if (open) return { open, at: at(0, c), kind: "ex" };
  let k = 0;
  if (!(wk && mins < o)) { k = 1; while (((p.wd + k) % 7) === 0 || ((p.wd + k) % 7) === 6) k++; }
  return { open, at: at(k, o), kind: "ex" };
}
/* short = card footer ("Closes 21:00", "Opens Tue 09:15"; IST is stated once in the hint) */
function sessionText(inst, s, now, short) {
  if (!s) return "";
  if (s.kind === "always") return short ? "Around the clock" : "Trades around the clock";
  const t = short ? fmt.time(s.at, IST) : istHM(s.at), sameDay = istDay(s.at) === istDay(now);
  const when = sameDay ? t : istWd(s.at) + " " + t;
  if (s.kind === "24h") return s.open ? (short ? "Weekdays, around the clock" : "Trades around the clock on weekdays") : "Reopens " + when;
  return (s.open ? "Closes " : "Opens ") + when;
}
/* India: Moneycontrol's market_state wins when it is fresh (it knows holidays). */
function isOpen(inst, q, now) {
  const s = session(inst, now);
  if (!s) return { s, open: null };
  let open = s.open;
  if (inst.group === "india" && q && q.state && q.src === "mc" && q.at && now - q.at < 6 * 3600e3) open = open && q.state === "OPEN";
  return { s, open };
}

/* ------------------------------------------------------------------ parsing (defensive) */
function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[,%+\s]/g, "").replace(/−/g, "-");
  if (!s) return null;
  if (s.toUpperCase() === "UNCH") return 0;
  if (!/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}
const sane = (v, kind) => v != null && (kind === "yld" ? v > -1 && v < 25 : v > 0);
function parseTime(s) {
  if (!s) return null;
  s = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  let off = m[3] || "";
  if (/^[+-]\d{4}$/.test(off)) off = off.slice(0, 3) + ":" + off.slice(3);
  const t = Date.parse(m[1] + "T" + m[2] + (off || "+05:30"));
  return isFinite(t) ? new Date(t).toISOString() : null;
}
function parseCnbc(j) {
  let rows = (((j || {}).FormattedQuoteResult) || {}).FormattedQuote || [];
  if (!Array.isArray(rows)) rows = [rows];
  const bySym = {};
  CAT.forEach(c => { if (c.prov === "cnbc") bySym[c.sym] = c; });
  const out = {};
  for (const r of rows) {
    const c = r && bySym[r.symbol];
    if (!c || String(r.code) !== "0") continue;
    const last = num(r.last);
    if (!sane(last, c.kind)) continue;
    const q = { last, chg: num(r.change), pct: num(r.change_pct), prev: num(r.previous_day_closing) };
    for (const k of ["open", "high", "low"]) { const v = num(r[k]); q[k] = sane(v, c.kind) && v !== 0 ? v : null; }
    if (q.prev != null && !sane(q.prev, c.kind)) q.prev = null;
    if (q.chg == null && q.prev != null) q.chg = +(last - q.prev).toFixed(6);
    if (String(r.change).toUpperCase() === "UNCH" && !(q.open || q.high || q.low)) q.chg = q.pct = null;   // no session data: change unknown
    if (c.kind === "yld" && q.chg != null && last - q.chg > 0) q.pct = +(q.chg / (last - q.chg) * 100).toFixed(4);
    let lt = String(r.last_time || "");
    if (/IST$/.test(String(r.last_timedate || "")) && /\+05:?00$/.test(lt)) lt = lt.replace(/\+05:?00$/, "+05:30");
    q.asOf = parseTime(lt);
    q.rt = String(r.realTime).toLowerCase() === "true";
    q.src = "cnbc";
    out[c.id] = q;
  }
  return out;
}
function parseMc(j) {
  const r = (j || {}).data || {};
  const last = num(r.pricecurrent);
  if (!sane(last, "px")) return null;
  const q = { last, chg: num(r.pricechange), pct: num(r.pricepercentchange), prev: num(r.priceprevclose) };
  for (const [k, s] of [["open", "OPEN"], ["high", "HIGH"], ["low", "LOW"]]) { const v = num(r[s]); q[k] = sane(v, "px") ? v : null; }
  if (q.prev != null && !sane(q.prev, "px")) q.prev = null;
  q.asOf = parseTime(r.lastupdate || r.lastupd);
  q.rt = true; q.src = "mc";
  const st = String(r.market_state || "").toUpperCase();
  if (st === "OPEN" || st === "CLOSED") q.state = st;
  return q;
}

/* ------------------------------------------------------------------ hub */
const CNBC_URL = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=";
const CNBC_TAIL = "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1";
const MC_URL = "https://priceapi.moneycontrol.com/pricefeed/notapplicable/inidicesindia/";
const pollMs = () => Math.max(5, +F.cfg.marketsPollSeconds || 15) * 1000;
const hub = { q: {}, snap: null, state: "loading", liveAt: 0, snapAt: 0, failures: 0, subs: new Set(), timer: 0, inflight: null, started: false, snapP: null, partial: [] };

function getJSON(u, ms) {
  const ctl = "AbortController" in W ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), ms || 8000) : 0;
  return fetch(u, { cache: "no-store", credentials: "omit", mode: "cors", signal: ctl ? ctl.signal : undefined })
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .finally(() => clearTimeout(t));
}
function notify(changed) {
  hub.subs.forEach(fn => { try { fn(changed || null); } catch (e) { setTimeout(() => { throw e; }); } });
}
function mergeQuotes(got, stamp) {
  const changed = new Map();
  for (const id in got) {
    const n = got[id], o = hub.q[id];
    if (!n) continue;
    n.at = stamp;
    // a live price replacing the saved snapshot is a baseline, not a move: no flash (direction 0)
    if (o && o.last !== n.last) changed.set(id, o.live ? (n.last > o.last ? 1 : -1) : 0);
    else if (o && (o.chg !== n.chg || o.high !== n.high || o.low !== n.low || o.state !== n.state)) changed.set(id, 0);
    else if (!o) changed.set(id, 0);
    hub.q[id] = n;
  }
  return changed;
}
function loadSnapshot() {
  hub.snapP = F.fetchJSON("data/live/markets.json", { bust: true }).then(j => {
    hub.snap = j || {};
    const t = Date.parse(hub.snap.updated || "");
    hub.snapAt = isFinite(t) ? t : 0;
    const qs = hub.snap.quotes || {}, take = {};
    for (const id in qs) {
      if (!BY[id] || !qs[id] || !sane(num(qs[id].last), BY[id].kind)) continue;
      const cur = hub.q[id];
      if (cur && cur.live) continue;   // never replace a live price with the older snapshot
      take[id] = Object.assign({}, qs[id]);
    }
    const ch = mergeQuotes(take, hub.snapAt);
    if (hub.state === "loading") hub.state = "snapshot";
    return ch;
  }, () => { if (!hub.snap) hub.snap = { quotes: {}, policy: [], curve: null, failed: true }; return new Map(); });
  return hub.snapP;
}
/* a Moneycontrol symbol that answered 5xx is left alone for the next few polls (the snapshot covers it meanwhile) */
const mcSkip = {};
function poll() {
  if (hub.inflight) return hub.inflight;
  clearTimeout(hub.timer); hub.timer = 0;
  const syms = CAT.filter(c => c.prov === "cnbc").map(c => c.sym);
  const mc = CAT.filter(c => c.prov === "mc").filter(c => { if (mcSkip[c.id] > 0) { mcSkip[c.id]--; return false; } return true; });
  const jobs = [getJSON(CNBC_URL + encodeURIComponent(syms.join("|")) + CNBC_TAIL).then(parseCnbc)]
    .concat(mc.map(c => getJSON(MC_URL + encodeURIComponent(c.sym))
      .catch(e => { if (/HTTP 5\d\d/.test(String(e && e.message))) mcSkip[c.id] = 4; throw e; })
      .then(j => { const q = parseMc(j); if (!q) throw new Error("no price"); return { [c.id]: q }; })));
  hub.inflight = Promise.allSettled(jobs).then(res => {
    const got = {}; let ok = 0; const bad = [];
    res.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value && Object.keys(r.value).length) { ok++; Object.assign(got, r.value); }
      else bad.push(i === 0 ? "CNBC" : "Moneycontrol");
    });
    const now = Date.now();
    for (const id in got) got[id].live = true;
    const first = !hub.liveAt;
    const changed = mergeQuotes(got, now);
    if (first) changed.forEach((v, k) => changed.set(k, 0));   // the first live merge is a baseline: text updates, nothing flashes
    const next = ok ? "live" : "fallback";
    if (D.hidden) { hub.prevState = next; hub.state = "paused"; } else hub.state = next;
    if (ok) { hub.liveAt = now; hub.failures = 0; hub.partial = [...new Set(bad)]; }
    else {
      hub.failures++;
      if (hub.failures % 4 === 1) return loadSnapshot().then(ch => { ch.forEach((v, k) => changed.set(k, v)); return changed; });
    }
    return changed;
  }).then(changed => { notify(changed); return changed; })
    .finally(() => { hub.inflight = null; schedule(); });
  return hub.inflight;
}
function schedule() {
  clearTimeout(hub.timer); hub.timer = 0;
  if (!hub.started || D.hidden) return;
  hub.timer = setTimeout(poll, pollMs());
}
function onVis() {
  if (!hub.started) return;
  if (D.hidden) {
    clearTimeout(hub.timer); hub.timer = 0;
    hub.prevState = hub.state === "paused" ? hub.prevState : hub.state;
    hub.state = "paused"; notify(null);
  } else {
    if (hub.state === "paused") hub.state = hub.prevState || "snapshot";
    notify(null);
    poll();
  }
}
function start() {
  if (hub.started) return;
  hub.started = true;
  D.addEventListener("visibilitychange", onVis);
  loadSnapshot().then(ch => {
    notify(ch);
    if (!D.hidden) poll(); else { hub.prevState = hub.state; hub.state = "paused"; notify(null); }
  });
}
function subscribe(fn) {
  hub.subs.add(fn);
  start();
  if (hub.snap) fn(null);
  return () => hub.subs.delete(fn);
}

/* ------------------------------------------------------------------ formatting */
/* direction as shown: a change that rounds to zero on screen is flat, not a red or green 0.00 */
const dirOf = q => {
  if (!q) return 0;
  if (q.pct != null && Math.abs(q.pct) < 0.005 && (q.chg == null || Math.abs(q.chg) < 0.0005)) return 0;
  const c = q.chg != null ? q.chg : q.pct;
  return c > 0 ? 1 : c < 0 ? -1 : 0;
};
const dirCls = d => d > 0 ? "mk-up" : d < 0 ? "mk-dn" : "mk-flat";
const valText = (c, q) => !q || q.last == null ? "—" : c.kind === "yld" ? fmt.num(q.last, 3) + "%" : fmt.num(q.last, c.dp);
const chgText = (c, q) => !q || q.chg == null ? "—" : c.kind === "yld" ? fmt.signed(q.chg * 100, 1) + " bp" : fmt.signed(q.chg, c.dp);
const pctText = q => !q || q.pct == null ? "—" : fmt.pct(q.pct);
const moveText = (c, q) => c.kind === "yld" ? chgText(c, q) : pctText(q);
function asOfText(q, now, short) {
  if (!q || !q.asOf) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.asOf)) return (short ? "Close " : "Last close ") + fmt.date(q.asOf, { year: undefined });
  const t = Date.parse(q.asOf);
  return isFinite(t) ? (short ? "" : "As of ") + whenIST(t, now) : "";
}
const reduce = W.matchMedia ? W.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
function setText(el, s) { if (el && el.textContent !== s) { el.textContent = s; return true; } return false; }
function flash(el, d) {
  if (!el || !d || reduce.matches) return;
  const k = d > 0 ? "up" : "dn", a = (el._mkF = !el._mkF) ? "a" : "b";
  el.classList.remove("mk-fl-up-a", "mk-fl-up-b", "mk-fl-dn-a", "mk-fl-dn-b");
  el.classList.add("mk-fl-" + k + "-" + a);
}
function setDir(el, d) {
  if (!el) return;
  const c = dirCls(d);
  if (el._mkD !== c) { el.classList.remove("mk-up", "mk-dn", "mk-flat"); el.classList.add(c); el._mkD = c; }
}
const arrow = () => h("i", { class: "mk-arw", "aria-hidden": "true" });

/* glossary ids for instrument labels (the dictionary grows over time, so resolve against whatever has loaded) */
const termCache = {};
function termFor(c) {
  if (!F.glossary.loaded()) return null;
  if (termCache[c.id] !== undefined) return termCache[c.id];
  let id = c.terms.find(t => F.glossary.get(t)) || null;
  if (!id) {
    const low = c.name.toLowerCase();
    const hit = F.glossary.search(c.name, { limit: 3 }).find(r => r.term.toLowerCase() === low || (r.aliases || []).some(a => String(a).toLowerCase() === low) || (r.abbr || []).includes(c.name));
    id = hit ? hit.id : null;
  }
  return (termCache[c.id] = id);
}
function termEl(c, cls) {
  const el = h("span", { class: cls || "mk-name-t" }, c.name);
  el._mkInst = c;
  applyTerm(el);
  return el;
}
/* a term label is a button that opens the dictionary tip (dialog); el._mkNoTab keeps it out of the Tab order where the
   tile around it is already one tab stop */
function applyTerm(el) {
  const id = el._mkInst ? termFor(el._mkInst) : (el._mkTerms ? el._mkTerms.find(t => F.glossary.get(t)) : null);
  if (id) {
    el.setAttribute("data-term", id); el.tabIndex = el._mkNoTab ? -1 : 0; el.classList.add("mk-term");
    el.setAttribute("role", "button"); el.setAttribute("aria-haspopup", "dialog");
  }
}
function phraseTerm(text, ids, cls) {
  const el = h("span", { class: cls || "" }, text);
  el._mkTerms = ids;
  applyTerm(el);
  return el;
}
const termEls = new Set();
function track(el) { termEls.add(el); return el; }
F.on("glossary", () => { termEls.forEach(el => { if (el.isConnected) applyTerm(el); else termEls.delete(el); }); });
/* The dictionary index (the biggest file) is fetched after the first live poll has answered, when the thread is free:
   prices and news come first, the underlines and tooltips a moment later. */
let glossaryQueued = false;
function loadGlossaryAfterPrices() {
  if (glossaryQueued || F.glossary.loaded()) return;
  glossaryQueued = true;
  let done = false, off = null;
  const go = () => {
    if (done) return;
    done = true; if (off) off();
    const fn = () => F.glossary.load().catch(() => {});
    if ("requestIdleCallback" in W) W.requestIdleCallback(fn, { timeout: 1500 }); else setTimeout(fn, 200);
  };
  const ready = () => hub.liveAt || hub.state === "fallback" || hub.failures;
  if (ready()) { go(); return; }
  off = subscribe(() => { if (ready()) setTimeout(go, 0); });
  setTimeout(go, 6000);   // slow sources must not hold the dictionary back for ever
}

/* ------------------------------------------------------------------ status line */
/* {st, text, clock}: text is the announced part (changes only with the state), clock the minute stamp beside it */
function statusInfo() {
  const s = hub.state;
  if (s === "loading") return { st: "loading", text: "Loading prices…", clock: "" };
  if (s === "paused") return { st: "paused", text: "Paused · resumes when you come back", clock: "" };
  if (s === "live") return { st: "live", text: "Live", clock: " · updated " + istHM(hub.liveAt) };
  if (s === "fallback" || s === "snapshot") {
    if (!hub.snapAt && !Object.keys(hub.q).length) return { st: "fallback", text: s === "snapshot" ? "Connecting to live prices…" : "Prices not available right now", clock: "" };
    const when = hub.snapAt ? " from " + whenIST(hub.snapAt) : "";
    return { st: s === "snapshot" ? "loading" : "fallback", text: "Saved prices" + when + (s === "snapshot" ? " · connecting" : " · reconnecting"), clock: "" };
  }
  return { st: "loading", text: "", clock: "" };
}
function mountStatus(el) {
  if (!el || el._mk) return;
  el._mk = 1;
  el.classList.add("mk-status");
  el.setAttribute("role", "status");
  el.title = "Refreshes every " + Math.round(pollMs() / 1000) + " s while this tab is open";
  const dot = h("i", { class: "mk-sdot", "aria-hidden": "true" }), txt = h("span", { class: "mk-stext" }), clk = h("span", { class: "mk-stime", "aria-hidden": "true" });
  F.dom.clear(el); el.append(dot, h("span", { class: "mk-sbody" }, txt, clk));
  const t0 = Date.now();
  let hold = 0;
  const upd = () => {
    const i = statusInfo();
    // the saved-prices sentence is worth showing only when live prices take longer than 1.5 s
    if (i.st === "loading" && hub.state === "snapshot" && Date.now() - t0 < 1500) {
      if (!hold) hold = setTimeout(() => { hold = 0; upd(); }, 1500 - (Date.now() - t0));
      return;
    }
    el.dataset.state = i.st;
    setText(txt, i.text);       // announced only when the sentence itself changes
    setText(clk, i.clock);      // the minute stamp is decorative for screen readers
  };
  upd();
  subscribe(upd);
}

/* ------------------------------------------------------------------ ticker */
const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z"/></svg>';
function svgEl(markup) { const t = D.createElement("template"); t.innerHTML = markup; return t.content.firstChild; }   // static markup only
/* The tape is built once the saved snapshot is in (the skeleton holds its place until then), so it never scrolls
   label-only cells and never re-sizes when the numbers land. The board exposes every quote to screen readers, so the
   tape itself is decorative: one tab stop (the pause button) instead of 41 links. */
function mountTicker(el) {
  if (!el || el._mk) return;
  el._mk = 1;
  el.classList.add("mk-tape-slot");
  if (!el.children.length) el.appendChild(h("div", { class: "mk-tape-skel", "aria-hidden": "true" }));
  const onPage = !!D.querySelector("[data-mk-page]");
  const refs = [];
  let track_ = null, view = null, built = false, empty = false, paused = false;
  const mkSet = clone => {
    const ul = h("ul", { class: "mk-tape-set" + (clone ? " mk-tape-clone" : ""), "aria-hidden": "true" });
    CAT.forEach(c => {
      const v = h("span", { class: "mk-tv" }), m = h("span", { class: "mk-tc" }, arrow(), h("span", { class: "mk-tcv" }));
      const href = onPage ? "#mk-" + c.id : mkHref(c.id);
      const a = h(href ? "a" : "span", { class: "mk-ti", href, tabindex: "-1" }, h("b", { class: "mk-tn" }, c.tick), v, m);
      ul.appendChild(h("li", null, a));
      refs.push({ c, v, m, mv: m.lastChild, a });
    });
    return ul;
  };
  function build() {
    built = true; empty = false;
    track_ = h("div", { class: "mk-tape-track" }, mkSet(false), mkSet(true));
    view = h("div", { class: "mk-tape-view" }, track_);
    const btn = h("button", { class: "mk-tape-pause", type: "button", "aria-pressed": "false", "aria-label": "Pause ticker", title: "Pause ticker" }, svgEl(PAUSE_SVG));
    btn.addEventListener("click", () => {
      paused = !paused;
      el.classList.toggle("mk-paused", paused);
      btn.setAttribute("aria-pressed", String(paused));
      btn.setAttribute("aria-label", paused ? "Play ticker" : "Pause ticker"); btn.title = paused ? "Play ticker" : "Pause ticker";
      btn.replaceChildren(svgEl(paused ? PLAY_SVG : PAUSE_SVG));
    });
    F.dom.clear(el);
    el.classList.add("mk-tape"); el.classList.remove("mk-tape-empty");
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Live prices ticker");
    el.append(view, btn);
    // the animation runs only while the ticker is on screen and the tab is visible
    if ("IntersectionObserver" in W) new IntersectionObserver(es => es.forEach(e => el.classList.toggle("mk-off", !e.isIntersecting))).observe(el);
    // the loop length follows the set's real width (fonts, value widths)
    if ("ResizeObserver" in W) new ResizeObserver(() => sizeTape()).observe(track_.firstChild);
    else if (D.fonts && D.fonts.ready) D.fonts.ready.then(sizeTape);
  }
  function showEmpty() {
    if (empty) return;
    empty = true;
    el.classList.add("mk-tape", "mk-tape-empty");
    el.replaceChildren(h("p", { class: "mk-tape-msg", role: "status" }, "Prices not available right now"));
  }
  const upd = changed => {
    if (!built) {
      if (hub.q && Object.keys(hub.q).length) build();
      else if (hub.state === "fallback" || (hub.snap && hub.snap.failed && hub.failures)) showEmpty();
      else return;
      if (!built) return;
      changed = null;
    }
    for (const r of refs) {
      if (changed && !changed.has(r.c.id)) continue;
      const q = hub.q[r.c.id], d = dirOf(q), na = !q || q.last == null;
      r.a.classList.toggle("mk-na", na);
      setText(r.v, valText(r.c, q));
      setText(r.mv, na ? "" : moveText(r.c, q).replace(/^[+−]/, ""));
      setDir(r.m, d);
      if (changed && changed.get(r.c.id)) flash(r.v, changed.get(r.c.id));
    }
  };
  let sized = 0, lastW = 0;
  function sizeTape() {
    if (sized || !track_) return;
    sized = 1;
    requestAnimationFrame(() => {
      sized = 0;
      const w = track_.firstChild.getBoundingClientRect().width;
      if (w > 0 && Math.abs(w - lastW) > 2) { lastW = w; track_.style.setProperty("--mk-dur", Math.round(w / 42) + "s"); }
    });
  }
  subscribe(upd);
}

/* ------------------------------------------------------------------ cards (markets board) */
function rangeBits(q) {
  if (!q || q.last == null) return null;
  const lo = q.low, hi = q.high;
  if (lo == null || hi == null || hi < lo) return null;
  const L = Math.min(lo, q.last), H = Math.max(hi, q.last), span = H - L;
  const pos = v => span > 0 ? Math.min(100, Math.max(0, (v - L) / span * 100)) : 50;
  const prev = q.chg != null ? q.last - q.chg : q.prev;
  return { lo: L, hi: H, at: pos(q.last), prev: prev != null && prev >= L && prev <= H ? pos(prev) : null };
}
function card(c) {
  const r = { c };
  r.name = track(termEl(c));
  r.pill = h("span", { class: "mk-pill" }, h("i", { "aria-hidden": "true" }), h("span", null, ""));
  r.last = h("span", { class: "mk-last" }, "—");
  r.abs = h("span", { class: "mk-abs" }, "—");
  r.pct = h("span", { class: "mk-pct" }, "—");
  r.chg = h("span", { class: "mk-chg mk-flat" }, arrow(), r.abs, r.pct);
  r.fill = h("i", { class: "mk-fill" }); r.prev = h("i", { class: "mk-prev", title: "Previous close" }); r.mark = h("i", { class: "mk-mark" });
  r.lo = h("span", { class: "mk-lo" }, "—"); r.hi = h("span", { class: "mk-hi" }, "—");
  r.rng = h("div", { class: "mk-range", role: "img", "aria-label": "Day range not available" },
    h("div", { class: "mk-track" }, r.fill, r.prev, r.mark),
    h("div", { class: "mk-range-l" }, r.lo, h("span", { class: "mk-range-k" }, "Day range"), r.hi));
  r.asof = h("span", { class: "mk-asof" }); r.sess = h("span", { class: "mk-sess" });
  r.delay = h("span", { class: "mk-delay", title: "Quote is delayed by the source", hidden: true }, "delayed");
  r.el = h("article", { class: "mk-card", id: "mk-" + c.id, tabindex: "-1", "aria-label": c.name },
    h("div", { class: "mk-card-top" }, h("h3", { class: "mk-name" }, r.name), r.pill),
    h("p", { class: "mk-sub" }, c.sub),
    h("div", { class: "mk-px" }, r.last, r.chg),
    r.rng,
    h("div", { class: "mk-foot" }, r.asof, r.delay, r.sess));
  return r;
}
function updCard(r, d, now) {
  const c = r.c, q = hub.q[c.id], dir = dirOf(q);
  if (setText(r.last, valText(c, q)) && d) flash(r.last, d);
  setText(r.abs, chgText(c, q)); setText(r.pct, pctText(q));
  setDir(r.chg, dir); r.el.dataset.dir = dir > 0 ? "up" : dir < 0 ? "down" : "flat";
  const b = rangeBits(q);
  r.rng.classList.toggle("mk-na", !b);
  if (b) {
    r.mark.style.left = b.at + "%";
    const from = b.prev == null ? b.at : b.prev;
    r.fill.style.left = Math.min(from, b.at) + "%"; r.fill.style.width = Math.abs(b.at - from) + "%";
    r.prev.hidden = b.prev == null; if (b.prev != null) r.prev.style.left = b.prev + "%";
    setText(r.lo, c.kind === "yld" ? fmt.num(b.lo, 3) : fmt.num(b.lo, c.dp)); setText(r.hi, c.kind === "yld" ? fmt.num(b.hi, 3) : fmt.num(b.hi, c.dp));
    r.rng.setAttribute("aria-label", "Day range " + r.lo.textContent + " to " + r.hi.textContent + ", last " + r.last.textContent);
  } else { setText(r.lo, ""); setText(r.hi, ""); r.rng.setAttribute("aria-label", "Day range not available"); }
  setText(r.asof, asOfText(q, now, true));
  r.asof.title = asOfText(q, now);
  r.delay.hidden = !(q && q.rt === false && q.asOf && !/^\d{4}-\d{2}-\d{2}$/.test(q.asOf));
  updSess(r, now);
}
function updSess(r, now) {
  const { s, open } = isOpen(r.c, hub.q[r.c.id], now);
  r.pill.hidden = open == null;
  r.pill.classList.toggle("mk-open", !!open);
  setText(r.pill.lastChild, open ? "Open" : "Closed");
  const S = SESS[r.c.sess];
  r.pill.title = S && S.o ? S.where + " " + S.o + "–" + S.c + " local time, Mon–Fri (approx.; holidays not shown)" : "";
  setText(r.sess, s ? sessionText(r.c, Object.assign({}, s, { open: !!open }), now, true) : "");
  r.sess.title = s ? sessionText(r.c, Object.assign({}, s, { open: !!open }), now) : "";
  return open;
}

/* compact rows (yields, commodities, currencies, crypto) */
function row(c) {
  const r = { c };
  r.name = track(termEl(c));
  r.v = h("span", { class: "mk-row-v" }, "—");
  r.m = h("span", { class: "mk-row-c mk-flat" }, arrow(), h("span", null, "—"));
  r.dot = h("i", { class: "mk-dot", "aria-hidden": "true" });
  r.el = h("li", { class: "mk-row", id: "mk-" + c.id, tabindex: "-1" },
    h("div", { class: "mk-row-n" }, h("span", { class: "mk-row-t" }, r.name, r.dot), h("small", null, c.sub)),
    r.v, r.m);
  return r;
}
function updRow(r, d, now) {
  const c = r.c, q = hub.q[c.id], dir = dirOf(q);
  if (setText(r.v, valText(c, q)) && d) flash(r.v, d);
  setText(r.m.lastChild, moveText(c, q));
  setDir(r.m, dir);
  const { s, open } = isOpen(c, q, now);
  r.dot.classList.toggle("mk-open", !!open);
  r.dot.title = s ? (open ? "Trading now" : "Closed") + " · " + sessionText(c, Object.assign({}, s, { open: !!open }), now) : "";
  r.el.title = asOfText(q, now);
}

/* ------------------------------------------------------------------ board with region tabs */
function mountBoard(seg, board) {
  if (!seg || !board || board._mk) return;
  board._mk = 1;
  const cards = {}, panels = {}, tabs = {};
  F.dom.clear(seg); F.dom.clear(board);
  seg.setAttribute("role", "tablist");
  seg.setAttribute("aria-label", "Region");
  REGIONS.forEach(g => {
    const p = h("div", { class: "mk-panel", id: "mk-p-" + g.id, role: "tabpanel", "aria-labelledby": "mk-t-" + g.id });
    CAT.filter(c => c.group === g.id).forEach(c => { const r = card(c); cards[c.id] = r; p.appendChild(r.el); });
    if (g.info) p.appendChild(h("aside", { class: "mk-info" }, h("b", null, g.info[0]), h("span", null, g.info[1])));
    panels[g.id] = p; board.appendChild(p);
    const st = h("i", { class: "mk-dot", "aria-hidden": "true" }), mv = h("span", { class: "mk-seg-m mk-flat" });
    const t = h("button", { class: "mk-seg-b", type: "button", role: "tab", id: "mk-t-" + g.id, "aria-controls": p.id },
      h("span", { class: "mk-seg-n" }, st, g.short ? [h("span", { class: "mk-seg-f" }, g.name), h("span", { class: "mk-seg-s" }, g.short)] : g.name), mv);
    t._st = st; t._mv = mv;
    t.addEventListener("click", () => select(g.id, true));
    tabs[g.id] = t; seg.appendChild(t);
  });
  seg.addEventListener("keydown", e => {
    const ids = REGIONS.map(g => g.id), i = ids.findIndex(id => tabs[id] === D.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === "ArrowRight") j = (i + 1) % ids.length; else if (e.key === "ArrowLeft") j = (i - 1 + ids.length) % ids.length;
    else if (e.key === "Home") j = 0; else if (e.key === "End") j = ids.length - 1;
    if (j != null) { e.preventDefault(); select(ids[j], true); tabs[ids[j]].focus(); }
  });
  let cur = null, userPicked = false, hT = 0;
  function select(id, user) {
    if (user) userPicked = true;
    if (cur === id) return;
    const animate = !!cur && !reduce.matches, h0 = animate ? board.offsetHeight : 0;
    cur = id;
    REGIONS.forEach(g => {
      const on = g.id === id;
      panels[g.id].setAttribute("aria-hidden", String(!on));   // hidden panels stay in the grid and cross-fade
      tabs[g.id].setAttribute("aria-selected", String(on));
      tabs[g.id].tabIndex = on ? 0 : -1;
    });
    if (animate) {   // the board slides to the new panel's height instead of jumping; everything below moves with it
      clearTimeout(hT);
      board.style.height = h0 + "px"; board.classList.add("mk-anim");
      const h1 = panels[id].offsetHeight;
      requestAnimationFrame(() => { board.style.height = h1 + "px"; });
      hT = setTimeout(() => { board.style.height = ""; board.classList.remove("mk-anim"); }, 300);
    }
    seg.dataset.cur = id;
    if (user) { try { sessionStorage.setItem("mk.region", id); } catch (e) {} }
    const t = tabs[id];
    if (seg.scrollWidth > seg.clientWidth + 2) {   // phones: keep the chosen segment in view
      const want = t.offsetLeft - (seg.clientWidth - t.offsetWidth) / 2;
      seg.scrollTo({ left: Math.max(0, want), behavior: reduce.matches ? "auto" : "smooth" });
    }
  }
  function regionInfo(g, now) {
    let open = 0, n = 0;
    CAT.forEach(c => { if (c.group === g.id) { n++; if (isOpen(c, hub.q[c.id], now).open) open++; } });
    return { open, n };
  }
  function defaultRegion(now) {
    let saved = null;
    try { saved = sessionStorage.getItem("mk.region"); } catch (e) {}
    if (saved && tabs[saved]) return saved;
    const ranks = REGIONS.map(g => [g.id, regionInfo(g, now).open]);
    const india = ranks[0];
    if (india[1] > 0) return "india";
    const best = ranks.slice().sort((a, b) => b[1] - a[1])[0];
    return best[1] > 0 ? best[0] : "india";
  }
  let firstData = true;
  const upd = changed => {
    const now = Date.now();
    const all = !changed || !changed.size;   // first paint, a refresh with nothing new, or an empty snapshot: paint every card
    for (const id in cards) if (all || changed.has(id)) updCard(cards[id], changed ? changed.get(id) || 0 : 0, now);
    REGIONS.forEach(g => {
      const info = regionInfo(g, now), t = tabs[g.id];
      t._st.classList.toggle("mk-open", info.open > 0);
      const lead = g.lead.map(id => [BY[id], hub.q[id]]).find(([, q]) => q && q.pct != null) || [BY[g.lead[0]], hub.q[g.lead[0]]];
      const txt = lead[1] && lead[1].pct != null ? lead[0].name + " " + fmt.pct(lead[1].pct) : "";
      setText(t._mv, txt); setDir(t._mv, dirOf(lead[1]));
      t.setAttribute("aria-label", g.name + (info.open ? ", " + info.open + " of " + info.n + " markets open" : ", markets closed") + (txt ? ", " + txt : ""));
    });
    // the region was picked from exchange hours before any data; the first data only matters on an Indian holiday
    if (firstData) { firstData = false; if (!userPicked) { const d = defaultRegion(now); if (d !== cur) select(d); } }
  };
  select(defaultRegion(Date.now()));
  if (location.hash) requestAnimationFrame(goHash);
  // refresh open/closed every 30 s (cheap; skipped while hidden)
  setInterval(() => { if (!D.hidden && hub.snap) { const now = Date.now(); for (const id in cards) updSess(cards[id], now); upd(new Map()); } }, 30000);
  function goHash() {
    const m = /^#mk-([A-Z0-9]+)$/.exec(location.hash);
    if (!m || !BY[m[1]]) return;
    const c = BY[m[1]];
    if (cards[c.id]) select(c.group, true);
    const el = D.getElementById("mk-" + c.id);
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: "center", behavior: reduce.matches ? "auto" : "smooth" });
      try { el.focus({ preventScroll: true }); } catch (e) {}
      el.classList.remove("mk-hl"); requestAnimationFrame(() => el.classList.add("mk-hl"));
      setTimeout(() => el.classList.remove("mk-hl"), 1800);
    });
  }
  W.addEventListener("hashchange", goHash);
  D.addEventListener("click", e => {   // same-hash clicks on the ticker still jump
    const a = e.target.closest && e.target.closest("a.mk-ti");
    if (a && a.getAttribute("href") === location.hash) { e.preventDefault(); goHash(); }
  });
  subscribe(upd);
}

function mountRows(el, group) {
  if (!el || el._mk) return;
  el._mk = 1;
  F.dom.clear(el);
  el.classList.add("mk-rows");
  const rows = CAT.filter(c => c.group === group).map(row);
  rows.forEach(r => el.appendChild(r.el));
  const upd = changed => { const now = Date.now(); rows.forEach(r => { if (!changed || changed.has(r.c.id) || changed.size === 0) updRow(r, changed ? changed.get(r.c.id) : 0, now); }); };
  setInterval(() => { if (!D.hidden && hub.snap) upd(new Map()); }, 30000);
  subscribe(upd);
}

/* ------------------------------------------------------------------ policy rates */
const SRC_URL = {
  "rbi.org.in": "https://www.rbi.org.in/",
  "bankofengland.co.uk": "https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate",
  "boj.or.jp": "https://www.boj.or.jp/en/mopo/index.htm",
  "pbc.gov.cn": "http://www.pbc.gov.cn/en/3688006/index.html"
};
const FRED = { "fed-funds": "https://fred.stlouisfed.org/series/DFEDTARU", "ecb-dfr": "https://fred.stlouisfed.org/series/ECBDFR" };
function srcLink(p) {
  const s = String(p.src || "").trim();
  if (!s) return h("span", { class: "mk-muted" }, "—");
  const u = FRED[p.id] && /fred/.test(s) ? FRED[p.id] : SRC_URL[s] || (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s) ? "https://" + s + "/" : null);
  const label = /fred/.test(s) ? "FRED" : s.replace(/^www\./, "");
  return F.dom.ext(u, { class: "mk-src-a" }, label, h("span", { class: "mk-ext", "aria-hidden": "true" }, "↗"));
}
const POLICY_TERMS = {
  "rbi-repo": ["repo-rate"], "rbi-sdf": ["standing-deposit-facility"], "rbi-msf": ["marginal-standing-facility"],
  "rbi-crr": ["cash-reserve-ratio"], "rbi-slr": ["statutory-liquidity-ratio"], "fed-funds": ["federal-funds-rate", "fed-funds-rate"],
  "ecb-dfr": ["deposit-facility-rate"], "boe-bank-rate": ["bank-rate"], "boj": ["policy-rate"], "pboc-lpr": ["loan-prime-rate"]
};
function policyValue(p) {
  if (p.lo != null && p.hi != null && isFinite(+p.lo) && isFinite(+p.hi)) return fmt.num(+p.lo, 2) + "–" + fmt.num(+p.hi, 2) + "%";
  if (p.value == null || !isFinite(+p.value)) return "—";
  return fmt.num(+p.value, 2) + "%";
}
function renderPolicy(el, policy) {
  F.dom.clear(el);
  if (!Array.isArray(policy) || !policy.length) { el.appendChild(h("p", { class: "mk-empty" }, "Policy rates are not available right now.")); return; }
  const groups = [];
  policy.forEach(p => {
    if (!p || typeof p !== "object") return;
    const key = p.bank || p.short || "";
    let g = groups.find(x => x.key === key);
    if (!g) { g = { key, short: p.short || "", rows: [] }; groups.push(g); }
    g.rows.push(p);
  });
  const tb = h("table", { class: "mk-pol" },
    h("caption", { class: "sr-only" }, "Central bank policy rates"),
    h("thead", null, h("tr", null, h("th", { scope: "col" }, "Rate"), h("th", { scope: "col", class: "mk-r" }, "Level"), h("th", { scope: "col" }, "As of"), h("th", { scope: "col" }, "Source"))));
  groups.forEach(g => {
    const body = h("tbody", { class: "mk-pol-g" + (g.rows.length > 1 ? " mk-multi" : "") },
      h("tr", { class: "mk-pol-bank" }, h("th", { colspan: "4", scope: "colgroup" }, g.short ? h("span", { class: "mk-bank-tag" }, g.short) : null, h("span", null, g.key))));
    g.rows.forEach(p => {
      const val = policyValue(p), missing = val === "—";
      if (missing && p.manual) return;   // a hand-kept rate with no value yet is left out rather than shown as a dash
      const nm = track(phraseTerm(p.name || p.id || "", [p.term].concat(POLICY_TERMS[p.id] || []).filter(Boolean), "mk-pol-name"));
      const asOf = p.asOf ? fmt.date(p.asOf) : "";
      body.appendChild(h("tr", { class: "mk-pol-r" + (missing ? " mk-na" : "") },
        h("th", { scope: "row" }, nm, p.next ? h("small", { class: "mk-next" }, p.next) : null),
        h("td", { class: "mk-r mk-pol-v" }, val),
        h("td", { class: "mk-pol-d" }, missing ? h("span", { class: "mk-muted" }, "Not available right now") : asOf + (p.stale ? " (last saved)" : "")),
        h("td", { class: "mk-pol-s" }, srcLink(p))));
    });
    if (body.children.length > 1) tb.appendChild(body);
  });
  el.appendChild(tb);
}

/* ------------------------------------------------------------------ U.S. Treasury yield curve (hand-drawn SVG) */
const SERIES = { latest: { label: "Latest", cls: "mk-s0" }, m1: { label: "1 month ago", cls: "mk-s1" }, y1: { label: "1 year ago", cls: "mk-s2" } };
function mountCurve(box, legend, readout, note, curve) {
  if (!box) return;
  F.dom.clear(box); if (legend) F.dom.clear(legend);
  const ok = curve && Array.isArray(curve.tenors) && Array.isArray(curve.series) && curve.series.some(s => Array.isArray(s.y) && s.y.some(v => v != null));
  if (!ok) { box.appendChild(h("p", { class: "mk-empty" }, "The yield curve is not available right now.")); if (note) F.dom.clear(note); if (readout) readout.hidden = true; return; }
  const T = curve.tenors, ser = curve.series.filter(s => SERIES[s.key] && Array.isArray(s.y)).map(s => ({ key: s.key, date: s.date, y: s.y.map(v => (v == null || !isFinite(+v)) ? null : +v) }));
  ser.sort((a, b) => Object.keys(SERIES).indexOf(a.key) - Object.keys(SERIES).indexOf(b.key));
  if (legend) ser.forEach(s => legend.appendChild(h("li", { class: SERIES[s.key].cls }, h("i", { "aria-hidden": "true" }), h("b", null, SERIES[s.key].label), s.date ? h("span", null, fmt.date(s.date)) : null)));
  let idx = T.indexOf("10Y"); if (idx < 0) idx = T.length - 1;
  const svgNS = "svg:";
  let W_ = 0, geo = null, svg = null, cross = null, dots = [];
  function draw() {
    const w = Math.round(box.clientWidth);
    if (!w || w === W_) return;
    W_ = w;
    const narrow = w < 520, H = narrow ? 230 : 290;
    const pad = { l: narrow ? 38 : 46, r: 12, t: 14, b: 30 };
    const all = ser.flatMap(s => s.y).filter(v => v != null);
    let lo = Math.min(...all), hi = Math.max(...all);
    const range = Math.max(0.5, hi - lo), step = range > 3 ? 1 : range > 1.4 ? 0.5 : 0.25;
    lo = Math.floor((lo - 0.1) / step) * step; hi = Math.ceil((hi + 0.1) / step) * step;
    const x = i => pad.l + i * (w - pad.l - pad.r) / (T.length - 1);
    const y = v => pad.t + (hi - v) / (hi - lo) * (H - pad.t - pad.b);
    geo = { x, y, pad, H, w };
    svg = h(svgNS + "svg", { class: "mk-curve-svg", viewBox: "0 0 " + w + " " + H, width: w, height: H, "aria-hidden": "true", focusable: "false" });
    const grid = h(svgNS + "g", { class: "mk-grid" });
    for (let v = lo; v <= hi + 1e-9; v += step) {
      grid.appendChild(h(svgNS + "line", { x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v) }));
      grid.appendChild(h(svgNS + "text", { x: pad.l - 8, y: y(v) + 4, "text-anchor": "end" }, fmt.num(v, step < 0.5 ? 2 : 1) + "%"));
    }
    T.forEach((t, i) => {
      if (narrow && (t === "3Y" || t === "7Y" || t === "20Y" || t === "6M")) return;
      grid.appendChild(h(svgNS + "text", { x: x(i), y: H - 8, "text-anchor": "middle" }, t));
    });
    svg.appendChild(grid);
    cross = h(svgNS + "line", { class: "mk-cross", y1: pad.t, y2: H - pad.b });
    svg.appendChild(cross);
    ser.slice().reverse().forEach(s => {
      let d = "", pen = false;
      s.y.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1); pen = true; });
      svg.appendChild(h(svgNS + "path", { class: "mk-line " + SERIES[s.key].cls, d }));
    });
    const latest = ser.find(s => s.key === "latest");
    if (latest) latest.y.forEach((v, i) => { if (v != null) svg.appendChild(h(svgNS + "circle", { class: "mk-pt", cx: x(i), cy: y(v), r: narrow ? 2.5 : 3 })); });
    dots = ser.map(s => { const c = h(svgNS + "circle", { class: "mk-hd " + SERIES[s.key].cls, r: 5 }); svg.appendChild(c); return c; });
    F.dom.clear(box); box.appendChild(svg);
    point(idx);
  }
  function point(i) {
    idx = Math.max(0, Math.min(T.length - 1, i));
    if (!geo) return;
    const X = geo.x(idx);
    cross.setAttribute("x1", X); cross.setAttribute("x2", X);
    ser.forEach((s, k) => { const v = s.y[idx]; dots[k].style.display = v == null ? "none" : ""; if (v != null) { dots[k].setAttribute("cx", X); dots[k].setAttribute("cy", geo.y(v)); } });
    if (readout) {
      F.dom.clear(readout);
      readout.appendChild(h("b", { class: "mk-ro-t" }, tenorName(T[idx])));
      ser.forEach(s => readout.appendChild(h("span", { class: "mk-ro-v " + SERIES[s.key].cls }, h("i", { "aria-hidden": "true" }), SERIES[s.key].label + " ", h("b", null, s.y[idx] == null ? "—" : fmt.num(s.y[idx], 2) + "%"))));
    }
  }
  const pick = ev => {
    if (!geo) return;
    const r = box.getBoundingClientRect(), px = ev.clientX - r.left;
    const step = (geo.w - geo.pad.l - geo.pad.r) / (T.length - 1);
    point(Math.round((px - geo.pad.l) / step));
    box.classList.add("mk-hover");
  };
  box.onpointermove = pick;
  box.onpointerdown = pick;
  box.onpointerleave = ev => { if (ev.pointerType !== "touch") box.classList.remove("mk-hover"); };
  box.tabIndex = 0;
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "U.S. Treasury yield curve. Use the left and right arrow keys to read each maturity.");
  box.onkeydown = e => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); point(idx + (e.key === "ArrowRight" ? 1 : -1)); box.classList.add("mk-hover"); }
    else if (e.key === "Home") { e.preventDefault(); point(0); } else if (e.key === "End") { e.preventDefault(); point(T.length - 1); }
  };
  draw();
  if ("ResizeObserver" in W) { let raf = 0; new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }).observe(box); }
  if (note) curveNote(note, T, ser);
}
function tenorName(t) {
  const m = /^(\d+)([MY])$/.exec(t);
  if (!m) return t;
  return m[1] + (m[2] === "M" ? (m[1] === "1" ? " month" : " months") : (m[1] === "1" ? " year" : " years"));
}
function curveNote(el, T, ser) {
  F.dom.clear(el);
  const L = ser.find(s => s.key === "latest"), M = ser.find(s => s.key === "m1");
  const i2 = T.indexOf("2Y"), i10 = T.indexOf("10Y");
  if (!L || i2 < 0 || i10 < 0 || L.y[i2] == null || L.y[i10] == null) { el.appendChild(h("p", null, "Not enough data to describe the curve right now.")); return; }
  const y2 = L.y[i2], y10 = L.y[i10], s = y10 - y2;
  const shape = s < -0.1 ? "inverted" : s <= 0.25 ? "flat" : "normal";
  const bp = v => Math.round(Math.abs(v) * 100) + " bp";
  const pp = v => fmt.num(Math.abs(v), 2);
  const title = { normal: "Normal: longer loans pay more", flat: "Flat: little extra for lending longer", inverted: "Inverted: short-term yields are higher" }[shape];
  const lead = shape === "inverted"
    ? `The 2-year Treasury yields ${fmt.num(y2, 2)}%, ${pp(s)} percentage points (${bp(s)}) more than the 10-year at ${fmt.num(y10, 2)}%.`
    : `The 10-year Treasury yields ${fmt.num(y10, 2)}%, ${pp(s)} percentage points (${bp(s)}) ${s >= 0 ? "above" : "below"} the 2-year at ${fmt.num(y2, 2)}%.`;
  const why = {
    normal: "Lenders usually want a higher yield to tie up money for longer, so an upward slope is the usual shape of the yield curve.",
    flat: "When 2-year and 10-year bonds pay about the same, investors expect short-term interest rates to stay near today's level or fall. A flat curve often shows up near the end of a cycle of rate rises.",
    inverted: "Short-term yields above long-term ones usually mean investors expect the Federal Reserve to cut rates. In the U.S. an inverted yield curve has come before most recessions since the 1970s, but the timing varies and it is not a sure signal."
  }[shape];
  el.appendChild(h("p", { class: "mk-note-t" }, h("span", { class: "mk-shape mk-shape-" + shape }, shape[0].toUpperCase() + shape.slice(1)), title.split(": ")[1].replace(/^./, c => c.toUpperCase())));
  const body = h("div", { class: "mk-note-b" }, h("p", null, lead), h("p", null, why));
  if (M && M.y[i2] != null && M.y[i10] != null) {
    const d10 = y10 - M.y[i10], d2 = y2 - M.y[i2], sM = M.y[i10] - M.y[i2], dg = s - sM;
    const mv = (d, n) => Math.abs(d) < 0.005 ? `the ${n} is unchanged` : `the ${n} has ${d > 0 ? "risen" : "fallen"} ${bp(d)}`;
    const since = M.date ? "Since " + fmt.date(M.date, { year: undefined }) : "Over the past month";
    const gap = Math.abs(dg) < 0.05 ? `so the gap is about the same (${fmt.num(sM, 2)} pp then, ${fmt.num(s, 2)} pp now)`
      : `so the curve is ${dg > 0 ? "steeper" : "flatter"}: the gap went from ${fmt.num(sM, 2)} pp to ${fmt.num(s, 2)} pp`;
    body.appendChild(h("p", null, `${since}, ${mv(d10, "10-year")} and ${mv(d2, "2-year")}, ${gap}.`));
  }
  el.appendChild(body);
  // underlines come once the dictionary index is in (it loads after prices and news); annotate() queues itself
  if (F.glossary.loaded()) F.glossary.annotate(body, { max: 6 });
  else F.on("glossary", () => { if (body.isConnected) F.glossary.annotate(body, { max: 6 }); });
}

/* ------------------------------------------------------------------ world trading hours (in IST) */
const CLOCK = [["in", "Mumbai", "NSE · BSE"], ["tyo", "Tokyo", "Japan Exchange"], ["hk", "Hong Kong", "HKEX"], ["ldn", "London", "LSE"], ["eu", "Frankfurt", "Xetra"], ["us", "New York", "NYSE · Nasdaq"]];
function offsetMin(tz, now) {
  const a = tzParts(now, tz), b = tzParts(now, IST);
  if (!a || !b) return 0;
  return (Date.UTC(a.y, a.m - 1, a.d, a.h, a.mi) - Date.UTC(b.y, b.m - 1, b.d, b.h, b.mi)) / 60000;
}
function inDur(ms) {
  const m = Math.max(1, Math.round(ms / 60000)), hh = Math.floor(m / 60), mm = m % 60;
  return hh ? hh + "h " + String(mm).padStart(2, "0") + "m" : mm + " min";
}
function mountClock(el) {
  if (!el || el._mk) return;
  el._mk = 1;
  F.dom.clear(el);
  el.classList.add("mk-clk");
  const now0 = h("span", { class: "mk-clk-now" });
  const rows = CLOCK.map(([sess, city, ex]) => {
    const r = { sess, inst: { sess, group: sess === "in" ? "india" : "x" } };
    r.local = h("span", { class: "mk-clk-l" });
    r.bar = h("div", { class: "mk-clk-bar", "aria-hidden": "true" });
    r.pill = h("span", { class: "mk-pill" }, h("i", { "aria-hidden": "true" }), h("span", null, ""));
    r.when = h("span", { class: "mk-clk-w" });
    r.el = h("li", { class: "mk-clk-r" },
      h("div", { class: "mk-clk-c", title: ex }, h("b", null, city), r.local),
      r.bar,
      h("div", { class: "mk-clk-s" }, r.pill, r.when));
    return r;
  });
  const ticks = h("div", { class: "mk-clk-ax", "aria-hidden": "true" }, ["00", "06", "12", "18", "24"].map(t => h("span", null, t)));
  el.append(h("div", { class: "mk-clk-h" }, h("p", { class: "mk-clk-t" }, "Trading hours, shown in IST"), now0),
    h("ol", { class: "mk-clk-list" }, rows.map(r => r.el)), h("div", { class: "mk-clk-foot" }, h("span"), ticks, h("span")));
  const upd = () => {
    const now = Date.now(), ip = tzParts(now, IST);
    if (!ip) return;
    const nowMin = ip.h * 60 + ip.mi;
    setText(now0, "Now " + istHM(now));
    rows.forEach(r => {
      const S = SESS[r.sess], off = offsetMin(S.tz, now);
      setText(r.local, fmt.time(now, S.tz) + " local");
      const start = ((hm(S.o) - off) % 1440 + 1440) % 1440, len = hm(S.c) - hm(S.o);
      const segs = start + len <= 1440 ? [[start, len]] : [[start, 1440 - start], [0, start + len - 1440]];
      const { s, open } = isOpen(r.inst, r.sess === "in" ? hub.q.NIFTY : null, now);
      if (!r.built) {
        r.built = true;
        segs.forEach(([a, l]) => r.bar.appendChild(h("i", { class: "mk-clk-seg", style: { left: (a / 14.4) + "%", width: (l / 14.4) + "%" } })));
        r.nowEl = h("i", { class: "mk-clk-nowl" }); r.bar.appendChild(r.nowEl);
      }
      r.nowEl.style.left = (nowMin / 14.4) + "%";
      r.el.classList.toggle("mk-open", !!open);
      r.pill.classList.toggle("mk-open", !!open);
      setText(r.pill.lastChild, open ? "Open" : "Closed");
      const far = s && s.at - now > 20 * 3600e3;
      setText(r.when, !s ? "" : open ? "closes in " + inDur(s.at - now) : far ? "opens " + istWd(s.at) + " " + istHM(s.at) : "opens in " + inDur(s.at - now));
    });
  };
  upd();
  setInterval(() => { if (!D.hidden) upd(); }, 20000);
  D.addEventListener("visibilitychange", () => { if (!D.hidden) upd(); });
  subscribe(() => upd());
}

/* ------------------------------------------------------------------ mini board (home page) */
function mountMini(el, ids) {
  if (!el || el._mk) return;
  el._mk = 1;
  ids = (Array.isArray(ids) && ids.length ? ids : ["NIFTY", "SENSEX", "SPX", "US10Y", "BRENT", "USDINR"]).filter(id => BY[id]);
  F.dom.clear(el);
  el.classList.add("mk-mini");
  const tiles = ids.map(id => {
    const c = BY[id], r = { c };
    r.name = h("span", { class: "mk-tile-n" }, c.name);
    r.name._mkInst = c; r.name._mkNoTab = true;   // the tile's link is the one tab stop; the tip still opens on hover/tap
    track(r.name); applyTerm(r.name);
    r.dot = h("i", { class: "mk-dot", "aria-hidden": "true" });
    r.v = h("span", { class: "mk-tile-v" }, "—");
    r.m = h("span", { class: "mk-tile-c mk-flat" }, arrow(), h("span", null, "—"));
    r.fill = h("i", { class: "mk-fill" }); r.mark = h("i", { class: "mk-mark" });
    r.bar = h("div", { class: "mk-track mk-tile-r", "aria-hidden": "true" }, r.fill, r.mark);
    r.el = h("div", { class: "mk-tile" },
      h("div", { class: "mk-tile-top" }, r.name, r.dot),
      r.v, r.m, r.bar,
      mkHref(id) ? h("a", { class: "mk-tile-a", href: mkHref(id), "aria-label": c.name + " on the Markets page" }) : null);
    return r;
  });
  const grid = h("div", { class: "mk-mini-g" }, tiles.map(t => t.el));
  const st = h("p", { class: "mk-mini-s" });
  el.append(grid, st);
  mountStatus(st);
  const upd = changed => {
    const now = Date.now();
    tiles.forEach(r => {
      if (changed && changed.size && !changed.has(r.c.id)) return;
      const q = hub.q[r.c.id], d = dirOf(q);
      if (setText(r.v, valText(r.c, q)) && changed && changed.get(r.c.id)) flash(r.v, changed.get(r.c.id));
      setText(r.m.lastChild, moveText(r.c, q)); setDir(r.m, d);
      const b = rangeBits(q);
      r.bar.classList.toggle("mk-na", !b);
      if (b) { r.mark.style.left = b.at + "%"; const from = b.prev == null ? b.at : b.prev; r.fill.style.left = Math.min(from, b.at) + "%"; r.fill.style.width = Math.abs(b.at - from) + "%"; }
      const { open } = isOpen(r.c, q, now);
      r.dot.classList.toggle("mk-open", !!open);
      r.dot.title = open ? "Trading now" : "Closed";
    });
  };
  setInterval(() => { if (!D.hidden && hub.snap) upd(new Map()); }, 30000);
  subscribe(upd);
  loadGlossaryAfterPrices();
}

/* ------------------------------------------------------------------ Markets page */
function mountPage(root) {
  root = root || D;
  const $ = s => root.querySelector(s);
  mountTicker($("[data-mk-ticker]"));
  mountClock($("[data-mk-clock]"));
  root.querySelectorAll("[data-mk-status]").forEach(mountStatus);
  mountBoard($("[data-mk-seg]"), $("[data-mk-board]"));
  mountRows($("[data-mk-rows=yields]"), "yields");
  mountRows($("[data-mk-rows=commodities]"), "commodities");
  mountRows($("[data-mk-rows=fx]"), "fx");
  mountRows($("[data-mk-rows=crypto]"), "crypto");
  const pol = $("[data-mk-policy]"), cv = $("[data-mk-curve]");
  let drawn = false;
  subscribe(() => {
    if (drawn || !hub.snap) return;
    drawn = true;
    if (pol) renderPolicy(pol, hub.snap.policy);
    if (cv) mountCurve(cv, $("[data-mk-curve-legend]"), $("[data-mk-curve-read]"), $("[data-mk-curve-note]"), hub.snap.curve);
    const cd = $("[data-mk-curve-date]");
    const lt = hub.snap.curve && (hub.snap.curve.series || []).find(s => s.key === "latest");
    if (cd) cd.textContent = lt && lt.date ? "Daily close, " + fmt.date(lt.date) + " · U.S. Treasury" : "";
  });
  root.querySelectorAll("[data-mk-term]").forEach(el => { el._mkTerms = el.getAttribute("data-mk-term").split(/\s+/); track(el); applyTerm(el); });
  const foot = D.getElementById("fsFootNote");
  if (foot) foot.textContent = "Prices from CNBC and Moneycontrol, may be delayed. News from the publishers’ feeds; headlines link to the source.";
  loadGlossaryAfterPrices();
}

const API = {
  mountTicker, mountMini, mountStatus, mountClock, mountPage,
  refresh: () => { start(); return (hub.snapP || Promise.resolve()).then(() => poll()); },
  state: () => ({ state: hub.state, liveAt: hub.liveAt, snapAt: hub.snapAt, failures: hub.failures, partial: hub.partial.slice(), quotes: JSON.parse(JSON.stringify(hub.q)) }),
  catalog: CAT
};
W.FinspireMarkets = Object.freeze(API);

function boot() { const m = D.querySelector("[data-mk-page]"); if (m) mountPage(m); }
if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", boot, { once: true }); else boot();
})();
