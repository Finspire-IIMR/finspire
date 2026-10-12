// Library page (site/library/index.html + assets/js/library.js + assets/css/library.css) in demo mode:
// ?demo-user=1 (fake student) + ?demo-drive=1 (Drive answered from _demo/drive.json and _demo/files/*).
//   python3 scripts/build_site.py --demo --out .dev/library
//   python3 -m http.server 8805 -d .dev/library &
//   node --experimental-websocket tests/library.test.mjs http://127.0.0.1:8805/ [chromeDebugPort=9405]
// Needs network access to cdnjs.cloudflare.com (PDF.js). Screenshots go to tests/out/library/.
import { launch, reporter, sleep } from "./lib/cdp.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const base = (process.argv[2] || "http://127.0.0.1:8805/").replace(/\/?$/, "/");
const port = +(process.argv[3] || 9405);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out", "library");
const LIB = base + "library/";
// folder counts come from the site's own data/site-data.json (admins add folders over time)
const SITE_FOLDERS = ((await (await fetch(base + "data/site-data.json")).json()).drive || {}).folders || [];
const NF = SITE_FOLDERS.length, NSOON = SITE_FOLDERS.filter(f => !/^https?:\/\/\S+$/.test(f.u || "")).length;
const DEMO = LIB + "?demo-user=1&demo-drive=1";
const R = reporter(), check = R.check;
const b = await launch({ port });

// Downloads: record what would be saved instead of saving it.
const HOOK = `(() => { window.__dl = []; const o = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function(){ if (this.hasAttribute("download")) { window.__dl.push({ href: this.href, name: this.download }); return; } return o.call(this); }; })();`;

// helpers ---------------------------------------------------------------------------------------------------------
const center = (p, sel) => p.js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;
  e.scrollIntoView({block:"center", behavior:"instant"}); const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
