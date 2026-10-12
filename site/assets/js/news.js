/* Finspire News: the live news feed on the Markets page and the headline teaser on the home page.
   Needs finspire.js (window.Finspire). Styles: assets/css/markets.css (every class prefixed nw-).

   window.FinspireNews
     mountTeaser(el, {count})   latest headlines (dictionary terms highlighted), source and time; updates quietly
     mountFeed(el)              full feed: region tabs, market chips, search, "Concepts in today's news", cards with
                                highlighted terms, concept chips and a "Why it matters" line, "Show more", and an
                                "N new stories" pill when a refresh brings new items (auto-runs for [data-nw-feed])
     refresh() → Promise        fetch data/live/news.json now

   Data: data/live/news.json, polled every cfg.newsPollSeconds while the tab is visible. Headlines link to the
   publisher in a new tab. All feed text goes into the page as text nodes, never as HTML. */
(() => {
"use strict";
if (window.FinspireNews) return;
const F = window.Finspire;
if (!F) return;
const D = document, W = window, h = F.dom.h, fmt = F.fmt;
const REG_ORDER = ["in", "us", "eu", "ap", "me", "gl"];
const MK_ORDER = ["stocks", "rates", "cb", "fx", "cmd", "crypto", "econ", "deals", "policy"];
const REG_DEF = { in: "India", us: "United States", eu: "Europe & UK", ap: "Asia-Pacific", me: "Middle East & Africa", gl: "Global" };
const MK_DEF = { stocks: "Stocks", rates: "Bonds & rates", cb: "Central banks", fx: "Currencies", cmd: "Commodities & energy", crypto: "Crypto", econ: "Economy", deals: "Companies & deals", policy: "Policy & regulation" };
/* One plain line per primary market tag: what a reader should watch for. */
const LENS = {
  stocks: "Share prices move on earnings and expectations; a big move in a heavyweight stock can swing the whole index.",
  rates: "Bond yields set borrowing costs for governments and companies; when yields rise, the prices of existing bonds fall.",
  cb: "Policy-rate changes reset borrowing costs; bond yields, the rupee and bank stocks usually react first.",
  fx: "Exchange rates change what imports cost and what exporters earn; a weaker rupee makes oil and electronics dearer in India.",
  cmd: "Commodity prices feed into inflation and company costs; India imports most of its oil, so crude moves the rupee and fuel prices.",
  crypto: "Crypto prices swing far more than stocks and often move on regulation news and on how much risk investors want to take.",
  econ: "Growth, jobs and inflation data shape what central banks do next; markets react to the surprise against forecasts, not the number alone.",
  deals: "Results, mergers and fund-raises change what a company is worth; the share price reacts to how the news compares with what was expected.",
  policy: "New rules and taxes change the economics of whole sectors; markets price in the impact as soon as the details are clear."
};
/* A lens is shown only when the story's own words back up the tag (feeds tag whole sections, e.g. every story in a
   markets feed gets "stocks"), so a story about crop damage never gets a line about share prices. */
const LENS_CHECK = {
  cb: /\b(rbi|fed|fomc|federal reserve|ecb|central banks?|bank of (england|japan|canada|korea)|boj|boe|pboc|repo|rate (cut|hike)s?|monetary|policy rates?|mpc|powell|lagarde|malhotra|governor)\b/i,
  rates: /\b(yields?|bonds?|treasur(y|ies)|g-?secs?|gilts?|bunds?|jgbs?|debt|borrowing costs?|interest rates?|coupon)\b/i,
  fx: /\b(rupee|dollar|currenc(y|ies)|forex|yen|euro|yuan|renminbi|sterling|pound|exchange rates?|dxy)\b/i,
  cmd: /\b(oil|crude|brent|wti|gold|silver|copper|aluminium|aluminum|natural gas|lng|commodit(y|ies)|metals?|wheat|sugar|coal|opec|iron ore)\b/i,
  crypto: /\b(bitcoin|crypto(currenc(y|ies))?|ether|ethereum|stablecoins?|blockchain|btc|eth|tokens?)\b/i,
  econ: /\b(gdp|inflation|cpi|wpi|jobs|payrolls|unemployment|economy|economic|growth|pmi|recession|trade deficit|exports?|imports?|industrial output|retail sales|consumer prices)\b/i,
  deals: /\b(ipo|mergers?|acqui\w+|deals?|stake|buyout|fund-?rais\w*|raises?|earnings|results|profit|revenue|q[1-4]|listing|valuation|takeover)\b/i,
  policy: /\b(sebi|regulat\w+|rules?|tax(es)?|gst|tariffs?|budget|law|bill|ban|ministry|government|curbs?|sanctions?|norms|guidelines)\b/i,
  stocks: /\b(shares?|stocks?|sensex|nifty|indices|index|equit(y|ies)|ipo|rall(y|ies|ied)|slump\w*|traders?|investors?|market cap\w*|listed|bourses?|wall street|dalal street|s&p|nasdaq|dow)\b/i
};
function lensOf(it) {
  const text = it.t + " " + it.s;
  for (const m of it.mk) if (LENS[m] && (!LENS_CHECK[m] || LENS_CHECK[m].test(text))) return LENS[m];
  return "";
}
const PAGE = 24;
const pollMs = () => Math.max(30, +F.cfg.newsPollSeconds || 180) * 1000;
const reduce = W.matchMedia ? W.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

/* ------------------------------------------------------------------ data hub */
const hub = { data: null, items: [], subs: new Set(), timer: 0, started: false, inflight: null, at: 0, failed: false };
function clean(list) {
  const out = [], seen = new Set();
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== "object" || typeof it.t !== "string" || !it.t.trim()) continue;
    const id = String(it.id || it.u || it.t);
    if (seen.has(id)) continue;
    const u = F.dom.safeUrl(it.u), ts = Date.parse(it.ts);
    if (!u || !isFinite(ts)) continue;
    seen.add(id);
    out.push({ id, t: it.t.trim(), s: typeof it.s === "string" ? it.s.trim() : "", u, src: String(it.src || "").trim() || "News",
      ts, iso: it.ts, rg: Array.isArray(it.rg) ? it.rg.map(String) : [], mk: Array.isArray(it.mk) ? it.mk.map(String) : [],
      terms: Array.isArray(it.terms) ? it.terms.map(String) : [] });
  }
  return out.sort((a, b) => b.ts - a.ts);
}
function notify() { hub.subs.forEach(fn => { try { fn(hub.items); } catch (e) { setTimeout(() => { throw e; }); } }); }
function refresh() {
  if (hub.inflight) return hub.inflight;
  clearTimeout(hub.timer); hub.timer = 0;
  hub.inflight = F.fetchJSON("data/live/news.json", { bust: true }).then(j => {
    hub.data = j || {}; hub.items = clean(hub.data.items); hub.at = Date.now(); hub.failed = false;
  }, () => { hub.failed = true; if (!hub.data) hub.data = { items: [] }; })
    .then(() => notify())
    .finally(() => { hub.inflight = null; schedule(); });
  return hub.inflight;
}
function schedule() {
  clearTimeout(hub.timer); hub.timer = 0;
  if (hub.started && !D.hidden) hub.timer = setTimeout(refresh, pollMs());
}
function start() {
  if (hub.started) return;
  hub.started = true;
  D.addEventListener("visibilitychange", () => {
    if (D.hidden) { clearTimeout(hub.timer); hub.timer = 0; return; }
    if (Date.now() - hub.at >= pollMs()) refresh(); else schedule();
  });
  refresh();
}
function subscribe(fn) { hub.subs.add(fn); start(); if (hub.data && !hub.inflight) fn(hub.items); return () => hub.subs.delete(fn); }
const names = () => ({ rg: Object.assign({}, REG_DEF, (hub.data && hub.data.regions) || {}), mk: Object.assign({}, MK_DEF, (hub.data && hub.data.markets) || {}) });
const feat = n => !F.feature || F.feature(n);
const dictHref = id => F.url((F.cfg.pages && F.cfg.pages.dictionary || "dictionary/") + "#t=" + encodeURIComponent(id));
/* the reader's own words: saved words plus recent lookups (per signed-in user, or this browser's guest profile) */
function myWords() {
  const out = new Map();
  const saved = F.store.get("dict.saved", []), hist = F.store.get("dict.history", []);
  (Array.isArray(saved) ? saved : []).forEach(id => { if (typeof id === "string") out.set(id, "saved"); });
  (Array.isArray(hist) ? hist : []).slice(0, 40).forEach(x => { if (x && typeof x.id === "string" && !out.has(x.id)) out.set(x.id, "looked"); });
  return out;
}
const glossaryReady = () => Promise.race([F.glossary.load().catch(() => null), new Promise(r => setTimeout(r, 5000))]);

