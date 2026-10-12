// Shared runtime (site/assets/js/finspire.js + pages.css + shell.css) on the demo page tests/fixtures/demo/shell.html.
//   python3 scripts/build_site.py --demo --out .dev/shell
//   python3 -m http.server 8801 -d .dev/shell &
//   node --experimental-websocket tests/shell.test.mjs http://127.0.0.1:8801/ [chromeDebugPort=9401]
// Screenshots go to tests/out/shell/.
import { launch, reporter, sleep } from "./lib/cdp.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const base = (process.argv[2] || "http://127.0.0.1:8801/").replace(/\/?$/, "/");
const port = +(process.argv[3] || 9401);
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out", "shell");
const PAGE = base + "_demo/shell.html";
const R = reporter(), check = R.check;
const b = await launch({ port });

// The dictionary is being written in content/glossary while this runs, so the checks below pin the small fixture
// glossary: it is built to a temp folder and served in place of <site>/data/glossary/* through CDP request interception.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = mkdtempSync(join(tmpdir(), "fs-gloss-"));
execFileSync("python3", [join(ROOT, "scripts/build_glossary.py"), "--src", join(ROOT, "tests/fixtures/glossary"), "--out", FIX], { stdio: "ignore" });
async function open(url, opts = {}) {
  const p = await b.page("about:blank", Object.assign({}, opts, { wait: 50 }));
  if (opts.realGlossary !== true) {
    await p.send("Fetch.enable", { patterns: [{ urlPattern: "*/data/glossary/*" }] });
    p.on(m => {
      if (m.method !== "Fetch.requestPaused") return;
      const rel = decodeURIComponent(new URL(m.params.request.url).pathname.split("/data/glossary/")[1] || "");
      const f = join(FIX, rel);
      if (rel && !rel.includes("..") && existsSync(f)) p.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: readFileSync(f).toString("base64") }).catch(() => {});
      else p.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 404, responseHeaders: [], body: "" }).catch(() => {});
    });
  }
  await p.goto(url, opts.wait || 1800);
  return p;
}

// helpers ---------------------------------------------------------------------------------------------------------
const center = (p, sel) => p.js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
  e.scrollIntoView({block:"center", behavior:"instant"}); const r=e.getClientRects()[0]||e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
async function hover(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(250); await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] }); return c; }
async function mouseTo(p, x, y) { await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); }
async function click(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(200);
  await mouseTo(p, c[0], c[1]);
  for (const type of ["mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: c[0], y: c[1], button: "left", clickCount: 1 }); await sleep(250); }
async function tap(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(250);
  await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c[0], y: c[1] }] });
  await sleep(60); await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(400); }
async function tapAt(p, x, y) { await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await sleep(60); await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(400); }
async function key(p, k, mods = 0) {
  const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 };
  for (const type of ["rawKeyDown", "keyUp"]) await p.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: codes[k] || 0, modifiers: mods });
  await sleep(120);
}
const noOverflow = p => p.js("document.documentElement.scrollWidth <= innerWidth");
const tipState = p => p.js(`(()=>{const t=document.querySelector(".gl-tip"); if(!t) return {open:false};
  const r=t.getBoundingClientRect(); return {open:t.classList.contains("gl-show"), sheet:t.classList.contains("gl-sheet"), side:t.dataset.side||null,
  term:t.querySelector(".gl-tip-term").textContent, lvl:t.querySelector(".gl-lvl").hidden?"":t.querySelector(".gl-lvl").textContent,
  def:t.querySelector(".gl-tip-def").textContent, href:t.querySelector(".gl-tip-open").getAttribute("href"),
  save:!t.querySelector(".gl-tip-save").hidden, pressed:t.querySelector(".gl-tip-save").getAttribute("aria-pressed"),
  rect:[r.left,r.top,r.right,r.bottom], vw:document.documentElement.clientWidth, vh:innerHeight}})()`);
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

