// Cross-page smoothness verification (final-pass integration check). Not part of run_all.sh.
//   node --experimental-websocket tests/verify_smooth.mjs <base> <chromePort> <label>
// base: a served --demo build (e.g. http://127.0.0.1:8850/), label: "before" | "after" (screenshot prefix).
// Checks, at desktop 1280x900 and phone 390x844: CLS per page (PerformanceObserver), console errors, horizontal
// overflow, a click-through home → markets → dictionary → library → home with ?demo-user=1 (header geometry identical,
// account control present, scroll position sane), a tooltip on every page, the dictionary sheet and the library viewer
// on the phone, landscape 844x390, and prefers-reduced-motion on every page. Screenshots: tests/out/verify/.
import { launch, reporter, sleep } from "./lib/cdp.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const base = (process.argv[2] || "http://127.0.0.1:8850/").replace(/\/?$/, "/");
const port = +(process.argv[3] || 9450);
const label = process.argv[4] || "after";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out", "verify");
const R = reporter(), check = R.check;
const b = await launch({ port });
const bail = e => { console.log("FAIL  run stopped: " + (e && e.stack || e)); b.close().finally(() => process.exit(1)); };
process.on("uncaughtException", bail); process.on("unhandledRejection", bail);

const PAGES = { home: "", markets: "markets/", dictionary: "dictionary/", library: "library/" };
const DESK = { width: 1280, height: 900 }, PHONE = { width: 390, height: 844, mobile: true, scale: 2 }, LAND = { width: 844, height: 390, mobile: true, scale: 2 };
const CLS = `window.__cls=0;window.__shifts=[];try{new PerformanceObserver(l=>l.getEntries().forEach(e=>{if(!e.hadRecentInput){__cls+=e.value;if(e.value>0.005)__shifts.push({v:+e.value.toFixed(4),t:Math.round(e.startTime),src:(e.sources||[]).map(s=>s.node&&(s.node.id||s.node.className&&String(s.node.className).split(" ")[0]||s.node.tagName)).join(",")})}})).observe({type:"layout-shift",buffered:true})}catch(e){}`;
const allErrors = [];
const section = name => console.log("\n## " + name);
const done = (p, who) => { if (p.errors.length) allErrors.push(who + ": " + p.errors.join(" | ")); p.close(); };
const center = (p, sel) => p.js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
  e.scrollIntoView({block:"center", behavior:"instant"}); const r=e.getClientRects()[0]||e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
async function click(p, sel, wait = 300) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(250);
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] });
  for (const type of ["mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: c[0], y: c[1], button: "left", clickCount: 1 }); await sleep(wait); }
async function hover(p, sel) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(300); await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] }); await sleep(600); }
async function tap(p, sel, wait = 400) { const c = await center(p, sel); if (!c) throw new Error("no " + sel); await sleep(250);
  await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c[0], y: c[1] }] }); await sleep(60);
  await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(wait); }
async function waitFor(p, expr, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await p.js(expr); if (v) return v; } catch (e) {} await sleep(150); } return null; }
const noOverflow = p => p.js("document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth");
const where = p => p.js("location.pathname + location.search + location.hash");
const tipOpen = p => p.js(`(()=>{const t=document.querySelector(".gl-tip.gl-show"); return t ? t.querySelector(".gl-tip-term").textContent : null})()`);
const HDR = `(()=>{const r=e=>{if(!e||!e.offsetParent) return null; const b=e.getBoundingClientRect(); return [Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)]};
  const ni=document.querySelector(".hdr .nav-in"), top=ni.getBoundingClientRect().top, rel=a=>a&&[a[0],a[1]-Math.round(top),a[2],a[3]];
  const links=[...document.querySelectorAll(".hdr .nav-links > .nl")].filter(e=>e.offsetParent);
  const cs=e=>{const s=getComputedStyle(e); return s.fontFamily.split(",")[0]+"/"+s.fontSize+"/"+s.fontWeight+"/"+s.color};
  const join=document.querySelector(".hdr .nav-cta .btn-primary"), burger=document.querySelector(".hdr .burger"), logo=document.querySelector(".hdr .logo"), acct=document.querySelector(".fs-acct-btn,.fs-acct-in");
  return {navH:Math.round(ni.getBoundingClientRect().height), logo:rel(r(logo)), wm:logo.querySelector(".wm")&&logo.querySelector(".wm").offsetParent?cs(logo.querySelector(".wm")):null,
    links:links.map(e=>e.textContent.trim()), linkX:links.map(e=>rel(r(e))), linkFont:links.length?cs(links[0]):null,
    join:rel(r(join)), joinFont:join&&join.offsetParent?cs(join):null, burger:rel(r(burger)), acct:rel(r(acct)), acctKind:acct?acct.className:null}})()`;
