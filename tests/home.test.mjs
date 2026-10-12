// Home page (src/home.html → index.html) in headless Chrome.
//   python3 scripts/build_site.py --demo --out .dev/home
//   python3 -m http.server 8806 -d .dev/home &
//   node --experimental-websocket tests/home.test.mjs http://127.0.0.1:8806/ [chromeDebugPort=9406]
// Screenshots go to tests/out/home/. Exits non-zero when a check fails.
//
// Most checks pin the small fixture dictionary (tests/fixtures/glossary, built to a temp folder) and a fixed set of
// three headlines, served in place of data/glossary/* and data/live/news.json through CDP request interception, so the
// term-highlight and tooltip checks don't depend on today's news or on the dictionary that is still being written.
// One block runs against the real build data (live market numbers, real headlines, real dictionary).
// GitHub is never called: Edit mode's save goes through a fetch mock installed in the page.
import { launch, reporter, sleep } from "./lib/cdp.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const base = (process.argv[2] || "http://127.0.0.1:8806/").replace(/\/?$/, "/");
const port = +(process.argv[3] || 9406);
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..");
const OUT = join(HERE, "out", "home");
const R = reporter(), check = R.check;
const b = await launch({ port });
const allErrors = [];

// ---- fixtures -------------------------------------------------------------------------------------------------------
const FIX = mkdtempSync(join(tmpdir(), "fs-home-gloss-"));
execFileSync("python3", [join(ROOT, "scripts/build_glossary.py"), "--src", join(ROOT, "tests/fixtures/glossary"), "--out", FIX], { stdio: "ignore" });
const now = Date.now(), iso = m => new Date(now - m * 60000).toISOString();
const NEWS = {
  updated: iso(1),
  items: [
    { id: "fx0000000001", t: "Nifty 50 ends higher as banks gain; Sensex adds 300 points", s: "Indian shares rose for a third day.", u: "https://example.com/markets/nifty-close", src: "Example Wire", ts: iso(6), rg: ["in"], mk: ["stocks"], terms: ["nifty-50", "sensex"] },
    { id: "fx0000000002", t: "Fed holds rates steady and signals patience on cuts", s: "The Federal Reserve kept its target range unchanged.", u: "https://example.com/us/fed-holds", src: "Example Wire", ts: iso(25), rg: ["us"], mk: ["cb", "rates"], terms: ["federal-reserve"] },
    { id: "fx0000000003", t: "Tech maker files for IPO in Mumbai", s: "The company plans to list next quarter.", u: "https://example.com/in/ipo-filing", src: "Example Wire", ts: iso(55), rg: ["in"], mk: ["deals"], terms: ["initial-public-offering"] }
  ],
  regions: { in: "India", us: "United States", eu: "Europe & UK", ap: "Asia-Pacific", me: "Middle East & Africa", gl: "Global" },
  markets: { stocks: "Stocks", rates: "Bonds & rates", cb: "Central banks", fx: "Currencies", cmd: "Commodities & energy", crypto: "Crypto", econ: "Economy", deals: "Companies & deals", policy: "Policy & regulation" }
};

async function open(url, opts = {}) {
  const p = await b.page("about:blank", Object.assign({}, opts, { wait: 50 }));
  if (opts.real !== true) {
    await p.send("Fetch.enable", { patterns: [{ urlPattern: "*/data/glossary/*" }, { urlPattern: "*/data/live/news.json*" }].concat(opts.config ? [{ urlPattern: "*/config.js*" }] : []) });
    p.on(m => {
      if (m.method !== "Fetch.requestPaused") return;
      const u = new URL(m.params.request.url), id = m.params.requestId;
      const ok = (body, type = "application/json") => p.send("Fetch.fulfillRequest", { requestId: id, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(body).toString("base64") }).catch(() => {});
      if (u.pathname.endsWith("/data/live/news.json")) return ok(JSON.stringify(NEWS));
      if (opts.config && u.pathname.endsWith("/config.js")) return ok("window.FINSPIRE_CONFIG = " + JSON.stringify(opts.config) + ";", "text/javascript");
      const rel = decodeURIComponent(u.pathname.split("/data/glossary/")[1] || ""), f = join(FIX, rel);
      if (rel && !rel.includes("..") && existsSync(f)) return ok(readFileSync(f));
      p.send("Fetch.fulfillRequest", { requestId: id, responseCode: 404, responseHeaders: [], body: "" }).catch(() => {});
    });
  }
  await p.goto(url, opts.wait || 2600);
  return p;
}
const done = p => { allErrors.push(...p.errors); p.close(); };

// ---- helpers --------------------------------------------------------------------------------------------------------
const center = (p, sel) => p.js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
  e.scrollIntoView({block:"center", behavior:"instant"}); const r=e.getClientRects()[0]||e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
async function hover(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(300); await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] }); return c; }
async function click(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(250);
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] });
  for (const type of ["mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: c[0], y: c[1], button: "left", clickCount: 1 }); await sleep(300); }
async function tap(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(300);
  await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c[0], y: c[1] }] });
  await sleep(60); await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(450); }
const q = async (p, e) => p.js(`(()=>{ return ${e}; })()`);
const goTo = async (p, sel, off = 90) => { await p.js(`scrollTo({top: document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().top + scrollY - ${off}, behavior: "instant"}); 1`); await sleep(700); };
const resize = async (p, width, height, mobile = false) => { await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile }); await sleep(700); };
const noOverflow = p => p.js("document.documentElement.scrollWidth <= innerWidth");
const shot = (p, name, o) => p.shot(join(OUT, name), o);
const waitFor = async (p, expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await p.js(`!!(${expr})`).catch(() => false)) return true; await sleep(200); } return false; };
// header from 961 to 1600 px: every item (logo, six links, account control, Join) on one line, nothing overlapping
const HDR_WIDTHS = [...new Set([961, 1000, 1100, 1180, 1280, 1440, ...Array.from({ length: 81 }, (_, i) => 961 + i * 8), 1600])].sort((x, y) => x - y);
async function headerSweep(p, want = 9) {
  const bad = {}, seen = {};
  for (const w of HDR_WIDTHS) {
    await p.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(60);
    const m = await p.js(`(()=>{const ni=document.querySelector('.nav-in');
      const items=[document.querySelector('.hdr .logo'), ...document.querySelectorAll('.nav-links > .nl, .nav-links > .mega-wrap > .nl, .nav-links > button.nl'), document.querySelector('#hdrAcct'), document.querySelector('.nav-cta .btn-primary')].filter(e => e && e.offsetParent);
      const r=items.map(e => e.getBoundingClientRect());
      let overlap=0; for(let i=1;i<r.length;i++) if(r[i].left < r[i-1].right - 0.5) overlap++;
      const tall=items.filter(e => e.getClientRects().length > 1 || e.getBoundingClientRect().height > 48).map(e => e.textContent.trim().slice(0,20));
      const tops=r.map(x => Math.round(x.top + x.height/2)), spread=Math.max(...tops)-Math.min(...tops);
      return {n: items.length, h: ni.offsetHeight, over: ni.scrollWidth > ni.clientWidth + 1, overlap, tall, spread, right: Math.round(r[r.length-1].right), vw: innerWidth, doc: document.documentElement.scrollWidth > innerWidth}})()`);
    seen[w] = m.n;
    if (m.n !== want || m.h !== 72 || m.over || m.overlap || m.tall.length || m.spread > 3 || m.right > m.vw - 15 || m.doc) bad[w] = m;
  }
  return { bad, widths: HDR_WIDTHS.length, items: [...new Set(Object.values(seen))] };
}
const NAV = ["Start here", "Repository", "Markets", "Dictionary", "Library", "Events"];

