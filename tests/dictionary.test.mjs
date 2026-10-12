// Dictionary page (site/dictionary/index.html + assets/js/dictionary.js + assets/css/dictionary.css).
//   python3 scripts/build_site.py --demo --out .dev/dictionary
//   python3 -m http.server 8804 -d .dev/dictionary &
//   node --experimental-websocket tests/dictionary.test.mjs http://127.0.0.1:8804/ [chromeDebugPort=9404]
// Uses the real built dictionary and the real data/live/news-terms.json; expectations are computed from that data in
// the page, so the checks keep working while content/glossary grows. The scale check serves a synthetic 1,900-term
// index (cloned from the real one) through request interception. Screenshots go to tests/out/dictionary/.
import { launch, reporter, sleep } from "./lib/cdp.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const base = (process.argv[2] || "http://127.0.0.1:8804/").replace(/\/?$/, "/");
const port = +(process.argv[3] || 9404);
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out", "dictionary");
const PAGE = base + "dictionary/";
const R = reporter(), check = R.check;
const b = await launch({ port });
// data/glossary/tod.json and data/live/news-terms/<cat>.json are optional (the page falls back to the index and the
// whole news-terms map); a 404 for them is expected until the build writes them, so it is not counted as an error
const OPTIONAL = /404[^]*\/(data\/glossary\/tod\.json|data\/live\/news-terms\/[a-z0-9-]+\.json)/;
const errs = p => p.errors.filter(e => !OPTIONAL.test(e));
const CLS = `window.__cls=0;try{new PerformanceObserver(l=>l.getEntries().forEach(e=>{if(!e.hadRecentInput)__cls+=e.value})).observe({type:"layout-shift",buffered:true})}catch(e){}`;
const DESK = { width: 1280, height: 900 }, PHONE = { width: 390, height: 844, mobile: true };

// helpers ---------------------------------------------------------------------------------------------------------
async function open(url, opts = {}) {
  const p = await b.page("about:blank", Object.assign({}, opts, { wait: 50 }));
  if (opts.setup) await opts.setup(p);
  await p.goto(url, 300);
  await until(p, "!!(window.Finspire && Finspire.glossary.loaded() && document.querySelector('#dcList .dc-row:not(.dc-skel)'))", 8000);
  await sleep(opts.settle || 300);
  return p;
}
async function until(p, expr, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (await p.js(expr)) return true; } catch (e) {} await sleep(60); }
  return false;
}
const center = (p, sel) => p.js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
  e.scrollIntoView({block:"center", behavior:"instant"}); const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
async function click(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(120);
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] });
  for (const type of ["mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: c[0], y: c[1], button: "left", clickCount: 1 });
  await sleep(220); }
async function tap(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(200);
  await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c[0], y: c[1] }] }); await sleep(50);
  await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(380); }
async function key(p, k, mods = 0) {
  const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, "/": 191, Backspace: 8 };
  for (const type of ["rawKeyDown", "keyUp"]) await p.send("Input.dispatchKeyEvent", { type, key: k, code: k === "/" ? "Slash" : k, windowsVirtualKeyCode: codes[k] || 0, modifiers: mods });
  await sleep(140);
}
async function typeQ(p, text) {                       // replace the search text, like a person typing it; the list follows ~80 ms later
  await p.js(`(()=>{const q=document.getElementById("dcQ"); q.focus(); q.select(); return true})()`);
  await p.send("Input.insertText", { text });
  await until(p, text ? `(()=>{const c=document.getElementById("dcCount").textContent, e=document.getElementById("dcEmpty"); return c.includes(${JSON.stringify(text)}) || (!e.hidden && e.textContent.includes(${JSON.stringify(text)}))})()`
                      : `!/ for /.test(document.getElementById("dcCount").textContent)`, 4000);
  await sleep(150);
}
const noOverflow = p => p.js("document.documentElement.scrollWidth <= innerWidth");
// screenshots are evidence, not checks: never let a stalled renderer (a loaded machine) hang the run
const shot = (p, name) => Promise.race([p.shot(join(OUT, name)).catch(e => console.log("shot failed:", name, e.message)), sleep(15000).then(() => console.log("shot timed out:", name))]);
const rows = p => p.js(`[...document.querySelectorAll("#dcList .dc-row")].map(r => r.dataset.id)`);
const store = (p, k) => p.js(`Finspire.store.get(${JSON.stringify(k)}, null)`);
const headings = p => p.js(`[...document.querySelectorAll("#dcEntry .dc-s-h")].map(e => e.textContent)`);
const entryOpen = p => p.js(`(()=>{const e=document.getElementById("dcEntry"); return !e.hidden && !!document.getElementById("dcTerm")})()`);
const termText = p => p.js(`(document.getElementById("dcTerm")||{}).textContent || ""`);
// a few real ids picked from the data in the page
const PICK = `(async()=>{
  const G=Finspire.glossary, rows=G.rows();
  const nt = await fetch(Finspire.url("data/live/news-terms.json")).then(r=>r.json()).catch(()=>({}));
  const withNews = Object.keys(nt).filter(id => G.get(id)).sort((a,b)=>nt[b].length-nt[a].length);
  const cats = Object.keys(G.cats());
  let formula=null, noFormula=null, withRel=null;
  for (const c of cats) { const m = await fetch(Finspire.url("data/glossary/entries/"+c+".json")).then(r=>r.json());
    for (const [id,e] of Object.entries(m)) { if(!G.get(id)) continue;
      if (!formula && e.formula && e.kid && e.example) formula=id;
      if (!noFormula && !e.formula && e.kid && e.detail && e.example && (e.related||[]).length>=2) noFormula=id;
      if (!withRel && (e.related||[]).filter(x=>G.get(x)).length>=2 && e.detail) withRel=id; }
    if (formula && noFormula && withRel) break; }
  const quiet = rows.find(r => !nt[r.id] && r.level==="b")?.id;
  return { n: rows.length, withNews: withNews[0]||null, newsN: withNews[0] ? Math.min(6, nt[withNews[0]].length) : 0,
    firstNews: withNews[0] ? nt[withNews[0]][0].t : "", quiet, formula, noFormula, withRel, tod: G.termOfDay()?.id };
})()`;