const ANIM = `(()=>{const a=document.getAnimations().filter(x=>x.playState==="running"&&x.effect&&x.effect.getTiming&&(x.effect.getTiming().duration>60||x.effect.getTiming().iterations===Infinity)); return a.map(x=>(x.animationName||x.id||"transition")+"@"+((x.effect.target&&(x.effect.target.className||x.effect.target.tagName))||"?").toString().slice(0,40))})()`;

// ---------------------------------------------------------------- 1. fresh loads: CLS, errors, overflow, screenshots
section("fresh load per page: CLS, errors, overflow (" + label + ")");
const clsTable = {};
for (const [name, path] of Object.entries(PAGES)) {
  for (const [vk, vp] of [["desk", DESK], ["phone", PHONE]]) {
    const p = await b.page(base + path + "?demo-user=1", Object.assign({ before: CLS, wait: 4500 }, vp));
    const cls = await p.js("__cls"), shifts = await p.js("JSON.stringify(__shifts.slice(0,6))");
    clsTable[name + "/" + vk] = cls;
    check(`${name} ${vk}: CLS < 0.05`, cls < 0.05, { cls: +cls.toFixed(4), shifts: JSON.parse(shifts) });
    check(`${name} ${vk}: no sideways scroll`, await noOverflow(p), await p.js("[document.documentElement.scrollWidth, innerWidth]"));
    check(`${name} ${vk}: no console errors`, p.errors.length === 0, p.errors.slice(0, 3));
    await p.shot(join(OUT, `${label}-${name}-${vk}.png`));
    if (vk === "desk") await p.shot(join(OUT, `${label}-${name}-${vk}-full.png`), { fullPage: true });
    const acct = await p.js(`!!document.querySelector(".fs-acct-btn")`);
    check(`${name} ${vk}: signed-in account control present (demo user)`, acct);
    // tap targets: visible buttons/links inside main/header under 40px tall on the phone
    if (vk === "phone") {
      const small = await p.js(`(()=>{const out=[]; for(const e of document.querySelectorAll("header button, header a, main button, main a, footer a, [role=button]")){ if(!e.offsetParent||e.closest("[hidden],[aria-hidden=true]")) continue; const r=e.getBoundingClientRect(); if(r.width<1||r.height<1) continue; const cs=getComputedStyle(e); const h=Math.max(r.height, parseFloat(cs.minHeight)||0) - (parseFloat(cs.marginTop)<0?parseFloat(cs.marginTop):0) - (parseFloat(cs.marginBottom)<0?parseFloat(cs.marginBottom):0); if(h<40 && !e.closest(".gl-term,.mk-tape,.mk-ti")) out.push((e.className||e.tagName).toString().split(" ")[0]+":"+Math.round(r.height)+"/"+(e.textContent.trim().slice(0,18)))} return out})()`);
      check(`${name} phone: tap targets ≥ 40px (controls under 40px listed)`, small.length === 0, small.slice(0, 12));
      const inputs = await p.js(`[...document.querySelectorAll("input,select,textarea")].filter(e=>e.offsetParent).map(e=>parseFloat(getComputedStyle(e).fontSize)).filter(f=>f<16)`);
      check(`${name} phone: inputs ≥ 16px`, inputs.length === 0, inputs);
    }
    done(p, `${name} ${vk} load`);
  }
}