// =====================================================================================================================
// 1. Desktop, signed out: page basics, hero, repository, paths, mega menu (ported from tools/smoke.mjs)
// =====================================================================================================================
{
  const p = await open(base, { width: 1280, height: 900 });
  await waitFor(p, "document.readyState === 'complete' && window.FinspireMarkets && window.FinspireNews", 10000);
  const head = await q(p, `({doctype: !!document.doctype, root: document.querySelector('meta[name="fs-root"]')?.content, fs: typeof Finspire, mk: typeof window.FinspireMarkets, nw: typeof window.FinspireNews,
    css: [...document.styleSheets].map(s => s.href || "").filter(Boolean).map(h => new URL(h).pathname.replace(/^.*\\/assets\\//, "assets/")),
    data: (() => { try { JSON.parse(document.getElementById("siteData").textContent); return true; } catch (e) { return false; } })(),
    tpl: document.documentElement.innerHTML.includes("__" + "SRC_TEMPLATE__") || document.documentElement.innerHTML.includes("__" + "DRIVE_DEFAULT__"),
    b64logo: [...document.querySelectorAll('img.logo-img, .dash-org img, .mega-col img')].some(i => i.src.startsWith("data:")),
    logos: [...document.querySelectorAll('header .logo-img')].map(i => i.getAttribute("src"))})`);
  check("page: a full HTML document with fs-root ./ and the site data embedded once", head.doctype && head.root === "./" && head.data && !head.tpl, head);
  check("page: loads finspire.js, shell.css and markets.css; markets.js + news.js present", head.fs === "object" && head.css.includes("assets/css/shell.css") && head.css.includes("assets/css/markets.css") && head.mk === "object" && head.nw === "object", head);
  check("page: logos come from assets/img (no inline base64 logos)", !head.b64logo && head.logos.join() === "assets/img/logo-light.png,assets/img/logo-dark.png", head.logos);
  check("no console errors after load", p.errors.length === 0, p.errors);
  check("below-the-fold rendered after idle (6 tracks, paths)", (await q(p, "document.querySelectorAll('#grid .rgroup').length")) === 6 && (await q(p, "document.querySelectorAll('#pwList .pw-item').length")) >= 4);
  check("laptop has an inline transform", await q(p, "!!document.getElementById('deviceWrap').style.transform"));
  await shot(p, "desktop-top.png");

  await p.js("scrollTo({top: 900, behavior: 'instant'}); 1"); await sleep(700);
  const mid = await q(p, "({op: +getComputedStyle(document.getElementById('heroCopy')).opacity, land: land.style.transform, zoom: scene.zoom})");
  check("hero: scrolling zooms the laptop and fades the copy", mid.op < 1 && mid.land.startsWith("scale") && mid.zoom > 0, mid);
  await p.js("scrollTo({top: 0, behavior: 'instant'}); 1"); await sleep(700);
  const top = await q(p, "({op: +getComputedStyle(document.getElementById('heroCopy')).opacity, land: land.style.transform, zoom: scene.zoom, hdr: document.getElementById('hdr').className})");
  check("hero: back at the top everything resets", top.op === 1 && top.land === "" && top.zoom === 0 && !top.hdr.includes("scrolled"), top);

  // nav order, links, nothing extra
  const nav = await q(p, `({links: [...document.querySelectorAll('.nav-links > *')].map(a => a.textContent.trim()), hrefs: [...document.querySelectorAll('.nav-links > *')].map(a => a.getAttribute('href') || '#' + (a.getAttribute('aria-controls') || '')),
    mob: [...document.querySelectorAll('#mobileMenu a')].map(a => a.textContent.trim()), mobH: [...document.querySelectorAll('#mobileMenu a')].map(a => a.getAttribute('href')),
    ctaLinks: document.querySelectorAll('.nav-cta .nl').length, join: document.querySelector('.nav-cta .btn-primary')?.textContent.trim(), acct: document.getElementById('hdrAcct').hidden && !document.querySelector('#hdrAcct button'),
    order: [...document.querySelector('.nav-cta').children].map(c => c.id || c.className.split(' ')[0]),
    navAboutDrive: !!document.querySelector('.nav-links a[href="#about"], .nav-links a[href="#drive"], .mobile-menu a[href="#about"], .mobile-menu a[href="#drive"]'),
    footAbout: !!document.querySelector('footer a[href="#about"]'), footDrive: !!document.querySelector('footer a[href="#drive"]'),
    footTools: [...document.querySelectorAll('footer .fcol-tools a')].map(a => a.getAttribute('href'))})`);
  check("nav: Start here · Repository · Markets · Dictionary · Library · Events", JSON.stringify(nav.links) === JSON.stringify(NAV) &&
    JSON.stringify(nav.hrefs) === JSON.stringify(["#paths", "#mega", "markets/", "dictionary/", "library/", "#events"]), nav);
  check("nav: mobile menu lists the same links in the same order", JSON.stringify(nav.mob.slice(0, 6)) === JSON.stringify(NAV) &&
    JSON.stringify(nav.mobH.slice(0, 6)) === JSON.stringify(["#paths", "#repository", "markets/", "dictionary/", "library/", "#events"]), nav.mob);
  check("nav: right side is account slot (hidden: no Google client id yet) + Join Finspire; no LinkedIn/About/Drive text links in the menus", nav.ctaLinks === 0 && nav.join === "Join Finspire" && nav.acct &&
    nav.order.join() === "hdrAcct,btn,burger" && !nav.navAboutDrive, nav);
  check("footer: About and Drive still reachable; Tools column links Markets, Dictionary, Library", nav.footAbout && nav.footDrive && nav.footTools.join() === "markets/,dictionary/,library/", nav);
  const internal = await q(p, "[...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => h.startsWith('/'))");
  check("links: no root-absolute internal URLs", internal.length === 0, internal);

  // active state while scrolling through the page
  const active = {};
  for (const id of ["paths", "repository", "events"]) { await goTo(p, "#" + id, -160); await sleep(400);
    active[id] = await q(p, "[...document.querySelectorAll('.nav-links [aria-current]')].map(a => a.textContent.trim()).join('|')"); }
  await p.js("scrollTo({top: 0, behavior: 'instant'}); 1"); await sleep(500);
  active.top = await q(p, "document.querySelectorAll('.nav-links [aria-current]').length");
  check("nav: the section you're reading is marked (aria-current) and cleared at the top", active.paths === "Start here" && active.repository === "Repository" && active.events === "Events" && active.top === 0, active);

  await goTo(p, "#paths", 40);
  check("header turns light over the light band", await q(p, "document.getElementById('hdr').classList.contains('light-mode')"));
  await shot(p, "desktop-header-light.png");
  await p.js("document.querySelector('#pwList [data-sel=\"1\"]').click(); 1"); await sleep(300);
  check("paths: choosing a path shows its roadmap", (await q(p, "document.querySelector('#pwMap h3').textContent")) === (await q(p, "PATHS[1].n")));
  await p.js("document.querySelector('[data-toggle=\"val\"]').click(); 1"); await sleep(400);
  const g = await q(p, "(()=>{const s=document.getElementById('track-val'); const h=s.querySelector('.rg-head').getBoundingClientRect(), b=s.querySelector('.rg-body').getBoundingClientRect(); return {headBottom:Math.round(h.bottom), bodyTop:Math.round(b.top), rows:s.querySelectorAll('.rrow').length}})()");
  check("repository: an opened track shows its rows below the heading", g.bodyTop >= g.headBottom - 1 && g.rows > 0, g);
  await p.js("(()=>{const i=document.getElementById('q'); i.value='dcf'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()"); await sleep(250);
  check("repository: search filters", (await q(p, "document.querySelectorAll('#grid .rrow').length")) > 0, await q(p, "document.getElementById('count').textContent"));
  await p.js("document.getElementById('clear').click(); 1");
  await p.js("scrollTo({top:0,behavior:'instant'}); 1"); await sleep(300);
  await click(p, "#megaBtn"); await sleep(300);
  check("mega menu: hover opens it and the click that follows keeps it open, with content", await q(p, "!document.getElementById('mega').hidden && document.querySelectorAll('#megaCols .item').length > 5"));
  await shot(p, "desktop-mega.png");
  await p.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1"); await sleep(200);
  check("mega menu closes on Escape", await q(p, "document.getElementById('mega').hidden"));

  // header at laptop widths: one row, nothing overlaps or overflows
  const W = {};
  for (const w of [1440, 1280, 1100, 1000, 961]) {
    await resize(p, w, 900);
    W[w] = await q(p, `(()=>{const ni=document.querySelector('.nav-in'), links=[...document.querySelectorAll('.nav-links .nl')];
      const lg=document.querySelector('.hdr .logo').getBoundingClientRect(), nl=document.querySelector('.nav-links').getBoundingClientRect(), cta=document.querySelector('.nav-cta').getBoundingClientRect();
      return {h: ni.offsetHeight, over: ni.scrollWidth > ni.clientWidth + 1, multi: links.filter(l => l.getClientRects().length > 1 || l.offsetHeight > 44).length,
        gapL: Math.round(nl.left - lg.right), gapR: Math.round(cta.left - nl.right), right: Math.round(cta.right), vw: innerWidth, links: getComputedStyle(document.querySelector('.nav-links')).display, doc: document.documentElement.scrollWidth > innerWidth}})()`);
  }
  await resize(p, 1100, 900); await shot(p, "desktop-header-1100.png", {}); await resize(p, 961, 900); await shot(p, "desktop-header-961.png");
  const okW = Object.values(W).every(m => m.h === 72 && !m.over && m.multi === 0 && m.gapL >= 12 && m.gapR >= 12 && m.right <= m.vw - 15 && m.links !== "none" && !m.doc);
  check("header at 1440/1280/1100/1000/961 px: one row, no wrapping, no overlap, no overflow", okW, W);
  const sw = await headerSweep(p, 8);
  check(`header, local guest (no account control): logo + 6 links + Join on one line at all ${sw.widths} widths 961–1600 px`, Object.keys(sw.bad).length === 0, sw);
  const narrow = {};
  for (const w of [960, 820]) { await resize(p, w, 900);
    narrow[w] = await q(p, "({burger: getComputedStyle(document.getElementById('burger')).display, links: getComputedStyle(document.querySelector('.nav-links')).display, acct: document.getElementById('hdrAcct').getBoundingClientRect().width, join: getComputedStyle(document.querySelector('.nav-cta .btn-primary')).display, over: document.querySelector('.nav-in').scrollWidth > document.querySelector('.nav-in').clientWidth + 1})"); }
  check("header below 960 px: burger menu, no account control for the local guest", Object.values(narrow).every(n => n.burger !== "none" && n.links === "none" && n.acct === 0 && n.join === "none" && !n.over), narrow);
  await resize(p, 960, 900); await click(p, "#burger"); await sleep(300);
  const mm = await q(p, "({open: !document.getElementById('mobileMenu').hidden, exp: document.getElementById('burger').getAttribute('aria-expanded'), label: document.getElementById('burger').getAttribute('aria-label')})");
  await shot(p, "tablet-menu.png");
  await p.js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1"); await sleep(200);
  check("burger opens the menu (aria-expanded, label) and Escape closes it", mm.open && mm.exp === "true" && mm.label === "Close menu" && (await q(p, "document.getElementById('mobileMenu').hidden")), mm);
  check("no console errors in the desktop run", p.errors.length === 0, p.errors);
  done(p);
}

