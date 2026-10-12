// Whole-site checks across the four pages (home, Markets & News, Dictionary, Library), meant to run against a --demo
// build served under a sub-folder, the way GitHub Pages serves a project site (https://<owner>.github.io/<repo>/):
//   python3 scripts/build_site.py --demo --out .dev/integrate
//   mkdir -p .dev/sub && cp -R .dev/integrate .dev/sub/finspire
//   python3 -m http.server 8807 -d .dev/sub &
//   node --experimental-websocket tests/integrate.test.mjs http://127.0.0.1:8807/finspire/ [chromeDebugPort=9407] [artifactBase]
// artifactBase (optional): the claude.ai dictionary-only build (scripts/build_artifact.py → ../artifact-out) served under
// a sub-folder with ../finspire.html wrapped by ../tools/wrap.py as its index.html.
// Screenshots go to tests/out/integrate/.
import { launch, reporter, sleep } from "./lib/cdp.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const base = (process.argv[2] || "http://127.0.0.1:8807/finspire/").replace(/\/?$/, "/");
const port = +(process.argv[3] || 9407);
const artBase = process.argv[4] ? process.argv[4].replace(/\/?$/, "/") : null;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out", "integrate");
const R = reporter(), check = R.check;
const b = await launch({ port });
// never leave a headless Chrome behind when something throws
const bail = e => { console.log("FAIL  run stopped: " + (e && e.stack || e)); b.close().finally(() => process.exit(1)); };
process.on("uncaughtException", bail); process.on("unhandledRejection", bail);
const BP = new URL(base).pathname;                         // e.g. /finspire/
const PAGES = { home: "", markets: "markets/", dictionary: "dictionary/", library: "library/" };
const DESK = { width: 1280, height: 900 }, PHONE = { width: 390, height: 844, mobile: true, scale: 2 };
const allErrors = [];

// every DevTools call gets a time limit, so a page that stops answering fails a check instead of hanging the run
const limit = (pr, ms, what) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout: " + what)), ms))]);
async function open(url, opts = {}, retry = 1) {
  let p;
  try {
    p = await limit(b.page("about:blank", Object.assign({}, opts, { wait: 50 })), 30000, "new tab");
    const js = p.js, send = p.send, goto = p.goto;
    p.js = expr => limit(js(expr), 20000, String(expr).slice(0, 80));
    p.send = (m, prm) => limit(send(m, prm), 20000, m);
    p.goto = (u, w) => limit(goto(u, w), 30000 + (w || 0), "navigate " + u);
    await p.goto(url, opts.wait || 2500);
    return p;
  } catch (e) {   // a stuck tab (seen under heavy machine load): close it and try once more in a fresh one
    if (p) p.close();
    if (!retry) throw e;
    console.log("retrying after: " + e.message);
    return open(url, opts, retry - 1);
  }
}
const section = name => console.log("\n## " + name);
const done = (p, label) => { if (p.errors.length) allErrors.push(label + ": " + p.errors.join(" | ")); p.close(); };
const center = (p, sel) => p.js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
  e.scrollIntoView({block:"center", behavior:"instant"}); const r=e.getClientRects()[0]||e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
async function click(p, sel, wait = 300) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(250);
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] });
  for (const type of ["mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: c[0], y: c[1], button: "left", clickCount: 1 }); await sleep(wait); }
async function hover(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(300); await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] }); await sleep(500); }
async function tap(p, sel, wait = 400) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(250);
  await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c[0], y: c[1] }] }); await sleep(60);
  await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(wait); }
async function waitFor(p, expr, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await p.js(expr); if (v) return v; } catch (e) {} await sleep(150); } return null; }
const noOverflow = p => p.js("document.documentElement.scrollWidth <= innerWidth");
const where = p => p.js("location.pathname + location.search + location.hash");
const tipOpen = p => p.js(`(()=>{const t=document.querySelector(".gl-tip.gl-show"); return t ? {term:t.querySelector(".gl-tip-term").textContent, href:t.querySelector(".gl-tip-open").getAttribute("href")} : null})()`);