// ---------------------------------------------------------------- 2. click-through navigation, both sizes
for (const [vk, vp] of [["desk", DESK], ["phone", PHONE]]) {
  section("click-through home → markets → dictionary → library → home (" + vk + ")");
  const p = await b.page(base + "?demo-user=1", Object.assign({ before: CLS, wait: 3500 }, vp));
  const geo = {};
  const grab = async name => { geo[name] = await p.js(HDR); };
  await grab("home");
  const hops = [["markets", 'a[href*="markets/"]'], ["dictionary", 'a[href*="dictionary/"]'], ["library", 'a[href*="library/"]'], ["home", 'a.logo']];
  for (const [name, sel] of hops) {
    if (vk === "phone" && name !== "home") {
      await tap(p, ".hdr .burger", 500);
      check(`${vk} → ${name}: phone menu opens and locks the page`, await p.js(`!document.getElementById("mobileMenu").hidden && document.documentElement.classList.contains("fs-lock")`));
      await tap(p, "#mobileMenu " + sel, 3500);
    } else {
      await click(p, (name === "home" ? ".hdr " : ".hdr .nav-links ") + sel, 3500);
    }
    const loc = await where(p);
    check(`${vk} → ${name}: landed`, name === "home" ? !/markets|dictionary|library/.test(loc) : loc.includes(name), loc);
    const cls = await p.js("__cls");
    check(`${vk} → ${name}: CLS after navigation < 0.05`, cls < 0.05, +cls.toFixed(4));
    check(`${vk} → ${name}: scroll at top`, (await p.js("scrollY")) <= 2, await p.js("scrollY"));
    check(`${vk} → ${name}: no sideways scroll`, await noOverflow(p));
    check(`${vk} → ${name}: account control carried over`, await p.js(`!!document.querySelector(".fs-acct-btn")`));
    check(`${vk} → ${name}: menu closed, page not locked`, await p.js(`(document.getElementById("mobileMenu")||{hidden:true}).hidden && !document.documentElement.classList.contains("fs-lock")`));
    await grab(name + (name === "home" ? "2" : ""));
    await p.shot(join(OUT, `${label}-nav-${vk}-${name}.png`));
  }
  // header identical on every page (nav row geometry, fonts); the home header differs only by its announcement bar
  const ref = geo.markets, d = [];
  for (const [k, g] of Object.entries(geo)) {
    if (!g || k === "markets") continue;
    for (const f of ["navH", "wm", "linkFont", "joinFont", "acctKind"]) if (JSON.stringify(g[f]) !== JSON.stringify(ref[f])) d.push([k, f, g[f], ref[f]]);
    for (const f of ["logo", "join", "burger", "acct"]) if (JSON.stringify(g[f]) !== JSON.stringify(ref[f])) d.push([k, f, g[f], ref[f]]);
    if (JSON.stringify(g.links) !== JSON.stringify(ref.links)) d.push([k, "links", g.links, ref.links]);
    if (vk === "desk" && JSON.stringify(g.linkX) !== JSON.stringify(ref.linkX)) d.push([k, "linkX", g.linkX, ref.linkX]);
  }
  check(`${vk}: header identical on every page`, d.length === 0, d.slice(0, 6));
  check(`${vk}: zero console errors across the click-through`, p.errors.length === 0, p.errors.slice(0, 4));
  done(p, "nav " + vk);
}