/* dictionary ids for an item: the pipeline's list plus a fresh match (the dictionary keeps growing) */
function termsOf(it) {
  if (it._g === F.glossary.rows().length) return it._terms;
  const ids = [];
  it.terms.forEach(id => { if (F.glossary.get(id) && !ids.includes(id)) ids.push(id); });
  F.glossary.match(it.t + " \n " + it.s).forEach(m => { if (!ids.includes(m.id)) ids.push(m.id); });
  it._g = F.glossary.rows().length; it._terms = ids;
  return ids;
}
let fullFmt = null;
function fullTime(ms) {
  try { fullFmt = fullFmt || new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); return fullFmt.format(ms) + " IST"; }
  catch (e) { return ""; }
}
const timeEl = it => h("time", { class: "nw-time", datetime: new Date(it.ts).toISOString(), title: fullTime(it.ts) }, fmt.ago(it.ts));
function tickTimes(root) { root.querySelectorAll("time.nw-time").forEach(t => { const s = fmt.ago(t.getAttribute("datetime")); if (t.textContent !== s) t.textContent = s; }); }
const SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
function svg(markup) { const t = D.createElement("template"); t.innerHTML = markup; return t.content.firstChild; }   // static markup only

/* ------------------------------------------------------------------ teaser (home page) */
function mountTeaser(el, opts) {
  if (!el || el._nw) return;
  el._nw = 1;
  const count = Math.max(1, Math.min(12, +(opts && opts.count) || 3));
  el.classList.add("nw-teaser");
  const list = h("ol", { class: "nw-t-list" });
  F.dom.clear(el);
  for (let i = 0; i < count; i++) list.appendChild(h("li", { class: "nw-t-item nw-skel" }, h("span", { class: "nw-sk nw-sk-s" }), h("span", { class: "nw-sk" }), h("span", { class: "nw-sk nw-sk-m" })));
  el.appendChild(list);
  let key = "";
  const render = items => {
    glossaryReady().then(() => {
      const top = items.slice(0, count), k = top.map(i => i.id).join(",") + "|" + F.glossary.rows().length;
      if (k === key) { tickTimes(el); return; }
      key = k;
      if (!top.length) { list.replaceChildren(h("li", { class: "nw-t-empty" }, hub.failed ? "News is not available right now." : "Updating…")); return; }
      list.replaceChildren(...top.map(it => {
        const a = F.dom.ext(it.u, { class: "nw-t-a" }, it.t);
        const hd = h("p", { class: "nw-t-h" }, a);
        F.glossary.annotate(hd, { max: 3 });
        return h("li", { class: "nw-t-item" }, h("p", { class: "nw-t-meta" }, h("span", { class: "nw-src" }, it.src), h("span", { class: "nw-sep", "aria-hidden": "true" }, "·"), timeEl(it)), hd);
      }));
    });
  };
  subscribe(render);
  setInterval(() => { if (!D.hidden && el.isConnected) tickTimes(el); }, 60000);
}