// header geometry: the nav row only (the home page also has a slim announcement bar above it on wide screens)
const HDR = `(()=>{const r=e=>{if(!e||!e.offsetParent) return null; const b=e.getBoundingClientRect(); return [Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)]};
  const ni=document.querySelector(".hdr .nav-in"), top=ni.getBoundingClientRect().top, rel=a=>a&&[a[0],a[1]-Math.round(top),a[2],a[3]];
  const links=[...document.querySelectorAll(".hdr .nav-links > .nl")].filter(e=>e.offsetParent);
  const cs=e=>{const s=getComputedStyle(e); return s.fontFamily.split(",")[0]+"/"+s.fontSize+"/"+s.fontWeight+"/"+s.color};
  const join=document.querySelector(".hdr .nav-cta .btn-primary"), burger=document.querySelector(".hdr .burger"), logo=document.querySelector(".hdr .logo");
  return {navH:Math.round(ni.getBoundingClientRect().height), bg:getComputedStyle(document.querySelector(".hdr")).backgroundColor,
    logo:rel(r(logo)), logoImg:rel(r(logo.querySelector(".logo-img.lt"))), wm:logo.querySelector(".wm")&&logo.querySelector(".wm").offsetParent?cs(logo.querySelector(".wm")):null,
    links:links.map(e=>e.textContent.trim()), linkX:links.map(e=>rel(r(e))), linkFont:links.length?cs(links[0]):null,
    join:rel(r(join)), joinFont:join&&join.offsetParent?cs(join):null, burger:rel(r(burger))}})()`;

// ================================================================================================ every page, both sizes
section("every page, both sizes");
const geo = { desk: {}, phone: {} };
for (const [name, path] of Object.entries(PAGES)) {
  for (const [vk, vp] of [["desk", DESK], ["phone", PHONE]]) {
    const p = await open(base + path + "?demo-user=0", vp);
    await p.js("localStorage.clear(), sessionStorage.clear(), true"); await p.goto(base + path, 3500);
    check(`${name} ${vk}: no console errors on load`, p.errors.length === 0, p.errors);
    check(`${name} ${vk}: no sideways scroll`, await noOverflow(p));
    geo[vk][name] = await p.js(HDR);
    const vt = await p.js(`(()=>{const n=k=>[...document.querySelectorAll("*")].filter(e=>getComputedStyle(e).viewTransitionName===k).length;
      const rule=[...document.styleSheets].some(s=>{try{return [...s.cssRules].some(r=>r.constructor.name==="CSSViewTransitionRule"||/@view-transition/.test(r.cssText))}catch(e){return false}});
      return {rule, hdr:n("fs-header"), logo:n("fs-logo"), html:getComputedStyle(document.documentElement).backgroundColor, body:getComputedStyle(document.body).backgroundColor,
        scheme:(document.querySelector('meta[name="color-scheme"]')||{}).content||"", theme:(document.querySelector('meta[name="theme-color"]')||{}).content||""}})()`);
    if (vk === "desk") {
      check(`${name}: cross-document view transitions on, exactly one fs-header and one fs-logo (a duplicate cancels the transition)`, vt.rule && vt.hdr === 1 && vt.logo === 1, vt);
      check(`${name}: dark page background before anything loads (no white flash between pages)`, vt.body === "rgb(20, 20, 22)" && /dark/.test(vt.scheme) && vt.theme.toLowerCase() === "#141416", vt);
      // every internal link stays inside the sub-folder and answers 200
      const links = await p.js(`[...document.querySelectorAll("a[href]")].map(a=>({h:a.getAttribute("href"), u:a.href, hidden:!!a.closest("[hidden]")||a.hidden}))
        .filter(x=>x.u.startsWith(location.origin) && !x.h.startsWith("#") && !x.h.startsWith("javascript:"))`);
      const outside = links.filter(l => !new URL(l.u).pathname.startsWith(BP) || l.h.startsWith("/"));
      check(`${name}: internal links are relative and stay under ${BP}`, links.length > 5 && outside.length === 0, outside.slice(0, 5));
      const uniq = [...new Set(links.map(l => l.u.split("#")[0]))];
      const bad = [];
      for (const u of uniq) { const r = await fetch(u).catch(() => null); if (!r || r.status !== 200) bad.push(u + " " + (r && r.status)); }
      check(`${name}: all ${uniq.length} internal link targets load (200)`, bad.length === 0, bad);
    }
    await p.shot(join(OUT, `${vk}-${name}.png`));
    if (vk === "phone") {
      const tt = await p.js(`[...document.querySelectorAll(".hdr .logo, .hdr .burger, .hdr .fs-acct > button")].filter(e=>e.offsetParent).map(e=>{const r=e.getBoundingClientRect(); return [e.className.split(" ")[0], Math.round(r.width), Math.round(r.height)]}).filter(x=>x[1]<40||x[2]<40)`);
      check(`${name} phone: header tap targets ≥ 40px`, tt.length === 0, tt);
    }
    done(p, `${name} ${vk}`);
  }
}