// ---------------------------------------------------------------- 3. tooltip on every page, both sizes
section("tooltip on every page");
const TERM = { home: "#mnNews .gl-term, #mnTod .gl-term, main .gl-term", markets: ".nw-card .gl-term, main .gl-term", dictionary: "#dcEntry .gl-term, .dc-tod .gl-term, #dcMain .gl-term, main .gl-term", library: "main .gl-term, main [data-term]" };
for (const [name, path] of Object.entries(PAGES)) {
  for (const [vk, vp] of [["desk", DESK], ["phone", PHONE]]) {
    const p = await b.page(base + path + "?demo-user=1", Object.assign({ wait: 3500 }, vp));
    const has = await waitFor(p, `!!document.querySelector(${JSON.stringify(TERM[name])})`, 10000);
    if (!has) { check(`${name} ${vk}: has a glossary term to open`, name === "library", "no .gl-term"); done(p, name + " tip " + vk); continue; }
    if (vk === "desk") await hover(p, TERM[name]); else await tap(p, TERM[name], 700);
    const t = await waitFor(p, `(()=>{const t=document.querySelector(".gl-tip.gl-show"); return t ? t.querySelector(".gl-tip-term").textContent : null})()`, 3000);
    check(`${name} ${vk}: tooltip opens`, !!t, t);
    if (t) {
      const inView = await p.js(`(()=>{const r=document.querySelector(".gl-tip").getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth+0.5 && r.top>=0 && r.bottom<=innerHeight+0.5})()`);
      check(`${name} ${vk}: tooltip inside the viewport`, inView);
      await p.shot(join(OUT, `${label}-tip-${name}-${vk}.png`));
      await p.key("Escape"); await sleep(400);
      check(`${name} ${vk}: Escape closes the tooltip`, !(await tipOpen(p)));
    }
    check(`${name} ${vk}: no console errors (tooltip)`, p.errors.length === 0, p.errors.slice(0, 3));
    done(p, name + " tip " + vk);
  }
}

// ---------------------------------------------------------------- 4. phone: dictionary sheet, library viewer
section("phone: dictionary entry sheet");
{
  const p = await b.page(base + "dictionary/?demo-user=1", Object.assign({ before: CLS, wait: 3500 }, PHONE));
  await waitFor(p, "!!document.querySelector('#dcList .dc-row:not(.dc-skel)')", 10000);
  const before = await p.js("__cls");
  await tap(p, "#dcList .dc-row:not(.dc-skel)", 900);
  const open = await waitFor(p, `!!document.querySelector("#dcEntry") && document.querySelector("#dcEntry").offsetParent !== null && !!document.querySelector("#dcEntry .dc-eterm")`, 5000);
  check("phone dictionary: sheet opens", !!open);
  check("phone dictionary: no sideways scroll with the sheet open", await noOverflow(p));
  check("phone dictionary: page locked behind the sheet", await p.js(`document.documentElement.classList.contains("fs-lock") || getComputedStyle(document.documentElement).overflow==="hidden" || getComputedStyle(document.body).overflow==="hidden" || document.documentElement.classList.contains("dc-sheet")`));
  await p.shot(join(OUT, `${label}-dict-sheet-phone.png`));
  const backSel = await p.js(`(()=>{for(const s of ["#dcEntry .dc-back","#dcEntry .dc-close","#dcEntry [data-dc-back]","#dcEntry button"]){const e=document.querySelector(s); if(e&&e.offsetParent) return s} return null})()`);
  if (backSel) { await tap(p, backSel, 700); check("phone dictionary: sheet closes", !(await p.js(`document.querySelector("#dcEntry") && document.querySelector("#dcEntry").offsetParent !== null && document.documentElement.classList.contains("dc-sheet")`))); }
  else check("phone dictionary: a visible close/back control", false);
  check("phone dictionary: CLS during open/close < 0.05", (await p.js("__cls")) - before < 0.05, await p.js("__cls"));
  check("phone dictionary: no console errors", p.errors.length === 0, p.errors.slice(0, 3));
  done(p, "dict sheet phone");
}
section("phone: library viewer (demo drive)");
{
  const p = await b.page(base + "library/?demo-user=1&demo-drive=1", Object.assign({ before: CLS, wait: 3500 }, PHONE));
  const btn = await waitFor(p, `!!document.querySelector("[data-lib-open]")`, 8000);
  if (btn) await tap(p, "[data-lib-open]", 1500);
  await waitFor(p, `!!document.querySelector("[data-lib-item]")`, 10000);
  await p.shot(join(OUT, `${label}-lib-folders-phone.png`));
  // walk into the first folder that has a PDF
  let pdf = await p.js(`!!document.querySelector('[data-lib-item][data-kind="pdf"]')`);
  for (let i = 0; i < 3 && !pdf; i++) {
    const f = await p.js(`(()=>{const e=document.querySelector('[data-lib-item][data-kind="folder"]'); return e ? e.getAttribute("data-lib-item") : null})()`);
    if (!f) break;
    await tap(p, `[data-lib-item="${f}"]`, 1500);
    pdf = await waitFor(p, `!!document.querySelector('[data-lib-item][data-kind="pdf"]')`, 4000);
  }
  check("phone library: reached a PDF row", !!pdf);
  if (pdf) {
    await tap(p, '[data-lib-item][data-kind="pdf"]', 1500);
    const stage = await waitFor(p, `!!document.querySelector("[data-lib-stage] canvas, [data-lib-stage] .lib-page, [data-lib-stage] img")`, 15000);
    check("phone library: viewer renders a page", !!stage);
    check("phone library: no sideways scroll in the viewer", await noOverflow(p));
    await p.shot(join(OUT, `${label}-lib-viewer-phone.png`));
    const close = await p.js(`!!document.querySelector("[data-lib-close]") && document.querySelector("[data-lib-close]").offsetParent !== null`);
    if (close) { await tap(p, "[data-lib-close]", 800); check("phone library: viewer closes back to the folder", await p.js(`!document.querySelector("[data-lib-stage]") || document.querySelector("[data-lib-stage]").offsetParent === null`)); }
  }
  check("phone library: no console errors", p.errors.length === 0, p.errors.slice(0, 3));
  done(p, "library viewer phone");
}

