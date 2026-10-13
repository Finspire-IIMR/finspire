// Records the home page's product-tour video: a real screen recording of the live site with a visible, eased cursor.
//
//   node --experimental-websocket tools/record-tour.mjs [--url https://ctaiuser.github.io/finspire/] [--port 9471]
//        [--out site/assets/video] [--crf 26] [--width 1280] [--keep]
//
// How it works: headless Chrome (tests/lib/cdp.mjs) at 1440x900 runs Page.startScreencast; every JPEG frame is written to a
// temp folder with its arrival time. A fixed-position macOS-style cursor is injected into every document and follows the
// real Input.dispatchMouseEvent moves, so hover states, tooltips and clicks are the site's own. Afterwards ffmpeg turns the
// frames into tour.mp4 (H.264) and tour.webm (VP9) through a concat list with per-frame durations, so playback speed is
// real, plus tour-poster.jpg. chapters.json holds the start time of each chapter (repository, paths, events, markets).
// Nothing is signed in and nothing is typed except the two search queries.
import { launch, sleep } from "../tests/lib/cdp.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > -1 ? process.argv[i + 1] : d; };
const URL_HOME = arg("url", "https://ctaiuser.github.io/finspire/");
const PORT = +arg("port", 9471), CRF = +arg("crf", 26), OUT_W = +arg("width", 1280), OUT_H = Math.round(OUT_W * 900 / 1440);
const OUT = resolve(ROOT, arg("out", "site/assets/video"));
const KEEP = process.argv.includes("--keep"), NO_WEBM = process.argv.includes("--no-webm"), VERBOSE = process.argv.includes("--verbose");
const W = 1440, H = 900;

// ---------- page-side helpers (injected into every document) ----------
const CURSOR_SRC = `(() => {
  if (window.__tour) return;
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 28" width="22" height="26">' +
    '<path d="M5.5 3.2v16.6l4.4-4.3 2.9 6.6 2.9-1.2-2.9-6.5h6.2z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const el = document.createElement("div"); el.id = "__tour-cursor";
  el.style.cssText = "position:fixed;left:0;top:0;width:22px;height:26px;z-index:2147483647;pointer-events:none;" +
    "transform:translate3d(-100px,-100px,0);will-change:transform;filter:drop-shadow(0 2px 2.5px rgba(0,0,0,.45));";
  const inner = document.createElement("div");
  inner.style.cssText = "width:22px;height:26px;margin:-3px 0 0 -5px;transform-origin:5px 3px;transition:transform 90ms ease-out;";
  inner.innerHTML = SVG; el.appendChild(inner);
  let x = -100, y = -100;
  const place = (nx, ny) => { x = nx; y = ny; el.style.transform = "translate3d(" + x + "px," + y + "px,0)"; };
  const mount = () => { (document.body || document.documentElement).appendChild(el); };
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
  window.addEventListener("mousemove", e => place(e.clientX, e.clientY), true);
  window.addEventListener("mousedown", () => { inner.style.transform = "scale(.8)"; }, true);
  window.addEventListener("mouseup", () => { inner.style.transform = ""; }, true);
  const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  window.__tour = {
    place, pos: () => [x, y],
    rect(sel, nth = 0) {
      const list = [...document.querySelectorAll(sel)].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
      const e = list[nth]; if (!e) return null; const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, top: b.top + scrollY };
    },
    scrollTo(y, ms) {
      document.documentElement.style.scrollBehavior = "auto";
      const max = document.documentElement.scrollHeight - innerHeight; y = Math.max(0, Math.min(max, y));
      return new Promise(res => { const y0 = scrollY, t0 = performance.now();
        const step = now => { const t = Math.min(1, (now - t0) / ms); window.scrollTo(0, Math.round(y0 + (y - y0) * ease(t))); if (t < 1) requestAnimationFrame(step); else res(scrollY); };
        requestAnimationFrame(step); });
    },
    scrollIn(sel, y, ms, absolute) {
      let e = document.querySelector(sel);
      while (e && e !== document.body) { const o = getComputedStyle(e).overflowY; if (/auto|scroll/.test(o) && e.scrollHeight > e.clientHeight + 2) break; e = e.parentElement; }
      if (!e || e === document.body) return this.scrollTo(absolute ? y : scrollY + y, ms);
      const y0 = e.scrollTop, y1 = Math.max(0, Math.min(e.scrollHeight - e.clientHeight, absolute ? y : y0 + y)), t0 = performance.now();
      return new Promise(res => { const step = now => { const t = Math.min(1, (now - t0) / ms); e.scrollTop = Math.round(y0 + (y1 - y0) * ease(t)); if (t < 1) requestAnimationFrame(step); else res(e.scrollTop); }; requestAnimationFrame(step); });
    }
  };
})();`;