async function click(p, sel) {
  const c = await center(p, sel); if (!c) throw new Error("no element " + sel); await sleep(120);
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] });
  for (const type of ["mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: c[0], y: c[1], button: "left", clickCount: 1 });
  await sleep(200);
}
async function tap(p, sel) {
  const c = await center(p, sel); if (!c) throw new Error("no element " + sel); await sleep(150);
  await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c[0], y: c[1] }] });
  await sleep(50); await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(300);
}
async function key(p, k) {
  const codes = { Escape: 27, ArrowRight: 39, ArrowLeft: 37, PageDown: 34, PageUp: 33, Enter: 13 };
  for (const type of ["rawKeyDown", "keyUp"]) await p.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: codes[k] || 0 });
  await sleep(150);
}
async function waitFor(p, expr, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const v = await p.js(expr); if (v) return v; } catch (e) {} await sleep(100); }
  return null;
}
const noOverflow = p => p.js("document.documentElement.scrollWidth <= innerWidth");
const txt = (p, sel) => p.js(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||""`);
const crumbs = p => p.js(`[...document.querySelectorAll(".lib-crumbs li")].map(l=>l.textContent.trim())`);
async function open(url, opts = {}) {
  const p = await b.page("about:blank", Object.assign({ wait: 50, before: HOOK }, opts));
  await p.goto(url, opts.wait || 1500);
  return p;
}
async function setFile(p, sel, path) {
  const { root } = await p.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await p.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
  await p.send("DOM.setFileInputFiles", { nodeId, files: [path] });
}

// ================================================================================================= desktop 1280×900
{
  // no Google client id in this build: everyone is a local guest; the Library says when it opens, no Google button anywhere
  const p = await open(LIB + "?demo-user=0");
  await waitFor(p, `document.querySelector("#lib").dataset.screen === "gate"`);
  check("gate (no client id): shown to the local guest", await p.js(`document.querySelector("#lib").dataset.screen`) === "gate");
  check("gate (no client id): says it opens once IIM Ranchi sign-in is switched on", /opens here once IIM Ranchi sign-in is switched on/.test(await txt(p, ".lib-intro-p")) && /opens with IIM Ranchi sign-in/i.test(await txt(p, ".lib-intro-h")));
  check("gate (no client id): no Google button, no account control, no sign-in prompt", await p.js(`!document.querySelector("[data-lib-signin], .fs-gbtn, [data-fs-signin]") && document.querySelector("[data-fs-account]").hidden`));
  const rows = await p.js(`[...document.querySelectorAll(".lib-intro-list li")].map(li=>li.textContent)`);
  check("gate: previews the folder names from site-data", rows.length === NF && rows.some(r => r.includes("Interview questions")), rows);
  check("gate: folders without a link say Coming soon", rows.filter(r => r.includes("Coming soon")).length === NSOON, rows.filter(r => r.includes("Coming soon")).length);
  check("gate: no file browser for the guest", !(await p.js(`!!document.querySelector(".lib-browser, [data-lib-open]")`)));
  await p.shot(join(OUT, "d-0-gate-no-client-id.png"));
  // sign-in usable (demo) but signed out: the gate offers IIM Ranchi sign-in
  await p.goto(LIB + "?demo-user=1", 1200);
  await p.js("Finspire.auth.signOut().then(()=>true)");
  await waitFor(p, `document.querySelector("#lib").dataset.screen === "gate" && !!document.querySelector("[data-lib-signin]")`);
  check("gate (signed out): Continue with Google button", !!(await p.js(`!!document.querySelector("[data-lib-signin]")`)));
  await p.shot(join(OUT, "d-1-gate.png"));
  await p.js(`document.querySelector("[data-lib-signin]").click(), true`); await sleep(500);   // (the "Signed out" toast covers the button's centre)
  check("gate (signed out): Continue with Google signs in (demo) and leaves the gate", !!(await waitFor(p, `!!Finspire.auth.user() && document.querySelector("#lib").dataset.screen !== "gate"`, 4000)));
  await p.js("sessionStorage.clear(), true");
  p.close();
}

const p = await open(DEMO);
await waitFor(p, `!!document.querySelector("[data-lib-open]")`);
check("signed in: 'Open the library' shown before any Drive access", !!(await p.js(`!!document.querySelector("[data-lib-open]")`)));
check("signed in: greets the student", (await txt(p, ".lib-intro-h")).includes("Demo"));
await p.shot(join(OUT, "d-2-open.png"));
await click(p, "[data-lib-open]");
await waitFor(p, `document.querySelectorAll(".lib-fc").length > 0`);
check("home: folder cards from site-data", await p.js(`document.querySelectorAll(".lib-fc").length`) === NF);
check("home: linked folders are buttons, the rest Coming soon", await p.js(`document.querySelectorAll("button.lib-fc").length + document.querySelectorAll(".lib-fc.soon").length`) === NF &&
  await p.js(`document.querySelectorAll("button.lib-fc").length`) >= 6 &&
  await p.js(`[...document.querySelectorAll(".lib-fc.soon")].every(e => e.textContent.includes("Coming soon"))`));
check("home: folder ids parsed from /folders/, ?id= and /u/0/ links", await p.js(`["demoCfaResources01","demoMembersNotes01","demoCoverLetters01","17UwJD6uBOuwLPXxiJAw3dnPPH6Wt85Bk"].every(id => document.querySelector('[data-lib-folder="'+id+'"]'))`));
check("home: Add a file shown (inbox configured)", !!(await p.js(`!!document.querySelector("[data-lib-upload]")`)));
await p.shot(join(OUT, "d-3-home.png"));

// folders + breadcrumb ------------------------------------------------------------------------------------------
await click(p, `button.lib-fc[data-lib-folder="demoCfaResources01"]`);
check("folder: skeleton while loading", !!(await p.js(`!!document.querySelector(".lib-skel-row")`)));
await waitFor(p, `!!document.querySelector('[data-lib-item="demoCfaLevel1Fold"]')`);
check("folder: lists children, folders first", (await p.js(`[...document.querySelectorAll(".lib-row-t")].map(e=>e.textContent)`)).join("|") === "Level I|Level II|Reading list.txt");
check("folder: hash routes to the folder", await p.js("location.hash") === "#f=demoCfaResources01");
await click(p, `[data-lib-item="demoCfaLevel1Fold"]`);
await waitFor(p, `!!document.querySelector('[data-lib-item="demoCfaNotesPdf01"]')`);
check("sub-folder: breadcrumb Library › CFA resources › Level I", (await crumbs(p)).join(" / ") === "Library / CFA resources / Level I", await crumbs(p));
check("sub-folder: sizes and dates shown", (await txt(p, '[data-lib-item="demoCfaNotesPdf01"]')).includes("2.6 KB") && (await txt(p, '[data-lib-item="demoCfaNotesPdf01"]')).includes("9 Oct 2026"));
check("sub-folder: type filter chips", (await p.js(`[...document.querySelectorAll("[data-lib-type]")].map(e=>e.dataset.libType)`)).join() === "all,pdf,image");
await click(p, `[data-lib-type="image"]`);
check("filter: Images shows only the image", (await p.js(`[...document.querySelectorAll("[data-lib-item]")].map(e=>e.dataset.kind)`)).join() === "image");
await click(p, `[data-lib-type="all"]`);
await p.js(`(()=>{const s=document.querySelector("[data-lib-sort]"); s.value="new"; s.dispatchEvent(new Event("change"))})()`);
check("sort: newest first", (await p.js(`[...document.querySelectorAll(".lib-row-t")].map(e=>e.textContent)`))[0] === "Sample CFA notes.pdf");
await p.js(`(()=>{const s=document.querySelector("[data-lib-sort]"); s.value="name"; s.dispatchEvent(new Event("change"))})()`);
check("sort: name A–Z", (await p.js(`[...document.querySelectorAll(".lib-row-t")].map(e=>e.textContent)`))[0] === "DCF walkthrough.pdf");
await p.shot(join(OUT, "d-4-folder.png"));
await click(p, `[data-lib-crumb="1"]`);
await waitFor(p, `!!document.querySelector('[data-lib-item="demoCfaLevel2Fold"]')`);
check("breadcrumb: back to CFA resources", (await crumbs(p)).length === 2);
await p.js("history.back()");
await waitFor(p, `!!document.querySelector('[data-lib-item="demoCfaNotesPdf01"]')`);
check("browser back: returns to Level I", (await crumbs(p)).length === 3);

// PDF viewer ----------------------------------------------------------------------------------------------------
await click(p, `[data-lib-item="demoCfaNotesPdf01"]`);
check("viewer: opens inside the page with a progress state", !!(await p.js(`!!document.querySelector(".fs-modal.lib-vw")`)));
const rendered = await waitFor(p, `document.querySelectorAll(".lib-pg.on canvas").length >= 1`, 20000);
check("pdf: pages render with PDF.js", !!rendered);
check("pdf: page counter of 3", (await txt(p, ".lib-pgof")) === "of 3" && await p.js(`document.querySelector("[data-lib-page]").value`) === "1");
check("pdf: canvas painted (not blank)", await p.js(`(()=>{const c=document.querySelector(".lib-pg.on canvas"); const d=c.getContext("2d").getImageData(0,0,c.width,c.height).data; let dark=0; for(let i=0;i<d.length;i+=40) if(d[i]<120) dark++; return dark>50})()`));
check("pdf: rendered at devicePixelRatio (canvas ≥ css size)", await p.js(`(()=>{const c=document.querySelector(".lib-pg.on canvas"); return c.width >= c.getBoundingClientRect().width - 1})()`));
check("viewer: no redirect to Google Drive", !(await p.js(`location.href.includes("google.com")`)));
await p.shot(join(OUT, "d-5-pdf.png"));
const w0 = await p.js(`document.querySelector(".lib-pg").getBoundingClientRect().width`);
const z0 = await txt(p, "[data-lib-fit]");
await click(p, "[data-lib-zin]"); await sleep(400);
const w1 = await p.js(`document.querySelector(".lib-pg").getBoundingClientRect().width`);
check("pdf: zoom in grows the page and updates the label", w1 > w0 && (await txt(p, "[data-lib-fit]")) !== z0, [w0, w1]);
await click(p, "[data-lib-zout]"); await click(p, "[data-lib-zout]"); await sleep(300);
check("pdf: zoom out shrinks the page", await p.js(`document.querySelector(".lib-pg").getBoundingClientRect().width`) < w1);
await click(p, "[data-lib-fit]"); await sleep(300);
check("pdf: fit width restores", Math.abs(await p.js(`document.querySelector(".lib-pg").getBoundingClientRect().width`) - w0) < 2);
await click(p, "[data-lib-next]"); await sleep(400);
check("pdf: next page button → page 2", await p.js(`document.querySelector("[data-lib-page]").value`) === "2");
await p.js(`document.querySelector("[data-lib-stage]").focus()`);
await key(p, "ArrowRight"); await sleep(400);
check("pdf: → key → page 3", await p.js(`document.querySelector("[data-lib-page]").value`) === "3");
await waitFor(p, `document.querySelectorAll(".lib-pg.on canvas").length >= 3`, 6000);
check("pdf: pages render lazily as they scroll in", await p.js(`document.querySelectorAll(".lib-pg.on canvas").length`) === 3);
await key(p, "PageUp"); await sleep(300);
check("pdf: PgUp → page 2", await p.js(`document.querySelector("[data-lib-page]").value`) === "2");
await p.js(`(()=>{const i=document.querySelector("[data-lib-page]"); i.focus(); i.value="3"; i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))})()`); await sleep(300);
check("pdf: page jump box → page 3", await p.js(`document.querySelector("[data-lib-page]").value`) === "3");
await p.js(`document.querySelector("[data-lib-stage]").focus()`);
await sleep(900);
await key(p, "Escape"); await sleep(500);
check("pdf: Esc closes the viewer", !(await p.js(`!!document.querySelector(".fs-modal.lib-vw")`)));
check("viewer: focus returns to the file row", await p.js(`document.activeElement && document.activeElement.dataset.libItem`) === "demoCfaNotesPdf01");
check("pdf: last page saved in store lib.pos", await p.js(`Finspire.store.get("lib.pos",{}).demoCfaNotesPdf01`) === 3);
await click(p, `[data-lib-item="demoCfaNotesPdf01"]`);
await waitFor(p, `!!document.querySelector("[data-lib-continue]")`, 15000);
check("pdf: reopen offers Continue from page 3", (await txt(p, "[data-lib-continue] .lib-cont-go")) === "Continue from page 3");
await p.shot(join(OUT, "d-6-continue.png"));
await click(p, "[data-lib-continue] .lib-cont-go"); await sleep(400);
check("pdf: Continue jumps to page 3", await p.js(`document.querySelector("[data-lib-page]").value`) === "3" && !(await p.js(`!!document.querySelector("[data-lib-continue]")`)));
// download from the viewer
await click(p, ".lib-vw [data-lib-dl]"); await sleep(500);
const dl1 = await p.js("window.__dl.slice(-1)[0]");
check("download: blob link with the real file name", dl1 && dl1.href.startsWith("blob:") && dl1.name === "Sample CFA notes.pdf", dl1);
check("download: blob holds the PDF bytes", await p.js(`fetch(window.__dl.slice(-1)[0].href).then(r=>r.blob()).then(b=>b.size===2676 && b.type==="application/pdf").catch(()=>false)`));
await click(p, "[data-lib-close]"); await sleep(500);
check("viewer: close button closes", !(await p.js(`!!document.querySelector(".fs-modal.lib-vw")`)));

// image viewer --------------------------------------------------------------------------------------------------
await click(p, `[data-lib-item="demoQuantChartPng"]`);
await waitFor(p, `(document.querySelector(".lib-img")||{}).naturalWidth > 0`, 8000);
check("image: shown inline", await p.js(`document.querySelector(".lib-img").naturalWidth`) === 640);
check("image: fitted inside the stage", await p.js(`(()=>{const s=document.querySelector("[data-lib-stage]").getBoundingClientRect(), i=document.querySelector(".lib-img").getBoundingClientRect(); return i.width <= s.width && i.height <= s.height})()`));
await p.shot(join(OUT, "d-7-image.png"));
await click(p, "[data-lib-zin]"); await sleep(200);
check("image: zoom in", (await txt(p, "[data-lib-fit]")).endsWith("%"));
await key(p, "Escape"); await sleep(400);
// row download button
await click(p, `[data-lib-dl="demoQuantChartPng"]`); await sleep(500);
const dl2 = await p.js("window.__dl.slice(-1)[0]");
check("download: row button saves the image by name", dl2 && dl2.href.startsWith("blob:") && dl2.name === "Revenue growth chart.png", dl2);

// in-folder search + other folders ------------------------------------------------------------------------------
await click(p, "[data-lib-q]");
await p.type("notes"); await sleep(900);
check("search: filters this folder", (await p.js(`[...document.querySelectorAll(".lib-list:not(.lib-more .lib-list) .lib-row-t")].map(e=>e.textContent)`)).join() === "Sample CFA notes.pdf");
await p.js(`(()=>{const i=document.querySelector("[data-lib-q]"); i.value=""; i.dispatchEvent(new Event("input"))})()`); await sleep(500);

// recent ----------------------------------------------------------------------------------------------------------
await click(p, `[data-lib-crumb="0"]`);
await waitFor(p, `!!document.querySelector("[data-lib-recent]")`);
const rec = await p.js(`[...document.querySelectorAll("[data-lib-recent]")].map(e=>e.dataset.libRecent)`);
check("recent: newest first", rec[0] === "demoQuantChartPng" && rec[1] === "demoCfaNotesPdf01", rec);
check("recent: shows the saved page", (await txt(p, `[data-lib-recent="demoCfaNotesPdf01"]`)).includes("Page 3"));
{ const st = await p.js(`Finspire.store.get("lib.recent",[]).map(r=>r.id+":"+r.folder)`);
  check("recent: stored in lib.recent with the folder name", st.length === 2 && st[1] === "demoCfaNotesPdf01:CFA resources", st); }
await p.shot(join(OUT, "d-8-recent.png"));
await click(p, `[data-lib-recent="demoCfaNotesPdf01"]`);
check("recent: reopens the file", !!(await waitFor(p, `document.querySelectorAll(".lib-pg.on canvas").length >= 1`, 10000)));
await key(p, "Escape"); await sleep(400);

// library-wide search ---------------------------------------------------------------------------------------------
await click(p, "[data-lib-q]");
await p.type("dcf"); await sleep(1200);
const res = await p.js(`[...document.querySelectorAll(".lib-results .lib-row-t")].map(e=>e.textContent)`);
check("search: Drive-side name search across the folders", res.includes("DCF walkthrough.pdf"), res);
check("search: results say which folder", (await txt(p, ".lib-results .lib-row-in")).startsWith("in "));
await p.shot(join(OUT, "d-9-search.png"));
await p.js(`(()=>{const i=document.querySelector("[data-lib-q]"); i.value="zzzz"; i.dispatchEvent(new Event("input"))})()`); await sleep(1000);
check("search: no results message", !!(await p.js(`!!document.querySelector("[data-lib-noresults]")`)));
await p.js(`(()=>{const i=document.querySelector("[data-lib-q]"); i.value=""; i.dispatchEvent(new Event("input"))})()`); await sleep(500);

// errors, Google Docs export, preview frame, empty folder ----------------------------------------------------
await click(p, `button.lib-fc[data-lib-folder="demoLockedModels01"]`);
await waitFor(p, `!!document.querySelector("[data-lib-error]")`);
check("403: friendly no-access message", (await txt(p, "[data-lib-error]")).includes("You don't have access to this folder") && (await txt(p, "[data-lib-error]")).includes("share it with IIM Ranchi"));
await p.shot(join(OUT, "d-10-denied.png"));
await p.js(`location.hash = "#f=17UwJD6uBOuwLPXxiJAw3dnPPH6Wt85Bk"`);
await waitFor(p, `!!document.querySelector('[data-lib-item="demoInterviewDoc1"]')`);
await click(p, `[data-lib-item="demoInterviewDoc1"]`);
check("google doc: exported to PDF in the same viewer", !!(await waitFor(p, `document.querySelectorAll(".lib-pg.on canvas").length >= 1`, 10000)) && (await txt(p, ".lib-vw-meta")).includes("opened as PDF"));
await click(p, ".lib-vw [data-lib-dl]"); await sleep(400);
check("google doc: downloads as Interview guide.pdf", (await p.js("window.__dl.slice(-1)[0].name")) === "Interview guide.pdf");
await key(p, "Escape"); await sleep(400);
await p.js(`location.hash = "#f=demoCoverLetters01"`);
await waitFor(p, `!!document.querySelector('[data-lib-item="demoCoverDocx001"]')`);
await click(p, `[data-lib-item="demoCoverDocx001"]`); await sleep(400);
check("docx: shown in the preview frame area with a note", !!(await p.js(`!!document.querySelector('[data-lib-preview="demo"]') && !!document.querySelector(".lib-pv-note")`)));
await p.shot(join(OUT, "d-11-preview.png"));
await key(p, "Escape"); await sleep(400);
await p.js(`location.hash = "#f=demoCfaResources01/demoCfaLevel2Fold"`);
await waitFor(p, `!!document.querySelector(".lib-empty")`);
check("empty folder: plain message", (await txt(p, ".lib-empty")).includes("This folder is empty"));

// upload --------------------------------------------------------------------------------------------------------------
await click(p, "[data-lib-upload]"); await sleep(300);
check("upload: dialog explains admin review", (await txt(p, "[data-lib-upload-dialog]")).includes("reviews each upload"));
await setFile(p, "[data-lib-file]", join(HERE, "fixtures/demo/files/reading-list.txt"));
await sleep(200);
check("upload: chosen file shown", (await txt(p, ".lib-up-file")).includes("reading-list.txt"));
await p.shot(join(OUT, "d-12-upload.png"));
await click(p, "[data-lib-upload-dialog] .fs-mbtn.primary");
await waitFor(p, `!!document.querySelector("[data-lib-uploaded]")`, 5000);
check("upload: progress then 'Sent for review'", (await txt(p, "[data-lib-uploaded]")).includes("Sent for review"));
await p.shot(join(OUT, "d-13-uploaded.png"));
await key(p, "Escape"); await sleep(300);

// deep link reload ----------------------------------------------------------------------------------------------------
await p.goto(LIB + "#f=demoCfaResources01/demoCfaLevel1Fold", 2000);
await waitFor(p, `!!document.querySelector('[data-lib-item="demoCfaNotesPdf01"]')`);
check("deep link: opens the sub-folder and resolves names", (await crumbs(p)).join(" / ") === "Library / CFA resources / Level I", await crumbs(p));
check("desktop: no horizontal overflow", await noOverflow(p));
// sign out → gate
await p.js("Finspire.auth.signOut()"); await sleep(600);
check("sign out: back to the gate", await p.js(`document.querySelector("#lib").dataset.screen`) === "gate");
check("desktop: zero console errors", p.errors.length === 0, p.errors);
p.close();

// ================================================================================================= phone 390×844
{
  const M = { width: 390, height: 844, mobile: true, scale: 2 };
  const q = await open(LIB + "?demo-user=0", M);
  await waitFor(q, `document.querySelector("#lib").dataset.screen === "gate"`);
  check("phone gate: no sideways scroll", await noOverflow(q));
  await q.shot(join(OUT, "m-1-gate.png"));
  await q.goto(DEMO, 1500);
  await waitFor(q, `!!document.querySelector("[data-lib-open]")`);
  check("phone open: button full width-ish and ≥ 44px", await q.js(`(()=>{const r=document.querySelector("[data-lib-open]").getBoundingClientRect(); return r.height>=44 && r.width>=250})()`));
  await q.shot(join(OUT, "m-2-open.png"));
  await tap(q, "[data-lib-open]");
  await waitFor(q, `document.querySelectorAll(".lib-fc").length > 0`);
  check("phone home: one column of folders", await q.js(`(()=>{const a=[...document.querySelectorAll(".lib-fc")].slice(0,2).map(e=>e.getBoundingClientRect()); return a[0].left===a[1].left && a[1].top>a[0].bottom})()`));
  check("phone home: no sideways scroll", await noOverflow(q));
  await q.shot(join(OUT, "m-3-home.png"));
  await tap(q, `button.lib-fc[data-lib-folder="demoCfaResources01"]`);
  await waitFor(q, `!!document.querySelector('[data-lib-item="demoCfaLevel1Fold"]')`);
  await tap(q, `[data-lib-item="demoCfaLevel1Fold"]`);
  await waitFor(q, `!!document.querySelector('[data-lib-item="demoCfaNotesPdf01"]')`);
  check("phone folder: rows are big tap targets", await q.js(`[...document.querySelectorAll(".lib-row-main, .lib-row-dl, .lib-crumb, .lib-back:not([hidden]), [data-lib-type]")].every(e=>{const r=e.getBoundingClientRect(); return r.height>=40 && (r.width>=40)})`));
  check("phone folder: search input ≥ 16px", await q.js(`parseFloat(getComputedStyle(document.querySelector("[data-lib-q]")).fontSize) >= 16`));
  check("phone folder: chips scroll sideways (no wrap)", await q.js(`getComputedStyle(document.querySelector(".lib-chips")).flexWrap === "nowrap"`));
  check("phone folder: 16px gutters", await q.js(`Math.round(document.querySelector(".lib-list").getBoundingClientRect().left) === 16`));
  await q.js(`scrollTo(0, 300)`); await sleep(300);
  check("phone folder: breadcrumb bar stays visible (sticky)", await q.js(`(()=>{const r=document.querySelector(".lib-bar").getBoundingClientRect(); const h=document.querySelector("header[data-fs-header]").getBoundingClientRect(); return Math.abs(r.top - h.bottom) < 2})()`));
  check("phone folder: no sideways scroll", await noOverflow(q));
  await q.shot(join(OUT, "m-4-folder.png"));
  await q.js(`scrollTo(0, 0)`);
  await tap(q, `[data-lib-item="demoCfaNotesPdf01"]`);
  await waitFor(q, `document.querySelectorAll(".lib-pg.on canvas").length >= 1`, 20000);
  { const fr = await q.js(`(()=>{const r=document.querySelector(".lib-vw .fs-modal-card").getBoundingClientRect(); return [r.left, r.top, r.width, r.height, innerWidth, innerHeight]})()`);
    check("phone viewer: full screen", fr[0] === 0 && Math.abs(fr[1]) < 1 && Math.round(fr[2]) === fr[4] && Math.round(fr[3]) === fr[5], fr); }
  check("phone viewer: page fits the width", await q.js(`(()=>{const r=document.querySelector(".lib-pg").getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth})()`));
  check("phone viewer: toolbar pinned to the bottom", await q.js(`Math.round(document.querySelector(".lib-vw-tools").getBoundingClientRect().bottom) === innerHeight`));
  check("phone viewer: tool buttons ≥ 44px", await q.js(`[...document.querySelectorAll(".lib-vw .lib-tbtn, .lib-vw .lib-vbtn")].every(e=>e.getBoundingClientRect().height>=44)`));
  check("phone viewer: Continue from page 3 (shared store)", (await txt(q, "[data-lib-continue] .lib-cont-go")) === "Continue from page 3");
  await q.shot(join(OUT, "m-5-pdf.png"));
  await tap(q, "[data-lib-continue] .lib-cont-x");
  await tap(q, "[data-lib-next]"); await sleep(300);
  check("phone viewer: next page", await q.js(`document.querySelector("[data-lib-page]").value`) === "2");
  await q.js("history.back()"); await sleep(600);
  check("phone viewer: back button closes the viewer, stays in the folder", !(await q.js(`!!document.querySelector(".fs-modal.lib-vw")`)) && (await crumbs(q)).length === 3);
  await tap(q, `[data-lib-item="demoQuantChartPng"]`);
  await waitFor(q, `(document.querySelector(".lib-img")||{}).naturalWidth > 0`, 8000); await sleep(200);
  check("phone image viewer: image fits the screen", await q.js(`(()=>{const r=document.querySelector(".lib-img").getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth})()`));
  await q.shot(join(OUT, "m-6-image.png"));
  await tap(q, "[data-lib-close]"); await sleep(400);
  await tap(q, "[data-lib-upload]"); await sleep(400);
  check("phone upload: dialog as a bottom sheet", await q.js(`Math.round(document.querySelector("[data-lib-upload-dialog]").getBoundingClientRect().bottom) === innerHeight`));
  await q.shot(join(OUT, "m-7-upload.png"));
  check("phone: no sideways scroll", await noOverflow(q));
  check("phone: zero console errors", q.errors.length === 0, q.errors);
  q.close();
}

// ================================================================================================= feature switches
// config.js assigns window.FINSPIRE_CONFIG; this setter merges feature switches into whatever it assigns.
const features = f => `(() => { let c; Object.defineProperty(window, "FINSPIRE_CONFIG", { configurable: true,
  get() { return c; }, set(v) { c = Object.assign({}, v, { googleClientId: "", features: Object.assign({}, v && v.features, ${JSON.stringify(f)}) }); } }); })();`;
{
  // sign-in switched off, no public Drive key: the gate says so plainly and keeps the folder preview
  const g = await open(LIB + "?demo-user=0&demo-drive=0", { before: HOOK + features({ signin: false }) });
  await waitFor(g, `document.querySelector("#lib").dataset.screen === "gate"`);
  check("signin off: gate shown (guests have no Drive access)", await g.js(`document.querySelector("#lib").dataset.screen`) === "gate");
  check("signin off: no Google button, no account control", await g.js(`!document.querySelector("[data-lib-signin]") && !document.querySelector("[data-lib-open]") && document.querySelector("[data-fs-account]").hidden`));
  check("signin off: says the Library opens with IIM Ranchi sign-in", /opens with IIM Ranchi sign-in/i.test(await txt(g, ".lib-intro-h")));
  check("signin off: still previews the folder names", await g.js(`document.querySelectorAll(".lib-intro-list li").length`) === NF);
  check("signin off: links to the Dictionary built from cfg.pages", await g.js(`(document.querySelector("[data-lib-off-signin] a")||{}).getAttribute("href")`) === "../dictionary/");
  check("signin off: no sideways scroll", await noOverflow(g));
  await g.shot(join(OUT, "d-14-signin-off.png"));
  check("signin off: zero console errors", g.errors.length === 0, g.errors);
  g.close();
}
{
  // sign-in switched off but folders reachable with the API key (demo Drive stands in): browse without signing in
  const k = await open(LIB + "?demo-user=1&demo-drive=1", { before: HOOK + features({ signin: false }) });
  await waitFor(k, `document.querySelectorAll(".lib-fc").length > 0`);
  check("signin off + key: folders open without a sign-in step", await k.js(`document.querySelector("#lib").dataset.screen`) === "browser" && await k.js(`document.querySelectorAll("button.lib-fc").length`) >= 6);
  check("signin off + key: no upload (needs a Google account)", !(await k.js(`!!document.querySelector("[data-lib-upload], [data-lib-share]")`)));
  await click(k, `button.lib-fc[data-lib-folder="demoMembersNotes01"]`);
  await waitFor(k, `!!document.querySelector('[data-lib-item="demoNotesDcf00001"]')`);
  await click(k, `[data-lib-item="demoNotesDcf00001"]`);
  check("signin off + key: PDF opens in the viewer", !!(await waitFor(k, `document.querySelectorAll(".lib-pg.on canvas").length >= 1`, 15000)));
  await key(k, "Escape"); await sleep(400);
  check("signin off + key: recent kept for the local guest", await k.js(`Finspire.store.get("lib.recent",[])[0].id`) === "demoNotesDcf00001");
  check("signin off + key: zero console errors", k.errors.length === 0, k.errors);
  k.close();
}
{
  const o = await open(LIB + "?demo-user=1&demo-drive=1", { before: HOOK + features({ library: false }) });
  await waitFor(o, `document.querySelector("#lib").dataset.screen === "off"`);
  check("library off: plain 'not open yet' panel", (await txt(o, "[data-lib-off]")).includes("The Library isn't open yet"));
  // (the account menu's own "Library" item belongs to finspire.js and is not checked here)
  check("library off: nav, menu and footer links to the Library hidden", await o.js(`[...document.querySelectorAll('.nav-links a[href="../library/"], .mobile-menu a[href="../library/"], .fs-foot a[href="../library/"]')].every(a => a.hidden)`));
  check("library off: home link from cfg.pages", await o.js(`document.querySelector("[data-lib-off] a.btn-primary").getAttribute("href")`) === "../index.html");
  await o.shot(join(OUT, "d-15-library-off.png"));
  check("library off: zero console errors", o.errors.length === 0, o.errors);
  o.close();
}

// ================================================================================================= reduced motion
{
  const r = await open(DEMO, { reducedMotion: true });
  await waitFor(r, `document.querySelectorAll(".lib-fc, [data-lib-open]").length > 0`);
  check("reduced motion: page works", await r.js(`!!document.querySelector("#lib .lib-intro, #lib .lib-browser")`));
  check("reduced motion: zero console errors", r.errors.length === 0, r.errors);
  r.close();
}

await b.close();
process.exit(R.done() ? 1 : 0);
