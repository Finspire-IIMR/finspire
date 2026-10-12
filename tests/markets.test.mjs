// Markets & News page (site/markets/, assets/js/markets.js, assets/js/news.js, assets/css/markets.css) in headless Chrome.
//   python3 scripts/build_site.py --demo --out .dev/markets
//   python3 -m http.server 8803 -d .dev/markets &
//   node --experimental-websocket tests/markets.test.mjs http://127.0.0.1:8803/ [chromeDebugPort=9403]
// Screenshots go to tests/out/markets/. Exits non-zero when a check fails.
//
// The page runs on the real build data (data/live/*.json and the dictionary built from content/glossary). One block
// polls the real CNBC / Moneycontrol endpoints; the deterministic live-update, pause and new-stories checks serve
// CNBC answers, config.js and news.json through CDP request interception instead.
import { launch, reporter, sleep } from "./lib/cdp.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, rmSync, mkdirSync } from "node:fs";

const base = (process.argv[2] || "http://127.0.0.1:8803/").replace(/\/?$/, "/");
const port = +(process.argv[3] || 9403);
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..");
const OUT = join(HERE, "out", "markets");
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const PAGE = base + "markets/";
const R = reporter(), check = R.check;
const b = await launch({ port });
const allErrors = [];

// ---- request interception -------------------------------------------------------------------------------------------
const CNBC_FIX = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/markets/cnbc.json"), "utf8"));
const NEWS = JSON.parse(await (await fetch(base + "data/live/news.json")).text());
const CONFIG = await (await fetch(base + "config.js")).text();
const json = (obj, extra = []) => ({ status: 200, type: "application/json", body: JSON.stringify(obj), headers: extra });
const CORS = [{ name: "Access-Control-Allow-Origin", value: "*" }];
const configWith = o => ({ status: 200, type: "application/javascript", body: CONFIG + "\nObject.assign(window.FINSPIRE_CONFIG, " + JSON.stringify(o) + ");\n" });
async function open(url, opts = {}) {
  const p = await b.page("about:blank", Object.assign({}, opts, { wait: 50 }));
  p.reqs = [];
  const routes = opts.routes || [];
  if (routes.length) {
    await p.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    p.on(m => {
      if (m.method !== "Fetch.requestPaused") return;
      const u = m.params.request.url;
      p.reqs.push(u);
      let r = null;
      for (const f of routes) { r = f(u); if (r) break; }
      if (!r) { p.send("Fetch.continueRequest", { requestId: m.params.requestId }).catch(() => {}); return; }
      if (r.fail) { p.send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "Failed" }).catch(() => {}); return; }
      p.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: r.status || 200,
        responseHeaders: [{ name: "Content-Type", value: r.type || "application/json" }, { name: "Cache-Control", value: "no-store" }].concat(r.headers || []),
        body: Buffer.from(r.body || "").toString("base64") }).catch(() => {});
    });
  } else {
    await p.send("Network.enable");
    p.on(m => { if (m.method === "Network.requestWillBeSent") p.reqs.push(m.params.request.url); });
  }
  await p.goto(url, opts.wait || 3500);
  return p;
}
// ignore: network errors the browser logs for requests a test fails on purpose (not page errors)
function done(p, label, ignore) {
  const errs = p.errors.filter(e => !(ignore && ignore.test(e)));
  allErrors.push(...errs.map(e => label + ": " + e)); check(label + ": no console errors", errs.length === 0, errs); p.close();
}
const BLOCKED = /^log: Failed to load resource: net::ERR_FAILED https:\/\/(quote\.cnbc\.com|priceapi\.moneycontrol\.com)\//;

// ---- helpers --------------------------------------------------------------------------------------------------------
const center = (p, sel, block = "center") => p.js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
  e.scrollIntoView({block:${JSON.stringify(block)}, behavior:"instant"}); const r=e.getClientRects()[0]||e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
async function hover(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(300); await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] }); await sleep(450); return c; }
async function click(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(200);
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] });
  for (const type of ["mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: c[0], y: c[1], button: "left", clickCount: 1 }); await sleep(300); }
async function tap(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(300);
  await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c[0], y: c[1] }] });
  await sleep(60); await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(500); }
async function key(p, k) {
  const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowRight: 39, ArrowLeft: 37 };
  for (const type of ["rawKeyDown", "keyUp"]) await p.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: codes[k] || 0 });
  await sleep(150);
}
const noOverflow = p => p.js("document.documentElement.scrollWidth <= innerWidth");
const waitFor = async (p, expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await p.js(expr)) return true; await sleep(150); } return false; };
const tipState = p => p.js(`(()=>{const t=document.querySelector(".gl-tip"); if(!t) return {open:false};
  return {open:t.classList.contains("gl-show"), sheet:t.classList.contains("gl-sheet"), term:t.querySelector(".gl-tip-term").textContent,
  def:t.querySelector(".gl-tip-def").textContent, href:t.querySelector(".gl-tip-open").getAttribute("href")}})()`);
const setHidden = (p, on) => p.js(`Object.defineProperty(document,"hidden",{configurable:true,get:()=>${on}}); Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>${on ? '"hidden"' : '"visible"'}}); document.dispatchEvent(new Event("visibilitychange")); true`);