// ================================================================================================ desktop, guest
let D;
{
  const p = await open(PAGE + "?demo-user=0", Object.assign({ before: CLS }, DESK));
  await p.js("localStorage.clear(), sessionStorage.clear(), true");
  await p.goto(PAGE + "?demo-user=0", 300);
  await until(p, "!!document.querySelector('#dcList .dc-row:not(.dc-skel)')", 8000); await sleep(600);
  D = await p.js(PICK);
  // D1: the page reserves its final heights (static level + A–Z buttons, skeleton topic cards, term-of-day/list min-heights)
  const cls = await p.js("__cls");
  check("load: no layout shift beyond the web-font swap (CLS < 0.05)", cls < 0.05, cls);
  const stat = await p.js(`(async()=>{const html = await (await fetch(location.pathname)).text(); const d = new DOMParser().parseFromString(html, "text/html");
    return {segs: d.querySelectorAll("#dcLevels .dc-seg").length, letters: d.querySelectorAll("#dcAz .dc-l").length, cats: d.querySelectorAll("#dcCats .dc-cat-skel").length,
      rows: d.querySelectorAll("#dcList .dc-skel").length, lede: d.getElementById("dcLede").textContent.trim(), count: d.getElementById("dcCount").textContent,
      updating: /Updating/.test(d.body.textContent)}})()`);
  check("D1: levels, A–Z, topic and list skeletons are in the HTML before any JS runs", stat.segs === 4 && stat.letters === 28 && stat.cats === 12 && stat.rows === 8 && stat.lede.length > 20 && !stat.updating, stat);
  const live = await p.js(`({lede: document.getElementById("dcLede").textContent, skel: document.querySelectorAll(".dc-cat-skel, #dcList .dc-skel").length,
    busy: [...document.querySelectorAll("[aria-busy]")].map(e=>e.id||e.className), segs: document.querySelectorAll("#dcLevels .dc-seg").length})`);
  check("D1: skeletons are gone and nothing is left aria-busy once loaded; the lede is not rewritten", live.skel === 0 && live.busy.length === 0 && live.segs === 4 && live.lede === stat.lede && live.lede, live);
  console.log("data:", JSON.stringify(D));
  check("desktop: no console errors on load", errs(p).length === 0, errs(p));
  check("desktop: no sideways scroll", await noOverflow(p));
  const first = await p.js(`({rows: document.querySelectorAll("#dcList .dc-row").length, count: document.getElementById("dcCount").textContent,
    live: document.getElementById("dcCount").getAttribute("aria-live"), lede: document.getElementById("dcLede").textContent,
    h1: document.querySelectorAll("h1").length, tod: document.querySelector("#dcTodBody").dataset.id, todTerm: document.querySelector(".dc-tod-term").textContent,
    cats: document.querySelectorAll(".dc-cat").length, catN: Object.keys(Finspire.glossary.cats()).length})`);
  // (under heavy CPU load the end-of-list sentinel can be in view for a moment before fonts settle, adding one chunk)
  check("list: renders in chunks of 60, not the whole dictionary", first.rows === Math.min(60, D.n) || first.rows === Math.min(120, D.n), first.rows);
  check("list: count shows every term, in an aria-live region", first.count.startsWith(D.n.toLocaleString("en-IN") + " term") && first.live === "polite", first.count);
  check("page: one h1; lede is static plain copy (the count lives in the list header)", first.h1 === 1 && first.lede.length > 40 && !/\d/.test(first.lede), first.lede);
  check("term of the day = Finspire.glossary.termOfDay()", first.tod === D.tod && first.todTerm.length > 1, first);
  check("topics: one card per category plus All", first.cats === first.catN + 1, first);
  await shot(p, "desktop-home.png");

  // ---- chunked list: scrolling to the end loads the next chunk
  await p.js(`document.getElementById("dcSentinel").scrollIntoView({block:"end"}), true`);
  await until(p, `document.querySelectorAll("#dcList .dc-row").length > 60`, 6000);
  check("list: next chunk appends on scroll", (await p.js(`document.querySelectorAll("#dcList .dc-row").length`)) === Math.min(120, D.n));
  await p.js("scrollTo(0,0), true");

  // ---- search ranking
  const probe = await p.js(`(()=>{const rows=Finspire.glossary.rows();
    const t = rows.find(r => r.term.length >= 10 && /^[A-Za-z ]+$/.test(r.term) && r.term.split(" ").length === 2 && !rows.some(x => x!==r && x.term.toLowerCase().startsWith(r.term.toLowerCase())));
    return {id:t.id, term:t.term}})()`);
  await p.js(`document.activeElement.blur(), document.body.focus(), true`);
  await key(p, "/");
  check("keyboard: '/' focuses the search box", await p.js(`document.activeElement.id === "dcQ"`));
  await typeQ(p, probe.term.toLowerCase());
  let r = await rows(p);
  check("search: exact name ranks first", r[0] === probe.id, { probe, top: r.slice(0, 3) });
  const pre = probe.term.slice(0, 4).toLowerCase();
  await typeQ(p, pre);
  const preTerms = await p.js(`[...document.querySelectorAll("#dcList .dc-row-term")].slice(0,3).map(e=>e.textContent)`);
  check("search: prefix matches come first", preTerms.length > 0 && preTerms[0].toLowerCase().startsWith(pre), { pre, preTerms });
  const w = probe.term.toLowerCase(), typo = w.slice(0, 3) + w[4] + w[3] + w.slice(5);
  await typeQ(p, typo);
  r = await rows(p);
  check("search: tolerates a typo (swapped letters)", r.slice(0, 3).includes(probe.id), { typo, top: r.slice(0, 3) });
  const cnt = await p.js(`document.getElementById("dcCount").textContent`);
  check("search: result count announced", /result/.test(cnt) && cnt.includes(typo), cnt);
  check("search: combobox points at the first result", await p.js(`document.getElementById("dcQ").getAttribute("aria-activedescendant") === "dco-0"`));
  const sem = await p.js(`(()=>{const o=document.querySelector("#dcList .dc-row"); return {set: o.getAttribute("aria-setsize"), pos: o.getAttribute("aria-posinset"), n: document.querySelectorAll("#dcList .dc-row").length,
    marker: getComputedStyle(document.querySelector("#dcList .dc-row.dc-act")).boxShadow !== "none", rows: Finspire.glossary.search(${JSON.stringify(typo)}, {limit: 400}).length}})()`);
  check("D7: options carry aria-setsize/aria-posinset for the whole result set", sem.set === String(sem.rows) && sem.pos === "1", sem);
  check("D7: the active row shows its left marker while the combobox is expanded", sem.marker, sem);

  // ---- keyboard: ↓ ↓ ↑ Enter opens the highlighted result and records "search"
  await typeQ(p, pre);
  const want = (await rows(p))[1];
  await key(p, "ArrowDown"); await key(p, "ArrowDown"); await key(p, "ArrowUp");
  const act = await p.js(`({ad: document.getElementById("dcQ").getAttribute("aria-activedescendant"), sel: document.querySelector('#dcList [aria-selected="true"]')?.dataset.id})`);
  check("keyboard: arrows move the highlighted result", act.ad === "dco-1" && act.sel === want, act);
  await key(p, "Enter");
  await until(p, `!document.getElementById("dcEntry").hidden`);
  await sleep(500);
  check("keyboard: Enter opens the highlighted entry (#t= deep link)", (await p.js("location.hash")) === "#t=" + want && (await termText(p)) === (await p.js(`Finspire.glossary.get(${JSON.stringify(want)}).term`)));
  check("focus: moves to the entry heading", await p.js(`document.activeElement.id === "dcTerm"`));
  let hst = await store(p, "dict.history");
  check("history: opened from search is recorded via 'search'", hst && hst[0].id === want && hst[0].via === "search", hst && hst[0]);

  // ---- empty state with close matches
  await typeQ(p, "balance sheetqqqq");
  const emp = await p.js(`({hidden: document.getElementById("dcEmpty").hidden, list: document.getElementById("dcList").hidden, txt: document.getElementById("dcEmpty").textContent,
    sug: [...document.querySelectorAll("#dcEmpty .dc-sug .chip")].map(c=>c.textContent), count: document.getElementById("dcCount").textContent})`);
  check("search: empty state replaces the list; the count line stays empty (one message, not two)", !emp.hidden && emp.list && emp.count === "" && /No terms match/.test(emp.txt), emp);
  check("search: empty state suggests close matches", emp.sug.length > 0 && emp.sug.some(s => /balance|sheet/i.test(s)), emp.sug);
  await shot(p, "desktop-empty.png");
  await click(p, "#dcEmpty .dc-empty-acts .btn:last-child");
  check("search: Clear search restores the full list", (await p.js(`!document.getElementById("dcList").hidden && document.getElementById("dcQ").value === ""`)) &&
    (await p.js(`document.getElementById("dcCount").textContent`)).startsWith(D.n.toLocaleString("en-IN")));
  check("D7: collapsed combobox has no aria-activedescendant", await p.js(`document.getElementById("dcQ").getAttribute("aria-expanded") === "false" && !document.getElementById("dcQ").hasAttribute("aria-activedescendant")`));
  await key(p, "Escape");
  await click(p, "#dcEntry .dc-close");
  await until(p, `document.getElementById("dcEntry").hidden`);

  // ---- category, level, A–Z filters
  const cat = await p.js(`document.querySelectorAll(".dc-cat")[2].dataset.cat`);
  await click(p, `.dc-cat[data-cat="${cat}"]`); await sleep(800);
  let f = await p.js(`(()=>{const G=Finspire.glossary, ids=[...document.querySelectorAll("#dcList .dc-row")].map(r=>r.dataset.id);
    return {n: ids.length, allCat: ids.every(id => G.get(id).cat === ${JSON.stringify(cat)}), want: G.cats()[${JSON.stringify(cat)}].n,
      count: document.getElementById("dcCount").textContent, title: document.getElementById("dcListTitle").textContent, name: G.cats()[${JSON.stringify(cat)}].name,
      pressed: document.querySelector('.dc-cat[aria-pressed="true"]').dataset.cat}})()`);
  check("filter: topic card limits the list to that category", f.allCat && f.count.startsWith(String(f.want)) && f.title === f.name && f.pressed === cat, f);
  await click(p, `.dc-seg[data-level="b"]`);
  f = await p.js(`(()=>{const G=Finspire.glossary, ids=[...document.querySelectorAll("#dcList .dc-row")].map(r=>r.dataset.id);
    return {ok: ids.every(id => G.get(id).level === "b" && G.get(id).cat === ${JSON.stringify(cat)}), want: G.rows().filter(r=>r.cat===${JSON.stringify(cat)} && r.level==="b").length,
      count: document.getElementById("dcCount").textContent}})()`);
  check("filter: level combines with topic", f.ok && f.count.startsWith(String(f.want)) && /Beginner/.test(f.count), f);
  await click(p, `.dc-seg[data-level=""]`);
  await click(p, `.dc-cat[data-cat=""]`); await sleep(800);           // let the smooth scroll to the list finish
  const L = await p.js(`[...document.querySelectorAll(".dc-az .dc-l:not(:disabled)")].map(b=>b.dataset.l).filter(l=>l && l!=="#")[1]`);
  await click(p, `.dc-l[data-l="${L}"]`);
  f = await p.js(`(()=>{const terms=[...document.querySelectorAll("#dcList .dc-row-term")].map(e=>e.textContent);
    const want=Finspire.glossary.rows().filter(r=>r.term.replace(/[^A-Za-z0-9]/g,"").toUpperCase().startsWith(${JSON.stringify(L)})).length;
    return {n: terms.length, ok: terms.every(t=>t.replace(/[^A-Za-z0-9]/g,"").toUpperCase().startsWith(${JSON.stringify(L)})), want,
      count: document.getElementById("dcCount").textContent, dis: document.querySelectorAll(".dc-az .dc-l:disabled").length}})()`);
  check("filter: A–Z letter shows that letter only", f.ok && f.count.startsWith(String(f.want)) && f.count.includes("starting with " + L), f);
  await click(p, `.dc-l[data-l=""]`);
  await shot(p, "desktop-list.png");

  // ---- deep link: sections in order, annotate, formula
  for (const [id, label] of [[D.noFormula, "without formula"], [D.formula, "with formula"]]) {
    if (!id) { check("entry: sample " + label + " exists in data", false); continue; }
    await p.goto(PAGE + "?demo-user=0#t=" + id, 300);
    await until(p, `!!document.querySelector("#dcEntry .dc-s-news")`, 6000); await sleep(500);
    const e = await p.js(`Finspire.glossary.entry(${JSON.stringify(id)})`);
    const want = ["Plain meaning", e.kid && "Like I’m three", e.detail && "In detail", e.example && "Example", e.formula && "Formula", e.related.length && "Related terms", "In the news"].filter(Boolean);
    const got = await headings(p);
    check("deep link #t= opens the entry " + label, (await entryOpen(p)) && (await termText(p)) === e.term, id);
    check("entry: sections in order " + label, JSON.stringify(got) === JSON.stringify(want), { got, want });
    const ent = await p.js(`({formula: document.querySelector(".dc-formula")?.textContent || null, kid: !!document.querySelector(".dc-kid .dc-kid-ic svg"),
      nums: document.querySelectorAll(".dc-example .dc-n").length, gl: [...document.querySelectorAll(".dc-prose .gl-term, .dc-example .gl-term")].map(s=>s.dataset.term),
      lvl: document.querySelector(".dc-emeta .gl-lvl")?.textContent, star: !!document.querySelector(".dc-save"), quiz: !!document.querySelector(".dc-quizme"),
      link: !!document.querySelector('[aria-label="Copy link to this entry"]'), cat: document.querySelector(".dc-ebar-cat").textContent})`);
    check("entry: header has category, level, Save, Quiz me, copy link " + label, ent.lvl && ent.star && ent.quiz && ent.link && ent.cat.length > 0, ent);
    check("entry: 'Like I'm three' card with icon " + label, ent.kid);
    check("entry: formula block only when present " + label, e.formula ? ent.formula === e.formula : ent.formula === null, ent.formula);
    check("entry: other terms annotated in the text, never the term itself " + label, ent.gl.length > 0 && !ent.gl.includes(id), ent.gl.slice(0, 6));
    if (/\d/.test(e.example)) check("entry: example figures styled as numbers " + label, ent.nums > 0, ent.nums);
  }
  await shot(p, "desktop-entry.png");
  const foot = await p.js(`(()=>{const a=document.querySelector(".dc-efoot a"); return a && {href:a.href, t:a.target, rel:a.rel, txt:a.textContent, news: Math.round(document.querySelector(".dc-news").getBoundingClientRect().height)}})()`);
  check("D12: entry footer links to Finspire on LinkedIn (new tab, noopener)", foot && /linkedin\.com\/company\/finspire/.test(foot.href) && foot.t === "_blank" && /noopener/.test(foot.rel) && /LinkedIn/.test(foot.txt), foot);
  check("D10: 'In the news' block reserves its height", foot && foot.news >= 120, foot && foot.news);
  await p.js(`document.getElementById("dcSide").scrollTop = 99999, true`); await sleep(200);
  await shot(p, "desktop-entry-bottom.png");

  // ---- related chip navigation + back/forward
  const startId = D.withRel || D.noFormula;
  await p.goto(PAGE + "?demo-user=0", 300); await until(p, `!!document.querySelector("#dcList .dc-row:not(.dc-skel)")`, 6000);
  await p.js(`location.hash = "t=${startId}", true`);
  await until(p, `!!document.querySelector("#dcEntry .dc-relchip")`, 6000);
  const rel = await p.js(`document.querySelector("#dcEntry .dc-relchip").dataset.id`);
  await click(p, "#dcEntry .dc-relchip");
  await until(p, `location.hash === "#t=${rel}"`);
  await sleep(300);
  check("related: chip opens that entry", (await termText(p)) === (await p.js(`Finspire.glossary.get(${JSON.stringify(rel)}).term`)), rel);
  await p.js("history.back(), true"); await until(p, `location.hash === "#t=${startId}"`); await sleep(400);
  check("history: Back returns to the previous entry", (await termText(p)) === (await p.js(`Finspire.glossary.get(${JSON.stringify(startId)}).term`)));
  await p.js("history.forward(), true"); await until(p, `location.hash === "#t=${rel}"`); await sleep(400);
  check("history: Forward goes to the related entry again", (await termText(p)) === (await p.js(`Finspire.glossary.get(${JSON.stringify(rel)}).term`)));
  await click(p, "#dcEntry .dc-close");
  await until(p, `document.getElementById("dcEntry").hidden`);
  check("close: X closes the entry, clears #t and shows the desk again", await p.js(`location.hash === "" && getComputedStyle(document.getElementById("dcDesk")).display !== "none"`));

  // ---- in the news (real news-terms.json)
  if (D.withNews) {
    await p.send("Network.enable"); const reqs = []; p.on(m => { if (m.method === "Network.requestWillBeSent") reqs.push(m.params.request.url); });
    await p.js(`location.hash = "t=${D.withNews}", true`);
    await until(p, `document.querySelectorAll(".dc-news-list li").length > 0`, 6000);
    const nw = await p.js(`[...document.querySelectorAll(".dc-news-list a")].map(a=>({href:a.href, t:a.target, rel:a.rel, title:a.querySelector(".dc-news-t").textContent, meta:a.querySelector(".dc-news-m").textContent}))`);
    check("news: up to 6 real headlines for the term", nw.length === D.newsN && nw[0].title === D.firstNews, { n: nw.length, want: D.newsN });
    check("news: links open outside, safely", nw.every(a => /^https?:/.test(a.href) && a.t === "_blank" && a.rel === "noopener noreferrer"), nw[0]);
    check("news: source and date shown", nw.every(a => a.meta.includes("·") || a.meta.length > 2), nw[0] && nw[0].meta);
    await shot(p, "desktop-entry-news.png");
    const cat = await p.js(`Finspire.glossary.get(${JSON.stringify(D.withNews)}).cat`);
    const shard = reqs.filter(u => u.includes("/data/live/news-terms/" + cat + ".json")).length, whole = reqs.filter(u => /\/data\/live\/news-terms\.json/.test(u)).length;
    check("D10: news comes from the per-topic shard, asked for once; the whole map only as a fallback", shard <= 1 && whole <= 1, { shard, whole, cat });
  } else check("news: news-terms.json has at least one dictionary term", false);
  if (D.quiet) {
    await p.js(`location.hash = "t=${D.quiet}", true`);
    await until(p, `!!document.querySelector(".dc-news-none")`, 6000);
    check("news: says so plainly when a term was not in the news", (await p.js(`document.querySelector(".dc-news-none").textContent`)) === "Not in the news this month.");
  }

  // ---- copy link + guest Save/Quiz invite sign-in
  await click(p, '[aria-label="Copy link to this entry"]');
  await until(p, `!!document.querySelector(".fs-toast")`, 2000);
  check("copy link: confirms with a toast", /Link copied|address bar/.test(await p.js(`document.querySelector(".fs-toast").textContent`)));
  // no Google client id in this build: the visitor is a local guest, so personal features work in this browser
  await click(p, ".dc-save"); await sleep(400);
  const gs = await p.js(`({modal: !!document.querySelector(".fs-modal"), saved: Finspire.store.get("dict.saved", []), guest: !!(Finspire.auth.user()||{}).guest,
    url: location.href, ss: JSON.stringify(sessionStorage), feat: Finspire.feature("signin"), demo: Finspire.auth.isDemo(), cid: Finspire.cfg.googleClientId})`);
  check("local guest: Save keeps the word in this browser (no sign-in prompt)", !gs.modal && gs.guest && gs.saved.length === 1, gs);
  await click(p, ".dc-save"); await sleep(300);
  const me = await p.js(`(()=>{const m=document.getElementById("me"); return {txt: m.textContent, inDesk: !!m.closest("#dcDesk"), signin: !!m.querySelector(".dc-me-in")}})()`);
  check("local guest: personal panel works without sign-in (no Sign in button)", me.txt.includes("Your dictionary") && me.txt.includes("Recent lookups") && !me.signin && !/Sign in/.test(me.txt), me);
  check("local guest: personal panel sits in the side panel on desktop", me.inDesk);
  await key(p, "Escape"); await sleep(250);
  check("Escape closes the entry", await p.js(`document.getElementById("dcEntry").hidden`));
  check("desktop guest: zero console errors", errs(p).length === 0, errs(p));
  check("desktop guest: no sideways scroll", await noOverflow(p));
  p.close();
}