// =====================================================================================================================
// 2. Markets & News section (fixture dictionary + fixed headlines; live market numbers)
// =====================================================================================================================
{
  const p = await open(base, { width: 1280, height: 900 });
  const order = await q(p, "[...document.querySelector('main').children].map(e => e.id || e.className.split(' ')[0]).slice(0, 4).join(',')");
  check("Markets & News sits after the about/product section and before Start here", order === "top,about,markets-news,light", order);
  const lazy = await q(p, "document.querySelector('#mnBoard .mn-wait') !== null");
  check("Markets & News waits until it's near the screen before mounting (hero first)", lazy);
  await goTo(p, "#markets-news", 80);
  const ok = await waitFor(p, "document.querySelectorAll('#mnNews a[href^=\"https://\"]').length >= 3 && document.querySelector('#mnTodBody .mn-tod-in') && /\\d/.test(document.getElementById('mnBoard').textContent)", 10000);
  await sleep(1200);
  const mn = await q(p, `(()=>{const b=document.getElementById('mnBoard'), n=document.getElementById('mnNews');
    const heads=[...n.querySelectorAll('a[href]')].filter(a => /^https?:/.test(a.href));
    return {board: b.textContent.replace(/\\s+/g,' ').trim().slice(0, 300), names: ["Nifty", "Sensex", "S&P", "10", "Brent", "INR"].filter(k => b.textContent.includes(k)).length,
      nums: (b.textContent.match(/\\d[\\d,]*\\.\\d+/g) || []).length, wait: !!b.querySelector('.mn-wait'),
      heads: [...new Set(heads.map(a => a.href))].length, safe: heads.every(a => a.target === "_blank" && /noopener/.test(a.rel) && /noreferrer/.test(a.rel)),
      terms: [...n.querySelectorAll('.gl-term')].map(t => t.dataset.term), btns: [...document.querySelectorAll('.mn-ctas a')].map(a => a.textContent.trim() + ' ' + a.getAttribute('href'))}})()`);
  check("mini-board shows the six instruments with live numbers", ok && mn.names >= 5 && mn.nums >= 6 && !mn.wait, mn);
  check("three latest headlines, opened safely in a new tab", mn.heads === 3 && mn.safe, mn);
  check("headline terms are highlighted for the dictionary", mn.terms.length >= 2, mn.terms);
  check("buttons: Open Markets & News (markets/) and Open the Dictionary (dictionary/)", mn.btns.join("|") === "Open Markets & News markets/|Open the Dictionary dictionary/", mn.btns);
  const tod = await q(p, `(()=>{const t=Finspire.glossary.termOfDay(), c=document.getElementById('mnTod');
    return {want: t && t.id, term: c.querySelector('h3')?.textContent, def: c.querySelector('.mn-tod-def')?.textContent, kid: c.querySelector('.mn-kid:not([hidden]) span')?.textContent || "",
      href: c.querySelector('a.link')?.getAttribute('href'), wantTerm: t && t.term, lvl: c.querySelector('.gl-lvl')?.textContent, date: document.getElementById('mnTodDate').textContent}})()`);
  check("term of the day: term, plain meaning, Like I'm three and a dictionary link", tod.term === tod.wantTerm && tod.def && tod.def.length > 20 && tod.kid.length > 10 &&
    tod.href === "./dictionary/#t=" + encodeURIComponent(tod.want) && !!tod.date, tod);
  await shot(p, "desktop-markets-news.png");
  if (mn.terms.length) {
    await hover(p, "#mnNews .gl-term"); await sleep(700);
    const tip = await q(p, "({show: !!document.querySelector('.gl-tip.gl-show'), term: document.querySelector('.gl-tip-term')?.textContent, open: document.querySelector('.gl-tip-open')?.getAttribute('href')})");
    check("hovering a highlighted headline term opens its dictionary tooltip", tip.show && tip.term && tip.term !== "Loading…" && /dictionary\/#t=/.test(tip.open || ""), tip);
    await shot(p, "desktop-news-tooltip.png");
    await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 450 }); await sleep(500);
  } else check("hovering a highlighted headline term opens its dictionary tooltip", false, "no .gl-term in the teaser");
  check("Markets & News: no console errors", p.errors.length === 0, p.errors);
  done(p);
}