// ===================================================================================================== desktop, real data
{
  const p = await open(PAGE, { width: 1280, height: 900, wait: 6000 });
  const s = await p.js(`(()=>{const q=s=>[...document.querySelectorAll(s)], st=FinspireMarkets.state();
    return {title:document.title, cards:q(".mk-card:not(.mk-sk-card)").length, withNum:q(".mk-card .mk-last").filter(e=>/\\d/.test(e.textContent)).length,
      seg:q(".mk-seg-b").map(b=>(b.querySelector(".mk-seg-f")||b.querySelector(".mk-seg-n")).textContent.trim()), visPanels:q(".mk-panel").filter(e=>!e.hidden).length,
      tape:q(".mk-tape-set").length, tapeItems:q(".mk-tape-set:first-child .mk-ti").length, tapeNum:q(".mk-tape-set:first-child .mk-tv").filter(e=>/\\d/.test(e.textContent)).length,
      pol:q(".mk-pol-r").length, polBanks:q(".mk-pol-bank").map(e=>e.textContent), rbi:q(".mk-pol-g")[0]?.querySelectorAll(".mk-pol-r").length,
      yields:q("[data-mk-rows=yields] .mk-row").length, yNum:q("[data-mk-rows=yields] .mk-row-c").filter(e=>/bp/.test(e.textContent)).length,
      cmd:q("[data-mk-rows=commodities] .mk-row").length, fx:q("[data-mk-rows=fx] .mk-row").length, crypto:q("[data-mk-rows=crypto] .mk-row").length,
      curve:!!document.querySelector(".mk-curve-svg"), lines:q(".mk-line").length, shape:document.querySelector(".mk-shape")?.textContent, note:document.querySelector(".mk-note-b")?.textContent,
      noteTerms:q(".mk-note .gl-term").length, nameTerms:q(".mk-card .mk-name [data-term]").length,
      status:document.querySelector("[data-mk-status]").textContent, state:st.state, snapAt:st.snapAt, dash:q(".mk-last,.mk-row-v").filter(e=>e.textContent==="—").length,
      src:document.querySelector(".mk-srcnote")?.textContent, foot:document.getElementById("fsFootNote").textContent,
      skel:q(".mk-sk-card,.mk-sk-row").length}})()`);
  check("page: title", s.title === "Markets & News · Finspire", s.title);
  check("board: 19 index cards with real numbers", s.cards === 19 && s.withNum >= 17, [s.cards, s.withNum]);
  check("board: India · Americas · Europe · Asia-Pacific, one panel shown", s.seg.join() === "India,Americas,Europe,Asia-Pacific" && s.visPanels === 1, s.seg);
  check("ticker: every catalog instrument (41) plus a clone for the loop", s.tape === 2 && s.tapeItems === 41 && s.tapeNum >= 38, s);
  check("rates: policy table with RBI repo/SDF/MSF/CRR/SLR grouped", s.pol >= 8 && s.rbi === 5 && /Reserve Bank of India/.test(s.polBanks[0]), [s.pol, s.rbi, s.polBanks]);
  check("rates: 8 government bond yields with bp changes", s.yields === 8 && s.yNum >= 6, [s.yields, s.yNum]);
  check("rows: commodities 6, currencies 6, crypto 2", s.cmd === 6 && s.fx === 6 && s.crypto === 2, s);
  check("curve: SVG with 3 series and a shape explainer", s.curve && s.lines === 3 && /Normal|Flat|Inverted/.test(s.shape) && /2-year/.test(s.note), [s.shape, s.note && s.note.slice(0, 120)]);
  check("curve: explainer links terms to the dictionary", s.noteTerms >= 1, s.noteTerms);
  check("board: instrument names carry dictionary terms", s.nameTerms >= 8, s.nameTerms);
  check("data: snapshot loaded, skeletons gone", s.snapAt > 0 && s.skel === 0, [s.snapAt, s.skel]);
  check("status: live, or an honest fallback", /^Live · updated \d\d:\d\d:\d\d IST · refreshing every 15 s$/.test(s.status) || /^Showing last saved prices/.test(s.status), s.status);
  check("notes: source + delay + approximate hours", /CNBC and Moneycontrol, may be delayed; market hours approximate \(holidays not shown\)/.test(s.src) && /CNBC, Moneycontrol; may be delayed/.test(s.foot), s.src);
  check("real live poll: CNBC and Moneycontrol reached", s.state === "live", [s.state, s.status]);
  check("desktop: no horizontal overflow", await noOverflow(p));

  // ticker animation + pause on hover
  const tk = await p.js(`(()=>{const t=document.querySelector(".mk-tape-track"), cs=getComputedStyle(t); return {name:cs.animationName, dur:cs.animationDuration, state:cs.animationPlayState,
    tf:t.style.getPropertyValue("--mk-dur")}})()`);
  check("ticker: continuous CSS transform animation", tk.name === "mkTape" && tk.state === "running" && /s$/.test(tk.tf), tk);
  await hover(p, ".mk-tape-set:first-child li:nth-child(3) .mk-ti");
  check("ticker: pauses on hover", await p.js(`getComputedStyle(document.querySelector(".mk-tape-track")).animationPlayState`) === "paused");
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 600 });

  // segmented control (mouse + keyboard)
  await click(p, "#mk-t-americas");
  let seg = await p.js(`({sel:document.querySelector(".mk-seg-b[aria-selected=true]").id, vis:[...document.querySelectorAll(".mk-panel")].filter(e=>!e.hidden).map(e=>e.id), n:document.querySelectorAll("#mk-p-americas .mk-card").length})`);
  check("segmented: click Americas shows its 4 cards", seg.sel === "mk-t-americas" && seg.vis.join() === "mk-p-americas" && seg.n === 4, seg);
  await key(p, "ArrowRight");
  seg = await p.js(`({sel:document.querySelector(".mk-seg-b[aria-selected=true]").id, focus:document.activeElement.id})`);
  check("segmented: arrow keys move to Europe", seg.sel === "mk-t-europe" && seg.focus === "mk-t-europe", seg);
  await click(p, "#mk-t-india");
  // open/closed pill and range bar
  const card = await p.js(`(()=>{const c=document.getElementById("mk-NIFTY"); return {pill:c.querySelector(".mk-pill").textContent, title:c.querySelector(".mk-pill").title,
    mark:c.querySelector(".mk-mark").style.left, lo:c.querySelector(".mk-lo").textContent, hi:c.querySelector(".mk-hi").textContent, sess:c.querySelector(".mk-sess").textContent}})()`);
  check("card: Open/Closed pill, day-range bar and session text", /^(Open|Closed)$/.test(card.pill) && /09:15–15:30/.test(card.title) && /%$/.test(card.mark) && /\d/.test(card.lo + card.hi) && /(Closes|Opens) /.test(card.sess), card);
  await p.shot(join(OUT, "desk-top.png"));

  // instrument tooltip
  await hover(p, "#mk-NIFTY .mk-name [data-term]");
  let tip = await tipState(p);
  check("tooltip: instrument name opens a dictionary tip", tip.open && /Nifty/i.test(tip.term) && tip.def.length > 20 && /dictionary\/#t=/.test(tip.href), tip);
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 880 }); await sleep(400);

  // curve crosshair
  await p.js(`document.querySelector("[data-mk-curve]").scrollIntoView({block:"center", behavior:"instant"}); true`); await sleep(300);
  const box = await p.js(`(()=>{const r=document.querySelector("[data-mk-curve]").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]})()`);
  const before = await p.js(`document.querySelector("[data-mk-curve-read] .mk-ro-t").textContent`);
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box[0] + 60, y: box[1] + box[3] / 2 }); await sleep(250);
  const c1 = await p.js(`({t:document.querySelector("[data-mk-curve-read] .mk-ro-t").textContent, vals:[...document.querySelectorAll("[data-mk-curve-read] .mk-ro-v b")].map(e=>e.textContent), x:document.querySelector(".mk-cross").getAttribute("x1")})`);
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box[0] + box[2] - 8, y: box[1] + box[3] / 2 }); await sleep(250);
  const c2 = await p.js(`({t:document.querySelector("[data-mk-curve-read] .mk-ro-t").textContent, x:document.querySelector(".mk-cross").getAttribute("x1")})`);
  check("curve: hover moves the crosshair and reads every series", before === "10 years" && /month/.test(c1.t) && c1.vals.length === 3 && c1.vals.every(v => /%$|—/.test(v)) && c2.t === "30 years" && +c2.x > +c1.x, { before, c1, c2 });
  await p.shot(join(OUT, "desk-curve.png"));

  // news feed ---------------------------------------------------------------------------------------------------------
  await p.js(`document.getElementById("news").scrollIntoView({behavior:"instant"}); true`); await sleep(600);
  const nw = await p.js(`(()=>{const q=s=>[...document.querySelectorAll(s)];
    return {cards:q(".nw-card:not(.nw-skel)").length, tabs:q(".nw-tab").map(t=>t.dataset.r), chips:q(".nw-chip").map(t=>t.dataset.m), count:document.querySelector(".nw-count").textContent,
      con:q(".nw-con-a").length, conHref:q(".nw-con-a").every(a=>/^\\.\\.\\/dictionary\\/#t=/.test(a.getAttribute("href"))), conDef:q(".nw-con-d").every(e=>e.textContent.length>10),
      hlTerms:q(".nw-h .gl-term").length, inLink:q(".nw-h .gl-term").every(e=>e.closest("a.nw-a")), why:q(".nw-why").length, chipsC:q(".nw-ccc").length,
      links:q(".nw-a").every(a=>a.target==="_blank" && a.rel==="noopener noreferrer" && /^https?:/.test(a.href)), meta:document.querySelector(".nw-meta").textContent,
      light:!!document.querySelector("#news.light"), upd:document.querySelector(".nw-upd").textContent, seen:+localStorage.getItem("fs:guest:news.seen")}})()`);
  check("news: 24 cards from real news.json", nw.cards === 24 && /Showing 24 of \d+ stories/.test(nw.count), [nw.cards, nw.count]);
  check("news: region tabs (non-empty only) and market chips", nw.tabs[0] === "all" && nw.tabs.length >= 4 && nw.tabs.every(t => ["all", "in", "us", "eu", "ap", "me", "gl"].includes(t)) && nw.chips.includes("all") && nw.chips.length >= 5, [nw.tabs, nw.chips]);
  check("news: concepts strip (up to 8, plain meanings, dictionary links)", nw.con >= 1 && nw.con <= 8 && nw.conHref && nw.conDef, nw.con);
  check("news: headline terms highlighted inside the links", nw.hlTerms >= 3 && nw.inLink, nw.hlTerms);
  check("news: concept chips and Why-it-matters lines", nw.chipsC >= 5 && nw.why >= 5, [nw.chipsC, nw.why]);
  check("news: links open the publisher in a new tab, safely", nw.links);
  check("news: light band, update line, last visit remembered", nw.light && /News updated .* checks for new stories every 3 min/.test(nw.upd) && nw.seen > Date.now() - 600000, [nw.upd, nw.seen]);
  await p.shot(join(OUT, "desk-news.png"));

  // headline tooltip, desktop hover; clicking a term inside a link shows the tip and does not navigate
  await hover(p, ".nw-h .gl-term");
  tip = await tipState(p);
  check("news tooltip: hover on a headline term (desktop)", tip.open && !tip.sheet && tip.term.length > 1 && tip.def.length > 10, tip);
  await p.shot(join(OUT, "desk-news-tip.png"));
  const href0 = await p.js("location.href");
  await click(p, ".nw-h .gl-term");
  check("news tooltip: clicking a term inside the headline link does not open the article", (await p.js("location.href")) === href0 && (await tipState(p)).open);
  await key(p, "Escape");

  // filters, search, show more
  const total = await p.js(`+document.querySelector(".nw-count").textContent.match(/of (\\d+)/)[1]`);
  await click(p, ".nw-tab[data-r=in]");
  const f1 = await p.js(`(()=>{const c=[...document.querySelectorAll(".nw-card")]; return {n:+document.querySelector(".nw-count").textContent.match(/of (\\d+)/)[1], tab:document.querySelector(".nw-tab[data-r=in]").getAttribute("aria-pressed"),
    allIndia:c.every(x=>[...x.querySelectorAll(".nw-tag")].some(t=>t.textContent==="India"))}})()`);
  check("news filter: India tab", f1.tab === "true" && f1.n > 0 && f1.n < total && f1.allIndia, f1);
  const chipId = await p.js(`[...document.querySelectorAll(".nw-chip")].find(c=>c.dataset.m!=="all" && c.dataset.m!=="mine" && !c.classList.contains("nw-zero")).dataset.m`);
  await click(p, `.nw-chip[data-m=${chipId}]`);
  const f2 = await p.js(`(()=>({n:+(document.querySelector(".nw-count").textContent.match(/of (\\d+)/)||[0,0])[1], pressed:document.querySelector(".nw-chip[aria-pressed=true]").dataset.m,
    clear:!!document.querySelector(".nw-count .nw-clear")}))()`);
  check("news filter: market chip (single select) narrows India further", f2.pressed === chipId && f2.n > 0 && f2.n <= f1.n && f2.clear, [chipId, f2]);
  await click(p, ".nw-count .nw-clear");
  await click(p, ".nw-q"); await p.type("rupee"); await sleep(500);
  const f3 = await p.js(`(()=>{const c=[...document.querySelectorAll(".nw-card")]; return {n:c.length, all:c.every(x=>/rupee/i.test(x.textContent)), count:document.querySelector(".nw-count").textContent}})()`);
  check("news search: 'rupee' shows only matching stories", f3.n > 0 && f3.all, f3);
  await p.js(`(()=>{const i=document.querySelector(".nw-q"); i.value=""; i.dispatchEvent(new Event("input",{bubbles:true})); return true})()`); await sleep(500);
  await p.js(`(()=>{const i=document.querySelector(".nw-q"); i.value="zzqx nothing"; i.dispatchEvent(new Event("input",{bubbles:true})); return true})()`); await sleep(500);
  check("news search: no match shows a clear empty state", await p.js(`/No stories match/.test(document.querySelector(".nw-empty")?.textContent||"")`));
  await click(p, ".nw-empty .nw-clear");
  await click(p, ".nw-more");
  const f4 = await p.js(`({n:document.querySelectorAll(".nw-card").length, count:document.querySelector(".nw-count").textContent})`);
  check("news: Show more adds 24", f4.n === 48 && /Showing 48 of/.test(f4.count), f4);
  done(p, "desktop");
}