// ---------------------------------------------------------------- 5. landscape phone
section("landscape 844x390");
for (const [name, path] of Object.entries(PAGES)) {
  const p = await b.page(base + path + "?demo-user=1", Object.assign({ wait: 3500 }, LAND));
  check(`${name} landscape: no sideways scroll`, await noOverflow(p));
  check(`${name} landscape: header not taller than 40% of the screen`, (await p.js(`document.querySelector(".hdr").getBoundingClientRect().height`)) < 156, await p.js(`document.querySelector(".hdr").getBoundingClientRect().height`));
  check(`${name} landscape: no console errors`, p.errors.length === 0, p.errors.slice(0, 3));
  await p.shot(join(OUT, `${label}-${name}-land.png`));
  done(p, name + " landscape");
}

// ---------------------------------------------------------------- 6. reduced motion
section("prefers-reduced-motion");
for (const [name, path] of Object.entries(PAGES)) {
  const p = await b.page(base + path + "?demo-user=1", Object.assign({ wait: 3500, reducedMotion: true }, DESK));
  const anims = await p.js(ANIM);
  check(`${name} reduced motion: no running animations`, anims.length === 0, anims.slice(0, 6));
  check(`${name} reduced motion: smooth scrolling off`, (await p.js(`getComputedStyle(document.documentElement).scrollBehavior`)) !== "smooth");
  check(`${name} reduced motion: no console errors`, p.errors.length === 0, p.errors.slice(0, 3));
  await p.shot(join(OUT, `${label}-${name}-reduced.png`));
  done(p, name + " reduced");
}

// ---------------------------------------------------------------- 7. other widths
section("1024x768 and 1440x900");
for (const [name, path] of Object.entries(PAGES)) {
  for (const [w, h] of [[1024, 768], [1440, 900]]) {
    const p = await b.page(base + path + "?demo-user=1", { width: w, height: h, wait: 3000 });
    check(`${name} ${w}: no sideways scroll`, await noOverflow(p));
    check(`${name} ${w}: no console errors`, p.errors.length === 0, p.errors.slice(0, 3));
    await p.shot(join(OUT, `${label}-${name}-${w}.png`));
    done(p, `${name} ${w}`);
  }
}

console.log("\nCLS table: " + JSON.stringify(Object.fromEntries(Object.entries(clsTable).map(([k, v]) => [k, +v.toFixed(4)]))));
check("zero console errors across every page and run", allErrors.length === 0, allErrors.slice(0, 6));
const fails = R.done();
await b.close();
process.exit(fails ? 1 : 0);