// ================================================================================================ desktop, signed out (sign-in usable: demo)
{
  const p = await open(PAGE + "?demo-user=1", DESK);
  await p.js("localStorage.clear(), true"); await p.goto(PAGE + "?demo-user=1#t=" + D.tod, 300);
  await p.js("Finspire.auth.signOut().then(()=>true)"); await sleep(400);
  await until(p, `!!document.querySelector("#dcEntry:not([hidden]) .dc-save")`, 6000);
  await click(p, ".dc-save");
  await until(p, `!!document.querySelector(".fs-modal.fs-show")`, 2000);
  const so = await p.js(`({title: (document.querySelector(".fs-modal-title")||{}).textContent, g: !!document.querySelector(".fs-modal .fs-gbtn"), saved: Finspire.store.get("dict.saved", []).length})`);
  check("signed out: Save offers IIM Ranchi sign-in instead of saving", so.title === "Sign in to Finspire" && so.g && so.saved === 0, so);
  await key(p, "Escape"); await sleep(300);
  const me = await p.js(`(()=>{const m=document.getElementById("me"); return {txt: m.textContent, btn: !!m.querySelector(".dc-me-in")}})()`);
  check("signed out: personal panel invites sign-in", me.btn && me.txt.includes("Sign in with your IIM Ranchi account to keep your history, save words and revise"), me);
  check("signed out: zero console errors", errs(p).length === 0, errs(p));
  await p.js("sessionStorage.clear(), true");
  p.close();
}