// ============================================================================ deterministic live poll, pause, CLS, long tasks
{
  let bump = 0, cnbcHits = 0;
  const cnbc = u => {
    if (!u.startsWith("https://quote.cnbc.com/")) return null;
    cnbcHits++;
    const d = JSON.parse(JSON.stringify(CNBC_FIX));
    const spx = d.FormattedQuoteResult.FormattedQuote.find(q => q.symbol === ".SPX");
    const last = 7811.54 + bump;
    spx.last = last.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    spx.change = (bump >= 0 ? "+" : "") + (46.18 + bump).toFixed(2); spx.change_pct = "+" + ((46.18 + bump) / 7765.36 * 100).toFixed(2) + "%";
    spx.high = Math.max(7820.57, last).toLocaleString("en-US", { minimumFractionDigits: 2 });
    return json(d, CORS);
  };
  const mc = u => u.startsWith("https://priceapi.moneycontrol.com/") ? { fail: true } : null;
  const cfg = u => /\/config\.js(\?|$)/.test(u) ? configWith({ marketsPollSeconds: 5 }) : null;
  const p = await open(PAGE, { width: 1280, height: 900, wait: 4000, routes: [cnbc, mc, cfg] });
  await p.js(`window.__ls=0; window.__lt=[]; new PerformanceObserver(l=>l.getEntries().forEach(e=>{ if(!e.hadRecentInput) window.__ls+=e.value; })).observe({type:"layout-shift"});
    new PerformanceObserver(l=>l.getEntries().forEach(e=>window.__lt.push(Math.round(e.duration)))).observe({type:"longtask"}); true`);
  await p.js(`document.getElementById("mk-t-americas").click(); document.getElementById("board").scrollIntoView({behavior:"instant"}); true`); await sleep(300);
  const s0 = await p.js(`({v:document.querySelector("#mk-SPX .mk-last").textContent, st:FinspireMarkets.state(), status:document.querySelector("[data-mk-status]").textContent})`);
  check("mock poll: CNBC answer applied (Moneycontrol failing is tolerated)", s0.v === "7,811.54" && s0.st.state === "live" && s0.st.partial.includes("Moneycontrol"), [s0.v, s0.st.state, s0.st.partial]);
  bump = 12.5;
  const t0 = s0.st.liveAt;
  await p.js("FinspireMarkets.refresh().then(()=>true)"); await sleep(120);
  const s1 = await p.js(`(()=>{const l=document.querySelector("#mk-SPX .mk-last"); return {v:l.textContent, fl:[...l.classList].find(c=>/^mk-fl-up/.test(c))||"", liveAt:FinspireMarkets.state().liveAt,
    tick:document.querySelector(".mk-tape-set .mk-ti[href='#mk-SPX'] .mk-tv").textContent, status:document.querySelector("[data-mk-status]").textContent}})()`);
  check("live poll: new value shown on card and ticker, flashes up, timestamp moves", s1.v === "7,824.04" && s1.tick === "7,824.04" && s1.fl && s1.liveAt > t0 && /^Live · updated/.test(s1.status), s1);
  await sleep(1800);
  // tab hidden → paused, no polling; visible → immediate poll
  await setHidden(p, true);
  const hits0 = cnbcHits;
  const ps = await p.js(`document.querySelector("[data-mk-status]").textContent`);
  await sleep(6500);
  check("hidden tab: status says Paused and polling stops", /^Paused/.test(ps) && cnbcHits === hits0, [ps, cnbcHits - hits0]);
  await setHidden(p, false); await sleep(800);
  const rs = await p.js(`document.querySelector("[data-mk-status]").textContent`);
  check("visible again: polls at once and shows Live", cnbcHits > hits0 && /^Live · updated/.test(rs), [cnbcHits - hits0, rs]);
  await sleep(5600);
  check("polling: repeats every marketsPollSeconds while visible", cnbcHits >= hits0 + 2, cnbcHits - hits0);
  const perf = await p.js(`({ls:window.__ls, lt:window.__lt})`);
  check("smooth: no layout shift while numbers update", perf.ls < 0.01, perf.ls);
  check("smooth: no long tasks during polls", perf.lt.every(d => d < 80), perf.lt);
  // all sources failing → keep the snapshot and say so
  done(p, "mock poll", BLOCKED);

  const p2 = await open(PAGE, { width: 1280, height: 900, wait: 5000, routes: [u => /quote\.cnbc\.com|priceapi\.moneycontrol\.com/.test(u) ? { fail: true } : null] });
  const fb = await p2.js(`({status:document.querySelector("[data-mk-status]").textContent, state:FinspireMarkets.state().state, v:document.querySelector("#mk-NIFTY .mk-last").textContent})`);
  check("fallback: live sources down → last saved prices with time, numbers kept", fb.state === "fallback" && /^Showing last saved prices \(.+\)/.test(fb.status) && /\d/.test(fb.v), fb);
  done(p2, "fallback", BLOCKED);
}

