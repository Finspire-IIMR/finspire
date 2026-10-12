// Minimal headless-Chrome driver over the DevTools protocol (Node 20: run with --experimental-websocket).
//   const b = await launch({port: 9401});  const p = await b.page("http://127.0.0.1:8801/markets/", {width: 1280, height: 900});
//   await p.js("document.title"); await p.shot("out/x.png"); p.errors (console errors + exceptions); await b.close();
import { spawn } from "node:child_process"; import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path"; import { tmpdir } from "node:os";
export const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function launch({port = 9400, headless = true} = {}){
  const dir = mkdtempSync(join(tmpdir(), "fs-chrome-"));
  const proc = spawn(CHROME, [headless ? "--headless=new" : "", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1280,900", "about:blank"].filter(Boolean), {stdio: "ignore"});
  let ok; for(let i = 0; i < 80 && !ok; i++){ try{ ok = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); }catch{ await sleep(250); } }
  if(!ok) throw new Error("Chrome did not start on port " + port);
  const pages = [];
  return {
    async page(url, {width = 1280, height = 900, mobile = false, scale = 1, reducedMotion = false, wait = 2500, before} = {}){
      const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method: "PUT"})).json();
      const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
      let id = 0; const pend = new Map(), errors = [], listeners = [];
      ws.onmessage = e => { const m = JSON.parse(e.data);
        if(m.id && pend.has(m.id)){ const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
        if(m.method === "Runtime.exceptionThrown") errors.push("exception: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
        if(m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("console: " + m.params.args.map(a => a.value ?? a.description ?? "").join(" "));
        if(m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push("log: " + m.params.entry.text + " " + (m.params.entry.url || ""));
        listeners.forEach(f => f(m)); };
      const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, {res, rej}); ws.send(JSON.stringify({id: i, method, params})); });
      await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
      await send("Emulation.setDeviceMetricsOverride", {width, height, deviceScaleFactor: scale, mobile});
      if(mobile) await send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
      if(reducedMotion) await send("Emulation.setEmulatedMedia", {features: [{name: "prefers-reduced-motion", value: "reduce"}]});
      if(before) await send("Page.addScriptToEvaluateOnNewDocument", {source: before});
      await send("Page.navigate", {url}); await sleep(wait);
      const p = {
        send, errors, on: f => listeners.push(f),
        async js(expr){ const r = await send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true});
          if(r.exceptionDetails) throw new Error("page JS: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; },
        async shot(file, {fullPage = false} = {}){ mkdirSync(dirname(file), {recursive: true});
          const params = {format: file.endsWith(".jpg") ? "jpeg" : "png", quality: 82};
          if(fullPage){ const {contentSize} = await send("Page.getLayoutMetrics"); params.clip = {x: 0, y: 0, width, height: Math.min(contentSize.height, 16000), scale: 1}; params.captureBeyondViewport = true; }
          const s = await send("Page.captureScreenshot", params); writeFileSync(file, Buffer.from(s.data, "base64")); },
        async click(sel){ const r = await p.js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; e.scrollIntoView({block:"center"}); const b=e.getBoundingClientRect(); return [b.x+b.width/2,b.y+b.height/2]})()`);
          if(!r) throw new Error("no element " + sel); await sleep(150);
          for(const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", {type, x: r[0], y: r[1], button: "left", clickCount: 1}); await sleep(200); },
        async hover(sel){ const r = await p.js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; e.scrollIntoView({block:"center"}); const b=e.getBoundingClientRect(); return [b.x+b.width/2,b.y+b.height/2]})()`);
          if(!r) throw new Error("no element " + sel); await sleep(100); await send("Input.dispatchMouseEvent", {type: "mouseMoved", x: r[0], y: r[1]}); await sleep(400); },
        async type(text){ await send("Input.insertText", {text}); await sleep(150); },
        async key(key){ for(const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", {type, key, code: key}); await sleep(100); },
        async goto(u, w = 2000){ await send("Page.navigate", {url: u}); await sleep(w); },
        close(){ try{ ws.close(); }catch{} }
      };
      pages.push(p); return p;
    },
    async close(){ pages.forEach(p => p.close()); proc.kill("SIGKILL"); }
  };
}

// tiny test runner: check("name", bool, detail)
export function reporter(){
  const rows = []; let fails = 0;
  return {
    check(name, ok, detail){ rows.push([ok, name, detail]); if(!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail).slice(0, 300)}`); },
    done(){ console.log(`\n${rows.length - fails}/${rows.length} passed`); return fails; }
  };
}