// ================================================================================================ desktop, signed in (demo)
{
  const p = await open(PAGE + "?demo-user=1", DESK);
  await p.js("localStorage.clear(), true"); await p.goto(PAGE + "?demo-user=1", 300);
  await until(p, `!!document.querySelector("#dcList .dc-row:not(.dc-skel)") && !!document.querySelector(".dc-rev-go")`, 8000); await sleep(300);
  check("demo: signed in, personal desk with Revise", await p.js(`!!Finspire.auth.user() && !!document.querySelector("#me .dc-rev-go")`));
  const quiet = await p.js(`(()=>{const b=document.querySelector("#me .dc-rev-go"); return {ghost: b.classList.contains("btn-ghost") && !b.classList.contains("btn-primary"), txt: b.textContent,
    rec: document.querySelector("#me .dc-recent .dc-me-empty").textContent, rev: document.querySelector("#me .dc-rev-txt").textContent}})()`);
  check("D6: with nothing saved the Revise button is a quiet ghost 'Try a quick quiz'", quiet.ghost && quiet.txt === "Try a quick quiz", quiet);
  check("D16: empty-state copy is short and plain", quiet.rec === "Terms you open here or on the Markets page will appear here." && quiet.rev === "Save or look up a few words, then test yourself.", quiet);
  // browse open → history via browse
  const ids = await rows(p);
  await click(p, `#dcList .dc-row[data-id="${ids[2]}"]`);
  await until(p, `location.hash === "#t=${ids[2]}"`); await sleep(400);
  let hst = await store(p, "dict.history");
  check("history: list click recorded via 'browse'", hst && hst[0].id === ids[2] && hst[0].via === "browse", hst);
  await click(p, "#dcEntry .dc-close"); await until(p, `document.getElementById("dcEntry").hidden`);
  await click(p, `#dcList .dc-row[data-id="${ids[2]}"]`); await sleep(400);
  await click(p, "#dcEntry .dc-close"); await sleep(300);
  hst = await store(p, "dict.history");
  check("history: consecutive repeat not duplicated", hst.length === 1 && hst[0].id === ids[2], hst.length);
  // a tooltip lookup on the news page arrives as via "news"
  await p.js(`Finspire.store.addHistory(${JSON.stringify(ids[5])}, "news"), true`); await sleep(200);
  const recent = await p.js(`[...document.querySelectorAll("#me .dc-recent .dc-me-row")].map(r=>({id:r.dataset.id, via:(r.querySelector(".dc-via")||{}).textContent||""}))`);
  check("recent lookups: listed newest first with 'via news'", recent[0] && recent[0].id === ids[5] && recent[0].via === "via news" && recent[1].id === ids[2], recent);
  // save two words
  for (const id of [ids[2], ids[7]]) {
    await click(p, `#dcList .dc-row[data-id="${id}"]`); await until(p, `!!document.querySelector(".dc-save")`); await sleep(300);
    await click(p, ".dc-save");
    check("save: star toggles on for " + id, await p.js(`document.querySelector(".dc-save").getAttribute("aria-pressed") === "true" && Finspire.store.isSaved(${JSON.stringify(id)})`));
    await click(p, "#dcEntry .dc-close"); await sleep(250);
  }
  const sv = await p.js(`({chips:[...document.querySelectorAll("#me .dc-saved .dc-savechip")].map(c=>c.dataset.id), btn: document.querySelector("#me .dc-rev-go").textContent})`);
  check("saved words: listed in the panel", sv.chips.length === 2 && sv.chips.includes(ids[2]) && sv.chips.includes(ids[7]), sv);
  check("Revise button shows 'N words due' (new saved words) and turns primary", /2 words due/.test(sv.btn) && await p.js(`document.querySelector("#me .dc-rev-go").classList.contains("btn-primary")`), sv.btn);
  check("desk: cards fit the side panel (no overflow)", await p.js(`[...document.querySelectorAll("#me .dc-card")].every(c => c.scrollWidth <= c.clientWidth + 1)`));
  await shot(p, "desktop-signed-in.png");

  // ---- quiz: 10 questions, feedback, srs update
  await click(p, "#me .dc-rev-go");
  await until(p, `!!document.querySelector(".dc-qz-modal .dc-opt")`, 6000);
  check("quiz: opens in the shell modal (dialog, focus inside)", await p.js(`(()=>{const c=document.querySelector(".dc-qz-modal .fs-modal-card"); return c.getAttribute("role")==="dialog" && c.contains(document.activeElement)})()`));
  check("D8: focus lands on the question, not option A", await p.js(`document.activeElement.classList.contains("dc-qz-prompt")`), await p.js(`document.activeElement.className`));
  check("D8: progress reads 'Question 1 of 10, 0 right'", await p.js(`document.querySelector(".dc-qz-prog").textContent`) === "Question 1 of 10, 0 right", await p.js(`document.querySelector(".dc-qz-prog").textContent`));
  await shot(p, "desktop-quiz.png");
  const qa = [], types = new Set();
  for (let i = 0; i < 10; i++) {
    const ok = await until(p, `!!document.querySelector(".dc-qz-modal .dc-opt:not(:disabled)")`, 3000);
    if (!ok) break;
    const q = await p.js(`({prog: document.querySelector(".dc-qz-prog span").textContent, label: document.querySelector(".dc-qz-label").textContent,
      opts: [...document.querySelectorAll(".dc-qz-modal .dc-opt")].map(b=>b.dataset.id), cats: [...document.querySelectorAll(".dc-qz-modal .dc-opt")].map(b=>Finspire.glossary.get(b.dataset.id).cat)})`);
    types.add(q.label);
    const pickN = i % 3 === 0 ? 2 : 1;                       // answer by keyboard (1–4), wrong-ish on purpose sometimes
    await key(p, String(pickN));
    const res = await p.js(`({right: document.querySelector(".dc-opt.ok").dataset.id, chosen: document.querySelectorAll(".dc-qz-modal .dc-opt")[${pickN - 1}].dataset.id,
      fb: document.querySelector(".dc-qz-res").textContent, read: !!document.querySelector(".dc-qz-read"), next: document.activeElement.classList.contains("dc-qz-next")})`);
    const fair = await p.js(`(async()=>{const G=Finspire.glossary, e=await G.entry(${JSON.stringify(res.right)}); const w=s=>new Set(String(s).toLowerCase().replace(/\\([^)]*\\)/g," ").split(/[^a-z0-9]+/).filter(x=>x.length>=3));
      const aw=w([e.term].concat(e.aliases||[]).join(" ")); return ${JSON.stringify(q.opts)}.filter(id=>id!==e.id).every(id=>!(e.related||[]).includes(id) && ![...w(G.get(id).term)].some(x=>aw.has(x)))})()`);
    qa.push({ id: res.right, ok: res.right === res.chosen, prog: q.prog, opts: q.opts.length, sameCat: q.cats.filter(c => c === q.cats[q.opts.indexOf(res.right)]).length, fair });
    if (i === 0) {
      check("quiz: 4 options, instant feedback with the answer and a link to the entry", q.opts.length === 4 && res.read && (res.right === res.chosen ? res.fb === "Correct." : (res.fb.includes("The answer is") || res.fb.includes("The right meaning is marked"))), res);
      check("quiz: focus moves to Next after answering", res.next);
      await shot(p, "desktop-quiz-feedback.png");
    }
    await click(p, ".dc-qz-next");
  }
  check("quiz: 10 questions", qa.length === 10 && qa[9].prog === "Question 10 of 10", qa.length);
  check("quiz: question types mixed", types.size >= 2, [...types]);
  check("quiz: distractors mostly from the same category", qa.filter(x => x.sameCat >= 2).length >= 6, qa.map(x => x.sameCat));
  check("D8: no distractor is a related term or shares a word with the answer", qa.every(x => x.fair), qa.map(x => x.fair));
  check("quiz: draws saved and recent words first", [ids[2], ids[5], ids[7]].every(id => qa.some(x => x.id === id)), qa.map(x => x.id));
  await until(p, `!!document.querySelector(".dc-qz-end")`, 2000);
  const right = qa.filter(x => x.ok).length;
  const end = await p.js(`({big: document.querySelector(".dc-qz-big").textContent.replace(/\\s/g,""), review: [...document.querySelectorAll(".dc-qz-review .chip")].length,
    again: !!document.querySelector(".dc-qz-endacts .btn-primary")})`);
  check("quiz end: score, words to review, Revise again", end.big === right + "/10" && end.review === 10 - right && end.again, { end, right });
  await shot(p, "desktop-quiz-end.png");
  const srs = await store(p, "dict.srs"), now = Date.now();
  const srsOk = qa.every(x => { const r = srs[x.id]; if (!r || r.seen !== 1) return false;
    const days = (r.due - now) / 864e5; return x.ok ? (r.box === 2 && days > 1.9 && days < 2.1) : (r.box === 1 && days > 0.9 && days < 1.1); });
  check("srs: right → box 2 (due in 2 days), wrong → box 1 (due tomorrow)", srsOk, Object.fromEntries(qa.slice(0, 3).map(x => [x.id, srs[x.id]])));
  await click(p, ".dc-qz-endacts .btn-primary");
  check("quiz: Revise again starts a new round", await until(p, `document.querySelector(".dc-qz-prog span")?.textContent === "Question 1 of 10"`, 4000));
  await key(p, "Escape"); await sleep(400);
  const after = await p.js(`document.querySelector("#me .dc-rev-go").textContent`);
  check("Revise button updates after the round (nothing due)", /Revise now/.test(after), after);

  // ---- Leitner: a due word in box 4 answered right → 5; wrong → back to 1. "Quiz me on this" asks about that word first.
  const [a, c] = [ids[10], ids[11]];
  await p.js(`Finspire.store.update("dict.srs", m => Object.assign({}, m, {${JSON.stringify(a)}: {box:4, due: Date.now()-1000, seen:3, right:3}, ${JSON.stringify(c)}: {box:4, due: Date.now()-1000, seen:3, right:3}}), {}), true`);
  for (const [id, good] of [[a, true], [c, false]]) {
    await p.js(`location.hash = "t=${id}", true`); await until(p, `!!document.querySelector(".dc-quizme")`); await sleep(200);
    await click(p, ".dc-quizme");
    await until(p, `!!document.querySelector(".dc-qz-modal .dc-opt:not(:disabled)")`, 5000);
    const opts = await p.js(`[...document.querySelectorAll(".dc-qz-modal .dc-opt")].map(b=>b.dataset.id)`);
    const k = good ? opts.indexOf(id) : opts.findIndex(x => x !== id);
    await click(p, `.dc-qz-modal .dc-opt:nth-child(${k + 1})`);
    const r2 = (await store(p, "dict.srs"))[id];
    check(`Quiz me on this: first question is that word, ${good ? "right → box 5 (16 days)" : "wrong → back to box 1"}`, opts.includes(id) &&
      (good ? r2.box === 5 && Math.round((r2.due - Date.now()) / 864e5) === 16 : r2.box === 1 && Math.round((r2.due - Date.now()) / 864e5) === 1) && r2.seen === 4, r2);
    await key(p, "Escape"); await sleep(350);
  }
  // account menu "My dictionary" → #me: closes an open entry and focuses the personal panel
  await p.js(`location.hash = "t=${ids[3]}", true`); await until(p, `!document.getElementById("dcEntry").hidden`); await sleep(200);
  await p.js(`location.hash = "me", true`); await sleep(700);
  check("#me: closes the entry and focuses the personal panel", await p.js(`document.getElementById("dcEntry").hidden && document.activeElement.id === "me" && getComputedStyle(document.getElementById("dcDesk")).display !== "none"`));
  // sign-out: personal panel goes back to the invitation; data stays with the account
  await p.js(`Finspire.auth.signOut(), true`); await sleep(400);
  check("sign out: panel shows the invitation again", await p.js(`document.querySelector("#me").classList.contains("dc-me-out")`));
  check("signed in: zero console errors", errs(p).length === 0, errs(p));
  p.close();
}