// real data: live numbers, real headlines, real dictionary
{
  const p = await open(base, { width: 1280, height: 900, real: true });
  await goTo(p, "#markets-news", 80);
  const ok = await waitFor(p, "document.querySelectorAll('#mnNews a[href^=\"http\"]').length >= 3 && document.querySelector('#mnTodBody .mn-tod-in, #mnTodBody .mn-empty')", 10000);
  const r = await q(p, "({nums: (document.getElementById('mnBoard').textContent.match(/\\d[\\d,]*\\.\\d+/g) || []).length, heads: document.querySelectorAll('#mnNews a[href^=\"http\"]').length, tod: document.querySelector('#mnTod h3')?.textContent || document.querySelector('#mnTod .mn-empty')?.textContent})");
  check("real data: numbers, three real headlines and a term of the day", ok && r.nums >= 6 && r.heads >= 3 && !!r.tod, r);
  check("real data: no console errors", p.errors.length === 0, p.errors);
  done(p);
}

// =====================================================================================================================
// 3. Account control (demo sign-in / sign-out on localhost)
// =====================================================================================================================
{
  const p = await open(base + "?demo-user=1", { width: 1280, height: 900 });
  const a1 = await q(p, "({btn: !!document.querySelector('#hdrAcct .fs-acct-btn'), name: document.querySelector('#hdrAcct .fs-acct-name')?.textContent, fab: document.getElementById('editFab').hidden})");
  check("account: demo student is signed in (avatar + name in the header)", a1.btn && a1.name === "Demo", a1);
  const sw = await headerSweep(p);
  check(`header, signed in: logo + 6 links + avatar + Join on one line at all ${sw.widths} widths 961–1600 px`, Object.keys(sw.bad).length === 0, sw);
  await resize(p, 1280, 900);
  check("edit mode: hidden for a signed-in student who isn't an admin", a1.fab === true, a1);
  await click(p, "#hdrAcct .fs-acct-btn"); await sleep(300);
  const menu = await q(p, "({open: !document.querySelector('#hdrAcct .fs-menu').hidden, items: [...document.querySelectorAll('#hdrAcct .fs-menu [role=menuitem]')].map(i => i.textContent.trim())})");
  check("account: menu opens with My dictionary, Library, Sign out", menu.open && menu.items.join("|") === "My dictionary|Library|Sign out", menu);
  await shot(p, "desktop-account-menu.png");
  await click(p, "#hdrAcct .fs-out"); await sleep(500);
  check("account: sign out shows the Sign in button again", await q(p, "!!document.querySelector('#hdrAcct .fs-acct-in') && !Finspire.auth.user()"));
  const sw2 = await headerSweep(p);
  check(`header, signed out: logo + 6 links + Sign in + Join on one line at all ${sw2.widths} widths 961–1600 px`, Object.keys(sw2.bad).length === 0, sw2);
  const narrow = {};
  for (const w of [960, 820]) { await resize(p, w, 900);
    narrow[w] = await q(p, "({burger: getComputedStyle(document.getElementById('burger')).display, links: getComputedStyle(document.querySelector('.nav-links')).display, acct: document.getElementById('hdrAcct').getBoundingClientRect().width, join: getComputedStyle(document.querySelector('.nav-cta .btn-primary')).display, over: document.querySelector('.nav-in').scrollWidth > document.querySelector('.nav-in').clientWidth + 1})"); }
  check("header below 960 px: burger menu, Sign in still visible", Object.values(narrow).every(n => n.burger !== "none" && n.links === "none" && n.acct > 30 && n.join === "none" && !n.over), narrow);
  await resize(p, 1280, 900);
  await click(p, "#hdrAcct .fs-acct-in"); await sleep(500);
  check("account: Sign in (demo) brings the avatar back", await q(p, "!!document.querySelector('#hdrAcct .fs-acct-btn') && Finspire.auth.user()?.email === 'demo.student@iimranchi.ac.in'"));
  await goTo(p, "#paths", 40); await sleep(300);
  await shot(p, "desktop-account-light.png");
  check("account: no console errors", p.errors.length === 0, p.errors);
  done(p);
}
{
  const p = await open(base, { width: 1280, height: 900 });
  const g = await q(p, "({hidden: document.getElementById('hdrAcct').hidden, btns: document.querySelectorAll('#hdrAcct button, [data-fs-signin], .fs-gbtn').length, guest: !!(Finspire.auth.user() || {}).guest})");
  check("account: without a Google client id there is no Sign in anywhere; the visitor is a local guest", g.hidden && g.btns === 0 && g.guest, g);
  const gd = await q(p, `({lede: document.querySelector('#drive .lede').textContent, links: [...document.querySelectorAll('#driveGrid a.df, #driveCtas a')].map(a => a.getAttribute('href')), lib: document.querySelectorAll('#drive a[href*="library/"]').length})`);
  check("Drive, no client id: folders open in Google Drive (the Library can't open files yet) and the copy doesn't promise sign-in", gd.lib === 0 && gd.links.length > 0 && gd.links.every(h => /^https:\/\/drive\.google\.com\//.test(h)) && !/right here/.test(gd.lede), gd);
  check("edit mode: hidden for visitors", await q(p, "document.getElementById('editFab').hidden"));
  done(p);
}

// =====================================================================================================================
// 4. Drive section → Library (sign-in usable: demo), field term cards → Dictionary
// =====================================================================================================================
{
  const p = await open(base + "?demo-user=1", { width: 1280, height: 900 });
  const d0 = await q(p, `({cards: document.querySelectorAll('#driveGrid .df').length, soon: document.querySelectorAll('#driveGrid .df.soon').length,
    anchors: [...document.querySelectorAll('#driveGrid a.df')].map(a => a.getAttribute('href')), labels: [...document.querySelectorAll('#driveGrid a.df .open-d')].map(s => s.textContent.trim()),
    ctas: [...document.querySelectorAll('#driveCtas a')].map(a => a.textContent.trim() + ' ' + a.getAttribute('href') + ' ' + (a.target || '')),
    google: [...document.querySelectorAll('#drive a[href]')].filter(a => /google\\.com/.test(a.href)).length, lede: document.querySelector('#drive .lede').textContent,
    count: document.getElementById('driveCount').textContent})`);
  const dr = await q(p, "({n: DRIVE.folders.length, linked: DRIVE.folders.filter(f => /^https?:\\/\\/\\S+$/.test(f.u||'') && f.u !== 'https://').length, ids: DRIVE.folders.filter(f => /\\/folders\\//.test(f.u||'')).map(f => f.u.split('/folders/')[1].split(/[?#/]/)[0])})");
  check("Drive: linked folders open in the Library (library/?f=<folder id>), the rest say coming soon", d0.cards === dr.n && d0.anchors.length === dr.linked && d0.soon === dr.n - dr.linked &&
    d0.anchors.every((h, i) => h === "./library/?f=" + dr.ids[i]) && d0.labels.every(l => l === "Open in the Library"), { ...d0, ...dr });
  check("Drive: Open the full Drive → library/, Add your files → library/#upload, nothing points at drive.google.com", d0.ctas.join("|") === "Open the full Drive ./library/ |Add your files ./library/#upload " && d0.google === 0, d0.ctas);
  check("Drive: copy says files open here after signing in with an IIM Ranchi account", /IIM Ranchi account/.test(d0.lede) && /right here/.test(d0.lede), d0.lede);
  await goTo(p, "#drive"); await shot(p, "desktop-drive.png");

  // field: term cards link to the dictionary when it has the term (fixture dictionary: GDP, IPO, SENSEX, NIFTY 50, bps, Repo)
  await goTo(p, "#field"); await sleep(900);
  await waitFor(p, "Finspire.glossary.loaded()", 5000);
  const cards = await p.js(`(()=>{const st=document.getElementById('stage'); const r=st.getBoundingClientRect(); const seen={};
    for(let gy=0.08; gy<0.92; gy+=0.05){ for(let gx=0.03; gx<0.98; gx+=0.025){ const x=r.left+r.width*gx, y=r.top+r.height*gy;
      st.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:y,bubbles:true,pointerType:'mouse'}));
      st.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true,pointerType:'mouse'}));
      const c=st.querySelector('.term-card'); if(c){ const a=c.querySelector('a'); seen[c.querySelector('b').textContent]=[a.getAttribute('href'), a.textContent, a.dataset.track||""]; } } } return seen})()`);
  const EXP = { "GDP": "gross-domestic-product", "IPO": "initial-public-offering", "SENSEX": "sensex", "NIFTY 50": "nifty-50", "bps": "basis-point", "Repo": "repo-rate" };
  const names = Object.keys(cards), dictCards = names.filter(n => cards[n][1].startsWith("Open in Dictionary"));
  const wrong = names.filter(n => EXP[n] ? cards[n][0] !== "./dictionary/#t=" + EXP[n] : !(cards[n][0] === "#repository" && cards[n][2] && /^Learn it in /.test(cards[n][1])));
  check("market field: term cards open the Dictionary when it has the term, otherwise the repository track", names.length > 8 && dictCards.length >= 1 && wrong.length === 0, { seen: names.length, dict: dictCards, wrong: wrong.map(n => [n, cards[n]]) });
  await p.js(`(()=>{const st=document.getElementById('stage'); const r=st.getBoundingClientRect(); for(let gy=0.15; gy<0.9; gy+=0.05){ for(let gx=0.05; gx<0.95; gx+=0.03){ const x=r.left+r.width*gx, y=r.top+r.height*gy;
    st.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:y,bubbles:true,pointerType:'mouse'})); st.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true,pointerType:'mouse'}));
    const c=st.querySelector('.term-card'); if(c && c.querySelector('a').getAttribute('href').startsWith('./dictionary/')) return 1; } } return 0})()`);
  await sleep(300); await shot(p, "desktop-field-card.png");
  check("Drive + field: no console errors", p.errors.length === 0, p.errors);
  done(p);
}

// =====================================================================================================================
// 5. Edit mode (admins only) and the GitHub save path (fetch to api.github.com is mocked)
// =====================================================================================================================
const MOCK = `(()=>{ if(window.__gh) return; const real = window.fetch; window.__gh = {calls: [], mode: {get: 200, put: 201}, remote: null};
  window.fetch = async (u, o = {}) => { const url = String(u && u.url || u);
    if(!url.startsWith("https://api.github.com/")) return real(u, o);
    const m = (o.method || "GET").toUpperCase(); __gh.calls.push({url, method: m, headers: o.headers || {}, body: o.body || null});
    const st = m === "GET" ? __gh.mode.get : __gh.mode.put;
    const json = (s, b, h = {}) => new Response(JSON.stringify(b), {status: s, headers: Object.assign({"Content-Type": "application/json"}, h)});
    if(st !== 200 && st !== 201) return json(st, {message: "mock " + st}, __gh.mode.limit ? {"x-ratelimit-remaining": "0"} : {});
    if(m === "GET"){ const txt = __gh.remote != null ? __gh.remote : document.getElementById("siteData").textContent;
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(txt))).replace(/(.{60})/g, "$1\\n");
      return json(200, {sha: "sha-remote-1", encoding: "base64", content: b64}); }
    try{ __gh.remote = new TextDecoder().decode(Uint8Array.from(atob(JSON.parse(o.body).content), ch => ch.charCodeAt(0))); }catch(e){}
    return json(201, {content: {sha: "sha-new"}, commit: {sha: "c0ffee"}}); }; })()`;
const decodePut = `(()=>{const c=__gh.calls.filter(x=>x.method==='PUT').pop(); if(!c) return null; const b=JSON.parse(c.body);
  const txt=new TextDecoder().decode(Uint8Array.from(atob(b.content), ch => ch.charCodeAt(0))); return {url: c.url, auth: c.headers.Authorization || c.headers.authorization, msg: b.message, branch: b.branch, sha: b.sha, txt}})()`;
{
  const p = await open(base + "?demo-user=1&demo-admin=1", { width: 1280, height: 900 });
  await p.js("localStorage.removeItem('fs.gh.token'); 1");
  check("edit mode: Edit site button shows for the demo admin (localhost, ?demo-admin=1)", await q(p, "!document.getElementById('editFab').hidden"));
  await p.js(MOCK);
  await click(p, "#editFab"); await sleep(400);
  check("edit mode: in-place editing switches on", await q(p, "document.documentElement.classList.contains('editing') && !document.getElementById('edBar').hidden && document.querySelectorAll('[contenteditable=true]').length > 20"));
  const newSection = await q(p, "[...document.querySelectorAll('#markets-news [data-ck]')].map(e => e.dataset.ck)");
  const keys = await q(p, `({drive: document.querySelector('#drive .lede').dataset.ck, about: document.querySelector('#about .h2').dataset.ck, quote: document.querySelector('.quote blockquote').dataset.ck,
    foot: [...document.querySelectorAll('footer [data-ck]')].map(e => e.dataset.ck + '=' + e.textContent.trim().slice(0, 12).trim()).join(','), tools: document.querySelectorAll('.fcol-tools [data-ck]').length,
    live: document.querySelectorAll('#mnBoard [data-ck], #mnNews [data-ck], #mnTod [data-ck], .mn-ctas [data-ck], header [data-ck]').length,
    leak: [...document.querySelectorAll('[data-ck^="markets-news|"]')].filter(e => !e.closest('#markets-news')).length})`);
  const FOOT = "footer|b|1=Repository,footer|b|2=Start here,footer|b|3=Club,footer|a|1=About Finspi,footer|a|2=Flagship eve,footer|a|3=Join the clu,footer|a|4=Suggest a re,footer|b|4=Follow,footer|a|5=LinkedIn,footer|a|6=IIM Ranchi,footer|p|1=Finspire is";
  check("edit mode: the new section has its own copy keys; existing keys unchanged; live widgets not editable", newSection.join() === "markets-news|span|1,markets-news|h2|1,markets-news|p|1" &&
    keys.drive === "drive|p|1" && keys.about === "about|h2|1" && keys.quote === "quote|blockquote|1" && keys.foot === FOOT && keys.tools === 0 && keys.live === 0 && keys.leak === 0, Object.assign({}, keys, { foot: keys.foot === FOOT ? "same" : keys.foot }));
  // Drive link editing still works (ported from tools/smoke.mjs)
  await goTo(p, "#drive");
  // indexes come from the live data (admins add folders): the first folder still without a link, and the next new one
  const EI = await q(p, "DRIVE.folders.findIndex(f => !/^https?:\\/\\/\\S+$/.test(f.u || '') || f.u === 'https://')"), NI = await q(p, "DRIVE.folders.length");
  await p.js(`document.querySelector('#driveGrid .df .go [data-gear="d:${EI}"]').click(); 1`); await sleep(200);
  await p.js("(()=>{const f=document.querySelector('#edDialog form'); f.querySelector('[name=u]').value='https://drive.google.com/drive/folders/EXAMPLE_FOLDER_ID_123?usp=sharing'; f.requestSubmit(); return 1})()"); await sleep(250);
  await p.js("document.querySelector('[data-adddrive]').click(); 1"); await sleep(300);
  await p.js(`(()=>{const el=document.querySelector('[data-b="d.${NI}.t"]'); el.textContent='Case competitions'; el.dispatchEvent(new Event('input',{bubbles:true})); el.blur(); return 1})()`); await sleep(400);
  await p.js("(()=>{const el=document.querySelector('#markets-news h2'); el.textContent='Markets, made plain.'; el.dispatchEvent(new Event('input',{bubbles:true})); el.blur(); return 1})()"); await sleep(300);
  const ed = await q(p, `({u: DRIVE.folders[${EI}].u, n: DRIVE.folders.length, t: DRIVE.folders[${NI}]?.t, dirty: ED.dirty, copy: S.copy['markets-news|h2|1']})`);
  check("edit mode: paste a Drive link, add a folder, edit copy", EI >= 0 && ed.u.includes("EXAMPLE_FOLDER_ID_123") && ed.n === NI + 1 && ed.t === "Case competitions" && ed.dirty && ed.copy === "Markets, made plain.", ed);
  await shot(p, "desktop-edit-mode.png");

  // publish with no repository configured (whatever config.js holds, start from an empty github block)
  await p.js("Finspire.cfg.github.owner = ''; Finspire.cfg.github.repo = ''; 1");
  await click(p, "#edPublish"); await sleep(400);
  const ns = await q(p, "({title: document.querySelector('.fs-modal.fs-show .fs-modal-title')?.textContent, calls: __gh.calls.length})");
  check("publish: explains an admin must fill github owner/repo in config.js first", /isn't set up yet/.test(ns.title || "") && ns.calls === 0 && /config\.js/.test(await q(p, "document.querySelector('.fs-modal.fs-show').textContent")), ns);
  await p.js("document.querySelector('.fs-modal.fs-show .fs-mbtn.primary').click(); 1"); await sleep(350);

  // configure a repository → token dialog → save
  await p.js("Finspire.cfg.github.owner = 'finspire-club'; Finspire.cfg.github.repo = 'finspire-site'; Finspire.cfg.github.branch = 'main'; 1");
  await click(p, "#edPublish"); await sleep(400);
  const td = await q(p, "({title: document.querySelector('.fs-modal.fs-show .fs-modal-title')?.textContent, text: document.querySelector('.fs-modal.fs-show')?.textContent || '', input: !!document.querySelector('#ghTok'), fs: getComputedStyle(document.querySelector('#ghTok')).fontSize, focus: document.activeElement?.id})");
  check("publish: first time, a dialog asks for a fine-grained token and explains how to make one", /Connect GitHub/.test(td.title || "") && td.input && td.fs === "16px" && td.focus === "ghTok" &&
    /Fine-grained/.test(td.text) && /Contents/.test(td.text) && /Read and write/.test(td.text) && /only in this browser/.test(td.text) && /finspire-club\/finspire-site/.test(td.text), td);
  await shot(p, "desktop-token-dialog.png");
  await p.js("(()=>{const i=document.getElementById('ghTok'); i.focus(); return 1})()"); await p.type("github_pat_TESTTOKEN_0123456789abcdef");
  await p.js("document.querySelector('.fs-modal.fs-show .fs-mbtn.primary').click(); 1");
  await waitFor(p, "__gh.calls.some(c => c.method === 'PUT')", 4000); await sleep(400);
  const put = await q(p, decodePut);
  const expected = await q(p, "JSON.stringify(siteObj(), null, 1)");
  let parsed = null; try { parsed = JSON.parse(put.txt); } catch (e) {}
  check("publish: GET for the sha, then PUT data/site-data.json with the token", put && put.url === "https://api.github.com/repos/finspire-club/finspire-site/contents/data/site-data.json" && put.auth === "Bearer github_pat_TESTTOKEN_0123456789abcdef" &&
    put.msg === "Update site content from Edit mode" && put.branch === "main" && put.sha === "sha-remote-1" && (await q(p, "__gh.calls[0].method + ' ' + __gh.calls[0].url")).startsWith("GET https://api.github.com/repos/finspire-club/finspire-site/contents/data/site-data.json?ref=main"), put && { ...put, txt: put.txt.length });
  check("publish: the PUT body decodes (base64, UTF-8) to the edited site JSON", put && put.txt === expected && parsed && parsed.drive.folders[EI].u.includes("EXAMPLE_FOLDER_ID_123") && parsed.drive.folders[NI].t === "Case competitions" &&
    parsed.settings.copy["markets-news|h2|1"] === "Markets, made plain." && parsed.resources.length > 50 && put.txt.includes("Bulls & Bears"), parsed && { folders: parsed.drive.folders.length });
  const after = await q(p, "({toast: [...document.querySelectorAll('.fs-toast')].map(t => t.textContent).join(' | '), state: document.getElementById('edState').textContent, dirty: ED.dirty, token: localStorage.getItem('fs.gh.token')})");
  check("publish: toast says it's saved and the live site updates in about a minute; token kept in this browser", /Saved — the live site updates in about a minute\./.test(after.toast) && !after.dirty && after.token === "github_pat_TESTTOKEN_0123456789abcdef", after);
  await shot(p, "desktop-saved-toast.png");

  // a second save reuses the token without asking
  await p.js("__gh.calls = []; (()=>{const el=document.querySelector('#markets-news h2'); el.textContent='Markets, made plainer.'; el.dispatchEvent(new Event('input',{bubbles:true})); el.blur(); return 1})()"); await sleep(300);
  await click(p, "#edPublish"); await waitFor(p, "__gh.calls.some(c => c.method === 'PUT')", 4000); await sleep(300);
  const put2 = await q(p, decodePut), dlg2 = await q(p, "!!document.querySelector('.fs-modal.fs-show')");
  check("publish: the next save uses the stored token (no dialog) and sends the new edit", !dlg2 && put2 && JSON.parse(put2.txt).settings.copy["markets-news|h2|1"] === "Markets, made plainer.", { dlg2 });

  // error handling
  const errCase = async (mode, expect, label, opts = {}) => {
    await p.js(`document.querySelectorAll('.fs-modal, .fs-toast').forEach(m => m.remove()); document.documentElement.classList.remove('fs-lock'); __gh.calls = []; __gh.mode = ${JSON.stringify(mode)}; ${opts.remote ? "__gh.remote = " + JSON.stringify(opts.remote) + ";" : ""} localStorage.setItem('fs.gh.token', 'github_pat_TESTTOKEN_0123456789abcdef'); markDirty(); 1`);
    await click(p, "#edPublish"); await sleep(900);
    const r = await q(p, "({modal: document.querySelector('.fs-modal.fs-show')?.textContent || '', toasts: [...document.querySelectorAll('.fs-toast')].map(t => t.textContent).join(' | '), token: localStorage.getItem('fs.gh.token'), dirty: ED.dirty, puts: __gh.calls.filter(c => c.method === 'PUT').length, state: document.getElementById('edState').textContent})");
    check("publish errors: " + label, expect.test(r.modal + " " + r.toasts) && r.dirty === true && (opts.puts == null || r.puts === opts.puts) && (opts.token === undefined || r.token === opts.token), r);
    return r;
  };
  await errCase({ get: 401, put: 201 }, /didn't accept the token/, "401 → token rejected, forgotten, asks for a new one", { token: null, puts: 0 });
  await shot(p, "desktop-token-401.png");
  await errCase({ get: 200, put: 403 }, /can't save to finspire-club\/finspire-site.*Contents: Read and write/s, "403 → token lacks Contents: Read and write");
  await errCase({ get: 403, put: 201, limit: true }, /request limit/, "403 rate limit → try again later");
  await errCase({ get: 404, put: 201 }, /couldn't find data\/site-data\.json in finspire-club\/finspire-site/, "404 → repository/file not found, check config.js");
  await errCase({ get: 200, put: 409 }, /Someone else saved first/, "409 → someone saved first; nothing overwritten");
  const stale = await errCase({ get: 200, put: 201 }, /Someone else saved first/, "remote changed since the page loaded → asks before replacing", { remote: '{"settings":{"headline":"changed elsewhere"}}', puts: 0 });
  void stale;
  await p.js("[...document.querySelectorAll('.fs-modal.fs-show .fs-mbtn')].find(b => /Replace with mine/.test(b.textContent)).click(); 1");
  await waitFor(p, "__gh.calls.some(c => c.method === 'PUT')", 4000); await sleep(300);
  check("publish: 'Replace with mine' saves anyway", await q(p, "__gh.calls.filter(c => c.method === 'PUT').length === 1 && !ED.dirty"));
  // forget token
  await p.js("document.querySelectorAll('.fs-modal').forEach(m => m.remove()); document.documentElement.classList.remove('fs-lock'); document.querySelector('[data-ed=\"site\"]').click(); 1"); await sleep(300);
  const hasForget = await q(p, "!!document.querySelector('#edDialog [data-ghforget]')");
  await p.js("document.querySelector('#edDialog [data-ghforget]')?.click(); 1"); await sleep(200);
  check("edit mode: Forget GitHub token (in Site settings) removes it from this browser", hasForget && (await q(p, "localStorage.getItem('fs.gh.token')")) === null);
  await p.js("document.querySelector('#edDialog [data-close]')?.click(); document.querySelector('[data-ed=\"done\"]').click(); 1"); await sleep(400);
  const d1 = await q(p, "({anchor: [...document.querySelectorAll('#driveGrid a.df')].map(a => a.getAttribute('href')).find(h => h.includes('EXAMPLE_FOLDER_ID_123')), editing: document.documentElement.classList.contains('editing'), fab: !document.getElementById('editFab').hidden})");
  check("after editing: the pasted folder opens in the Library and Edit site is back", d1.anchor === "./library/?f=EXAMPLE_FOLDER_ID_123" && !d1.editing && d1.fab, d1);
  check("edit mode: no console errors", p.errors.length === 0, p.errors);
  await p.js("localStorage.removeItem('fs.gh.token'); 1");
  done(p);
}

// =====================================================================================================================
// 6. Phone 390 × 844
// =====================================================================================================================
{
  const p = await open(base, { width: 390, height: 844, mobile: true, scale: 2 });
  await shot(p, "phone-top.png");
  const ph = await q(p, `({announce: getComputedStyle(document.querySelector('.announce')).display, panel: getComputedStyle(document.querySelector('.product-panel')).display,
    steps: getComputedStyle(document.querySelector('.repo-steps')).display, tiles: getComputedStyle(document.getElementById('tiles')).display, chips: getComputedStyle(document.getElementById('chips')).flexWrap,
    chipsH: document.getElementById('chips').offsetHeight, paused, burger: getComputedStyle(document.getElementById('burger')).display, acct: document.getElementById('hdrAcct').getBoundingClientRect().width,
    acctHidden: document.getElementById('hdrAcct').hidden})`);
  check("phone: announcement, tour mock, repo explainer and tiles hidden; chips in one row; tour paused", ph.announce === "none" && ph.panel === "none" && ph.steps === "none" && ph.tiles === "none" && ph.chips === "nowrap" && ph.chipsH < 60 && ph.paused === true, ph);
  check("phone: header has the burger; no account control for the local guest", ph.burger !== "none" && ph.acct === 0 && ph.acctHidden, ph);
  await tap(p, "#burger"); await sleep(300);
  const mob = await q(p, "({open: !document.getElementById('mobileMenu').hidden, links: [...document.querySelectorAll('#mobileMenu a')].map(a => a.textContent.trim()), h: Math.min(...[...document.querySelectorAll('#mobileMenu a')].map(a => a.getBoundingClientRect().height))})");
  check("phone: burger menu lists the same links, each at least 40 px tall", mob.open && JSON.stringify(mob.links.slice(0, 6)) === JSON.stringify(NAV) && mob.h >= 40, mob);
  await shot(p, "phone-menu.png");
  await tap(p, "#burger"); await sleep(200);
  await goTo(p, "#markets-news", 72);
  await waitFor(p, "document.querySelectorAll('#mnNews a[href^=\"https://\"]').length >= 3 && document.querySelector('#mnTodBody .mn-tod-in') && /\\d/.test(document.getElementById('mnBoard').textContent)", 10000);
  await sleep(1500);
  const mn = await q(p, `(()=>{const s=document.getElementById('markets-news'); const small=[...s.querySelectorAll('a[href], button')].filter(e => e.offsetParent && !e.closest('.gl-term')).map(e => [e.textContent.trim().slice(0, 30), Math.round(e.getBoundingClientRect().height)]).filter(x => x[1] < 40);
    const g=(sel)=>{const e=s.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().left) : null};
    return {h: s.offsetHeight, small, gut: [g('.mn-copy'), g('.mn-board'), g('.mn-news'), g('.mn-tod')], ctas: [...s.querySelectorAll('.mn-ctas .btn')].map(b => Math.round(b.getBoundingClientRect().height))}})()`);
  check("phone: Markets & News is compact (≤ 900 px), 16 px gutters, tap targets ≥ 40 px", mn.h <= 900 && mn.gut.every(x => x === 16) && mn.small.length === 0 && mn.ctas.every(x => x >= 40), mn);
  await shot(p, "phone-markets-news.png");
  await p.js("scrollBy(0, 420); 1"); await sleep(500); await shot(p, "phone-markets-news-2.png");
  if (await q(p, "!!document.querySelector('#mnNews .gl-term')")) {
    await tap(p, "#mnNews .gl-term"); await sleep(600);
    const sh = await q(p, "({sheet: !!document.querySelector('.gl-tip.gl-sheet.gl-show'), term: document.querySelector('.gl-tip-term')?.textContent, href: location.href})");
    check("phone: tapping a headline term opens the dictionary sheet (and doesn't follow the link)", sh.sheet && !!sh.term && sh.href.startsWith(base), sh);
    await shot(p, "phone-term-sheet.png");
    await p.js("document.querySelector('.gl-tip-x')?.click(); 1"); await sleep(400);
  } else check("phone: tapping a headline term opens the dictionary sheet (and doesn't follow the link)", false, "no .gl-term in the teaser");
  await goTo(p, "#drive", 72); await shot(p, "phone-drive.png");
  await p.js("scrollTo(0, document.documentElement.scrollHeight); 1"); await sleep(800); await shot(p, "phone-footer.png");
  const size = await q(p, "({pageH: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth > innerWidth, sw: document.documentElement.scrollWidth})");
  check("phone: page under 15,500 px tall and no sideways scroll", size.pageH < 15500 && !size.overflow, size);
  // rotate back to desktop
  await p.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(900);
  const dk = await q(p, "({announce: getComputedStyle(document.querySelector('.announce')).display, panel: getComputedStyle(document.querySelector('.product-panel')).display, tiles: getComputedStyle(document.getElementById('tiles')).display, chips: getComputedStyle(document.getElementById('chips')).flexWrap, paused, menu: document.getElementById('mobileMenu').hidden})");
  check("desktop after rotating back: everything restored and the tour resumes", dk.announce !== "none" && dk.panel !== "none" && dk.tiles !== "none" && dk.chips === "wrap" && dk.paused === false, dk);
  check("phone: no console errors", p.errors.length === 0, p.errors);
  done(p);
}
{
  // phone, signed in: account avatar fits, menu full width
  const p = await open(base + "?demo-user=1", { width: 390, height: 844, mobile: true, scale: 2 });
  const av = await q(p, "(()=>{const r=document.querySelector('#hdrAcct .fs-acct-btn').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]})()");
  check("phone, signed in: account control at least 40 px", av[0] >= 40 && av[1] >= 40, av);
  await tap(p, "#hdrAcct .fs-acct-btn"); await sleep(300);
  const m = await q(p, "(()=>{const r=document.querySelector('#hdrAcct .fs-menu').getBoundingClientRect(); return {open: !document.querySelector('#hdrAcct .fs-menu').hidden, left: Math.round(r.left), right: Math.round(innerWidth - r.right)}})()");
  check("phone: account menu opens inside the 16 px gutters", m.open && m.left === 16 && m.right === 16, m);
  await shot(p, "phone-account-menu.png");
  check("phone, signed in: no overflow, no console errors", (await noOverflow(p)) && p.errors.length === 0, p.errors);
  done(p);
}

// =====================================================================================================================
// 6b. Feature switches (config.js features): a launch without Markets, Library and sign-in
// =====================================================================================================================
{
  const p = await open(base, { width: 1280, height: 900, config: { features: { markets: false, dictionary: true, library: false, signin: false } } });
  await goTo(p, "#drive", 80);
  const f = await q(p, `({sec: document.getElementById('markets-news').hidden, mounted: !!document.querySelector('#mnBoard .mk-mini, #mnBoard [class^="mk-"]'),
    nav: [...document.querySelectorAll('.nav-links .nl')].filter(a => !a.hidden).map(a => a.textContent.trim()),
    acct: document.getElementById('hdrAcct').hidden || !document.querySelector('#hdrAcct .fs-acct-in, #hdrAcct .fs-acct-btn'),
    drive: [...document.querySelectorAll('#driveGrid a.df, #driveCtas a')].map(a => a.getAttribute('href')), lib: document.querySelectorAll('a[href*="library/"]:not([hidden])').length})`);
  check("features off: Markets & News hidden and not mounted; Markets/Library links hidden; no account control", f.sec && !f.mounted && f.nav.join("|") === "Start here|Repository|Dictionary|Events" && f.acct, f);
  check("features off: Drive links open Google Drive again (no Library links)", f.drive.length > 0 && f.drive.every(h => /^https:\/\/drive\.google\.com\//.test(h)) && f.lib === 0, f);
  check("features off: no overflow, no console errors", (await noOverflow(p)) && p.errors.length === 0, p.errors);
  done(p);
}

// =====================================================================================================================
// 7. Reduced motion
// =====================================================================================================================
{
  const p = await open(base, { width: 1280, height: 900, reducedMotion: true });
  const rm = await q(p, "({rm: document.documentElement.classList.contains('rm'), inline: document.getElementById('deviceWrap').style.transform, pre: document.querySelectorAll('.rv.pre').length, drive: document.querySelectorAll('#driveGrid .df').length})");
  check("reduced motion: static hero, nothing hidden, Drive present", rm.rm && rm.inline === "" && rm.pre === 0 && rm.drive === await q(p, "DRIVE.folders.length") && rm.drive >= 8, rm);
  await goTo(p, "#markets-news", 80);
  check("reduced motion: Markets & News still mounts", await waitFor(p, "document.querySelector('#mnTodBody .mn-tod-in') && document.querySelectorAll('#mnNews a[href^=\"https://\"]').length >= 3", 8000));
  await shot(p, "desktop-reduced-motion.png");
  check("reduced motion: no console errors", p.errors.length === 0, p.errors);
  done(p);
}

check("zero console errors across every run", allErrors.length === 0, allErrors);
const fails = R.done();
await b.close();
process.exit(fails ? 1 : 0);