// ---------- recorder ----------
async function main() {
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "fs-tour-")), framesDir = join(tmp, "frames"); mkdirSync(framesDir);
  const frames = [];                       // {file, t}
  const marks = [];                        // {id, t}
  let posterT = null, recording = false;
  const b = await launch({ port: PORT });
  const p = await b.page("about:blank", { width: W, height: H, scale: 1, realConfig: true, wait: 200, before: CURSOR_SRC });
  const { send } = p;
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  p.on(m => {
    if (m.method !== "Page.screencastFrame") return;
    const { data, sessionId } = m.params;
    if (recording) { const file = join(framesDir, String(frames.length).padStart(6, "0") + ".jpg"); writeFileSync(file, Buffer.from(data, "base64")); frames.push({ file, t: Date.now() }); }
    send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  // the screencast survives same-origin navigations, so a restart may answer "already active"
  const startCast = () => send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: W, maxHeight: H, everyNthFrame: 1 }).catch(() => {});

  // mouse + keyboard primitives (all go through CDP so the page reacts for real)
  let mx = 1180, my = 300;
  const el = () => ((Date.now() - (frames[0]?.t ?? Date.now())) / 1000).toFixed(1) + "s";
  const stamp = (label, t0) => { if (VERBOSE) console.log(`  ${el()}  ${label}${t0 ? " (" + (Date.now() - t0) + " ms)" : ""}`); };
  const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const mouseAt = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  async function moveTo(x, y, ms) {
    const d = Math.hypot(x - mx, y - my); ms = ms ?? Math.max(500, Math.min(900, 400 + d * 0.5));
    const x0 = mx, y0 = my, t0 = Date.now(); let t = 0;
    while (t < 1) { t = Math.min(1, (Date.now() - t0) / ms); const e = ease(t); mx = x0 + (x - x0) * e; my = y0 + (y - y0) * e; await mouseAt(mx, my); await sleep(16); }
    mx = x; my = y; await mouseAt(x, y); stamp(`move → ${Math.round(x)},${Math.round(y)}`, t0);
  }
  const rect = (sel, nth = 0) => p.js(`__tour.rect(${JSON.stringify(sel)}, ${nth})`);
  async function centre(sel, nth = 0, fx = 0.5, fy = 0.5) { const r = await rect(sel, nth); if (!r) throw new Error("not visible: " + sel); return [r.x + r.w * fx, r.y + r.h * fy]; }
  async function hover(sel, { nth = 0, fx = 0.5, fy = 0.5, ms, hold = 1200 } = {}) { const t0 = Date.now(); const [x, y] = await centre(sel, nth, fx, fy); await moveTo(x, y, ms); await sleep(hold); stamp("hover " + sel, t0); }
  async function press() {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: mx, y: my, button: "left", clickCount: 1 }); await sleep(110);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: mx, y: my, button: "left", clickCount: 1 });
  }
  async function click(sel, { nth = 0, fx = 0.5, fy = 0.5, ms, settle = 600 } = {}) { const t0 = Date.now(); const [x, y] = await centre(sel, nth, fx, fy); await moveTo(x, y, ms); await sleep(180); await press(); await sleep(settle); stamp("click " + sel, t0); }
  async function type(text, per = 120) {
    const t0 = Date.now();
    for (const ch of text) {
      const key = ch === " " ? " " : ch, code = ch === " " ? "Space" : "Key" + ch.toUpperCase();
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, text: ch, unmodifiedText: ch });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code });
      await sleep(per + Math.round(Math.random() * 50));
    }
    stamp("type " + JSON.stringify(text), t0);
  }
  const scrollTo = async (y, ms = 800) => { const t0 = Date.now(); const r = await p.js(`__tour.scrollTo(${y}, ${ms})`); stamp("scroll → " + Math.round(y), t0); return r; };
  const scrollIn = async (sel, y, ms = 1000, absolute = false) => { const t0 = Date.now(); const r = await p.js(`__tour.scrollIn(${JSON.stringify(sel)}, ${y}, ${ms}, ${absolute})`); stamp(`scrollIn ${sel} ${absolute ? "to" : "by"} ${y}`, t0); return r; };
  async function scrollToEl(sel, offset = 120, ms = 900, nth = 0) { const r = await rect(sel, nth); if (!r) throw new Error("not found: " + sel); await scrollTo(r.top - offset, ms); await sleep(120); await mouseAt(mx, my); }
  async function waitFor(expr, timeout = 12000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await p.js(expr)) { if (Date.now() - t0 > 400) console.log(`  waited ${((Date.now() - t0) / 1000).toFixed(1)}s for ${expr.slice(0, 50)} (@${el()})`); return true; } await sleep(120); } throw new Error("timeout waiting for " + expr); }
  async function navigate(doClick) {
    const loaded = new Promise(res => p.on(m => { if (m.method === "Page.loadEventFired") res(); }));
    const t0 = Date.now(); await doClick(); await Promise.race([loaded, sleep(15000)]); await startCast(); await sleep(250); await mouseAt(mx, my);
    console.log(`  navigation ${((Date.now() - t0) / 1000).toFixed(1)}s (@${el()})`);
  }
  const mark = id => { marks.push({ id, t: Date.now() }); console.log(`chapter ${id} @ ${el()}`); };

  // ---------- the journey ----------
  await send("Page.navigate", { url: URL_HOME });
  await waitFor(`document.readyState === "complete" && !!document.querySelector("#repository")`);
  await sleep(1200);
  await mouseAt(mx, my); await startCast(); await sleep(400); recording = true; await mouseAt(mx + 1, my);
  await waitFor("__tour && document.getElementById('__tour-cursor') && true", 3000).catch(() => {});

  // 1. repository (t = 0: the first chapter starts with the first frame)
  mark("repository"); await sleep(600);
  await moveTo(980, 640, 700);
  await scrollToEl("#repository", 90, 1500); await sleep(800);
  await scrollToEl("#repository .search", 250, 800); await sleep(300);
  await click("#q", { fx: 0.12 });
  await type("DCF", 120); await sleep(700); posterT = Date.now();
  await hover(".rrow", { nth: 1, fx: 0.35, hold: 1000 });
  await click("#repository .search button", { settle: 500 });     // clear the query so the tracks come back
  await click("#track-mkt .rg-head", { fx: 0.2, settle: 700 });   // open a track
  await scrollTo(await p.js("scrollY") + 260, 800); await sleep(700);

  // 2. paths
  mark("paths");
  await moveTo(mx + 40, my - 40, 450);
  await scrollToEl("#paths", 60, 1500); await sleep(800);
  await click("#path-valuation-in-a-summer", { fx: 0.4, settle: 800 });
  await scrollToEl("#pwMap", 110, 700); await sleep(400);
  await hover("#pwMap .pw-step", { nth: 1, fx: 0.45, hold: 1000 });

  // 3. events
  mark("events");
  await scrollToEl("#events", 70, 1300); await sleep(700);
  await hover("#egrid .ev", { nth: 0, fx: 0.5, fy: 0.55, hold: 1000 });
  await hover("#egrid .ev", { nth: 1, fx: 0.5, fy: 0.55, hold: 1000 });

  // 4. markets + dictionary
  mark("markets");
  await navigate(() => click('header a.nl[href*="markets"]', { settle: 100 }));
  await waitFor(`/\\d/.test((document.querySelector(".mk-card .mk-last")||{}).textContent||"")`);
  await p.js(`window.Finspire && Finspire.glossary && Finspire.glossary.load && Finspire.glossary.load(), true`).catch(() => {});   // warm the index the news feed needs
  await sleep(700);
  await scrollToEl("#board", 110, 900); await sleep(300);
  await hover(".mk-card", { nth: 0, fx: 0.5, fy: 0.45, hold: 1000 });
  await waitFor(`!!document.querySelector(".nw-card .gl-term")`, 15000);
  await scrollToEl(".nw-card", 170, 1300); await sleep(300);
  // first underlined term that sits comfortably inside the viewport
  const termN = await p.js(`[...document.querySelectorAll(".nw-card .gl-term")].findIndex(e => { const b = e.getBoundingClientRect(); return b.top > 150 && b.bottom < 760 && b.width > 0; })`);
  await hover(".nw-card .gl-term", { nth: Math.max(0, termN), fy: 0.5, hold: 300 });
  await waitFor(`(() => { const t = document.getElementById("gl-tip"); return t && !t.hidden && t.getBoundingClientRect().height > 0; })()`, 4000).catch(() => {});
  await sleep(1300);
  await navigate(() => click('header a.nl[href*="dictionary"]', { settle: 100 }));
  await waitFor(`!!document.getElementById("dcQ")`); await sleep(500);
  await click("#dcQ", { fx: 0.15 });
  await type("repo rate", 85);
  await waitFor(`!!document.getElementById("dco-0")`); await sleep(450);
  await hover("#dco-0", { fx: 0.3, hold: 400 });
  await press(); await waitFor(`!!document.getElementById("dcEntry")`); await sleep(800);
  // the entry panel scrolls on its own: walk its sections slowly, then come back to the heading
  await scrollToEl("#dcEntry", 70, 600); await sleep(200);
  await moveTo(1340, 420, 600); await sleep(400);
  await scrollIn("#dcs-plain", 600, 1300); await sleep(700);
  await scrollIn("#dcs-plain", 760, 1300); await sleep(700);
  await scrollIn("#dcs-plain", 0, 1000, true); await sleep(150);
  await moveTo(70, 640, 650); await sleep(1300);
  const endT = Date.now();
  recording = false;
  await send("Page.stopScreencast").catch(() => {});
  await b.close();

  // ---------- encode ----------
  if (frames.length < 10) throw new Error("too few frames: " + frames.length);
  const t0 = frames[0].t, dur = (endT - t0) / 1000;
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.t ?? endT) - f.t) / 1000).toFixed(4)}`).join("\n") + `\nfile '${frames.at(-1).file}'\n`;
  const listFile = join(tmp, "frames.txt"); writeFileSync(listFile, list);
  const vf = `scale=${OUT_W}:${OUT_H}:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p`;   // JPEG frames are full-range; the video must be plain yuv420p
  const ff = args => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  const mp4 = join(OUT, "tour.mp4"), webm = join(OUT, "tour.webm"), poster = join(OUT, "tour-poster.jpg");
  console.log(`encoding ${frames.length} frames, ${dur.toFixed(1)}s …`);
  ff(["-f", "concat", "-safe", "0", "-i", listFile, "-vf", vf, "-r", "30", "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "slow", "-crf", String(CRF), "-profile:v", "high", "-pix_fmt", "yuv420p", "-color_range", "tv", "-movflags", "+faststart", "-an", mp4]);
  if (!NO_WEBM) ff(["-f", "concat", "-safe", "0", "-i", listFile, "-vf", vf, "-r", "30", "-fps_mode", "cfr", "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-pix_fmt", "yuv420p", "-color_range", "tv", "-an", webm]);
  const pf = frames.reduce((best, f) => Math.abs(f.t - posterT) < Math.abs(best.t - posterT) ? f : best, frames[0]);
  ff(["-i", pf.file, "-vf", `scale=${OUT_W}:${OUT_H}:flags=lanczos`, "-q:v", "3", "-frames:v", "1", poster]);
  const chapters = { chapters: marks.map(m => ({ id: m.id, t: +Math.max(0, (m.t - t0) / 1000).toFixed(1) })), duration: +dur.toFixed(1), width: OUT_W, height: OUT_H };
  writeFileSync(join(OUT, "chapters.json"), JSON.stringify(chapters, null, 2) + "\n");
  const mb = f => (statSync(f).size / 1048576).toFixed(2) + " MB";
  console.log(`tour.mp4 ${mb(mp4)} · tour.webm ${NO_WEBM ? "skipped" : mb(webm)} · poster ${mb(poster)} · frames ${frames.length} · ${JSON.stringify(chapters)}`);
  if (KEEP) { copyFileSync(listFile, join(OUT, "frames.txt")); console.log("frames kept in " + tmp); } else rmSync(tmp, { recursive: true, force: true });
}

main().catch(e => { console.error(e); process.exit(1); });