// ================================================================================================ new-stories pill
{
  const now = Date.now();
  let extra = [];
  const news = u => /\/data\/live\/news\.json/.test(u) ? json(Object.assign({}, NEWS, { updated: new Date().toISOString(), items: extra.concat(NEWS.items) })) : null;
  const p = await open(PAGE, { width: 1280, height: 900, wait: 4500, routes: [news] });
  await p.js(`document.getElementById("news").scrollIntoView({behavior:"instant"}); scrollBy({top:900, behavior:"instant"}); true`); await sleep(800);
  const y0 = await p.js("scrollY"), first0 = await p.js(`document.querySelector(".nw-card").dataset.id`);
  extra = [
    { id: "test0000001", t: "RBI keeps the repo rate unchanged as inflation cools", s: "The Monetary Policy Committee voted to hold the policy rate.", u: "https://example.com/a", src: "Test Wire", ts: new Date(now).toISOString(), rg: ["in"], mk: ["cb"], terms: ["repo-rate"] },
    { id: "test0000002", t: "Brent crude climbs as supply worries return", s: "", u: "https://example.com/b", src: "Test Wire", ts: new Date(now - 60000).toISOString(), rg: ["gl"], mk: ["cmd"], terms: [] }
  ];
  await p.js("FinspireNews.refresh().then(()=>true)"); await sleep(400);
  const pl = await p.js(`({hidden:document.querySelector(".nw-pill").hidden, text:document.querySelector(".nw-pill").textContent, first:document.querySelector(".nw-card").dataset.id, y:scrollY})`);
  check("new stories: pill shows the count, list does not jump", !pl.hidden && /2 new stories/.test(pl.text) && pl.first === first0 && Math.abs(pl.y - y0) < 2, Object.assign(pl, { y0 }));
  await p.shot(join(OUT, "desk-news-pill.png"));
  await click(p, ".nw-pill");
  await sleep(500);
  const ins = await p.js(`(()=>{const c=[...document.querySelectorAll(".nw-card")].slice(0,2); return {ids:c.map(x=>x.dataset.id), fresh:c.every(x=>x.classList.contains("nw-fresh")),
    hidden:document.querySelector(".nw-pill").hidden, terms:[...c[0].querySelectorAll(".nw-h .gl-term")].map(e=>e.dataset.term), why:c[0].querySelector(".nw-why")?.textContent||"",
    focus:document.activeElement.closest(".nw-card")?.dataset.id, n:document.querySelectorAll(".nw-card").length}})()`);
  check("new stories: click inserts them on top, marked fresh", ins.ids.join() === "test0000001,test0000002" && ins.fresh && ins.hidden && ins.focus === "test0000001" && ins.n === 26, ins);
  check("new stories: terms highlighted, central-bank lens", ins.terms.includes("repo-rate") && /Policy-rate changes reset borrowing costs/.test(ins.why), ins);
  await p.shot(join(OUT, "desk-news-inserted.png"));
  done(p, "news pill");
}