// ================================================================================================ phone
{
  const p = await open(PAGE + "?demo-user=0", PHONE);
  await p.js("localStorage.clear(), true"); await p.goto(PAGE + "?demo-user=0", 300);
  await until(p, `!!document.querySelector("#dcList .dc-row:not(.dc-skel)")`, 8000); await sleep(400);
  check("phone: no console errors", errs(p).length === 0, errs(p));
  check("phone: no sideways scroll", await noOverflow(p));
  await shot(p, "phone-home.png");
  const lay = await p.js(`(()=>{const q=document.getElementById("dcQ"), cats=document.getElementById("dcCats"), az=document.getElementById("dcAz");
    const small=[...document.querySelectorAll(".dc-cat, .dc-seg, .dc-l, .dc-q-x:not([hidden]), .dc-me-in, .dc-tod-go")].filter(e=>e.offsetParent).map(e=>{const r=e.getBoundingClientRect(); return [e.className, Math.round(r.height)]}).filter(x=>x[1]<40);
    const wr=document.querySelector(".dc-top").getBoundingClientRect(), qr=q.getBoundingClientRect();
    return {font: parseFloat(getComputedStyle(q).fontSize), catsScroll: cats.scrollWidth > cats.clientWidth && getComputedStyle(cats).flexWrap === "nowrap",
      catsH: Math.round(cats.getBoundingClientRect().height), azScroll: az.scrollWidth > az.clientWidth, small, gutter: Math.round(qr.left), right: Math.round(innerWidth - qr.right),
      meBefore: !!(document.getElementById("me").compareDocumentPosition(cats) & 4)}})()`);
  check("phone: search input ≥ 16px (no iOS zoom)", lay.font >= 16, lay.font);
  check("phone: 16px gutters", lay.gutter === 16 && lay.right === 16, lay);
  check("phone: topics are one sideways-scrolling chip row", lay.catsScroll && lay.catsH <= 48, lay);
  check("phone: A–Z scrolls sideways", lay.azScroll);
  check("phone: tap targets ≥ 40px", lay.small.length === 0, lay.small);
  check("phone: personal panel sits above the topics", lay.meBefore);
  // D5: the level segment and A–Z row stay reachable while scrolling the long list
  await p.js(`scrollTo({top: document.getElementById("dcWork").offsetTop + 2000, behavior: "instant"}), true`); await sleep(250);
  const stick = await p.js(`(()=>{const t=document.querySelector(".dc-tools").getBoundingClientRect(), hdr=document.querySelector(".hdr").getBoundingClientRect();
    return {pos: getComputedStyle(document.querySelector(".dc-tools")).position, top: Math.round(t.top), hdr: Math.round(hdr.bottom), h: Math.round(t.height), countIn: !!document.querySelector(".dc-tools #dcCount"),
      cls: [...document.elementsFromPoint(200, t.top + t.height/2)].some(e => e.classList.contains("dc-tools"))}})()`);
  check("D5: tools stick under the header while scrolling (≈ 140px block, count outside it)", stick.pos === "sticky" && Math.abs(stick.top - stick.hdr) <= 1 && stick.h <= 145 && !stick.countIn && stick.cls, stick);
  await p.js(`scrollTo({top: 0, behavior: "instant"}), true`); await sleep(200);

  // search on phone: focusing the box collapses the head and brings the box to the top (D2)
  await p.send("Emulation.setFocusEmulationEnabled", { enabled: true });          // headless: focus events need an active window
  await p.js(`document.getElementById("dcQ").focus(), true`); await sleep(700);
  const fo = await p.js(`({y: Math.round(scrollY), q: Math.round(document.getElementById("dcQ").getBoundingClientRect().top), lede: getComputedStyle(document.getElementById("dcLede")).display, h1: parseFloat(getComputedStyle(document.querySelector(".h1")).fontSize)})`);
  check("D2: focus brings the search box up under the header and hides the eyebrow/lede", fo.q < 140 && fo.lede === "none" && fo.h1 <= 24, fo);
  await typeQ(p, "margin");
  const sr = await p.js(`({top: Math.round(document.querySelector("#dcList .dc-row").getBoundingClientRect().top), tod: getComputedStyle(document.getElementById("dcTod")).display, q: Math.round(document.getElementById("dcQ").getBoundingClientRect().top)})`);
  check("phone: while searching, results sit right under the search box (first result within the keyboard-free area)", sr.tod === "none" && sr.top < 400, sr);
  await shot(p, "phone-search.png");
  await p.js(`scrollTo({top: 700, behavior: "instant"}), true`); await sleep(250);
  const stq = await p.js(`({q: Math.round(document.getElementById("dcQ").getBoundingClientRect().top), pos: getComputedStyle(document.querySelector(".dc-top")).position})`);
  check("D2: the search box stays pinned while scrolling results", stq.pos === "sticky" && stq.q < 160 && stq.q > 60, stq);
  await p.js(`scrollTo({top: 0, behavior: "instant"}), true`);
  await p.js(`(()=>{const q=document.getElementById("dcQ"); q.value=""; q.dispatchEvent(new Event("input")); q.blur(); return true})()`); await sleep(200);

  // entry as full-screen sheet with Back
  await p.js(`scrollTo({top: document.getElementById("dcWork").offsetTop, behavior: "instant"}), true`); await sleep(200);
  const id = (await rows(p))[3];
  await center(p, `#dcList .dc-row[data-id="${id}"]`); await sleep(150);
  const y0 = await p.js("Math.round(scrollY)");
  await tap(p, `#dcList .dc-row[data-id="${id}"]`);
  await until(p, `document.documentElement.classList.contains("dc-sheet")`, 3000); await sleep(600);
  const sh = await p.js(`(()=>{const s=document.getElementById("dcSide"), r=s.getBoundingClientRect(); return {rect:[r.left,r.top,r.width,r.height].map(Math.round), pos:getComputedStyle(s).position,
    role:s.getAttribute("role"), modal:s.getAttribute("aria-modal"), focus:document.activeElement.id, back:!!document.querySelector(".dc-back").offsetParent, hash:location.hash,
    over: s.scrollWidth <= s.clientWidth}})()`);
  check("phone: entry opens as a full-screen sheet", sh.pos === "fixed" && sh.rect[0] === 0 && sh.rect[1] === 0 && sh.rect[2] === 390 && sh.rect[3] === 844 && sh.role === "dialog" && sh.modal === "true", sh);
  check("phone: sheet has Back, focus on the heading, #t= in the URL", sh.back && sh.focus === "dcTerm" && sh.hash === "#t=" + id, sh);
  const bar = await p.js(`[...document.querySelectorAll(".dc-ebar button")].filter(b=>b.offsetParent).map(b=>[b.className.split(" ")[0], Math.round(b.getBoundingClientRect().height)])`);
  check("D15: the sheet bar has Back, Save and link only (no duplicate ×), all 44px tall", bar.length === 3 && !bar.some(b => b[0] === "dc-close") && bar.every(b => b[1] >= 44), bar);
  check("phone: no sideways scroll inside the sheet", sh.over && await noOverflow(p));
  await shot(p, "phone-entry.png");
  await p.js(`document.getElementById("dcSide").scrollTop = 99999, true`); await sleep(200);
  await shot(p, "phone-entry-bottom.png");
  await tap(p, ".dc-back");
  await until(p, `!document.documentElement.classList.contains("dc-sheet")`, 3000); await sleep(300);
  const back = await p.js(`({hash: location.hash, y: Math.round(scrollY), hidden: document.getElementById("dcEntry").hidden, focus: document.activeElement.id})`);
  check("phone: Back closes the sheet and keeps the list position", back.hash === "" && back.hidden && Math.abs(back.y - y0) < 4, { back, y0 });
  check("D3: closing an entry never focuses the search box on a phone (list row keeps focus)", back.focus !== "dcQ" && back.focus === "dcList", back.focus);

  // deep link on phone + related + Back goes one step
  if (D.withRel) {
    await p.goto("about:blank", 100); await p.goto(PAGE + "?demo-user=0#t=" + D.withRel, 300);   // a real deep link: fresh document, no scroll, no origin row
    await until(p, `document.documentElement.classList.contains("dc-sheet") && !!document.querySelector(".dc-relchip")`, 6000); await sleep(300);
    check("phone: deep link opens the sheet", await entryOpen(p));
    const rel = await p.js(`document.querySelector(".dc-relchip").dataset.id`);
    await tap(p, ".dc-relchip"); await until(p, `location.hash === "#t=${rel}"`); await sleep(300);
    await tap(p, ".dc-back"); await until(p, `location.hash === "#t=${D.withRel}"`, 3000); await sleep(300);
    check("phone: Back after a related term returns to the first entry", (await p.js("location.hash")) === "#t=" + D.withRel && await entryOpen(p));
    await tap(p, ".dc-back"); await until(p, `!document.documentElement.classList.contains("dc-sheet")`, 3000); await sleep(300);
    const dl = await p.js(`({hash: location.hash, focus: document.activeElement.id, y: Math.round(scrollY)})`);
    check("phone: Back again leaves the sheet", dl.hash === "");
    check("D3: deep link → Back lands focus on the list title or list, never the search box; the page stays at the top", (dl.focus === "dcListTitle" || dl.focus === "dcList") && dl.y < 100, dl);
  }
  check("phone guest: zero console errors", errs(p).length === 0, errs(p));
  p.close();
}
{
  const p = await open(PAGE + "?demo-user=1", PHONE);
  await p.js("localStorage.clear(), true"); await p.goto(PAGE + "?demo-user=1", 300);
  await until(p, `!!document.querySelector("#dcList .dc-row:not(.dc-skel)") && !!document.querySelector(".dc-rev-go")`, 8000); await sleep(300);
  const ids = await rows(p);
  await p.js(`[${JSON.stringify(ids[1])}, ${JSON.stringify(ids[4])}].forEach(id => Finspire.store.toggleSaved(id, true)); Finspire.store.addHistory(${JSON.stringify(ids[6])}, "news"); Finspire.store.addHistory(${JSON.stringify(ids[7])}, "search"); Finspire.store.addHistory(${JSON.stringify(ids[8])}, "browse"); Finspire.store.addHistory(${JSON.stringify(ids[9])}, "browse"); true`); await sleep(300);
  await p.js(`document.getElementById("me").scrollIntoView({block:"start"}), true`); await sleep(200);
  await shot(p, "phone-signed-in.png");
  check("phone signed in: no sideways scroll", await noOverflow(p));
  const cmp = await p.js(`(()=>{const m=document.getElementById("me"); const via=m.querySelector(".dc-via.v-search"); return {h: Math.round(m.getBoundingClientRect().height), rows: m.querySelectorAll(".dc-recent .dc-me-row").length,
    via: via && getComputedStyle(via).color, ink2: getComputedStyle(document.documentElement).getPropertyValue("--ink2").trim()}})()`);
  check("D6: phone panel with lookups stays compact (recent capped at 3 rows)", cmp.rows <= 3 && cmp.h < 700, cmp);
  check("D11: 'via …' chips use --ink2 on the --line background (AA)", cmp.via === "rgb(189, 189, 198)", cmp);
  await p.js("localStorage.clear(), true"); await p.goto(PAGE + "?demo-user=1", 300); await until(p, `!!document.querySelector(".dc-rev-go")`, 8000); await sleep(300);
  const emp = await p.js(`({h: Math.round(document.getElementById("me").getBoundingClientRect().height), empties: document.querySelectorAll("#me .dc-card.dc-empty").length})`);
  check("D6: phone panel for a new user is three compact rows (under 340px)", emp.empties === 3 && emp.h < 340, emp);
  await p.js(`[${JSON.stringify(ids[1])}, ${JSON.stringify(ids[4])}].forEach(id => Finspire.store.toggleSaved(id, true)); true`); await sleep(300);
  await tap(p, "#me .dc-rev-go");
  await until(p, `!!document.querySelector(".dc-qz-modal .dc-opt")`, 5000); await sleep(400);
  const qm = await p.js(`(()=>{const c=document.querySelector(".dc-qz-modal .fs-modal-card").getBoundingClientRect(); const o=[...document.querySelectorAll(".dc-opt")].map(b=>Math.round(b.getBoundingClientRect().height));
    return {w: Math.round(c.width), bottom: Math.round(c.bottom), minOpt: Math.min(...o)}})()`);
  check("phone: quiz is a bottom sheet with large options", qm.w === 390 && qm.bottom === 844 && qm.minOpt >= 48, qm);
  await shot(p, "phone-quiz.png");
  await tap(p, ".dc-qz-modal .dc-opt");
  await sleep(300);
  await shot(p, "phone-quiz-feedback.png");
  check("phone: quiz feedback shown", await p.js(`!!document.querySelector(".dc-qz-res")`));
  check("phone signed in: zero console errors", errs(p).length === 0, errs(p));
  p.close();
}