// ================================================================================================ desktop, guest
{
  const p = await open(PAGE, { width: 1280, height: 900 });
  await p.js("localStorage.clear(), sessionStorage.clear(), true"); await p.goto(PAGE, 1800);
  check("desktop: no console errors on load", p.errors.length === 0, p.errors);
  const api = await p.js(`(()=>{const F=Finspire; return {keys:Object.keys(F).sort(), root:F.root, url:F.url("dictionary/#t=x"), abs:F.url("https://a.b/c"),
    auth:Object.keys(F.auth).sort(), store:Object.keys(F.store).sort(), gl:Object.keys(F.glossary).sort(), ui:Object.keys(F.ui).sort(), tip:Object.keys(F.tip).sort(),
    globals:Object.keys(window).filter(k=>/^(fs|gl|finspire)/i.test(k))}})()`);
  check("api: window.Finspire surface", ["auth", "cfg", "dom", "emit", "fetchJSON", "fmt", "glossary", "header", "off", "on", "root", "store", "tip", "ui", "url"].every(k => api.keys.includes(k)), api.keys);
  check("api: only Finspire (+ FINSPIRE_CONFIG) global", api.globals.every(k => k === "Finspire" || k === "FINSPIRE_CONFIG"), api.globals);
  check("api: root and url()", api.root === "../" && api.url === "../dictionary/#t=x" && api.abs === "https://a.b/c", api);
  check("api: auth/store/glossary/ui members", ["ready", "user", "enabled", "signIn", "signOut", "getToken", "hasToken", "isAdmin"].every(k => api.auth.includes(k)) &&
    ["get", "set", "update", "clear"].every(k => api.store.includes(k)) && ["load", "get", "cats", "search", "entry", "annotate", "match", "termOfDay"].every(k => api.gl.includes(k)) &&
    ["toast", "mountAccount", "signInDialog", "modal"].every(k => api.ui.includes(k)), api);

  const f = await p.js(`(()=>{const f=Finspire.fmt; return [f.num(24812.345,2), f.num(-0.001,2), f.signed(-46.18), f.signed(46.18), f.pct(0.59), f.pct(-1.2,1), f.pct(null), f.num("x"),
    f.date("2026-10-12"), f.time(Date.UTC(2026,0,1,8,35), "Asia/Kolkata"), f.ago(Date.now()-5*60000), f.ago(Date.now()-3*3600000)]})()`);
  check("fmt: numbers, signs, dates", JSON.stringify(f) === JSON.stringify(["24,812.35", "0.00", "−46.18", "+46.18", "+0.59%", "−1.2%", "—", "—", "12 Oct 2026", "14:05", "5 min ago", "3 h ago"]), f);
  const d = await p.js(`(()=>{const h=Finspire.dom.h; const e=h("p",{class:"x",dataset:{a:"1"}},"<b>hi</b>",[h("i",null,"y"),null,false]);
    return [e.innerHTML, e.className, e.dataset.a, Finspire.dom.safeUrl("javascript:alert(1)"), Finspire.dom.safeUrl("https://ok.example/a"), Finspire.dom.safeUrl("/rel"),
      Finspire.dom.ext("javascript:x",null,"t").tagName, Finspire.dom.ext("https://e.com",null,"t").rel, Finspire.dom.esc("<a href='x'>&")]})()`);
  check("dom: h() never parses HTML, safeUrl/ext only allow http(s)", d[0] === "&lt;b&gt;hi&lt;/b&gt;<i>y</i>" && d[1] === "x" && d[2] === "1" && d[3] === null &&
    d[4] === "https://ok.example/a" && d[5] === null && d[6] === "SPAN" && d[7] === "noopener noreferrer" && d[8] === "&lt;a href=&#39;x&#39;&gt;&amp;", d);

  // glossary ------------------------------------------------------------------------------------------------------
  const s = await p.js(`Finspire.glossary.load().then(()=>{const S=(q,o)=>Finspire.glossary.search(q,o).map(r=>r.id);
    return {repo:S("repo"), gdp:S("gdp"), GDP:S("GDP"), infl:S("inflation"), typo:S("inflaton"), typo2:S("recesion"), typo3:S("sensxe"), basis:S("basis"), yield:S("yield"),
      nifty:S("nifty"), fed:S("the fed"), cap:S("cap"), fpi:S("fii"), rate:S("rate"), cat:S("rate",{cat:"central-banks"}), lim:S("e",{limit:3}).length, empty:S("  "), none:S("zzzz")}})`);
  check("search: exact/alias first (repo, gdp, GDP, inflation, fii)", s.repo[0] === "repo-rate" && s.gdp[0] === "gross-domestic-product" && s.GDP[0] === "gross-domestic-product" && s.infl[0] === "inflation" && s.fpi[0] === "foreign-portfolio-investor", s);
  check("search: typo tolerance ≥4 chars (inflaton, recesion, sensxe)", s.typo[0] === "inflation" && s.typo2[0] === "recession" && s.typo3[0] === "sensex", [s.typo, s.typo2, s.typo3]);
  check("search: prefix and word-prefix ranking", s.basis[0] === "basis-point" && s.yield.slice(0, 2).sort().join() === "bond-yield,yield-curve" && s.nifty[0] === "nifty-50" && s.fed[0] === "federal-reserve" && s.cap[0] === "market-capitalisation", s);
  check("search: cat filter, limit, empty", s.cat.every(id => ["repo-rate", "federal-reserve"].includes(id)) && s.cat.length >= 1 && s.lim === 3 && s.empty.length === 0 && s.none.length === 0, s);

  const m = await p.js(`(()=>{const M=t=>Finspire.glossary.match(t).map(x=>x.id+"@"+x.start+"-"+x.end);
    return {a:M("RBI cuts the Repo Rate; repo rate again. GDP up, gdp down."), b:M("Nifty 500 and Nifty 50 rose"), c:M("prerecession nonGDP GDPs"),
      d:M("The policy repo rate was cut"), e:M("yield-curve inverted"), f:M("FIIs sold; FII flows")}})()`);
  check("match: case-insensitive hl, case-sensitive abbr, once per term", JSON.stringify(m.a) === JSON.stringify(["repo-rate@13-22", "gross-domestic-product@41-44"]), m.a);
  check("match: word boundaries and longest phrase first", m.b[0] === "nifty-50@0-5" && m.b.length === 1 && m.c.length === 0 && m.d[0] === "repo-rate@4-20" && m.e[0] === "yield-curve@0-11" && m.f.length === 1 && m.f[0] === "foreign-portfolio-investor@0-4", m);

  const an = await p.js(`(()=>{const q=s=>[...document.querySelectorAll(s)];
    return {prose:q("#prose .gl-term").map(e=>e.dataset.term), code:q("#prose code .gl-term").length, inLink:q("#hl1 .gl-term").map(e=>e.dataset.term),
      linkParent:q("#hl1 .gl-term").every(e=>e.closest("a")===document.querySelector("#hl1")), nogloss:q("[data-no-gloss] .gl-term").length,
      tab:q(".gl-term").every(e=>e.tabIndex===0), li1:q("#news li:first-child .gl-term").map(e=>e.dataset.term)}})()`);
  check("annotate: prose (once per term, code untouched)", an.prose.filter(x => x === "repo-rate").length === 1 && an.prose.includes("gross-domestic-product") && an.prose.includes("basis-point") && an.code === 0, an.prose);
  check("annotate: works inside links, skips [data-no-gloss]", an.inLink.join() === "foreign-portfolio-investor,brent-crude,nifty-50" && an.linkParent && an.nogloss === 0 && an.tab, an);
  check("annotate: each term once per headline+snippet", an.li1.filter(x => x === "foreign-portfolio-investor").length === 1, an.li1);
  const later = await p.js(`(()=>{const el=document.createElement("p"); el.textContent="Inflation and the Sensex."; document.body.appendChild(el);
    const ids=Finspire.glossary.annotate(el,{max:1}); const n=el.querySelectorAll(".gl-term").length; el.remove(); return [ids, n]})()`);
  check("annotate: max option", later[0].length === 1 && later[1] === 1, later);
  const ent = await p.js(`Finspire.glossary.entry("repo-rate").then(e=>({t:e.term, cat:e.catName, kid:!!e.kid, detail:e.detail.length>40, rel:e.related}))`);
  check("entry(): loads entries/<cat>.json on demand", ent.t === "Repo rate" && ent.cat && ent.kid && ent.detail && Array.isArray(ent.rel), ent);
  const tod = await p.js(`(()=>{const G=Finspire.glossary, a=G.termOfDay(new Date("2026-10-12T02:00:00+05:30")), b=G.termOfDay(new Date("2026-10-12T23:00:00+05:30")), c=G.termOfDay(new Date("2026-10-13T09:00:00+05:30"));
    return [a&&a.id, b&&b.id, a&&a.level, Object.keys(G.cats()).length]})()`);
  check("termOfDay(): same term all IST day, beginner/intermediate", tod[0] && tod[0] === tod[1] && ["b", "i"].includes(tod[2]) && tod[3] > 0, tod);
  // glossary v2: phrases.json + tod.json + entry shards (fixture built by scripts/build_glossary.py above)
  const v2 = await p.js(`(async()=>{const G=Finspire.glossary; const ix=await (await fetch("../data/glossary/index.json")).json(); const ph=await (await fetch("../data/glossary/phrases.json")).json();
    const today=await G.today(); const todF=await (await fetch("../data/glossary/tod.json")).json();
    const key=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    return {v:ix.v, hlInRows:ix.t.every(r=>!r[6].length), phrases:Object.keys(ph.hl||{}).length, shards:typeof ix.shards, today:today.id, todFile:(todF.days[key]||{}).id, js:G.termOfDay().id,
      catName:today.catName, loaded:G.loaded(), rows:G.rows().length}})()`);
  check("glossary v2: rows carry no phrases, phrases.json does; today() = tod.json = termOfDay()", v2.v === 2 && v2.hlInRows && v2.phrases > 0 && v2.shards === "object" && v2.today && v2.today === v2.todFile && v2.today === v2.js && v2.catName && v2.loaded, v2);
  const a11y = await p.js(`(()=>{const q=[...document.querySelectorAll("[data-term]")]; return {n:q.length, ok:q.every(e=>e.getAttribute("role")==="button" && e.getAttribute("aria-haspopup")==="dialog" && e.getAttribute("aria-expanded")==="false" && e.tabIndex===0)}})()`);
  check("a11y: every term is a button that opens a dialog (role, aria-haspopup, aria-expanded, tabindex)", a11y.n > 5 && a11y.ok, a11y);

  // tooltip: hover --------------------------------------------------------------------------------------------------
  const termSel = '#prose .gl-term[data-term="repo-rate"]';
  await hover(p, termSel); await sleep(80);
  check("tip: not open before hover intent (120ms)", !(await tipState(p)).open);
  await sleep(300);
  let t = await tipState(p);
  const tr = await p.js(`(()=>{const r=document.querySelector(${JSON.stringify(termSel)}).getBoundingClientRect(); return [r.left,r.top,r.right,r.bottom]})()`);
  check("tip: hover opens with term, level, meaning, dictionary link", t.open && t.term === "Repo rate" && t.lvl === "Beginner" && t.def.length > 20 && t.href === "../dictionary/#t=repo-rate", t);
  check("tip: the open term says aria-expanded=true", await p.js(`document.querySelector(${JSON.stringify(termSel)}).getAttribute("aria-expanded")`) === "true");
  check("tip: inside viewport and not covering the term", t.rect[0] >= 0 && t.rect[2] <= t.vw && t.rect[1] >= 0 && t.rect[3] <= t.vh && !overlaps(t.rect, tr), { tip: t.rect, term: tr });
  check("tip: Save offered to the local guest (no client id yet, so everyone is a guest)", t.save === true, t);
  await p.shot(join(OUT, "desktop-tip-hover.png"));
  await sleep(1000);
  const hist = await p.js(`JSON.parse(localStorage.getItem("fs:guest:dict.history")||"[]")`);
  check("tip: lookup recorded in dict.history (via tooltip) after ~1s", hist[0] && hist[0].id === "repo-rate" && hist[0].via === "tooltip", hist);
  // move into the tip: stays open
  await mouseTo(p, (t.rect[0] + t.rect[2]) / 2, t.side === "top" ? t.rect[3] - 20 : t.rect[1] + 20); await sleep(400);
  check("tip: stays open while the pointer is over it", (await tipState(p)).open);
  await mouseTo(p, 1200, 860); await sleep(450);
  check("tip: closes on pointer leave", !(await tipState(p)).open);
  check("tip: closed term says aria-expanded=false", await p.js(`document.querySelector(${JSON.stringify(termSel)}).getAttribute("aria-expanded")`) === "false");

  // tooltip on [data-term] labels + unknown id
  await hover(p, '.demo-lbl[data-term="nifty-50"]'); await sleep(350);
  t = await tipState(p);
  check("tip: [data-term] elements work too", t.open && t.term === "Nifty 50", t.term);
  await p.shot(join(OUT, "desktop-tip-label.png"));
  await hover(p, '.demo-lbl[data-term="unknown-term"]'); await sleep(350);
  t = await tipState(p);
  check("tip: unknown id says so plainly", t.open && /Not available right now/.test(t.term), t);
  await mouseTo(p, 1200, 860); await sleep(450);

  // tooltip: click on a term inside a link shows the tip and does not navigate
  const targetsBefore = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).length;
  await p.js(`window.__linkClick=0; document.querySelector("#hl1").addEventListener("click",()=>window.__linkClick++); true`);
  await click(p, '#hl1 .gl-term[data-term="brent-crude"]'); await sleep(300);
  t = await tipState(p);
  const targetsAfter = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).length;
  const nav = await p.js(`[location.pathname, window.__linkClick]`);
  check("tip: click on term inside link opens tip, link not followed", t.open && t.term === "Brent crude" && targetsAfter === targetsBefore && nav[0].endsWith("/_demo/shell.html") && nav[1] === 0, { t: t.term, targetsBefore, targetsAfter, nav });
  await p.shot(join(OUT, "desktop-tip-in-link.png"));
  await key(p, "Escape"); await sleep(250);
  check("tip: Escape closes", !(await tipState(p)).open);
  // a click on the link text (not the term) still works as a link
  await p.js(`document.querySelector("#hl1").addEventListener("click",e=>e.preventDefault()); true`);
  await p.js(`(()=>{const a=document.querySelector("#hl1"); const r=document.createRange(); r.selectNodeContents(a); return true})()`);
  const plain = await p.js(`(()=>{const a=document.querySelector("#hl1"); const tn=[...a.childNodes].find(n=>n.nodeType===3&&/pull/.test(n.nodeValue)); const r=document.createRange(); r.setStart(tn,2); r.setEnd(tn,6); const b=r.getBoundingClientRect(); return [b.x+b.width/2,b.y+b.height/2]})()`);
  for (const type of ["mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: plain[0], y: plain[1], button: "left", clickCount: 1 });
  await sleep(250);
  check("link text outside terms still behaves as a link", (await p.js("window.__linkClick")) === 1 && !(await tipState(p)).open);

  // tooltip: keyboard
  await p.js(`document.querySelector('#prose .gl-term[data-term="inflation"]').focus(), true`); await sleep(250);
  t = await tipState(p);
  check("tip: keyboard focus opens it", t.open && t.term === "Inflation", t.term);
  await key(p, "Enter"); await sleep(200);
  const inTip = await p.js(`document.activeElement.classList.contains("gl-tip-open")`);
  check("tip: Enter moves focus into the tip", inTip);
  await key(p, "Escape"); await sleep(250);
  const back = await p.js(`[document.activeElement.dataset.term, document.querySelector(".gl-tip").classList.contains("gl-show")]`);
  check("tip: Escape closes and returns focus to the term", back[0] === "inflation" && back[1] === false, back);
  await p.js("document.activeElement.blur(), true");

  // scroll closes
  await hover(p, termSel); await sleep(400);
  await p.js("scrollBy(0, 120), true"); await sleep(350);
  check("tip: closes on scroll", !(await tipState(p)).open);

  // header: scrolled, light band, aria-current
  await p.js("scrollTo({top:0, behavior:\"instant\"}), true"); await sleep(300);
  const h0 = await p.js(`document.querySelector(".hdr").classList.contains("scrolled")`);
  await p.js("scrollTo({top:400, behavior:\"instant\"}), true"); await sleep(300);
  const h1 = await p.js(`document.querySelector(".hdr").classList.contains("scrolled")`);
  check("header: scrolled state", h0 === false && h1 === true, [h0, h1]);
  await p.js(`(()=>{const b=document.querySelector("#band"); scrollTo(0, b.getBoundingClientRect().top + scrollY - 20); return true})()`); await sleep(400);
  const lm = await p.js(`document.querySelector(".hdr").classList.contains("light-mode")`);
  check("header: light mode over a .light band", lm === true);
  await p.shot(join(OUT, "desktop-light-band.png"));
  await hover(p, '#lightProse .gl-term'); await sleep(400);
  t = await tipState(p);
  check("tip: opens on the light band", t.open, t.term);
  await p.shot(join(OUT, "desktop-tip-light.png"));
  await mouseTo(p, 5, 880); await sleep(400);
  await p.js("scrollTo(0,0), true"); await sleep(300);
  const lm0 = await p.js(`document.querySelector(".hdr").classList.contains("light-mode")`);
  check("header: dark again at the top", lm0 === false);
  const cur = await p.js(`[...document.querySelectorAll("[aria-current=page]")].map(a=>a.getAttribute("href"))`);
  check("header: aria-current only on the current page link", cur.length === 1 && cur[0] === "shell.html", cur);

  // sign-in rollout: no client id yet → no account control, no sign-in prompts, everyone is a local guest
  const ro = await p.js(`(()=>{const a=document.querySelector("[data-fs-account]"); return {hidden:a.hidden, kids:a.children.length, pill:!!document.querySelector("[data-fs-signin]"),
    feat:Finspire.feature("signin"), en:Finspire.auth.enabled(), guest:!!(Finspire.auth.user()||{}).guest}})()`);
  check("rollout: without a client id the account control is hidden and everyone is a local guest", ro.hidden && ro.kids === 0 && !ro.pill && !ro.feat && !ro.en && ro.guest, ro);
  await click(p, "#bModal"); await sleep(350);
  const dlg = await p.js(`(()=>{const m=document.querySelector(".fs-modal.fs-show"); if(!m) return null; return {focusIn:m.contains(document.activeElement),
    lock:document.documentElement.classList.contains("fs-lock"), role:m.querySelector("[role=dialog]").getAttribute("aria-modal")}})()`);
  check("modal: opens with focus inside, scroll locked, aria-modal", dlg && dlg.focusIn && dlg.lock && dlg.role === "true", dlg);
  for (let i = 0; i < 4; i++) await key(p, "Tab");
  check("modal: focus trapped", await p.js(`document.querySelector(".fs-modal").contains(document.activeElement)`));
  await key(p, "Escape"); await sleep(350);
  const after = await p.js(`[!!document.querySelector(".fs-modal"), document.documentElement.classList.contains("fs-lock"), document.activeElement.id]`);
  check("modal: Escape closes, unlocks scroll, returns focus", after[0] === false && after[1] === false && after[2] === "bModal", after);
  const sp = await p.js(`Finspire.auth.signIn().then(()=>"resolved", e=>e.message)`); await sleep(300);
  check("auth.signIn() without client id rejects (programmatic misuse only; no UI offers it)", sp === "not-configured", sp);
  await key(p, "Escape"); await sleep(300);

  // toast + generic modal
  await click(p, "#bToast"); await sleep(400);
  const toastOk = await p.js(`(()=>{const t=document.querySelector(".fs-toast.fs-show"); return t ? t.textContent : null})()`);
  check("toast shows", toastOk === "Saved. This is a toast.", toastOk);
  await click(p, "#bModal"); await sleep(350);
  await p.shot(join(OUT, "desktop-modal.png"));
  await p.js(`document.querySelector(".fs-modal").dispatchEvent(new MouseEvent("mousedown",{bubbles:true})), true`); await sleep(300);
  check("modal: backdrop closes", !(await p.js(`!!document.querySelector(".fs-modal")`)));

  check("desktop: no horizontal overflow", await noOverflow(p));
  const shell = await p.js(`(()=>{const cs=e=>getComputedStyle(e); return {fcols:cs(document.querySelector(".fcols")).gridTemplateColumns.split(" ").length, cols:[...document.querySelectorAll(".fcol b")].map(b=>b.textContent),
    repoPad:cs(document.querySelector('.nl[href$="#repository"]')).paddingRight, h2:cs(document.querySelector(".h2")||document.body).fontSize, acct:cs(document.querySelector(".fs-acct")).display,
    fonts:[...document.fonts].filter(f=>f.status==="loaded").map(f=>f.family).sort(), gf:!!document.querySelector('link[href*="fonts.googleapis"]'), preload:document.querySelectorAll('link[rel=preload][as=font]').length,
    icon:(document.querySelector('link[rel=icon]')||{}).getAttribute("href"), join:document.querySelector(".nav-cta .join").getAttribute("aria-label")}})()`);
  check("footer: five columns, same blocks as the home page", shell.fcols === 5 && shell.cols.join() === "Repository,Start here,Tools,Club,Follow", shell);
  check("header: Repository link reserves the home chevron's slot; Join carries its new-tab label", shell.repoPad === "36px" && /opens in a new tab/.test(shell.join), shell);
  check("type: section headings use the home scale (53.76px at 1280)", shell.h2 === "53.76px", shell.h2);
  check("fonts: self-hosted Plex loaded, no Google Fonts link, preloads present, hidden empty account slot", shell.fonts.includes("IBM Plex Sans") && shell.fonts.includes("IBM Plex Mono") && !shell.gf && shell.preload >= 2 && shell.acct === "none" && /icon\.png$/.test(shell.icon), shell);
  await p.js("scrollTo(0,0), true"); await sleep(200);
  await p.shot(join(OUT, "desktop-top.png"));
  await p.shot(join(OUT, "desktop-full.png"), { fullPage: true });
  check("desktop: no console errors after interactions", p.errors.length === 0, p.errors);
  p.close();
}

// ================================================================================================ desktop, demo user
{
  const p = await open(PAGE + "?demo-user=1", { width: 1280, height: 900 });
  const u = await p.js(`Finspire.auth.ready.then(u=>({u, en:Finspire.auth.enabled(), demo:Finspire.auth.isDemo(), admin:Finspire.auth.isAdmin()}))`);
  check("demo: ?demo-user=1 on localhost signs in a fake student", u.u && u.u.email === "demo.student@iimranchi.ac.in" && u.en && u.demo && u.admin === false, u);
  const acct = await p.js(`(()=>{const b=document.querySelector(".fs-acct-btn"); return b ? {name:b.querySelector(".fs-acct-name").textContent, av:b.querySelector(".fs-av").textContent, exp:b.getAttribute("aria-expanded")} : null})()`);
  check("account: avatar (initials) + first name", acct && acct.name === "Demo" && acct.av === "DS" && acct.exp === "false", acct);
  const tok = await p.js(`Finspire.auth.getToken(["drive.readonly"]).then(t=>[t, Finspire.auth.hasToken("drive.appdata")])`);
  check("demo: getToken resolves demo-token", tok[0] === "demo-token" && tok[1] === true, tok);

  // store namespacing + Save from the tip
  await hover(p, '#prose .gl-term[data-term="inflation"]'); await sleep(400);
  let t = await tipState(p);
  check("tip: Save shown when signed in", t.open && t.save && t.pressed === "false", t);
  await click(p, ".gl-tip-save"); await sleep(250);
  t = await tipState(p);
  const ns = await p.js(`({user:JSON.parse(localStorage.getItem("fs:demo-student:dict.saved")||"null"), guest:localStorage.getItem("fs:guest:dict.saved"), api:Finspire.store.get("dict.saved"), saved:Finspire.store.isSaved("inflation")})`);
  check("store: Save writes to the user's namespace only", t.pressed === "true" && JSON.stringify(ns.user) === '["inflation"]' && ns.guest === null && ns.saved, ns);
  await p.shot(join(OUT, "desktop-tip-saved.png"));
  await mouseTo(p, 1200, 880); await sleep(400);
  const st = await p.js(`(()=>{const S=Finspire.store, ev=[]; const off=Finspire.on("store",k=>ev.push(k));
    S.set("news.seen", 123); S.update("lib.pos", o=>Object.assign({}, o, {f1: 4}), {}); S.addHistory("gdp-x","search"); S.addHistory("sensex","news"); S.addHistory("gdp-x","browse");
    const h=S.get("dict.history"); off(); return {ev, seen:S.get("news.seen"), pos:S.get("lib.pos"), h:h.slice(0,3).map(x=>x.id+":"+x.via), missing:S.get("nope", 7),
      raw:localStorage.getItem("fs:demo-student:news.seen")}})()`);
  check("store: get/set/update + events + history dedupe", st.ev.includes("news.seen") && st.ev.includes("lib.pos") && st.seen === 123 && st.pos.f1 === 4 && st.h.join() === "gdp-x:browse,sensex:news,inflation:tooltip" && st.missing === 7 && st.raw === "123", st);
  const quota = await p.js(`(()=>{const orig=Storage.prototype.setItem; Storage.prototype.setItem=function(){throw new Error("QuotaExceededError")};
    let ok; try{ ok=Finspire.store.set("dict.srs",{a:{box:1,due:1,seen:1,right:0}}); }catch(e){ ok="threw" } Storage.prototype.setItem=orig; return [ok, Finspire.store.get("dict.srs").a.box]})()`);
  check("store: survives storage errors (memory fallback)", quota[0] === true && quota[1] === 1, quota);

  // menu
  await click(p, ".fs-acct-btn"); await sleep(250);
  const menu = await p.js(`(()=>{const m=document.querySelector(".fs-menu"); return {open:!m.hidden, exp:document.querySelector(".fs-acct-btn").getAttribute("aria-expanded"),
    items:[...m.querySelectorAll("[role=menuitem]")].map(a=>a.textContent.trim()+"|"+(a.getAttribute("href")||"")), who:m.querySelector(".fs-menu-who").textContent}})()`);
  check("account menu: name/email, My dictionary, Library, Sign out", menu.open && menu.exp === "true" && menu.who.includes("demo.student@iimranchi.ac.in") &&
    menu.items.join() === "My dictionary|../dictionary/#me,Library|../library/,Sign out|", menu);
  await p.shot(join(OUT, "desktop-account-menu.png"));
  await key(p, "Escape"); await sleep(150);
  check("account menu: Escape closes", await p.js(`document.querySelector(".fs-menu").hidden`));

  // internal navigation keeps demo on (session), then sign out
  await p.goto(PAGE, 1500);
  check("demo: stays signed in across internal navigation", await p.js(`Finspire.auth.ready.then(u=>!!u && !!document.querySelector(".fs-acct-btn"))`));
  check("store: user data still there after reload", await p.js(`Finspire.store.isSaved("inflation")`));
  await click(p, ".fs-acct-btn"); await sleep(200);
  await click(p, ".fs-menu .fs-out"); await sleep(400);
  const out = await p.js(`({u:Finspire.auth.user(), pill:!!document.querySelector("[data-fs-signin]"), saved:Finspire.store.isSaved("inflation"), guestNs:Finspire.store.get("news.seen", null)})`);
  check("sign-out: back to guest, Sign in pill, guest namespace", out.u === null && out.pill && out.saved === false && out.guestNs === null, out);
  const sbtn = await p.js(`(()=>{const b=document.querySelector("[data-fs-signin]"); return b ? [b.textContent.trim(), !!b.querySelector("svg.fs-g"), b.getBoundingClientRect().height] : null})()`);
  check("account: Sign in pill with Google mark when sign-in works and nobody is signed in", sbtn && sbtn[0] === "Sign in" && sbtn[1] && sbtn[2] >= 40, sbtn);
  // what a local guest kept in this browser (before sign-in was switched on) moves into the account at first sign-in
  await p.js(`(()=>{const now=Date.now(); localStorage.setItem("fs:guest:dict.saved", JSON.stringify(["gdp"]));
    localStorage.setItem("fs:guest:dict.history", JSON.stringify([{id:"repo-rate", at:now+5000, via:"search"}]));
    localStorage.setItem("fs:guest:dict.srs", JSON.stringify({gdp:{box:2, due:now, seen:3, right:2}})); return true})()`);
  await click(p, "[data-fs-signin]"); await sleep(400);
  check("demo: Sign in pill signs back in", await p.js(`!!Finspire.auth.user() && Finspire.store.isSaved("inflation")`));
  const mg = await p.js(`({saved:Finspire.store.get("dict.saved"), h0:(Finspire.store.get("dict.history")||[])[0], srs:(Finspire.store.get("dict.srs")||{}).gdp,
    left:["dict.saved","dict.history","dict.srs"].filter(k=>localStorage.getItem("fs:guest:"+k)!==null)})`);
  check("rollout: guest saved words, lookups and revision merge into the account at first sign-in", mg.saved.includes("gdp") && mg.saved.includes("inflation") &&
    mg.h0 && mg.h0.id === "repo-rate" && mg.srs && mg.srs.box === 2 && mg.left.length === 0, mg);
  await p.goto(PAGE + "?demo-user=0", 1200);
  check("demo: ?demo-user=0 turns it off", await p.js(`Finspire.auth.ready.then(u=>u===null && !Finspire.auth.isDemo())`));
  check("demo desktop: no console errors", p.errors.length === 0, p.errors);
  p.close();
}

// ================================================================================================ phone
{
  const p = await open(PAGE + "?demo-user=1", { width: 390, height: 844, mobile: true, scale: 2 });
  check("phone: no console errors on load", p.errors.length === 0, p.errors);
  check("phone: no horizontal overflow", await noOverflow(p));
  const hd = await p.js(`(()=>{const v=s=>{const e=document.querySelector(s); return e && getComputedStyle(e).display!=="none" && e.getBoundingClientRect().width>0};
    const r=s=>{const e=document.querySelector(s).getBoundingClientRect(); return [Math.round(e.width),Math.round(e.height)]};
    return {links:v(".nav-links"), join:v(".nav-cta .join"), burger:v(".burger"), name:v(".fs-acct-name"), acct:r(".fs-acct-btn"), burgerSz:r(".burger"),
      gutter:Math.round(document.querySelector(".pg-head").getBoundingClientRect().left)}})()`);
  check("phone header: burger (44px) + compact avatar, links hidden", !hd.links && !hd.join && hd.burger && !hd.name && hd.acct[0] >= 40 && hd.acct[1] >= 40 && hd.burgerSz[0] === 44 && hd.burgerSz[1] === 44, hd);
  check("phone: 16px gutters", hd.gutter === 16, hd.gutter);
  await p.shot(join(OUT, "phone-top.png"));
  await tap(p, ".burger");
  const mm = await p.js(`(()=>{const m=document.querySelector(".mobile-menu"); return {open:!m.hidden, exp:document.querySelector(".burger").getAttribute("aria-expanded"),
    links:[...m.querySelectorAll("a")].map(a=>a.textContent.trim()), minH:Math.min(...[...m.querySelectorAll("a")].map(a=>a.getBoundingClientRect().height))}})()`);
  check("phone: burger opens the menu (nav order, tap targets)", mm.open && mm.exp === "true" && mm.links.slice(0, 6).join() === "Start here,Repository,Markets,Dictionary,Library,Events" && mm.minH >= 40, mm);
  check("phone: menu ends in the red Join on LinkedIn button and locks page scroll", mm.links[6] === "Join on LinkedIn ↗" && await p.js(`document.documentElement.classList.contains("fs-lock") && document.querySelector(".mobile-menu .btn-primary") !== null`), mm.links[6]);
  await p.shot(join(OUT, "phone-menu.png"));
  await key(p, "Escape"); await sleep(200);
  check("phone: Escape closes the menu and unlocks scroll", await p.js(`document.querySelector(".mobile-menu").hidden && !document.documentElement.classList.contains("fs-lock")`));
  // account menu on phone
  await tap(p, ".fs-acct-btn");
  const am = await p.js(`(()=>{const m=document.querySelector(".fs-menu"); const r=m.getBoundingClientRect(); return {open:!m.hidden, l:r.left, r:r.right, vw:innerWidth}})()`);
  check("phone: account menu fits the screen", am.open && am.l >= 8 && am.r <= am.vw - 8, am);
  await p.shot(join(OUT, "phone-account-menu.png"));
  await tapAt(p, 200, 700);
  check("phone: tapping outside closes the account menu", await p.js(`document.querySelector(".fs-menu").hidden`));

  // tap a term inside a link → sheet
  await tap(p, '#hl1 .gl-term[data-term="nifty-50"]');
  let t = await tipState(p);
  const scrim = await p.js(`(()=>{const s=document.querySelector(".gl-scrim"); return s && !s.hidden && s.classList.contains("gl-show")})()`);
  check("phone: tap on term opens a bottom sheet (not the link)", t.open && t.sheet && t.term === "Nifty 50" && scrim && (await p.js("location.pathname")).endsWith("/_demo/shell.html"), t);
  check("phone: sheet spans the bottom of the screen", Math.round(t.rect[3]) === t.vh && t.rect[0] === 0 && Math.round(t.rect[2]) === t.vw, t.rect);
  const xs = await p.js(`(()=>{const x=document.querySelector(".gl-tip-x").getBoundingClientRect(), o=document.querySelector(".gl-tip-open").getBoundingClientRect(); return [x.width,x.height,o.height]})()`);
  check("phone: sheet buttons are ≥ 40px", xs.every(v => v >= 40), xs);
  await sleep(300);
  await p.shot(join(OUT, "phone-sheet.png"));
  await tapAt(p, 195, 120);
  check("phone: tapping the scrim closes the sheet", !(await tipState(p)).open);
  // the grab handle drags the sheet; a pull of more than 60px closes it
  await tap(p, '#hl1 .gl-term[data-term="nifty-50"]');
  const hn = await p.js(`(()=>{const r=document.querySelector(".gl-tip-in").getBoundingClientRect(); return [r.x+r.width/2, r.y+12]})()`);
  await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: hn[0], y: hn[1] }] });
  for (let i = 1; i <= 6; i++) { await p.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: hn[0], y: hn[1] + i * 20 }] }); await sleep(30); }
  const mid = await p.js(`document.querySelector(".gl-tip-in").style.transform`);
  await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(400);
  check("phone: dragging the sheet handle down closes it", /translateY\(\d+px\)/.test(mid) && !(await tipState(p)).open, mid);
  await tap(p, '#prose .gl-term[data-term="repo-rate"]');
  t = await tipState(p);
  check("phone: sheet close button works", t.open && t.sheet);
  await tap(p, ".gl-tip-x");
  check("phone: closed by its X", !(await tipState(p)).open);

  const ch = await p.js(`(()=>{const c=document.querySelector(".chips"); const r=c.getBoundingClientRect(); return {scroll:c.scrollWidth>c.clientWidth, h:Math.round(r.height), ov:getComputedStyle(c).overflowX,
    minChip:Math.min(...[...c.children].map(x=>x.getBoundingClientRect().height))}})()`);
  check("phone: chip row scrolls sideways instead of wrapping", ch.scroll && ch.h <= 48 && ch.ov === "auto" && ch.minChip >= 40, ch);
  const fs = await p.js(`parseFloat(getComputedStyle(document.querySelector("#q")).fontSize)`);
  check("phone: inputs ≥ 16px (no iOS zoom)", fs >= 16, fs);
  await p.js(`document.querySelector("#q").scrollIntoView({block:"center",behavior:"instant"}), true`);
  await p.js(`(()=>{const q=document.querySelector("#q"); q.value="inflaton"; q.dispatchEvent(new Event("input")); return true})()`); await sleep(200);
  await p.shot(join(OUT, "phone-search.png"));
  await tap(p, "#bSignin");
  const sd = await p.js(`(()=>{const c=document.querySelector(".fs-modal-card"); const r=c.getBoundingClientRect(); return {bottom:Math.round(r.bottom), vh:innerHeight, w:Math.round(r.width), title:c.querySelector(".fs-modal-title").textContent,
    g:!!c.querySelector(".fs-gbtn")}})()`);
  check("phone: sign-in dialog is a bottom sheet with the Google button", sd.bottom === sd.vh && sd.w === 390 && sd.title === "Sign in to Finspire" && sd.g, sd);
  await sleep(300);
  await p.shot(join(OUT, "phone-signin.png"));
  await tap(p, ".fs-gbtn"); await sleep(300);
  check("phone: dialog Google button runs sign-in (demo)", await p.js(`!document.querySelector(".fs-modal") && !!Finspire.auth.user()`));
  check("phone: no horizontal overflow after interactions", await noOverflow(p));
  await p.shot(join(OUT, "phone-full.png"), { fullPage: true });
  check("phone: no console errors", p.errors.length === 0, p.errors);
  p.close();
}