// ================================================================================================ the header is one header
section("the header is one header");
{
  const ref = geo.desk.markets, diff = {};
  for (const [name, g] of Object.entries(geo.desk)) {
    const d = [];
    if (g.navH !== ref.navH) d.push(["navH", g.navH, ref.navH]);
    if (g.bg !== ref.bg && name !== "home") d.push(["bg", g.bg, ref.bg]);   // home: transparent over its dark hero until scrolled
    if (JSON.stringify(g.logo) !== JSON.stringify(ref.logo)) d.push(["logo", g.logo, ref.logo]);
    if (JSON.stringify(g.logoImg) !== JSON.stringify(ref.logoImg)) d.push(["logoImg", g.logoImg, ref.logoImg]);
    if (g.wm !== ref.wm) d.push(["wordmark", g.wm, ref.wm]);
    if (JSON.stringify(g.links) !== JSON.stringify(ref.links)) d.push(["links", g.links, ref.links]);
    if (g.linkFont !== ref.linkFont) d.push(["linkFont", g.linkFont, ref.linkFont]);
    // home's Repository is a menu button with a chevron (20px wider), so its links sit up to 10px off; everything else must match
    const tol = name === "home" ? 11 : 2;
    if (g.linkX.some((x, i) => !ref.linkX[i] || Math.abs(x[0] - ref.linkX[i][0]) > tol || Math.abs(x[1] - ref.linkX[i][1]) > 2 || Math.abs(x[3] - ref.linkX[i][3]) > 1 ||
      (i !== 1 && Math.abs(x[2] - ref.linkX[i][2]) > 1))) d.push(["linkX", g.linkX, ref.linkX]);
    if (JSON.stringify(g.join) !== JSON.stringify(ref.join) || g.joinFont !== ref.joinFont) d.push(["join", g.join, ref.join, g.joinFont, ref.joinFont]);
    if (d.length) diff[name] = d;
  }
  check("desktop: header nav row identical on all four pages (logo, links, positions, type, Join)", Object.keys(diff).length === 0, diff);
  const pr = geo.phone.markets, pd = {};
  for (const [name, g] of Object.entries(geo.phone)) {
    const d = [];
    if (g.navH !== pr.navH) d.push(["navH", g.navH, pr.navH]);
    if (JSON.stringify(g.logo) !== JSON.stringify(pr.logo)) d.push(["logo", g.logo, pr.logo]);
    if (JSON.stringify(g.burger) !== JSON.stringify(pr.burger)) d.push(["burger", g.burger, pr.burger]);
    if (d.length) pd[name] = d;
  }
  check("phone: header identical on all four pages (logo, burger, height)", Object.keys(pd).length === 0, pd);
}