// =================================================================== "New since last visit" and personal "Your words"
{
  const p = await open(PAGE, { width: 1280, height: 900, wait: 4000 });
  const pick = await p.js(`(()=>{const c=document.querySelector(".nw-card .nw-ccc"); return c ? c.dataset.term : null})()`);
  await p.js(`localStorage.setItem("fs:guest:news.seen", String(Date.now()-3*3600e3)); localStorage.setItem("fs:guest:dict.saved", JSON.stringify([${JSON.stringify(pick)}])); true`);
  await p.goto(PAGE, 4500);
  await p.js(`document.getElementById("news").scrollIntoView({behavior:"instant"}); true`); await sleep(300);
  const nv = await p.js(`(()=>{const c=[...document.querySelectorAll(".nw-card")]; const seen=Date.now()-3*3600e3;
    return {newN:document.querySelectorAll(".nw-new").length, ok:c.every(x=>!!x.querySelector(".nw-new")===(Date.parse(x.querySelector("time").getAttribute("datetime"))>seen-120000) || true),
      mine:!!document.querySelector(".nw-chip.nw-mine"), mineN:+(document.querySelector(".nw-chip.nw-mine .nw-n")?.textContent||0), star:document.querySelectorAll(".nw-ccc-mine").length}})()`);
  check("new dot: stories newer than the last visit are marked New", nv.newN > 0, nv);
  check("your words: saved word gives a personal chip and starred concept chips", nv.mine && nv.mineN >= 1 && nv.star >= 1, nv);
  await click(p, ".nw-chip.nw-mine");
  const mw = await p.js(`(()=>{const c=[...document.querySelectorAll(".nw-card")]; return {n:c.length, all:c.every(x=>x.querySelector(".nw-ccc-mine")), pressed:document.querySelector(".nw-mine").getAttribute("aria-pressed")}})()`);
  check("your words: filter shows only stories with your words", mw.n >= 1 && mw.all && mw.pressed === "true", mw);
  await p.shot(join(OUT, "desk-news-yourwords.png"));
  done(p, "personal");

  // signed in (demo student): personal words belong to that account, not the guest profile
  const p2 = await open(PAGE + "?demo-user=1", { width: 1280, height: 900, wait: 4500 });
  const si = await p2.js(`({user:Finspire.auth.user()&&Finspire.auth.user().email, mine:!!document.querySelector(".nw-chip.nw-mine")})`);
  await p2.js(`Finspire.store.set("dict.saved", [${JSON.stringify(pick)}]); true`); await sleep(600);
  const si2 = await p2.js(`({mine:!!document.querySelector(".nw-chip.nw-mine"), star:document.querySelectorAll(".nw-ccc-mine").length, acct:!!document.querySelector(".fs-acct-btn")})`);
  check("signed in: account control shown; personal words are per account and update live", si.user === "demo.student@iimranchi.ac.in" && !si.mine && si2.mine && si2.star >= 1 && si2.acct, [si, si2]);
  await p2.js(`localStorage.clear(); sessionStorage.clear(); true`);
  done(p2, "signed in");

  // sign-in switched off (features.signin:false): everyone is a local guest; the news feed and "Your words" still work
  const p3 = await open(PAGE, { width: 1280, height: 900, wait: 4500, routes: [u => /\/config\.js(\?|$)/.test(u) ? configWith({ features: { signin: false } }) : null] });
  await p3.js(`Finspire.store.set("dict.saved", [${JSON.stringify(pick)}]); true`); await sleep(600);
  const go = await p3.js(`({guest:!!(Finspire.auth.user()&&Finspire.auth.user().guest), enabled:Finspire.auth.enabled(), acctHidden:document.querySelector("[data-fs-account]").hidden,
    cards:document.querySelectorAll(".nw-card:not(.nw-skel)").length, mine:!!document.querySelector(".nw-chip.nw-mine")})`);
  check("sign-in off: guest mode, account control hidden, news feed and personal words work", go.guest && !go.enabled && go.acctHidden && go.cards === 24 && go.mine, go);
  await p3.js(`localStorage.clear(); true`);
  done(p3, "guest mode");
}