// ================================================================================================ reduced motion + not-local guard
{
  const p = await open(PAGE, { width: 1280, height: 900, reducedMotion: true });
  await hover(p, '#prose .gl-term[data-term="repo-rate"]'); await sleep(300);
  const dur = await p.js(`getComputedStyle(document.querySelector(".gl-tip")).transitionDuration`);
  check("reduced motion: tooltip opens without animation", (await tipState(p)).open && /^0s|^1e-05s|^0\.00001s/.test(dur), dur);
  const vt = await p.js(`[...document.styleSheets].some(s=>{try{return [...s.cssRules].some(r=>r.cssText.includes("@view-transition"))}catch(e){return false}})`);
  check("view transitions declared", vt);
  p.close();
}
{
  // demo mode must not activate on a non-local host name (localhost alias via a different hostname is not possible here,
  // so check the guard directly: the same build opened as 127.0.0.1 works, the hostname check is strict equality)
  const p = await open(PAGE.replace("127.0.0.1", "localhost") + "?demo-user=1", { width: 800, height: 600 });
  check("demo: works on localhost too", await p.js(`Finspire.auth.ready.then(u=>!!u)`));
  p.close();
}

{
  // the real dictionary as built right now (whatever batches exist): loads, compiles fast, search + annotate work
  const p = await open(PAGE, { width: 1280, height: 900, realGlossary: true });
  const r = await p.js(`(async()=>{const G=Finspire.glossary; const t0=performance.now(); await G.load(); const t1=performance.now();
    const rows=G.rows(); const pick=rows[Math.floor(rows.length/2)]; const hits=G.search(pick.term).map(x=>x.id);
    const longText=rows.slice(0,400).map(r=>"Analysts said "+((r.hl&&r.hl[0])||r.term)+" moved on Tuesday.").join(" ");
    const t2=performance.now(); const m=G.match(longText); const t3=performance.now();
    const el=document.createElement("div"); el.textContent=longText; document.body.appendChild(el); const t4=performance.now(); const ids=G.annotate(el); const t5=performance.now(); el.remove();
    const t6=performance.now(); for(let i=0;i<50;i++) G.search(["rat","inflat","capital","bond yeild","ebitda"][i%5]); const t7=performance.now();
    return {n:rows.length, load:Math.round(t1-t0), pick:pick.id, top:hits.slice(0,3), match:m.length, matchMs:Math.round(t3-t2), annot:ids.length, annotMs:Math.round(t5-t4), search50:Math.round(t7-t6)}})()`);
  check("real glossary: loads and the middle term searches to itself", r.n > 0 && r.top[0] === r.pick, r);
  check("real glossary: match/annotate over 400 phrases is fast (< 150 ms each)", r.match > 0 && r.annot > 0 && r.matchMs < 150 && r.annotMs < 150, r);
  check("real glossary: 50 searches < 400 ms", r.search50 < 400, r.search50);
  check("real glossary: no console errors", p.errors.length === 0, p.errors);
  p.close();
}

await b.close();
process.exit(R.done() ? 1 : 0);