/* ------------------------------------------------------------------ feed (Markets page) */
function mountFeed(el) {
  if (!el || el._nw) return;
  el._nw = 1;
  const S = { region: "all", market: "all", q: "", mine: false, words: new Map(), shown: PAGE, items: [], known: new Set(), pending: [], seenAt: 0, ready: false, fresh: new Set() };
  /* controls */
  const tabs = h("div", { class: "nw-tabs", role: "group", "aria-label": "Region" });
  const chips = h("div", { class: "nw-chips", role: "group", "aria-label": "Market" });
  const input = h("input", { class: "nw-q", type: "search", placeholder: "Search headlines", "aria-label": "Search news", autocomplete: "off", spellcheck: "false", enterkeyhint: "search" });
  const search = h("label", { class: "nw-search" }, svg(SEARCH_SVG), input);
  const pill = h("button", { class: "nw-pill", type: "button", hidden: true }, h("span", { class: "nw-pill-arw", "aria-hidden": "true" }, "↑"), h("span", null, ""));
  const count = h("p", { class: "nw-count", "aria-live": "polite" });
  const list = h("ol", { class: "nw-list", "aria-label": "News stories" });
  const more = h("button", { class: "nw-more", type: "button", hidden: true }, "Show more");
  const concepts = h("ol", { class: "nw-con-list" });
  const conHead = h("div", { class: "nw-con-head" }, h("h3", { class: "nw-con-t" }, "Concepts in today's news"), h("p", { class: "nw-con-s" }, "The dictionary terms that came up most in the last 24 hours."));
  const aside = h("aside", { class: "nw-side", "aria-label": "Concepts in today's news" }, h("div", { class: "nw-con" }, conHead, concepts));
  const main = h("div", { class: "nw-main" }, h("div", { class: "nw-pill-wrap" }, pill), count, list, more);
  const live = h("p", { class: "nw-upd" });
  F.dom.clear(el);
  el.classList.add("nw-feed");
  el.append(
    h("div", { class: "nw-ctl" }, tabs, h("div", { class: "nw-ctl2" }, chips, search)),
    h("div", { class: "nw-layout" }, aside, main),
    live);
  // skeletons until the first data arrives
  for (let i = 0; i < 4; i++) list.appendChild(h("li", { class: "nw-card nw-skel" }, h("span", { class: "nw-sk nw-sk-s" }), h("span", { class: "nw-sk nw-sk-l" }), h("span", { class: "nw-sk" }), h("span", { class: "nw-sk nw-sk-m" })));
  for (let i = 0; i < 4; i++) concepts.appendChild(h("li", { class: "nw-con-i nw-skel" }, h("span", { class: "nw-sk nw-sk-s" }), h("span", { class: "nw-sk" })));

  const matchQ = it => {
    if (!S.q) return true;
    if (!it._hay) it._hay = (it.t + " " + it.s + " " + it.src + " " + termsOf(it).map(id => (F.glossary.get(id) || {}).term || "").join(" ")).toLowerCase();
    return S.q.split(/\s+/).every(w => it._hay.includes(w));
  };
  const inRegion = (it, r) => r === "all" || it.rg.includes(r);
  const inMarket = (it, m) => m === "all" || it.mk.includes(m);
  const isMine = it => S.words.size > 0 && termsOf(it).some(id => S.words.has(id));
  const inMine = it => !S.mine || isMine(it);
  const visible = () => S.items.filter(it => inRegion(it, S.region) && inMarket(it, S.market) && inMine(it) && matchQ(it));

  function buildControls() {
    const N = names(), byQ = S.items.filter(it => matchQ(it) && inMine(it));
    const regs = REG_ORDER.concat(Object.keys(N.rg).filter(k => !REG_ORDER.includes(k))).filter(r => S.items.some(it => it.rg.includes(r)));
    if (S.region !== "all" && !regs.includes(S.region)) S.region = "all";
    const tab = (id, label) => {
      const n = byQ.filter(it => inRegion(it, id) && inMarket(it, S.market)).length;
      return h("button", { class: "nw-tab" + (n ? "" : " nw-zero"), type: "button", "aria-pressed": String(S.region === id), "data-r": id,
        onclick: () => { if (S.region !== id) { S.region = id; S.shown = PAGE; update(true); } } }, label, h("span", { class: "nw-n" }, String(n)));
    };
    tabs.replaceChildren(tab("all", "All"), ...regs.map(r => tab(r, N.rg[r] || r)));
    const mks = MK_ORDER.concat(Object.keys(N.mk).filter(k => !MK_ORDER.includes(k))).filter(m => S.items.some(it => it.mk.includes(m)));
    if (S.market !== "all" && !mks.includes(S.market)) S.market = "all";
    const chip = (id, label) => {
      const n = byQ.filter(it => inMarket(it, id) && inRegion(it, S.region)).length;
      return h("button", { class: "nw-chip" + (n ? "" : " nw-zero"), type: "button", "aria-pressed": String(S.market === id), "data-m": id,
        onclick: () => { S.market = S.market === id && id !== "all" ? "all" : id; S.shown = PAGE; update(true); } }, label, h("span", { class: "nw-n" }, String(n)));
    };
    const mineN = S.words.size ? S.items.filter(it => matchQ(it) && inRegion(it, S.region) && inMarket(it, S.market) && isMine(it)).length : 0;
    if (S.mine && !S.words.size) S.mine = false;
    const mine = (mineN || S.mine) ? h("button", { class: "nw-chip nw-mine" + (mineN ? "" : " nw-zero"), type: "button", "aria-pressed": String(S.mine), "data-m": "mine",
      title: "Stories that mention words you saved or looked up in the Dictionary",
      onclick: () => { S.mine = !S.mine; S.shown = PAGE; update(true); } }, F.dom.icon("star"), "Your words", h("span", { class: "nw-n" }, String(mineN))) : null;
    chips.replaceChildren(...[mine, chip("all", "All markets"), ...mks.map(m => chip(m, N.mk[m] || m))].filter(Boolean));
  }

  function cardEl(it) {
    const N = names();
    const isNew = (S.seenAt && it.ts > S.seenAt) || S.fresh.has(it.id);
    const txt = h("div", { class: "nw-txt" },
      h("h3", { class: "nw-h" }, F.dom.ext(it.u, { class: "nw-a" }, it.t)),
      it.s ? h("p", { class: "nw-s" }, it.s) : null);
    const found = F.glossary.annotate(txt, { max: 6 });
    const all = found.concat(termsOf(it).filter(id => !found.includes(id)));
    const ids = all.filter(id => S.words.has(id)).concat(all.filter(id => !S.words.has(id))).slice(0, 4);   // the reader's own words first
    const tags = it.rg.map(r => N.rg[r]).filter(Boolean).concat(it.mk.map(m => N.mk[m]).filter(Boolean));
    const lens = lensOf(it);
    return h("li", { class: "nw-card" + (S.fresh.has(it.id) ? " nw-fresh" : ""), "data-id": it.id },
      h("div", { class: "nw-meta" },
        h("span", { class: "nw-src" }, it.src), h("span", { class: "nw-sep", "aria-hidden": "true" }, "·"), timeEl(it),
        isNew ? h("span", { class: "nw-new", title: "New since your last visit" }, h("i", { "aria-hidden": "true" }), "New") : null,
        tags.length ? h("span", { class: "nw-tags" }, tags.map(t => h("span", { class: "nw-tag" }, t))) : null),
      txt,
      ids.length ? h("div", { class: "nw-cc" }, h("span", { class: "nw-cc-k" }, "Concepts"),
        ids.map(id => h("span", { class: "nw-ccc" + (S.words.has(id) ? " nw-ccc-mine" : ""), "data-term": id, tabindex: "0",
          title: S.words.get(id) === "saved" ? "One of your saved words" : S.words.has(id) ? "You looked this up recently" : null },
          S.words.has(id) ? F.dom.icon("star") : null, (F.glossary.get(id) || {}).term || id))) : null,
      lens ? h("p", { class: "nw-why" }, h("b", null, "Why it matters"), h("span", null, lens)) : null);
  }

  function renderList(keepShown) {
    const v = visible();
    if (!keepShown) S.shown = Math.max(PAGE, Math.min(S.shown, v.length));
    const slice = v.slice(0, S.shown);
    if (!v.length) {
      const clr = h("button", { class: "nw-clear", type: "button", onclick: clearAll }, "Clear filters");
      list.replaceChildren(h("li", { class: "nw-empty" }, h("b", null, S.items.length ? "No stories match" : (hub.failed ? "News is not available right now" : "Updating…")),
        S.items.length ? h("span", null, "Try another region or market, or a shorter search.") : null, S.items.length ? clr : null));
    } else list.replaceChildren(...slice.map(cardEl));
    more.hidden = v.length <= S.shown;
    setCount(slice.length, v.length);
  }
  function setCount(a, b) {
    const filtered = S.region !== "all" || S.market !== "all" || S.mine || S.q;
    count.replaceChildren(...[b ? `Showing ${a} of ${b} ${b === 1 ? "story" : "stories"}` : "", filtered && b ? h("button", { class: "nw-clear", type: "button", onclick: clearAll }, "Clear filters") : null].filter(Boolean));
  }
  function clearAll() { S.region = "all"; S.market = "all"; S.mine = false; S.q = ""; input.value = ""; S.shown = PAGE; update(true); }
  more.addEventListener("click", () => {
    const v = visible(), from = S.shown;
    S.shown = Math.min(v.length, S.shown + PAGE);
    const frag = D.createDocumentFragment();
    v.slice(from, S.shown).forEach(it => frag.appendChild(cardEl(it)));
    list.appendChild(frag);
    more.hidden = v.length <= S.shown;
    setCount(S.shown, v.length);
    const first = list.children[from];
    const a = first && first.querySelector(".nw-a");
    if (a) { try { a.focus({ preventScroll: true }); } catch (e) {} }
  });

  function renderConcepts() {
    const now = Date.now(), newest = S.items.length ? S.items[0].ts : now;
    const ref = now - newest > 86400e3 ? newest : now;
    const counts = new Map();
    S.items.forEach(it => { if (ref - it.ts <= 86400e3) termsOf(it).forEach(id => counts.set(id, (counts.get(id) || 0) + 1)); });
    const top = [...counts.entries()].filter(([id]) => F.glossary.get(id)).sort((a, b) => b[1] - a[1]).slice(0, 8);
    requestAnimationFrame(stickAside);
    aside.hidden = !top.length;
    el.classList.toggle("nw-no-side", !top.length);
    concepts.replaceChildren(...top.map(([id, n]) => {
      const r = F.glossary.get(id);
      const dict = feat("dictionary");
      const inner = [h("span", { class: "nw-con-top" }, h("b", null, r.term), h("span", { class: "nw-con-n" }, n + (n === 1 ? " story" : " stories"))),
        h("span", { class: "nw-con-d" }, r.short || (dict ? "Open in the Dictionary" : "")),
        dict ? h("span", { class: "nw-con-go", "aria-hidden": "true" }, "Open in Dictionary →") : null];
      return h("li", { class: "nw-con-i" }, dict ? h("a", { class: "nw-con-a", href: dictHref(id) }, inner)
        : h("div", { class: "nw-con-a", "data-term": id, tabindex: "0" }, inner));
    }));
  }
  /* the concepts panel sticks below the header; when it is taller than the window it sticks by its bottom edge */
  function stickAside() {
    if (aside.hidden || getComputedStyle(aside).position !== "sticky") { aside.style.top = ""; return; }
    const hdr = parseFloat(getComputedStyle(D.documentElement).getPropertyValue("--hdr")) || 72;
    aside.style.top = Math.round(Math.min(hdr + 20, W.innerHeight - aside.offsetHeight - 20)) + "px";
  }
  W.addEventListener("resize", () => requestAnimationFrame(stickAside), { passive: true });
  function setLive() {
    const t = hub.data && Date.parse(hub.data.updated || "");
    live.textContent = hub.failed && !S.items.length ? "News is not available right now." :
      (isFinite(t) && t ? "News updated " + fmt.ago(t) + " · checks for new stories every " + Math.round(pollMs() / 60000) + " min" : "");
  }
  function update(filtersChanged) {
    buildControls();
    renderList(!filtersChanged);
    if (filtersChanged) S.fresh.clear();
  }
  function setPill() {
    const n = S.pending.length;
    pill.hidden = !n;
    pill.lastChild.textContent = n + (n === 1 ? " new story" : " new stories");
  }
  pill.addEventListener("click", () => {
    if (!S.pending.length) return;
    const add = S.pending.splice(0);
    add.forEach(it => { S.known.add(it.id); S.fresh.add(it.id); });
    S.items = add.concat(S.items).sort((a, b) => b.ts - a.ts);
    S.shown += add.filter(it => inRegion(it, S.region) && inMarket(it, S.market) && inMine(it) && matchQ(it)).length;
    setPill();
    buildControls(); renderList(true); renderConcepts();
    const top = list.getBoundingClientRect().top;
    if (top < 80) list.scrollIntoView({ block: "start", behavior: reduce.matches ? "auto" : "smooth" });
    const a = list.querySelector(".nw-a");
    if (a) { try { a.focus({ preventScroll: true }); } catch (e) {} }
    setTimeout(() => { S.fresh.clear(); list.querySelectorAll(".nw-fresh").forEach(c => c.classList.remove("nw-fresh")); }, 4000);
  });

  let qt = 0;
  input.addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(() => { S.q = input.value.trim().toLowerCase(); S.shown = PAGE; update(true); }, 140); });
  input.addEventListener("keydown", e => { if (e.key === "Escape" && input.value) { e.stopPropagation(); input.value = ""; S.q = ""; update(true); } });

  const onData = items => {
    if (!S.ready) {
      S.ready = true;
      S.items = items.slice();
      S.items.forEach(it => S.known.add(it.id));
      update(true); renderConcepts(); setLive();
      F.header.refresh();
      return;
    }
    const known = new Set(S.pending.map(i => i.id));
    const fresh = items.filter(it => !S.known.has(it.id) && !known.has(it.id));
    if (fresh.length) { S.pending = fresh.concat(S.pending).sort((a, b) => b.ts - a.ts); setPill(); }
    if (!S.items.length && !S.pending.length) renderList(true);
    setLive();
  };
  Promise.all([F.auth.ready.catch(() => null), glossaryReady()]).then(() => {
    S.words = myWords();
    S.seenAt = +F.store.get("news.seen", 0) || 0;
    F.store.set("news.seen", Date.now());
    subscribe(onData);
  });
  let wt = 0;
  F.on("store", key => {
    if (key !== "*" && key !== "dict.saved" && key !== "dict.history") return;
    clearTimeout(wt);
    wt = setTimeout(() => {   // a lookup or a save elsewhere on the page: refresh the personal chip and stars quietly
      const w = myWords(), sig = m => [...m].join();
      if (sig(w) === sig(S.words)) return;
      S.words = w;
      if (!S.ready) return;
      buildControls();
      if (S.mine) renderList(true);
      else list.querySelectorAll(".nw-ccc").forEach(c => { const id = c.getAttribute("data-term"), on = S.words.has(id);
        if (on !== c.classList.contains("nw-ccc-mine")) { c.classList.toggle("nw-ccc-mine", on); if (on) c.prepend(F.dom.icon("star")); else { const s = c.querySelector("svg"); if (s) s.remove(); } } });
    }, 250);
  });
  F.on("glossary", () => { if (S.ready) { S.items.forEach(it => { it._hay = null; }); renderList(true); renderConcepts(); } });
  setInterval(() => { if (!D.hidden && S.ready) { tickTimes(list); setLive(); } }, 60000);
}

W.FinspireNews = Object.freeze({ mountTeaser, mountFeed, refresh: () => { start(); return refresh(); } });
function boot() { D.querySelectorAll("[data-nw-feed]").forEach(mountFeed); }
if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", boot, { once: true }); else boot();
})();