// ============================================================================================================ phone
{
  const p = await open(PAGE, { width: 390, height: 844, mobile: true, scale: 2, wait: 6000 });
  const ph = await p.js(`(()=>{const q=s=>[...document.querySelectorAll(s)], vw=innerWidth;
    const seg=document.querySelector(".mk-seg").getBoundingClientRect(), segB=q(".mk-seg-b").map(b=>b.getBoundingClientRect());
    const small=q("a.nw-a,.nw-tab,.nw-chip,.mk-seg-b,.nw-more,.mk-jump a,.nw-q").filter(e=>e.offsetParent&&e.getBoundingClientRect().height<40).map(e=>e.className+":"+Math.round(e.getBoundingClientRect().height));
    const g=document.querySelector(".mk-card").getBoundingClientRect();
    return {seg:[Math.round(seg.left), Math.round(seg.right)], segFit:segB.every(r=>r.right<=seg.right+1 && r.left>=seg.left-1), segN:segB.length, small,
      gutter:[Math.round(g.left), Math.round(vw-g.right)], q:getComputedStyle(document.querySelector(".nw-q")).fontSize,
      chipsScroll:getComputedStyle(document.querySelector(".nw-chips")).overflowX, chipsWrap:getComputedStyle(document.querySelector(".nw-chips")).flexWrap,
      tabsScroll:getComputedStyle(document.querySelector(".nw-tabs")).overflowX, tableStack:getComputedStyle(document.querySelector(".mk-pol-r")).display, cols:getComputedStyle(document.querySelector(".nw-layout")).gridTemplateColumns.split(" ").length}})()`);
  check("phone: no horizontal overflow", await noOverflow(p));
  check("phone: segmented control fits (4 segments)", ph.segFit && ph.segN === 4 && ph.seg[0] === 16 && ph.seg[1] === 374, ph.seg);
  check("phone: 16px gutters", ph.gutter[0] === 16 && ph.gutter[1] === 16, ph.gutter);
  check("phone: search input 16px (no iOS zoom)", ph.q === "16px", ph.q);
  check("phone: region tabs and chips scroll sideways", ph.chipsScroll === "auto" && ph.chipsWrap === "nowrap" && ph.tabsScroll === "auto", ph);
  check("phone: policy table stacks, news in one column", ph.tableStack === "grid" && ph.cols === 1, ph);
  check("phone: tap targets ≥ 40px", ph.small.length === 0, ph.small);
  await p.shot(join(OUT, "phone-0-top.png"));
  await tap(p, "#mk-t-asia");
  const pa = await p.js(`({sel:document.querySelector(".mk-seg-b[aria-selected=true]").id, n:[...document.querySelectorAll("#mk-p-asia .mk-card")].filter(e=>e.offsetParent).length})`);
  check("phone: tapping Asia shows the Asia-Pacific cards", pa.sel === "mk-t-asia" && pa.n === 7, pa);
  await p.js(`scrollTo(0, document.getElementById("board").offsetTop - 60); true`); await sleep(400);
  await p.shot(join(OUT, "phone-1-board.png"));
  await p.js(`scrollTo(0, document.getElementById("rates").offsetTop - 60); true`); await sleep(400);
  await p.shot(join(OUT, "phone-2-rates.png"));
  await p.js(`document.querySelector(".mk-box-curve").scrollIntoView({behavior:"instant"}); scrollBy(0,-70); true`); await sleep(400);
  const cb = await p.js(`(()=>{const r=document.querySelector("[data-mk-curve]").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]})()`);
  await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cb[0] + 40, y: cb[1] + cb[3] / 2 }] }); await sleep(60);
  await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(300);
  const ct = await p.js(`document.querySelector("[data-mk-curve-read] .mk-ro-t").textContent`);
  check("phone: tapping the curve reads that maturity", /month/.test(ct), ct);
  await p.shot(join(OUT, "phone-3-curve.png"));
  await p.js(`scrollTo(0, document.getElementById("more").offsetTop - 60); true`); await sleep(400);
  await p.shot(join(OUT, "phone-4-more.png"));
  await p.js(`scrollTo(0, document.getElementById("news").offsetTop); true`); await sleep(400);
  await p.shot(join(OUT, "phone-5-news.png"));
  await p.js(`scrollTo(0, document.querySelector(".nw-list").getBoundingClientRect().top + scrollY - 80); true`); await sleep(400);
  await p.shot(join(OUT, "phone-6-cards.png"));
  // headline term tap → bottom sheet, no navigation
  const href0 = await p.js("location.href");
  await tap(p, ".nw-h .gl-term");
  const tip = await tipState(p);
  check("phone: tapping a headline term opens the dictionary sheet, not the article", tip.open && tip.sheet && (await p.js("location.href")) === href0, tip);
  await p.shot(join(OUT, "phone-7-sheet.png"));
  await p.js(`document.querySelector(".gl-tip-x").click(); true`); await sleep(300);
  check("phone: no horizontal overflow after interactions", await noOverflow(p));
  done(p, "phone");
}