// ================================================================================================ scale: 1,900 terms on a slow phone
{
  // clone the real index up to 1,900 rows (new ids, same shape) and serve it instead of data/glossary/index.json
  const real = await (await fetch(base + "data/glossary/index.json")).json();
  const t = real.t.slice(); let k = 1;
  const N = Math.max(1900, real.t.length);   // at least 1,900 rows; the real dictionary may already be bigger
  while (t.length < N) { for (const r of real.t) { if (t.length >= N) break; t.push([r[0] + "-v" + k, r[1] + " " + "ABCDEFGHIJ"[k % 10] + k, r[2], r[3], r[4], [], [], []]); } k++; }
  const cats = {}; t.forEach(r => { (cats[r[2]] = cats[r[2]] || { name: (real.cats[r[2]] || {}).name || r[2], n: 0 }).n++; });
  const body = Buffer.from(JSON.stringify(Object.assign({}, real, { n: t.length, cats, t }))).toString("base64");
  const setup = async p => {
    await p.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await p.send("Fetch.enable", { patterns: [{ urlPattern: "*/data/glossary/index.json*" }] });
    p.on(m => { if (m.method === "Fetch.requestPaused") p.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }], body }).catch(() => {}); });
    await p.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__lt=[];try{new PerformanceObserver(l=>l.getEntries().forEach(e=>__lt.push(Math.round(e.duration)))).observe({type:"longtask",buffered:true})}catch(e){}` });
  };
  const p = await open(PAGE + "?demo-user=0", Object.assign({ setup }, PHONE));
  const n = await p.js(`Finspire.glossary.rows().length`);
  check(`scale: ${N.toLocaleString("en-IN")}-term dictionary loads (at least 1,900)`, n === N, n);
  const perf = await p.js(`(async()=>{
    const q=document.getElementById("dcQ"), frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    window.__lt.length = 0; const list=document.getElementById("dcList"); const rendered=()=>new Promise(r=>{const mo=new MutationObserver(()=>{mo.disconnect(); r()}); mo.observe(list,{childList:true}); setTimeout(()=>{mo.disconnect(); r()}, 1500)});
    const times=[]; for (const s of ["c","ca","cap","capi","capit","capital"]) { const t0=performance.now(); q.value=s; q.dispatchEvent(new Event("input")); await rendered(); await frame(); times.push(Math.round(performance.now()-t0)); }
    q.value=""; q.dispatchEvent(new Event("input")); await frame(); await new Promise(r=>setTimeout(r,200)); const ltSearch = window.__lt.slice();
    const t1=performance.now(); for (let i=0;i<6;i++){ document.getElementById("dcSentinel").scrollIntoView({block:"end"}); await frame(); await new Promise(r=>setTimeout(r,60)); }
    const scroll=Math.round(performance.now()-t1);
    const lb=document.querySelector('.dc-l[data-l="S"]'); const t2=performance.now(); lb.click(); await frame(); const letter=Math.round(performance.now()-t2);
    lb.click(); await frame();
    return {search: times, maxSearch: Math.max(...times), rows: document.querySelectorAll("#dcList .dc-row").length, scroll, letter, longtasks: window.__lt, ltSearch}})()`);
  console.log("scale (4x CPU throttle, phone):", JSON.stringify(perf));
  check("scale: each keystroke renders within 80 ms debounce + 100 ms at 4× CPU throttle", perf.maxSearch < 180, perf.search);
  check("D9: a keystroke never blocks the main thread for 100 ms (first slice of 24 rows, rest idle)", perf.ltSearch.every(x => x < 100), perf.ltSearch);
  check("scale: letter filter under 100 ms", perf.letter < 100, perf.letter);
  check("scale: list never renders more than it needs (chunks of 60)", perf.rows <= 60, perf.rows);
  const deb = await p.js(`(async()=>{const q=document.getElementById("dcQ"); q.value="bond"; q.dispatchEvent(new Event("input")); const n0=document.querySelectorAll("#dcList .dc-row-term").length, t0=document.querySelector("#dcList .dc-row-term")?.textContent;
    await new Promise(r=>setTimeout(r,400)); const t1=document.querySelector("#dcList .dc-row-term")?.textContent; q.value=""; q.dispatchEvent(new Event("input")); return {t0, t1}})()`);
  check("D9: results appear after the debounce", /bond/i.test(deb.t1), deb);
  check("scale: no main-thread task over 250 ms", perf.longtasks.every(x => x < 250), perf.longtasks);
  check("scale: no console errors", errs(p).length === 0, errs(p));
  await p.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  p.close();
}

// ================================================================================================ term of the day before the index (D4)
{
  // hold index.json back for 1.5 s: the card must already be painted from data/glossary/tod.json (built next to the index)
  const held = [];
  const setup = async p => {
    await p.send("Fetch.enable", { patterns: [{ urlPattern: "*/data/glossary/index.json*" }] });
    p.on(m => { if (m.method === "Fetch.requestPaused") held.push(m.params.requestId); });
  };
  const p = await b.page("about:blank", Object.assign({ setup, wait: 50 }, PHONE));
  await setup(p);
  await p.goto(PAGE + "?demo-user=0", 100);
  const todFile = await (await fetch(base + "data/glossary/tod.json")).json().catch(() => null);
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const pick = todFile && todFile.days && todFile.days[key];
  const early = await until(p, `!!document.querySelector("#dcTodBody .dc-tod-def") && !Finspire.glossary.loaded()`, 1500);
  const card = await p.js(`({id: document.getElementById("dcTodBody").dataset.id, term: document.querySelector(".dc-tod-term")?.textContent, cat: document.querySelector(".dc-tod-meta span:last-child")?.textContent,
    loaded: Finspire.glossary.loaded(), skel: document.querySelectorAll("#dcTodBody .skel").length, busy: document.getElementById("dcTodBody").hasAttribute("aria-busy")})`);
  if (pick) check("D4: term of the day paints from tod.json before the index arrives", early && card.id === pick.id && card.term === pick.term && card.cat === pick.catName && !card.loaded && card.skel === 0 && !card.busy, { card, pick: pick.id });
  else check("D4: data/glossary/tod.json has today's pick (built by scripts/build_glossary.py)", false, key);
  for (const id of held.splice(0)) await p.send("Fetch.continueRequest", { requestId: id }).catch(() => {});
  await p.send("Fetch.disable");
  await until(p, `Finspire.glossary.loaded() && !!document.querySelector("#dcList .dc-row:not(.dc-skel)")`, 8000); await sleep(400);
  const after = await p.js(`({id: document.getElementById("dcTodBody").dataset.id, same: document.getElementById("dcTodBody").dataset.id === Finspire.glossary.termOfDay()?.id})`);
  check("D4: the index agrees with tod.json (no re-render, same term)", after.same && after.id === card.id, after);
  p.close();
}

// ================================================================================================ 1024px: A–Z grid
{
  const p = await open(PAGE + "?demo-user=0", { width: 1024, height: 768 });
  const az = await p.js(`[...document.querySelectorAll("#dcAz .dc-l")].map(b => Math.round(b.getBoundingClientRect().height))`);
  check("D14: every A–Z key is one line tall at 1024px ('0–9' included)", az.length === 28 && az.every(h => h === az[0]), az);
  check("1024px: no sideways scroll", await noOverflow(p));
  await shot(p, "w1024-work.png");
  p.close();
}

// ================================================================================================ reduced motion
{
  const p = await open(PAGE + "?demo-user=0#t=" + (D.noFormula || D.tod), Object.assign({ reducedMotion: true }, PHONE));
  await until(p, `document.documentElement.classList.contains("dc-sheet")`, 4000);
  check("reduced motion: sheet has no animation", await p.js(`getComputedStyle(document.getElementById("dcSide")).animationName === "none" || parseFloat(getComputedStyle(document.getElementById("dcSide")).animationDuration) < 0.02`));
  check("reduced motion: chips and rows have no transitions", await p.js(`["dc-cat","dc-l","dc-seg","dc-row"].every(c => { const e=document.querySelector("."+c); return !e || getComputedStyle(e).transitionDuration.split(",").every(d => parseFloat(d) < 0.01); })`));
  p.close();
}

await b.close();
process.exit(R.done() ? 1 : 0);