// ================================================================================================ click through the nav (sub-path)
section("click through the nav (sub-path)");
{
  const p = await open(base + "?demo-user=0", DESK);
  const steps = [
    ["home", ".nav-links a.nl[href$='markets/']", BP + "markets/"],
    ["markets", ".nav-links a.nl[href$='dictionary/']", BP + "dictionary/"],
    ["dictionary", ".nav-links a.nl[href$='library/']", BP + "library/"],
    ["library", ".nav-links a.nl[href$='#events']", BP + "index.html#events"],
  ];
  const got = [];
  for (const [, sel, want] of steps) { await click(p, sel, 2200); got.push([await where(p), want]); }
  await p.goto(base + "dictionary/", 2000);
  await click(p, ".hdr .logo", 2200); got.push([await where(p), BP + "index.html"]);
  await p.goto(base + "markets/", 2000);
  await click(p, ".hdr .nav-links a.nl[href$='#paths']", 2200); got.push([await where(p), BP + "index.html#paths"]);
  const at = await p.js(`(()=>{const s=document.getElementById("paths"); const r=s.getBoundingClientRect(); return Math.round(r.top)})()`);
  await p.goto(base + "library/", 2000);
  await click(p, "footer a[href$='markets/']", 2200); got.push([await where(p), BP + "markets/"]);
  check("desktop: header, logo and footer links land on the right page under the sub-folder", got.every(([a, w]) => a === w), got);
  check("desktop: Start here from a sub-page scrolls the home page to the section", at < 300 && at > -50, at);
  done(p, "click-through desktop");

  const m = await open(base + "markets/?demo-user=0", PHONE);
  await tap(m, ".hdr .burger");
  const menu = await m.js(`[...document.querySelectorAll("#mobileMenu a")].filter(a=>!a.hidden).map(a=>a.textContent.trim())`);
  await tap(m, "#mobileMenu a[href$='dictionary/']", 2200);
  const w1 = await where(m);
  await tap(m, ".hdr .burger"); await tap(m, "#mobileMenu a[href$='#repository']", 2200);
  const w2 = await where(m);
  await m.goto(base + "dictionary/", 2000);
  await tap(m, ".hdr .burger"); await tap(m, "#mobileMenu a[href$='library/']", 2200);
  const w3 = await where(m);
  check("phone: burger menu lists the same six links on a sub-page", menu.slice(0, 6).join("|") === "Start here|Repository|Markets|Dictionary|Library|Events", menu);
  check("phone: burger links land on the right page", w1 === BP + "dictionary/" && w2 === BP + "index.html#repository" && w3 === BP + "library/", [w1, w2, w3]);
  check("phone click-through: no sideways scroll", await noOverflow(m));
  done(m, "click-through phone");
}

// ================================================================================================ account control everywhere (demo)
section("account control everywhere (demo)");
{
  const p = await open(base + "?demo-user=1", DESK);
  const seen = {};
  const acct = async () => p.js(`Finspire.auth.ready.then(()=>{const b=document.querySelector(".hdr .fs-acct-btn"); const a=document.querySelector(".hdr .fs-acct"); const r=a&&a.getBoundingClientRect();
    return {btn:!!b, name:b&&b.querySelector(".fs-acct-name").textContent, pill:!!document.querySelector(".hdr [data-fs-signin]"), w:r&&Math.round(r.width), h:r&&Math.round(r.height)}})`);
  seen.home = await acct();
  for (const [name, sel] of [["markets", ".nav-links a.nl[href$='markets/']"], ["dictionary", ".nav-links a.nl[href$='dictionary/']"], ["library", ".nav-links a.nl[href$='library/']"]]) {
    await click(p, sel, 2200); seen[name] = await acct();
  }
  check("demo sign-in persists across all four pages (avatar + first name, same size)", Object.values(seen).every(s => s.btn && s.name === "Demo" && !s.pill && s.w === seen.home.w && s.h === seen.home.h), seen);
  await click(p, ".hdr .fs-acct-btn", 300);
  const items = await p.js(`[...document.querySelectorAll(".hdr .fs-menu [role=menuitem]")].map(a=>a.textContent.trim()+"|"+(a.getAttribute("href")||""))`);
  check("account menu on a sub-page: My dictionary, Library, Sign out with relative links", items.join() === "My dictionary|../dictionary/#me,Library|../library/,Sign out|", items);
  await click(p, ".hdr .fs-menu .fs-out", 600);
  await click(p, ".hdr .logo", 2200);
  const out = await acct();
  check("sign-out persists to the next page (Sign in pill on home)", !out.btn && out.pill, out);
  await click(p, ".hdr [data-fs-signin]", 600);
  check("Sign in from the home page signs back in (demo)", (await acct()).btn);
  done(p, "account");
}