// ===================================================================================== reduced motion
{
  const p = await open(PAGE, { width: 390, height: 844, mobile: true, reducedMotion: true, wait: 4500 });
  const rm = await p.js(`(()=>{const t=document.querySelector(".mk-tape"), tr=document.querySelector(".mk-tape-track"); return {anim:getComputedStyle(tr).animationName, ox:getComputedStyle(t).overflowX,
    scrolls:t.scrollWidth>t.clientWidth, clone:getComputedStyle(document.querySelector(".mk-tape-set[aria-hidden]")).display}})()`);
  check("reduced motion: ticker becomes a static strip you can scroll", rm.anim === "none" && rm.ox === "auto" && rm.scrolls && rm.clone === "none", rm);
  check("reduced motion: no overflow", await noOverflow(p));
  done(p, "reduced motion");
}

// ===================================================================== home-page widgets on a blank page (dark background)
{
  const BLANK = base + "markets/_widgets.html";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="fs-root" content="../">
<title>Widgets</title><link rel="icon" href="data:,"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="../assets/css/shell.css"><link rel="stylesheet" href="../assets/css/markets.css">
<style>body{margin:0;background:#141416;color:#F4F4F6;font-family:"IBM Plex Sans",sans-serif}main{max-width:1100px;margin:0 auto;padding:24px 16px;display:grid;gap:28px}
a{color:inherit;text-decoration:none}ol,ul{margin:0;padding:0}p,h3{margin:0}button{font:inherit;background:none;border:0;color:inherit}</style></head><body>
<div id="tk"></div><main><div id="mini"></div><div id="teaser"></div></main>
<script src="../config.js"></script><script src="../assets/js/finspire.js"></script><script src="../assets/js/markets.js"></script><script src="../assets/js/news.js"></script>
<script>FinspireMarkets.mountTicker(document.getElementById("tk")); FinspireMarkets.mountMini(document.getElementById("mini"), ["NIFTY","SENSEX","SPX","US10Y","BRENT","USDINR"]); FinspireNews.mountTeaser(document.getElementById("teaser"), {count: 3});</script>
</body></html>`;
  const routes = [u => u.split("?")[0] === BLANK ? { status: 200, type: "text/html", body: html } : null,
    u => /\/config\.js(\?|$)/.test(u) ? configWith({ pages: { markets: "markets/index.html" } }) : null];
  for (const [label, vw] of [["widgets desktop", { width: 1280, height: 900 }], ["widgets phone", { width: 390, height: 844, mobile: true, scale: 2 }]]) {
    const p = await open(BLANK, Object.assign({ wait: 6000, routes }, vw));
    const w = await p.js(`(()=>{const q=s=>[...document.querySelectorAll(s)];
      return {tiles:q(".mk-tile").length, nums:q(".mk-tile-v").filter(e=>/\\d/.test(e.textContent)).length, href:document.querySelector(".mk-tile-a")?.getAttribute("href"),
        tape:q(".mk-tape-set:first-child .mk-ti").length, tapeHref:document.querySelector(".mk-ti")?.getAttribute("href"), status:document.querySelector(".mk-mini .mk-status")?.textContent,
        heads:q(".nw-t-item:not(.nw-skel) .nw-t-a").length, meta:q(".nw-t-meta").map(e=>e.textContent), terms:q(".nw-t-h .gl-term").length,
        foreign:q("body *").filter(e=>e.className && typeof e.className==="string" && e.closest("#tk,#mini,#teaser") && e.className.split(/\\s+/).some(c=>c && !/^(mk-|nw-|gl-|fs-)/.test(c))).map(e=>e.className).slice(0,5),
        tileBg:getComputedStyle(document.querySelector(".mk-tile")).backgroundColor, nameTerm:q(".mk-tile-n[data-term]").length}})()`);
    check(label + ": mini board with 6 live tiles linking to the Markets page", w.tiles === 6 && w.nums >= 5 && w.href === "../markets/index.html#mk-NIFTY" && /^(Live|Last saved|Showing)/.test(w.status), w);
    check(label + ": ticker mounts and links to the Markets page", w.tape === 41 && /^\.\.\/markets\/index\.html#mk-/.test(w.tapeHref), w.tapeHref);
    check(label + ": teaser with 3 headlines, source and time", w.heads === 3 && w.meta.length === 3 && w.meta.every(m => /ago|just now|yesterday/.test(m)), w.meta);
    check(label + ": only mk-/nw-/gl- classes, dark tiles", w.foreign.length === 0 && w.tileBg === "rgb(26, 26, 31)", [w.foreign, w.tileBg]);
    check(label + ": no overflow", await noOverflow(p));
    await p.shot(join(OUT, label.replace(" ", "-") + ".png"));
    done(p, label);
  }
}

// ======================================================================================== full-page screenshots
{
  const p = await open(PAGE, { width: 1280, height: 900, wait: 6000 });
  await p.js(`scrollTo(0, document.body.scrollHeight); true`); await sleep(600); await p.js(`scrollTo(0, 0); true`); await sleep(400);
  await p.shot(join(OUT, "desk-full.png"), { fullPage: true });
  done(p, "full page");
}

await b.close();
console.log(allErrors.length ? "\nConsole errors:\n" + allErrors.join("\n") : "\nNo console errors in any page.");
process.exit(R.done() ? 1 : 0);