// ================================================================================================ tooltips on all three surfaces
section("tooltips on all three surfaces");
{
  // home teaser
  const p = await open(base + "?demo-user=0#markets-news", DESK);
  await waitFor(p, `document.querySelectorAll("#mnNews .gl-term").length > 0`, 10000);
  const nHome = await p.js(`document.querySelectorAll("#mnNews .gl-term").length`);
  let t = null;
  if (nHome) { await hover(p, "#mnNews .gl-term"); t = await tipOpen(p); }
  check("tooltip: home news teaser terms open the tip", nHome > 0 && !!t, { nHome, t });
  if (t) await p.shot(join(OUT, "tip-home.png"));
  done(p, "tip home");

  // markets news feed → Open in Dictionary lands on that entry
  const m = await open(base + "markets/?demo-user=0#news", DESK);
  await waitFor(m, `document.querySelectorAll(".nw-card .gl-term").length > 0`, 10000);
  await hover(m, ".nw-card .gl-term"); t = await tipOpen(m);
  check("tooltip: markets news terms open the tip", !!t, t);
  await m.shot(join(OUT, "tip-markets.png"));
  if (t) {
    const want = await m.js(`(()=>{const id=document.querySelector(".gl-tip-open").getAttribute("href").split("#t=")[1]; return {id:decodeURIComponent(id), term:Finspire.glossary.get(decodeURIComponent(id)).term}})()`);
    await click(m, ".gl-tip-open", 2500);
    const landed = await waitFor(m, `(()=>{const e=document.getElementById("dcEntry"); const h=document.getElementById("dcTerm"); return e&&!e.hidden&&h ? {path:location.pathname, hash:location.hash, term:h.textContent} : null})()`, 8000);
    check("tooltip: Open in Dictionary lands on that entry", landed && landed.path === BP + "dictionary/" && landed.hash === "#t=" + encodeURIComponent(want.id) && landed.term === want.term, { want, landed });
    await m.shot(join(OUT, "tip-landed.png"));
    // dictionary prose: related text inside an entry is annotated too
    const nDict = await waitFor(m, `document.querySelectorAll("#dcEntry .gl-term, .dc-tod .gl-term, #dcMain .gl-term").length`, 6000);
    if (nDict) {
      await hover(m, "#dcEntry .gl-term, .dc-tod .gl-term, #dcMain .gl-term"); const td = await tipOpen(m);
      check("tooltip: terms inside dictionary text open the tip", !!td, td);
    } else check("tooltip: terms inside dictionary text open the tip", false, "no .gl-term in dictionary text");
  }
  done(m, "tip markets");

  // phone: tap a news term → sheet, Open in Dictionary
  const ph = await open(base + "markets/?demo-user=0#news", PHONE);
  await waitFor(ph, `document.querySelectorAll(".nw-card .gl-term").length > 0`, 10000);
  await tap(ph, ".nw-card .gl-term", 600);
  const sheet = await ph.js(`!!document.querySelector(".gl-tip.gl-show.gl-sheet")`);
  check("phone: tapping a news term opens the bottom sheet (not the article)", sheet && (await where(ph)).startsWith(BP + "markets/"));
  await ph.shot(join(OUT, "tip-phone-sheet.png"));
  done(ph, "tip phone");
}

// ================================================================================================ home Drive cards → Library folder
section("home Drive cards → Library folder");
{
  // the Library's demo Drive is switched on for this tab session by visiting it once with ?demo-drive=1
  const p = await open(base + "library/?demo-user=1&demo-drive=1", DESK);
  await p.goto(base, 2500);
  await p.js(`document.getElementById("drive").scrollIntoView(), true`); await sleep(800);
  const card = await p.js(`(()=>{const a=document.querySelector("#driveGrid a.df"); return a ? {href:a.getAttribute("href"), t:a.querySelector("h3").textContent} : null})()`);
  check("home Drive card links into the Library (relative ?f=<folder id>)", card && /^\.\/library\/\?f=[\w-]{10,}$/.test(card.href), card);
  if (card) {
    await click(p, "#driveGrid a.df", 1500);
    // first visit in this tab: the Library asks for one click to open (Drive consent); then it goes to the folder
    const first = await waitFor(p, `location.pathname.endsWith("/library/") && (document.querySelector("[data-lib-open]") ? "open" : document.querySelector(".lib-crumb.cur") ? "folder" : "")`, 10000);
    if (first === "open") await click(p, "[data-lib-open]", 1500);
    const lib = await waitFor(p, `(()=>{const c=document.querySelector(".lib-crumb.cur"); return c && document.querySelectorAll("[data-lib-item]").length ? {crumb:c.textContent, hash:location.hash, search:location.search, path:location.pathname, items:document.querySelectorAll("[data-lib-item]").length} : null})()`, 8000);
    const fid = card.href.split("?f=")[1];
    check("home Drive card opens the Library on that folder", lib && lib.path === BP + "library/" && lib.hash === "#f=" + fid && lib.crumb === card.t && lib.items > 0 && !/[?&]f=/.test(lib.search), lib);
    await p.shot(join(OUT, "drive-to-library.png"));
    if (await p.js(`!!document.querySelector(".lib-crumb[data-lib-crumb='0']")`)) await click(p, ".lib-crumb[data-lib-crumb='0']", 800);
    const back = await p.js(`({hash:location.hash, folders:document.querySelectorAll("button.lib-fc").length})`);
    check("Library: the breadcrumb goes back to the Library home after a home-page deep link", back.hash === "" && back.folders > 0, back);
  }
  done(p, "drive");
}

// ================================================================================================ claude.ai dictionary-only build
section("claude.ai dictionary-only build");
if (artBase) {
  for (const [vk, vp] of [["desk", DESK], ["phone", PHONE]]) {
    const p = await open(artBase + "dictionary/index.html", vp);
    await waitFor(p, `!!document.querySelector("#dcList .dc-row:not(.dc-skel)")`, 8000);
    const a = await p.js(`({shown:[...document.querySelectorAll("a[href]")].filter(a=>!a.hidden && !a.closest("[hidden]")).map(a=>a.textContent.trim()+" "+a.getAttribute("href")),
      acct:(()=>{const e=document.querySelector("[data-fs-account]"); return !e || e.hidden})(), signin:document.querySelectorAll("[data-fs-signin], .fs-gbtn, .dc-me-in").length,
      rows:document.querySelectorAll("#dcList .dc-row").length, me:(document.getElementById("me")||{}).textContent||""})`);
    const offenders = a.shown.filter(s => /markets|library/i.test(s) && !/^Markets & News? ?$/.test(s));
    check(`artifact ${vk}: dictionary page has no console errors`, p.errors.length === 0, p.errors);
    check(`artifact ${vk}: no Markets / Library links, no account control, no sign-in prompts`, offenders.length === 0 && a.acct && a.signin === 0, { offenders, acct: a.acct, signin: a.signin });
    check(`artifact ${vk}: dictionary lists terms and the personal panel works for the local guest`, a.rows > 5 && /Your dictionary/.test(a.me), { rows: a.rows });
    check(`artifact ${vk}: no sideways scroll`, await noOverflow(p));
    await p.shot(join(OUT, `artifact-${vk}-dictionary.png`));
    if (vk === "desk") {
      const h = await p.js(`(()=>{const a=[...document.querySelectorAll(".hdr a.logo, .nav-links a.nl")].filter(e=>!e.hidden).map(e=>e.getAttribute("href")); return a})()`);
      check("artifact: header links point at the artifact's own pages", h.every(x => /^\.\.\/(#\w+)?$/.test(x) || x === "../dictionary/index.html"), h);
    }
    done(p, "artifact " + vk);
  }
}

check("zero console errors across every page and run", allErrors.length === 0, allErrors);
const fails = R.done();
await b.close();
process.exit(fails ? 1 : 0);
