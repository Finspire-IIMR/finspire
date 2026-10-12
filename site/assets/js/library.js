/* Finspire Library (library/index.html): the club's Google Drive folders, browsed and opened inside the site.
   Contract: ARCHITECTURE.md ("Library"). Uses window.Finspire only; defines no globals.

   States   signed out → gate (sign-in + folder preview) · signed in → "Open the library" (Drive token needs a click,
            skipped when a drive.readonly token already exists) · open → folders → files (Drive API v3).
   Routing  #f=<folderId>/<subfolderId>/…   (back/forward work; the viewer also closes with the phone's back button)
   Viewer   PDFs with PDF.js 4.10.38 (lazy pages, zoom, page jump, last page remembered in store "lib.pos"),
            Google Docs/Slides/Sheets exported to PDF, images inline, text inline, anything else in Drive's preview
            frame. Download everywhere (blob + object URL, real file name).
   Upload   to drive.inbox (scope drive.file), multipart ≤ 5 MB, resumable above.
   Demo     ?demo-user=1&demo-drive=1 on localhost with a --demo build: Drive calls are answered from _demo/drive.json
            and _demo/files/*, so the whole flow runs without Google. */
(() => {
"use strict";
const F = window.Finspire;
const root = document.getElementById("lib");
if (!F || !root) return;
const D = document, W = window, { h } = F.dom;

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/";
const RO = ["drive.readonly"], RW = ["drive.file"];
const GA = "application/vnd.google-apps.";
const FOLDER = GA + "folder";
const FIELDS = "id,name,mimeType,size,modifiedTime,iconLink,thumbnailLink,parents,shortcutDetails(targetId,targetMimeType)";
const MAX_UPLOAD = 100 * 1024 * 1024;
const mq = q => (W.matchMedia ? W.matchMedia(q) : { matches: false, addEventListener() {} });
const PHONE = mq("(max-width: 720px)"), REDUCE = mq("(prefers-reduced-motion: reduce)");
/* A real signed-in student. Without usable sign-in (switched off, or no Google client id yet) Finspire.auth.user() returns a local
   guest, who has no Google account and therefore no Drive token. */
const member = () => { const u = F.auth.user(); return u && !u.guest ? u : null; };
const signinOn = () => F.feature("signin");
const ss = (() => { try { return W.sessionStorage; } catch (e) { return null; } })();
const sget = k => { try { return ss ? ss.getItem(k) : null; } catch (e) { return null; } };
const sset = (k, v) => { try { if (ss) v == null ? ss.removeItem(k) : ss.setItem(k, v); } catch (e) {} };

/* ---------------------------------------------------------------- icons (static, trusted markup only) */
const P = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  cv: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h6"/>',
  qa: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.5A8 8 0 1 1 21 12z"/><path d="M10 10a2.2 2.2 0 1 1 3 2c-.7.4-1 .9-1 1.6M12 16.5h.01"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  cfa: '<circle cx="12" cy="9" r="5"/><path d="m9 13.5-2 7 5-2.5 5 2.5-2-7"/>',
  notes: '<path d="M6 3h11a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8 8h7M8 12h7M8 16h4"/>',
  model: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 4v16M15 4v16"/>',
  pitch: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8"/><path d="m7 12 3-3 2 2 4-4"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  pdf: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M9.5 17v-4h1.3a1.2 1.2 0 0 1 0 2.4H9.5"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 12h6M10 15h6M10 18h4"/>',
  sheet: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/>',
  slides: '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M12 17v3M8.5 20h7"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-8 9"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  audio: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  text: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h3"/>',
  zip: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M11 6h1M11 9h1M11 12h1M10.5 15h2v3h-2z"/>',
  other: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 16V5M7 9.5l5-5 5 5"/><path d="M5 20h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  arrow: '<path d="M7 17 17 7M9 7h8v8"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20v-4h-4"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>'
};
function I(name, cls) {
  const t = D.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"' +
    (cls ? ' class="' + cls + '"' : "") + ">" + (P[name] || P.other) + "</svg>";
  return t.content.firstChild;
}

/* ---------------------------------------------------------------- helpers */
const KINDS = {
  folder: "Folders", pdf: "PDFs", doc: "Documents", sheet: "Spreadsheets", slides: "Slides", image: "Images",
  video: "Video", audio: "Audio", text: "Text", zip: "Archives", other: "Other"
};
const KIND_LABEL = { folder: "Folder", pdf: "PDF", doc: "Document", sheet: "Spreadsheet", slides: "Slides", image: "Image",
  video: "Video", audio: "Audio", text: "Text", zip: "Archive", other: "File" };
function kindOf(m) {
  m = String(m || "");
  if (m === FOLDER) return "folder";
  if (m === "application/pdf") return "pdf";
  if (m === GA + "document" || /msword|wordprocessingml|opendocument\.text|rtf/.test(m)) return "doc";
  if (m === GA + "spreadsheet" || /ms-excel|spreadsheetml|opendocument\.spreadsheet|text\/csv/.test(m)) return "sheet";
  if (m === GA + "presentation" || /ms-powerpoint|presentationml|opendocument\.presentation/.test(m)) return "slides";
  if (m.startsWith("image/") || m === GA + "drawing") return "image";
  if (m.startsWith("video/") || m === GA + "video") return "video";
  if (m.startsWith("audio/") || m === GA + "audio") return "audio";
  if (m.startsWith("text/") || m === "application/json") return "text";
  if (/zip|x-rar|x-7z|x-tar|gzip/.test(m)) return "zip";
  return "other";
}
const EXPORTABLE = [GA + "document", GA + "presentation", GA + "spreadsheet", GA + "drawing"];
function openMode(f) {
  const m = String(f.mimeType || "");
  if (m === "application/pdf") return "pdf";
  if (EXPORTABLE.includes(m)) return "export";
  if (/^image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml)$/.test(m)) return "image";
  if ((/^text\/(plain|csv|markdown|tab-separated-values)$/.test(m) || m === "application/json") && !(+f.size > 2e6)) return "text";
  if (m.startsWith(GA)) return "none";
  return "preview";
}
function fileName(f) {
  const n = String(f.name || "file").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim() || "file";
  return openMode(f) === "export" && !/\.pdf$/i.test(n) ? n + ".pdf" : n;
}
function fmtSize(n) {
  if (n == null || n === "") return "";
  n = +n;
  if (!isFinite(n) || n < 0) return "";
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB"]; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")) + " " + u[i];
}
const fmtDate = iso => iso ? F.fmt.date(iso) : "";
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
function folderIdFrom(u) {
  const s = String(u || "").trim();
  if (!/^https?:\/\//i.test(s)) return null;
  let x; try { x = new URL(s); } catch (e) { return null; }
  if (!/(^|\.)(drive|docs)\.google\.com$/i.test(x.hostname)) return null;
  const m = x.pathname.match(/\/folders\/([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  const id = x.searchParams.get("id");
  return id && /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
}
const debounce = (fn, ms) => { let t = 0; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); return d; };
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
function err(kind, status, detail) { const e = new Error(kind + (status ? " " + status : "")); e.kind = kind; e.status = status || 0; e.detail = detail || ""; return e; }
const isAbort = e => e && (e.name === "AbortError" || e.kind === "abort");

/* ---------------------------------------------------------------- state */
const S = {
  site: null, folders: [], inbox: null, demo: null, keyMode: false,
  opened: false, path: [], names: new Map(), lists: new Map(), searchIds: new Set(),
  sort: "name", type: "all", q: "", loadSeq: 0, items: null, error: null, badToken: null
};
const live = h("p", { class: "sr-only", role: "status", "aria-live": "polite" });
D.body.appendChild(live);
const say = t => { live.textContent = ""; setTimeout(() => { live.textContent = t; }, 30); };

/* ---------------------------------------------------------------- Drive access (real + demo share one interface) */
async function readBody(r, onProgress, signal) {
  const total = +r.headers.get("Content-Length") || 0;
  const type = r.headers.get("Content-Type") || "";
  if (!r.body || !r.body.getReader || !onProgress) return r.blob();
  const reader = r.body.getReader(), parts = []; let got = 0;
  for (;;) {
    if (signal && signal.aborted) { try { reader.cancel(); } catch (e) {} throw err("abort"); }
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.byteLength;
    onProgress(got, total);
  }
  return new Blob(parts, { type: type.split(";")[0] });
}
async function token() {
  if (S.keyMode) return null;
  if (!member()) throw err("signed-out");
  if (!F.auth.hasToken(RO)) throw err("auth");
  return F.auth.getToken(RO);
}
async function gfetch(url, o = {}) {
  const tok = await token();
  if (!tok) {
    if (!F.cfg.driveApiKey) throw err("auth");
    url += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(F.cfg.driveApiKey);
  }
  let r;
  try {
    r = await fetch(url, { method: o.method || "GET", signal: o.signal, body: o.body,
      headers: Object.assign(tok ? { Authorization: "Bearer " + tok } : {}, o.headers || {}) });
  } catch (e) { if (isAbort(e)) throw err("abort"); throw err("network"); }
  if (r.ok) { S.badToken = null; return r; }
  let reason = "";
  try { const j = await r.json(); reason = ((j.error && j.error.errors && j.error.errors[0]) || {}).reason || (j.error && j.error.status) || ""; } catch (e) {}
  if (r.status === 401) { if (!tok) throw err("access", 401); S.badToken = tok; throw err("auth", 401); }
  if (/rateLimit|userRateLimit|backendError/i.test(reason) || r.status === 429 || r.status >= 500) throw err("busy", r.status, reason);
  if (/exportSizeLimit/i.test(reason)) throw err("too-big", r.status, reason);
  if (r.status === 403 || r.status === 404) throw err("access", r.status, reason);
  throw err("http", r.status, reason);
}
const qs = o => Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
const qstr = s => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
function normFile(f) {
  if (f && f.mimeType === GA + "shortcut" && f.shortcutDetails && f.shortcutDetails.targetId)
    return Object.assign({}, f, { id: f.shortcutDetails.targetId, mimeType: f.shortcutDetails.targetMimeType || "", size: undefined, shortcut: true });
  return f;
}
const realDrive = {
  async list(id, signal) {
    let out = [], page = "";
    do {
      const r = await gfetch(API + "?" + qs({ q: qstr(id) + " in parents and trashed=false", fields: "nextPageToken,files(" + FIELDS + ")",
        orderBy: "folder,name", pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true, pageToken: page }), { signal });
      const j = await r.json();
      out = out.concat((j.files || []).map(normFile));
      page = j.nextPageToken || "";
    } while (page && out.length < 5000);
    return out;
  },
  async meta(id, signal) {
    const r = await gfetch(API + "/" + encodeURIComponent(id) + "?" + qs({ fields: "id,name,mimeType,parents", supportsAllDrives: true }), { signal });
    return r.json();
  },
  async search(text, parents, signal) {
    const q = "name contains " + qstr(text) + " and trashed=false and (" + parents.map(p => qstr(p) + " in parents").join(" or ") + ")";
    const r = await gfetch(API + "?" + qs({ q, fields: "files(" + FIELDS + ")", pageSize: 60, orderBy: "folder,name",
      corpora: "allDrives", supportsAllDrives: true, includeItemsFromAllDrives: true }), { signal });
    return ((await r.json()).files || []).map(normFile);
  },
  async media(f, onP, signal) {
    const r = await gfetch(API + "/" + encodeURIComponent(f.id) + "?alt=media&supportsAllDrives=true", { signal });
    return readBody(r, onP, signal);
  },
  async exportPdf(f, onP, signal) {
    const r = await gfetch(API + "/" + encodeURIComponent(f.id) + "/export?mimeType=application%2Fpdf", { signal });
    const b = await readBody(r, onP, signal);
    return b.type === "application/pdf" ? b : new Blob([b], { type: "application/pdf" });
  },
  previewUrl: f => "https://drive.google.com/file/d/" + encodeURIComponent(f.id) + "/preview",
  async upload(file, folderId, onP) {
    const tok = await F.auth.getToken(RW);
    const meta = JSON.stringify({ name: file.name, parents: [folderId] });
    const type = file.type || "application/octet-stream";
    const send = (method, url, body, headers) => new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      x.setRequestHeader("Authorization", "Bearer " + tok);
      for (const k in headers) x.setRequestHeader(k, headers[k]);
      x.upload.onprogress = e => { if (e.lengthComputable) onP(e.loaded, e.total); };
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) { try { res(JSON.parse(x.responseText)); } catch (e) { res({}); } }
        else rej(err(x.status === 401 ? "auth" : x.status === 403 || x.status === 404 ? "access" : x.status >= 500 || x.status === 429 ? "busy" : "http", x.status));
      };
      x.onerror = () => rej(err("network"));
      x.send(body);
    });
    if (file.size <= 5 * 1024 * 1024) {
      const b = "fslib" + Math.random().toString(36).slice(2);
      const body = new Blob(["--" + b + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta + "\r\n--" + b + "\r\nContent-Type: " + type + "\r\n\r\n",
        file, "\r\n--" + b + "--"]);
      return send("POST", UPLOAD_API + "?uploadType=multipart&supportsAllDrives=true&fields=id,name", body, { "Content-Type": "multipart/related; boundary=" + b });
    }
    let r;
    try {
      r = await fetch(UPLOAD_API + "?uploadType=resumable&supportsAllDrives=true&fields=id,name", { method: "POST",
        headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(file.size) }, body: meta });
    } catch (e) { throw err("network"); }
    if (!r.ok) throw err(r.status === 401 ? "auth" : r.status === 403 || r.status === 404 ? "access" : "http", r.status);
    const loc = r.headers.get("Location");
    if (!loc) throw err("http", 0, "no upload session");
    return send("PUT", loc, file, { "Content-Type": type });
  }
};
function makeDemo(j) {
  const files = (Array.isArray(j.files) ? j.files : []).map(x => Object.assign({}, x));
  const denied = new Set(j.denied || []), lat = +j.latency >= 0 ? +j.latency : 300;
  const known = id => denied.has(id) || files.some(f => f.id === id || (f.parents || []).includes(id)) || Object.values(j.links || {}).some(u => folderIdFrom(u) === id) || folderIdFrom(j.inbox) === id;
  const wait = (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); if (signal) signal.addEventListener("abort", () => { clearTimeout(t); rej(err("abort")); }, { once: true }); });
  const pub = f => { const o = Object.assign({}, f); delete o.src; delete o.exportSrc; if (o.thumbnailLink) o.thumbnailLink = F.url("_demo/files/" + o.thumbnailLink); return o; };
  const rec = id => files.find(f => f.id === id);
  async function get(src, onP, signal, type) {
    if (!src) throw err("access", 404);
    let r; try { r = await fetch(F.url("_demo/files/" + src), { signal, cache: "no-store" }); } catch (e) { if (isAbort(e)) throw err("abort"); throw err("network"); }
    if (!r.ok) throw err("access", r.status);
    const b = await readBody(r, onP, signal);
    return type ? new Blob([b], { type }) : b;
  }
  let up = 0;
  return {
    links: j.links || {}, inbox: j.inbox || "",
    async list(id, signal) { await wait(lat, signal); if (denied.has(id)) throw err("access", 403); if (!known(id)) throw err("access", 404);
      return files.filter(f => (f.parents || []).includes(id)).map(pub); },
    async meta(id, signal) { await wait(60, signal); const f = rec(id); if (!f || denied.has(id)) throw err("access", 404); return pub(f); },
    async search(text, parents, signal) { await wait(lat, signal); const t = text.toLowerCase();
      return files.filter(f => (f.parents || []).some(p => parents.includes(p)) && f.name.toLowerCase().includes(t)).map(pub); },
    async media(f, onP, signal) { const r = rec(f.id); return get(r && r.src, onP, signal, r && r.mimeType); },
    async exportPdf(f, onP, signal) { const r = rec(f.id); return get(r && r.exportSrc, onP, signal, "application/pdf"); },
    previewUrl: () => null,
    async upload(file, folderId, onP) {
      if (!member()) throw err("auth");
      for (let i = 1; i <= 12; i++) { await wait(70); onP(Math.round(file.size * i / 12), file.size); }
      const id = "demoUpload" + (++up);
      files.push({ id, name: file.name, mimeType: file.type || "application/octet-stream", size: String(file.size), modifiedTime: new Date().toISOString(), parents: [folderId] });
      return { id, name: file.name };
    }
  };
}
const drive = () => S.demo || realDrive;

/* ---------------------------------------------------------------- blobs: small cache shared by viewer and download */
const blobs = new Map();
function cacheBlob(key, b) {
  blobs.delete(key); blobs.set(key, b);
  let total = 0; for (const v of blobs.values()) total += v.size;
  for (const k of blobs.keys()) { if (blobs.size <= 1 || (blobs.size <= 4 && total <= 80e6)) break; total -= blobs.get(k).size; blobs.delete(k); }
}
async function fileBlob(f, onP, signal) {
  const exp = openMode(f) === "export", key = (exp ? "x:" : "m:") + f.id;
  if (blobs.has(key)) { const b = blobs.get(key); if (onP) onP(b.size, b.size); return b; }
  const b = exp ? await drive().exportPdf(f, onP, signal) : await drive().media(f, onP, signal);
  cacheBlob(key, b);
  return b;
}
function saveBlob(b, name) {
  const u = URL.createObjectURL(b);
  const a = h("a", { href: u, download: name, hidden: true, "data-lib-save": "" });
  D.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}
async function download(f, btn, inViewer) {
  if (btn && (btn.getAttribute("aria-busy") === "true" || btn.classList.contains("done"))) return;
  const lbl = btn && btn.querySelector(".lib-btn-t"), was = lbl ? lbl.textContent : "";
  if (btn) { btn.setAttribute("aria-busy", "true"); btn.classList.add("busy"); }
  const setL = t => { if (lbl) lbl.textContent = t; };
  let ok = false;
  try {
    const b = await fileBlob(f, (got, total) => setL(total ? Math.min(99, Math.round(got / total * 100)) + "%" : fmtSize(got)));
    saveBlob(b, fileName(f));
    ok = true;
    // inside the viewer the button itself confirms (a toast would sit on the viewer's toolbar)
    if (!inViewer) F.ui.toast("Downloaded " + fileName(f), { kind: "ok" });
  } catch (e) {
    if (!isAbort(e)) F.ui.toast(e.kind === "too-big" ? "This file is too large for Google to convert. Not available right now." : errText(e).short, { kind: "error" });
    if (e.kind === "auth") renderAuthLost();
  } finally {
    if (btn) {
      btn.removeAttribute("aria-busy"); btn.classList.remove("busy"); setL(was);
      if (ok && inViewer) {
        const ic = btn.querySelector("svg"), done = I("check");
        if (ic) ic.replaceWith(done);
        setL("Downloaded"); btn.classList.add("done");
        setTimeout(() => { if (done.isConnected) done.replaceWith(I("download")); setL(was); btn.classList.remove("done"); }, 2200);
      }
    }
  }
}

/* ---------------------------------------------------------------- folders from site-data */
function buildFolders() {
  const dv = (S.site && S.site.drive) || {}, links = S.demo ? S.demo.links : {};
  S.folders = (Array.isArray(dv.folders) ? dv.folders : []).map((f, i) => {
    const t = String(f.t || "Folder"), u = (S.demo && !folderIdFrom(f.u) && links[t]) ? links[t] : f.u;
    const id = folderIdFrom(u);
    return { i, t, d: String(f.d || ""), tags: String(f.tags || "").split(",").map(x => x.trim()).filter(Boolean), icon: P[f.icon] ? f.icon : "folder", id };
  });
  S.folders.forEach(f => { if (f.id) S.names.set(f.id, f.t); });
  S.inbox = folderIdFrom(S.demo && S.demo.inbox ? S.demo.inbox : dv.inbox);
}
const openFolders = () => S.folders.filter(f => f.id);
const canUpload = () => !!S.inbox && signinOn() && (!!member() || !!S.demo);
const topOf = id => S.folders.find(f => f.id === id) || null;

/* ---------------------------------------------------------------- recent files + last page */
const RECENT_MAX = 12;
function recentList() { const r = F.store.get("lib.recent", []); return Array.isArray(r) ? r.filter(x => x && x.id && x.name).slice(0, RECENT_MAX) : []; }
function addRecent(f) {
  const top = S.path[0], here = S.path[S.path.length - 1];
  const row = { id: f.id, name: String(f.name || ""), mime: f.mimeType || "", folder: (top && top.name) || f.folderName || "", fid: (here && here.id) || f.fid || "", at: Date.now() };
  F.store.update("lib.recent", list => [row].concat((Array.isArray(list) ? list : []).filter(x => x && x.id !== f.id)).slice(0, RECENT_MAX), []);
}
const lastPage = id => { const p = F.store.get("lib.pos", {}); return p && +p[id] > 1 ? +p[id] : 0; };
function setLastPage(id, n) {
  F.store.update("lib.pos", p => {
    const o = Object.assign({}, p && typeof p === "object" ? p : {});
    delete o[id];
    if (n > 1) o[id] = n;
    const keys = Object.keys(o); keys.slice(0, Math.max(0, keys.length - 300)).forEach(k => delete o[k]);
    return o;
  }, {});
}

/* ---------------------------------------------------------------- shared bits of UI */
function badge(kind, extra) {
  return h("span", { class: "lib-badge k-" + kind + (extra ? " " + extra : ""), "aria-hidden": "true" }, I(kind === "folder" ? "folder" : kind));
}
function btn(label, o = {}) {
  return h(o.href ? "a" : "button", Object.assign({ class: "btn " + (o.kind || "btn-ghost") + (o.sm ? " sm" : ""), type: o.href ? null : "button", href: o.href || null },
    o.attrs || {}, { onclick: o.onclick || null }), o.icon ? I(o.icon) : null, h("span", { class: "lib-btn-t" }, label));
}
function skeletonRows(n) {
  return h("div", { class: "lib-list", "aria-hidden": "true" },
    Array.from({ length: n }, (_, i) => h("div", { class: "lib-row lib-skel-row" },
      h("span", { class: "skel lib-skel-ic" }), h("span", { class: "lib-skel-tx" }, h("span", { class: "skel skel-line", style: { width: (38 + (i * 17) % 40) + "%" } }),
        h("span", { class: "skel skel-line w40 lib-skel-sub" })))));
}
function errText(e) {
  const k = e && e.kind;
  if (k === "access") return { title: "You don't have access to this folder", body: "Ask a Finspire admin to share it with IIM Ranchi.", short: "You don't have access to this file. Ask a Finspire admin to share it with IIM Ranchi.", retry: false };
  if (k === "auth") return { title: "Your Google access has ended", body: "Reconnect to keep browsing the Library.", short: "Your Google access has ended. Reconnect and try again.", retry: false };
  if (k === "network") return { title: "Couldn't reach Google Drive", body: "Check your connection and try again.", short: "Couldn't reach Google Drive. Check your connection.", retry: true };
  if (k === "busy") return { title: "Google Drive is busy", body: "Try again in a minute.", short: "Google Drive is busy. Try again in a minute.", retry: true };
  if (k === "too-big") return { title: "Too large to convert", body: "Google can't convert this file to PDF because it is too large.", short: "Too large to convert.", retry: false };
  return { title: "Something went wrong", body: "The Library couldn't load this. Try again.", short: "Something went wrong. Try again.", retry: true };
}
function errorPanel(e, retry) {
  const t = errText(e);
  const acts = h("div", { class: "lib-err-acts" });
  if (e.kind === "auth") acts.appendChild(btn("Reconnect", { kind: "btn-primary", onclick: reconnect }));
  if (t.retry && retry) acts.appendChild(btn("Try again", { kind: "btn-primary", icon: "refresh", onclick: retry }));
  if (S.path.length && e.kind !== "auth") acts.appendChild(btn("Back to the Library", { onclick: () => nav([]) }));
  return h("div", { class: "lib-err", role: "alert", "data-lib-error": e.kind || "error" },
    h("span", { class: "lib-err-ic" }, I(e.kind === "access" ? "lock" : "alert")),
    h("b", null, t.title), h("p", null, t.body), acts.children.length ? acts : null);
}

/* ---------------------------------------------------------------- folder icon cards (gate preview + library home) */
function folderCard(f, onOpen) {
  const has = !!f.id, tag = has && onOpen ? "button" : "div";
  return h(tag, { class: "lib-fc" + (has ? "" : " soon"), type: tag === "button" ? "button" : null, "data-lib-folder": f.id || "", "data-name": f.t,
      onclick: tag === "button" ? () => onOpen(f) : null },
    h("span", { class: "lib-fc-ic" }, I(f.icon)),
    h("span", { class: "lib-fc-t" }, f.t),
    f.d ? h("span", { class: "lib-fc-d" }, f.d) : null,
    f.tags.length ? h("span", { class: "lib-fc-tags" }, f.tags.map(x => h("span", null, x))) : h("span"),
    h("span", { class: "lib-fc-go" }, has ? [h("span", null, "Open folder"), I("right")] : h("span", null, "Coming soon")));
}

/* ================================================================ screens ================================================= */
const head = D.querySelector(".lib-head");
function setScreen(name) { root.dataset.screen = name; if (head) head.classList.toggle("compact", name === "browser"); }

/* ---- gate (signed out) and "open the library" (signed in, no Drive token yet) ---- */
function renderIntro() {
  const u = member();
  setScreen(u ? "open" : "gate");
  const n = S.folders.length, open = openFolders().length;
  const left = h("div", { class: "lib-intro-copy" });
  if (!u && !signinOn()) {
    // the site runs without Google sign-in, and no public Drive key is set: say so plainly, keep the preview
    const go = ["dictionary", "markets"].filter(k => F.feature(k)).map((k, i) =>
      btn(k === "dictionary" ? "Open the Dictionary" : "Markets & News", { kind: i ? "btn-ghost" : "btn-primary", href: F.url(F.cfg.pages[k]) }));
    left.append(
      h("span", { class: "lib-lock" }, I("lock"), "Members only"),
      h("h2", { class: "lib-intro-h" }, "Opens with IIM Ranchi sign-in."),
      h("p", { class: "lib-intro-p" }, "The Library is for IIM Ranchi students. It opens here once IIM Ranchi sign-in is switched on for the site. Until then, this is what's inside."),
      go.length ? h("div", { class: "lib-intro-acts", "data-lib-off-signin": "" }, go) : null,
      h("p", { class: "lib-intro-note" }, "Club members can ask a Finspire admin for files in the meantime."));
  } else if (!u) {
    left.append(
      h("span", { class: "lib-lock" }, I("lock"), "Members only"),
      h("h2", { class: "lib-intro-h" }, "Sign in with your IIM Ranchi account."),
      h("p", { class: "lib-intro-p" }, "The Library holds notes, templates and past work shared by Finspire members. It is open to IIM Ranchi students: sign in with your @" + F.cfg.allowedDomain + " Google account to read and download files here."),
      h("div", { class: "lib-intro-acts" },
        h("button", { class: "fs-gbtn lib-signin", type: "button", "data-lib-signin": "", onclick: () => {
          if (!F.auth.enabled()) { F.ui.signInDialog(); return; }
          F.auth.signIn().catch(() => {});
        } }, F.dom.icon("google"), "Continue with Google")),
      h("p", { class: "lib-intro-note" }, "Only @" + F.cfg.allowedDomain + " accounts can sign in. Finspire sees your name and email, and can only read the club's shared folders."));
  } else {
    left.append(
      h("span", { class: "lib-lock ok" }, I("check"), "Signed in as " + (u.email || u.name)),
      h("h2", { class: "lib-intro-h" }, "Welcome, " + (u.given || u.name || "there") + "."),
      h("p", { class: "lib-intro-p" }, "Open the Library to browse the club's folders. Google asks once for permission to read them. Finspire can't change or delete anything in your Drive."),
      h("div", { class: "lib-intro-acts" },
        btn("Open the library", { kind: "btn-primary", icon: "book", attrs: { "data-lib-open": "" }, onclick: ev => openLibrary(ev.currentTarget) })),
      h("p", { class: "lib-intro-note" }, "Files open inside this page. Nothing is posted or shared for you."));
  }
  const rowIn = f => [h("span", { class: "lib-il-ic" }, I(f.icon)), h("span", { class: "lib-il-t" }, f.t),
    h("span", { class: "lib-il-s" }, f.id ? (u ? I("right") : I("lock")) : "Coming soon")];
  const list = h("ul", { class: "lib-intro-list", "aria-label": "Folders in the Library" },
    S.folders.length ? S.folders.map(f => h("li", { class: f.id ? "" : "soon" },
      u && f.id ? h("button", { class: "lib-il-b", type: "button", "data-lib-folder": f.id, "aria-label": "Open " + f.t,
        onclick: ev => openLibrary(ev.currentTarget, () => nav([{ id: f.id, name: f.t }])) }, rowIn(f)) : h("div", { class: "lib-il-b" }, rowIn(f)))) :
      h("li", { class: "soon" }, h("span", { class: "lib-il-t" }, "Folder list not available right now.")));
  const right = h("div", { class: "lib-intro-side" },
    h("div", { class: "lib-intro-side-h" }, h("span", null, "Inside the Library"),
      h("span", { class: "lib-count" }, !n ? "" : open === n ? plural(n, "folder") : open + " of " + n + " open")), list);
  F.dom.clear(root).appendChild(h("section", { class: "lib-intro", "aria-label": u ? "Open the Library" : "Sign in to the Library" }, left, right));
}

/* ---- the Library is switched off for this site (cfg.features.library false): only reachable by a direct link ---- */
function renderOff() {
  setScreen("off");
  const dim = head && head.querySelector(".dim");
  if (dim) dim.textContent = "Opening soon.";
  const go = ["dictionary", "markets"].filter(k => F.feature(k)).map(k =>
    btn(k === "dictionary" ? "Open the Dictionary" : "Markets & News", { kind: "btn-ghost", href: F.url(F.cfg.pages[k]) }));
  F.dom.clear(root).appendChild(h("section", { class: "lib-off", "data-lib-off": "" },
    h("span", { class: "lib-err-ic" }, I("book")),
    h("b", null, "The Library isn't open yet"),
    h("p", null, "Finspire will open the club's shared files here soon."),
    h("div", { class: "lib-err-acts" }, btn("Back to Finspire", { kind: "btn-primary", href: F.url(F.cfg.pages.home) }), go)));
}

/* ---- "open the library": the click that may show Google's consent popup ---- */
async function openLibrary(button, then) {
  if (button) { button.setAttribute("aria-busy", "true"); button.classList.add("busy"); }
  try {
    if (!S.demo) {
      try { await F.auth.getToken(RO); }
      catch (e) {
        const m = String(e && e.message || "");
        if (F.cfg.driveApiKey && /gis|popup_failed/.test(m)) S.keyMode = true;
        else {
          if (/scope-denied|access_denied/.test(m)) F.ui.toast("The Library needs permission to read the club's folders. Press Open the library and allow it.", { kind: "error", ms: 7000 });
          else if (/gis-loading/.test(m)) F.ui.toast("Google is still loading. Try again in a moment.");
          else if (!/popup_closed|superseded/.test(m)) F.ui.toast("Couldn't connect to Google Drive. Try again.", { kind: "error" });
          return;
        }
      }
    }
    sset("fs.lib.open", "1");
    S.opened = true;
    if (then) { UI = null; then(); } else route();
  } finally {
    if (button) { button.removeAttribute("aria-busy"); button.classList.remove("busy"); }
  }
}
async function reconnect(ev) {
  const b = ev && ev.currentTarget;
  if (S.demo) { route(); return; }
  try {
    const t = await F.auth.getToken(RO);
    if (S.badToken && t === S.badToken) {
      F.ui.modal({ title: "Sign in again", body: "Google ended this session early. Sign out and sign back in to reconnect the Library.",
        actions: [{ label: "Not now", kind: "ghost" }, { label: "Sign out", kind: "primary", onClick: () => { F.auth.signOut(); } }] });
      return;
    }
    S.lists.clear(); route();
  } catch (e) { if (b) F.ui.toast("Couldn't reconnect to Google Drive. Try again.", { kind: "error" }); }
}
function renderAuthLost() {
  S.opened = false; sset("fs.lib.open", null);
  if (!member() && !S.keyMode) { renderIntro(); return; }
  if (root.dataset.screen === "browser") {
    const c = root.querySelector(".lib-content");
    if (c) { F.dom.clear(c).appendChild(errorPanel(err("auth"))); return; }
  }
  renderIntro();
}

/* ---- browser frame: sticky bar (breadcrumb + search + actions), content ---- */
let UI = null;
function frame() {
  if (UI && root.contains(UI.wrap)) return UI;
  setScreen("browser");
  const crumbs = h("ol", { class: "lib-crumbs" });
  const back = h("button", { class: "lib-back", type: "button", "aria-label": "Up one folder", hidden: true, onclick: () => nav(S.path.slice(0, -1)) }, I("back"));
  const input = h("input", { type: "search", class: "lib-q", placeholder: "Search the library", "aria-label": "Search the library", autocomplete: "off", spellcheck: "false", enterkeyhint: "search", "data-lib-q": "" });
  const clearQ = h("button", { class: "lib-q-x", type: "button", "aria-label": "Clear search", hidden: true, onclick: () => { input.value = ""; onQuery(); input.focus(); } }, I("x"));
  const sort = h("select", { class: "lib-sort", "aria-label": "Sort", "data-lib-sort": "" },
    h("option", { value: "name" }, "Name A–Z"), h("option", { value: "new" }, "Newest first"), h("option", { value: "old" }, "Oldest first"));
  sort.value = S.sort;
  sort.addEventListener("change", () => { S.sort = sort.value; renderList(); });
  const sortWrap = h("label", { class: "lib-sortw" }, h("span", { class: "sr-only" }, "Sort"), sort, I("down"));
  const add = canUpload() ? btn("Add a file", { kind: "btn-ink", sm: true, icon: "upload", attrs: { "data-lib-upload": "" }, onclick: openUpload }) : null;
  const tools = h("div", { class: "lib-tools" }, h("div", { class: "lib-search" }, I("search"), input, clearQ), sortWrap, add);
  const barIn = h("div", { class: "lib-bar-in" }, h("nav", { class: "lib-nav", "aria-label": "Folder path" }, back, crumbs));
  const bar = h("div", { class: "lib-bar" }, barIn);
  const content = h("div", { class: "lib-content" });
  const wrap = h("div", { class: "lib-browser" }, bar, content);
  // desktop: tools sit in the sticky bar; phone: only the path sticks, the tools scroll with the page
  const place = () => { if (PHONE.matches) wrap.insertBefore(tools, content); else barIn.appendChild(tools); };
  place();
  if (!S.placeBound) { S.placeBound = true; const on = () => { if (UI && UI.place) UI.place(); }; PHONE.addEventListener ? PHONE.addEventListener("change", on) : PHONE.addListener(on); }
  F.dom.clear(root).appendChild(wrap);
  const run = debounce(() => onQuery(), 260);
  input.addEventListener("input", () => { clearQ.hidden = !input.value; run(); });
  input.addEventListener("keydown", e => { if (e.key === "Escape" && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ""; clearQ.hidden = true; onQuery(); } if (e.key === "Enter") { run.cancel(); onQuery(); } });
  UI = { wrap, bar, crumbs, back, input, clearQ, sort, sortWrap, content, run, place };
  return UI;
}
function renderCrumbs() {
  const ui = frame(), list = [{ id: "", name: "Library" }].concat(S.path);
  F.dom.clear(ui.crumbs);
  list.forEach((c, i) => {
    const last = i === list.length - 1;
    ui.crumbs.appendChild(h("li", null,
      last ? h("span", { "aria-current": "page", class: "lib-crumb cur", title: c.name }, c.name || "Folder")
           : h("button", { type: "button", class: "lib-crumb", "data-lib-crumb": String(i), onclick: () => nav(S.path.slice(0, i)) }, c.name || "Folder"),
      last ? null : I("right", "lib-crumb-sep")));
  });
  ui.back.hidden = !S.path.length;
  ui.input.placeholder = S.path.length ? (PHONE.matches ? "Search" : "Search this folder") : "Search the library";
  ui.input.setAttribute("aria-label", S.path.length ? "Search this folder" : "Search the library");
  ui.sortWrap.hidden = !S.path.length;
  requestAnimationFrame(() => { ui.crumbs.scrollLeft = ui.crumbs.scrollWidth; });
}

/* ---- library home: recent files + folder cards ---- */
function renderHome() {
  const ui = frame();
  renderCrumbs();
  const c = F.dom.clear(ui.content);
  if (S.q.length >= 2) { renderSearch(); return; }
  const rec = recentList();
  if (rec.length) {
    const pos = F.store.get("lib.pos", {}) || {};
    c.appendChild(h("section", { class: "lib-sec lib-recent", "aria-label": "Recent files" },
      h("div", { class: "lib-sec-h" }, h("h2", { class: "lib-h2" }, "Recent"),
        h("button", { class: "lib-textbtn", type: "button", "data-lib-clear-recent": "", onclick: () => { F.store.set("lib.recent", []); renderHome(); } }, "Clear")),
      h("div", { class: "lib-rc-row" }, rec.map(r => {
        const k = kindOf(r.mime), p = +pos[r.id] > 1 ? +pos[r.id] : 0;
        return h("button", { class: "lib-rc", type: "button", "data-lib-recent": r.id, onclick: () => openViewer({ id: r.id, name: r.name, mimeType: r.mime, folderName: r.folder, fid: r.fid }) },
          h("span", { class: "lib-rc-top" }, badge(k), p ? h("span", { class: "lib-rc-p" }, "Page " + p) : null),
          h("span", { class: "lib-rc-n" }, r.name),
          h("span", { class: "lib-rc-m" }, [r.folder, F.fmt.ago(r.at)].filter(Boolean).join(" · ")));
      }))));
  }
  const n = S.folders.length, open = openFolders().length;
  c.appendChild(h("section", { class: "lib-sec", "aria-label": "Folders" },
    h("div", { class: "lib-sec-h" }, h("h2", { class: "lib-h2" }, "Folders"),
      h("span", { class: "lib-count" }, !n ? "" : open === n ? plural(n, "folder") : open + " of " + n + " folders open")),
    n ? h("div", { class: "lib-fgrid" }, S.folders.map(f => folderCard(f, x => nav([{ id: x.id, name: x.t }]))))
      : h("div", { class: "empty" }, h("b", null, "No folders yet"), h("span", null, "A Finspire admin adds folders from the home page."))));
  if (canUpload()) c.appendChild(h("section", { class: "lib-share", "aria-label": "Share a file" },
    h("span", { class: "lib-share-ic" }, I("upload")),
    h("div", { class: "lib-share-tx" }, h("b", null, "Made something useful?"),
      h("p", null, "Add your notes or templates for the next batch. A Finspire admin reviews every upload before it appears here.")),
    btn("Add a file", { kind: "btn-ghost", icon: "upload", attrs: { "data-lib-share": "" }, onclick: openUpload })));
  say("Library home. " + plural(open, "folder") + " open.");
}

/* ---- folder view ---- */
async function showFolder() {
  const ui = frame(), seq = ++S.loadSeq;
  renderCrumbs();
  const here = S.path[S.path.length - 1];
  S.items = null; S.error = null;
  if (S.type !== "all") S.type = "all";
  const c = F.dom.clear(ui.content);
  c.appendChild(h("div", { class: "lib-fhead" }, h("h2", { class: "lib-h2 lib-ftitle" }, here.name || "Folder"), h("span", { class: "lib-count skel", style: "width:70px;height:14px" })));
  c.appendChild(skeletonRows(6));
  // names of unknown path parts (deep link)
  if (S.path.some(p => !p.name)) {
    try {
      await Promise.all(S.path.map(async p => { if (!p.name) { const m = await drive().meta(p.id); p.name = m.name || "Folder"; S.names.set(p.id, p.name); } }));
      if (seq !== S.loadSeq) return;
      renderCrumbs();
      const t = c.querySelector(".lib-ftitle"); if (t) t.textContent = here.name;
    } catch (e) { /* the listing below reports the error */ }
  }
  try {
    let items = S.lists.get(here.id);
    if (!items || Date.now() - items.at > 5 * 60000) {
      const list = await drive().list(here.id);
      items = { at: Date.now(), list };
      S.lists.set(here.id, items);
    }
    if (seq !== S.loadSeq) return;
    items.list.forEach(f => { if (f.mimeType === FOLDER) { S.names.set(f.id, f.name); S.searchIds.add(f.id); } });
    S.items = items.list;
    renderList();
    say((here.name || "Folder") + ". " + plural(S.items.length, "item") + ".");
  } catch (e) {
    if (seq !== S.loadSeq || isAbort(e)) return;
    S.error = e;
    if (e.kind === "auth") { renderAuthLost(); return; }
    F.dom.clear(c).appendChild(errorPanel(e, () => { S.lists.delete(here.id); showFolder(); }));
    say(errText(e).title);
  }
}
function sorted(list) {
  const coll = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const t = f => Date.parse(f.modifiedTime) || 0;
  return list.slice().sort((a, b) => {
    const fa = a.mimeType === FOLDER, fb = b.mimeType === FOLDER;
    if (fa !== fb) return fa ? -1 : 1;
    if (S.sort === "new") return t(b) - t(a) || coll.compare(a.name, b.name);
    if (S.sort === "old") return t(a) - t(b) || coll.compare(a.name, b.name);
    return coll.compare(a.name, b.name);
  });
}
function renderList() {
  if (!S.items || !UI) return;
  const c = F.dom.clear(UI.content), here = S.path[S.path.length - 1];
  const all = S.items, q = S.q.toLowerCase();
  const counts = {}; all.forEach(f => { const k = kindOf(f.mimeType); counts[k] = (counts[k] || 0) + 1; });
  const kinds = Object.keys(KINDS).filter(k => counts[k]);
  if (S.type !== "all" && !counts[S.type]) S.type = "all";
  const shown = sorted(all.filter(f => (S.type === "all" || kindOf(f.mimeType) === S.type) && (!q || f.name.toLowerCase().includes(q))));
  c.appendChild(h("div", { class: "lib-fhead" },
    h("h2", { class: "lib-h2 lib-ftitle" }, here.name || "Folder"),
    h("span", { class: "lib-count", "data-lib-count": String(all.length) }, plural(all.length, "item")),
    h("button", { class: "lib-iconbtn lib-refresh", type: "button", "aria-label": "Refresh folder", title: "Refresh", onclick: () => { S.lists.delete(here.id); showFolder(); } }, I("refresh"))));
  if (kinds.length > 1) {
    const chips = h("div", { class: "chips lib-chips", role: "toolbar", "aria-label": "Filter by type" },
      [["all", "All", all.length]].concat(kinds.map(k => [k, KINDS[k], counts[k]])).map(([k, label, n]) =>
        h("button", { class: "chip", type: "button", "aria-pressed": String(S.type === k), "data-lib-type": k, onclick: () => { S.type = k; renderList(); } },
          label, h("span", { class: "n" }, String(n)))));
    c.appendChild(chips);
  }
  if (!all.length) {
    c.appendChild(h("div", { class: "empty lib-empty" }, h("span", { class: "lib-err-ic" }, I("folder")), h("b", null, "This folder is empty"),
      h("span", null, canUpload() ? "Have something useful for it? Use Add a file." : "Files will appear here once a Finspire admin adds them.")));
  } else if (!shown.length) {
    c.appendChild(h("div", { class: "empty lib-empty" }, h("b", null, q ? "Nothing in this folder matches “" + S.q + "”" : "No files of this type"),
      h("span", null, q ? "Results from other folders are below." : "Choose All to see everything.")));
  } else {
    c.appendChild(listEl(shown, false));
  }
  if (q.length >= 2) {
    const more = h("section", { class: "lib-sec lib-more", "aria-label": "Results in other folders" },
      h("div", { class: "lib-sec-h" }, h("h3", { class: "lib-h3" }, "In other folders")), skeletonRows(2));
    c.appendChild(more);
    driveSearch(S.q, new Set(all.map(f => f.id)), more);
  }
}
function listEl(items, withFolder) {
  return h("div", { class: "lib-list", role: "list" },
    h("div", { class: "lib-lh", "aria-hidden": "true" }, h("span", null, "Name"), h("span", null, "Last updated"), h("span", null, "Size")),
    items.map(f => rowEl(f, withFolder)));
}
function rowEl(f, withFolder) {
  const k = kindOf(f.mimeType), isF = k === "folder";
  const where = withFolder ? S.names.get((f.parents || [])[0]) : "";
  const sub = [isF ? "Folder" : KIND_LABEL[k], isF ? "" : fmtSize(f.size), fmtDate(f.modifiedTime)].filter(Boolean).join(" · ");
  const b = badge(k);
  const thumb = k === "image" ? thumbUrl(f.thumbnailLink) : null;
  if (thumb) {
    const img = h("img", { src: thumb, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => img.remove(), { once: true });
    img.addEventListener("load", () => b.classList.add("thumb"), { once: true });
    b.appendChild(img);
  }
  const main = h("button", { class: "lib-row-main", type: "button", "data-lib-item": f.id, "data-kind": k, "data-name": f.name,
      onclick: () => isF ? nav(withFolder ? folderPathFor(f) : S.path.concat([{ id: f.id, name: f.name }])) : openViewer(f) },
    b,
    h("span", { class: "lib-row-name" }, h("span", { class: "lib-row-t" }, f.name),
      h("span", { class: "lib-row-sub" }, where ? h("span", { class: "lib-row-in" }, "in " + where) : null, h("span", { class: "lib-row-meta" }, sub))),
    h("span", { class: "lib-row-date" }, fmtDate(f.modifiedTime)),
    h("span", { class: "lib-row-size" }, isF ? "—" : (fmtSize(f.size) || "—")));
  const act = isF ? h("span", { class: "lib-row-go", "aria-hidden": "true" }, I("right"))
    : openMode(f) === "none" ? h("span", { class: "lib-row-go" })
    : h("button", { class: "lib-iconbtn lib-row-dl", type: "button", "aria-label": "Download " + f.name, title: "Download", "data-lib-dl": f.id, onclick: e => download(f, e.currentTarget) }, I("download"), h("span", { class: "lib-btn-t sr-only" }, "Download"));
  return h("div", { class: "lib-row" + (isF ? " is-folder" : ""), role: "listitem" }, main, act);
}
function thumbUrl(u) { if (!u) return null; try { return F.dom.safeUrl(new URL(u, location.href).href); } catch (e) { return null; } }
function folderPathFor(f) {
  const parent = (f.parents || [])[0];
  const top = topOf(parent);
  if (top) return [{ id: top.id, name: top.t }, { id: f.id, name: f.name }];
  // a sub-folder we have seen inside the current path?
  const i = S.path.findIndex(p => p.id === parent);
  if (i >= 0) return S.path.slice(0, i + 1).concat([{ id: f.id, name: f.name }]);
  return [{ id: f.id, name: f.name }];
}

/* ---- search across the configured folders (Drive-side, name contains) ---- */
let searchAC = null;
async function driveSearch(q, exclude, box) {
  if (searchAC) searchAC.abort();
  const ac = searchAC = new AbortController();
  const parents = [...new Set(openFolders().map(f => f.id).concat([...S.searchIds]))].slice(0, 40);
  const put = node => { if (!box.isConnected) return; [...box.children].slice(1).forEach(x => x.remove()); box.appendChild(node); };
  if (!parents.length) { put(h("p", { class: "lib-note" }, "No folders are open yet.")); return; }
  try {
    const res = (await drive().search(q, parents, ac.signal)).filter(f => !exclude.has(f.id));
    if (ac.signal.aborted) return;
    res.forEach(f => { if (f.mimeType === FOLDER) S.names.set(f.id, f.name); });
    put(res.length ? listEl(sorted(res), true) : h("p", { class: "lib-note", "data-lib-noresults": "" }, exclude.size ? "No other matches." : "No files match “" + q + "”."));
    if (!exclude.size) say(plural(res.length, "result") + " for " + q);
  } catch (e) {
    if (isAbort(e)) return;
    if (e.kind === "auth") { renderAuthLost(); return; }
    put(h("p", { class: "lib-note" }, errText(e).short));
  }
}
function renderSearch() {
  const c = F.dom.clear(UI.content);
  const box = h("section", { class: "lib-sec lib-results", "aria-label": "Search results" },
    h("div", { class: "lib-sec-h" }, h("h2", { class: "lib-h2" }, "Results for “" + S.q + "”"),
      h("button", { class: "lib-textbtn", type: "button", onclick: () => { UI.input.value = ""; UI.clearQ.hidden = true; onQuery(); } }, "Clear")),
    skeletonRows(3));
  c.appendChild(box);
  c.appendChild(h("p", { class: "lib-note" }, "Searches file names in the club's folders and the sub-folders you have opened."));
  driveSearch(S.q, new Set(), box);
}
function onQuery() {
  if (!UI) return;
  S.q = UI.input.value.trim();
  UI.clearQ.hidden = !UI.input.value;
  if (!S.path.length) renderHome(); else renderList();
}

/* ---------------------------------------------------------------- routing */
function pathFromHash() {
  const m = location.hash.match(/^#f=([A-Za-z0-9_\-/]+)/);
  if (!m) return [];
  return m[1].split("/").filter(Boolean).slice(0, 12).map(id => ({ id, name: S.names.get(id) || "" }));
}
const pathKey = p => p.map(x => x.id).join("/");
function nav(path) {
  const want = path.length ? "#f=" + pathKey(path) : "";
  if (location.hash !== want && !(want === "" && !location.hash)) {
    history.pushState(null, "", want || location.pathname + location.search);
  }
  setPath(path);
  if (UI) { UI.input.value = ""; UI.clearQ.hidden = true; } S.q = "";
  showPath();
  const top = root.getBoundingClientRect().top, hdr = (D.querySelector("header[data-fs-header]") || { offsetHeight: 72 }).offsetHeight;
  if (top < hdr) W.scrollTo({ top: Math.max(0, W.scrollY + top - hdr - 12), behavior: "auto" });
}
function setPath(path) { S.path = path.map(p => ({ id: p.id, name: p.name || S.names.get(p.id) || "" })); }
function showPath() { if (!S.path.length) renderHome(); else showFolder(); }
function onPop() {
  if (VW && VW.pushed && !VW.closed) { VW.close(true); return; }
  if (!S.opened) return;
  const p = pathFromHash();
  if (pathKey(p) === pathKey(S.path) && UI && root.contains(UI.wrap)) return;
  setPath(p); S.q = ""; if (UI) { UI.input.value = ""; UI.clearQ.hidden = true; }
  showPath();
}
function route() {
  if (!F.feature("library")) { if (VW) VW.close(); UI = null; renderOff(); return; }
  if (!member() && !S.keyMode) { if (VW) VW.close(); S.opened = false; UI = null; renderIntro(); return; }
  if (!S.opened) {
    const auto = S.keyMode || (S.demo ? sget("fs.lib.open") === "1" : F.auth.hasToken(RO));
    if (!auto) { UI = null; renderIntro(); return; }
    S.opened = true;
  }
  setPath(pathFromHash());
  showPath();
}

/* ================================================================ viewer ================================================== */
let VW = null, pdfjsP = null;
function loadPdfjs() {
  if (!pdfjsP) pdfjsP = import(PDFJS + "pdf.min.mjs").then(m => { m.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs"; return m; })
    .catch(e => { pdfjsP = null; throw err("pdfjs", 0, String(e && e.message)); });
  return pdfjsP;
}
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

function openViewer(f) {
  if (VW && !VW.closed) VW.close();
  const md = openMode(f), k = kindOf(f.mimeType);
  const v = VW = { f, md, ac: new AbortController(), urls: [], closed: false, pushed: false, n: 0, cur: 1, scale: 1, fit: true,
    pages: [], doc: null, task: null, io: null, ro: null, tops: [], vis: new Set(), cleanup: [] };

  const dl = h("button", { class: "lib-vbtn lib-vw-dl", type: "button", "data-lib-dl": f.id, "aria-label": "Download " + f.name, onclick: e => download(f, e.currentTarget, true) },
    I("download"), h("span", { class: "lib-btn-t" }, "Download"));
  const x = h("button", { class: "lib-vbtn lib-vw-x", type: "button", "aria-label": "Close viewer", "data-lib-close": "", onclick: () => v.close() }, I("x"));
  const metaEl = h("span", { class: "lib-vw-meta" }, [md === "export" ? KIND_LABEL[k] + " · opened as PDF" : KIND_LABEL[k], fmtSize(f.size), f.folderName || (S.path[0] && S.path[0].name) || ""].filter(Boolean).join(" · "));
  const top = h("div", { class: "lib-vw-top" }, badge(k), h("div", { class: "lib-vw-id" }, h("b", { class: "lib-vw-name", title: f.name }, f.name), metaEl), h("div", { class: "lib-vw-acts" }, dl, x));
  const stage = h("div", { class: "lib-vw-stage", tabindex: "0", "aria-label": f.name, "data-lib-stage": md });
  const tools = h("div", { class: "lib-vw-tools", hidden: true });
  const body = h("div", { class: "lib-vw-body" }, stage, tools);
  v.stage = stage; v.tools = tools; v.body = body;
  addRecent(f);

  const m = F.ui.modal({ label: f.name, head: top, body, className: "lib-vw", size: "lg", initialFocus: stage, onClose: () => teardown(v) });
  v.m = m;
  m.el.setAttribute("data-lib-viewer", md);
  v.close = fromPop => {
    if (v.closed) return;
    v.closed = true;
    if (v.pushed && !fromPop && history.state && history.state.libViewer) { v.pushed = false; history.back(); }
    m.close();
  };
  try { history.pushState({ libViewer: 1 }, ""); v.pushed = true; } catch (e) {}
  m.card.addEventListener("keydown", e => onViewerKey(v, e));

  if (md === "pdf" || md === "export") openPdf(v);
  else if (md === "image") openImage(v);
  else if (md === "text") openText(v);
  else if (md === "preview") openPreview(v);
  else stageMessage(v, "alert", "This kind of Google file can't be opened here", "Google Forms, Sites and Maps only open in Google. Ask a Finspire admin for a copy.", false);
  return v;
}
function teardown(v) {
  v.closed = true;
  if (v.pushed && history.state && history.state.libViewer) { v.pushed = false; try { history.back(); } catch (e) {} }
  v.ac.abort();
  if (v.io) v.io.disconnect();
  if (v.ro) v.ro.disconnect();
  if (v.saveT) { clearTimeout(v.saveT); if (v.n) setLastPage(v.f.id, v.cur); }
  v.pages.forEach(p => { if (p.task) try { p.task.cancel(); } catch (e) {} });
  if (v.task) try { v.task.destroy(); } catch (e) {}
  if (v.doc) try { v.doc.destroy(); } catch (e) {}
  v.urls.forEach(u => URL.revokeObjectURL(u));
  v.cleanup.forEach(fn => { try { fn(); } catch (e) {} });
  if (VW === v) VW = null;
  if (S.homeStale) {
    S.homeStale = false;
    if (!S.path.length && S.opened && UI && root.contains(UI.wrap) && !S.q) {
      const had = D.activeElement && D.activeElement.closest && D.activeElement.closest("[data-lib-recent],[data-lib-item]");
      renderHome();
      const back = root.querySelector('[data-lib-recent="' + CSS.escape(v.f.id) + '"]');
      if (back && (had || D.activeElement === D.body)) back.focus({ preventScroll: true });
    }
  }
}
function stageMessage(v, ic, title, text, retry) {
  const acts = h("div", { class: "lib-err-acts" });
  if (retry) acts.appendChild(btn("Try again", { kind: "btn-primary", icon: "refresh", onclick: retry }));
  if (v.md !== "none") acts.appendChild(btn("Download instead", { icon: "download", onclick: e => download(v.f, e.currentTarget) }));
  F.dom.clear(v.stage).appendChild(h("div", { class: "lib-err lib-vw-msg", role: "alert" }, h("span", { class: "lib-err-ic" }, I(ic)), h("b", null, title), h("p", null, text), acts.children.length ? acts : null));
  v.tools.hidden = true;
}
function loader(v, label) {
  const bar = h("i"), txt = h("span", { class: "lib-load-t" }, "Starting…");
  const el = h("div", { class: "lib-load", "data-lib-loading": "" }, badge(kindOf(v.f.mimeType), "lg"),
    h("b", null, label), h("div", { class: "lib-prog indet", role: "progressbar", "aria-label": label }, bar), txt);
  F.dom.clear(v.stage).appendChild(el);
  const prog = el.querySelector(".lib-prog");
  return (got, total) => {
    if (total) { prog.classList.remove("indet"); const p = Math.min(100, got / total * 100); bar.style.transform = "scaleX(" + (p / 100) + ")"; prog.setAttribute("aria-valuenow", String(Math.round(p))); txt.textContent = fmtSize(got) + " of " + fmtSize(total); }
    else txt.textContent = fmtSize(got) + " loaded";
  };
}
async function fetchFor(v, label) {
  const onP = loader(v, label);
  try { return await fileBlob(v.f, onP, v.ac.signal); }
  catch (e) {
    if (isAbort(e) || v.closed) return null;
    if (e.kind === "auth") { v.close(); renderAuthLost(); return null; }
    if (e.kind === "too-big") { openPreview(v, "Google can't convert this file to PDF because it is too large, so it is shown with Google's previewer."); return null; }
    const t = errText(e);
    stageMessage(v, e.kind === "access" ? "lock" : "alert", e.kind === "access" ? "You don't have access to this file" : t.title,
      t.body, t.retry ? () => reopen(v) : null);
    return null;
  }
}
function reopen(v) { if (v.md === "pdf" || v.md === "export") openPdf(v); else if (v.md === "image") openImage(v); else if (v.md === "text") openText(v); }

/* ---- PDF ---- */
async function openPdf(v) {
  const libP = loadPdfjs(); libP.catch(() => {});
  const blob = await fetchFor(v, v.md === "export" ? "Converting to PDF…" : "Opening " + v.f.name);
  if (!blob) return;
  let lib;
  try { lib = await libP; } catch (e) { if (!v.closed) stageMessage(v, "alert", "The PDF viewer didn't load", "Check your connection and try again.", () => openPdf(v)); return; }
  if (v.closed) return;
  try {
    const data = new Uint8Array(await blob.arrayBuffer());
    v.task = lib.getDocument({ data, isEvalSupported: false, verbosity: 0 });
    v.doc = await v.task.promise;
    v.first = await v.doc.getPage(1);
  } catch (e) {
    if (v.closed) return;
    const pw = e && e.name === "PasswordException";
    stageMessage(v, "alert", pw ? "This PDF is password-protected" : "This PDF couldn't be opened", pw ? "Download it and open it with its password." : "The file may be damaged. You can still download it.", false);
    return;
  }
  if (v.closed) return;
  const vp = v.first.getViewport({ scale: 1 });
  v.n = v.doc.numPages;
  v.base = { w: vp.width, h: vp.height };
  const wrap = h("div", { class: "lib-pages" });
  v.pages = Array.from({ length: v.n }, (_, i) => {
    const el = h("div", { class: "lib-pg", "data-page": String(i + 1), "aria-label": "Page " + (i + 1) }, h("span", { class: "lib-pg-n" }, String(i + 1)));
    wrap.appendChild(el);
    return { i: i + 1, el, w: vp.width, h: vp.height, scale: 0, canvas: null, task: null, sized: i === 0 };
  });
  F.dom.clear(v.stage).appendChild(wrap);
  buildPdfTools(v);
  layout(v);
  v.io = new IntersectionObserver(ents => {
    ents.forEach(en => { const pg = v.pages[+en.target.dataset.page - 1]; if (en.isIntersecting) { v.vis.add(pg); renderPage(v, pg); } else { v.vis.delete(pg); dropPage(v, pg); } });
  }, { root: v.stage, rootMargin: "120% 0px" });
  v.pages.forEach(p => v.io.observe(p.el));
  let raf = 0;
  v.stage.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; trackPage(v); }); }, { passive: true });
  let lastW = v.stage.clientWidth;
  v.ro = new ResizeObserver(() => { const w = v.stage.clientWidth; if (Math.abs(w - lastW) > 1) { lastW = w; if (v.fit) zoomTo(v, null); } });
  v.ro.observe(v.stage);
  v.stage.addEventListener("wheel", e => { if (!e.ctrlKey) return; e.preventDefault(); zoomTo(v, Math.max(.25, Math.min(4, v.scale * Math.exp(-e.deltaY / 300)))); }, { passive: false });
  const last = lastPage(v.f.id);
  if (last > 1 && last <= v.n) offerContinue(v, last);
  say(v.f.name + " opened. " + plural(v.n, "page") + ".");
}
function buildPdfTools(v) {
  const input = h("input", { class: "lib-pgin", type: "text", inputmode: "numeric", pattern: "[0-9]*", value: "1", "aria-label": "Page number", "data-lib-page": "", autocomplete: "off" });
  const total = h("span", { class: "lib-pgof" }, "of " + v.n);
  const prev = h("button", { class: "lib-tbtn", type: "button", "aria-label": "Previous page", "data-lib-prev": "", onclick: () => goPage(v, v.cur - 1) }, I("up"));
  const next = h("button", { class: "lib-tbtn", type: "button", "aria-label": "Next page", "data-lib-next": "", onclick: () => goPage(v, v.cur + 1) }, I("down"));
  const zout = h("button", { class: "lib-tbtn", type: "button", "aria-label": "Zoom out", "data-lib-zout": "", onclick: () => stepZoom(v, -1) }, I("minus"));
  const zin = h("button", { class: "lib-tbtn", type: "button", "aria-label": "Zoom in", "data-lib-zin": "", onclick: () => stepZoom(v, 1) }, I("plus"));
  const zl = h("button", { class: "lib-zl", type: "button", "aria-label": "Fit to width", title: "Fit to width", "data-lib-fit": "", onclick: () => { v.fit = true; zoomTo(v, null); } }, "100%");
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); const n = parseInt(input.value, 10); if (n) goPage(v, n); else input.value = String(v.cur); input.select(); } });
  input.addEventListener("focus", () => input.select());
  input.addEventListener("blur", () => { input.value = String(v.cur); });
  F.dom.clear(v.tools).append(
    h("div", { class: "lib-tgrp lib-pager" }, prev, h("label", { class: "lib-pgl" }, h("span", { class: "sr-only" }, "Page"), input), total, next),
    h("span", { class: "lib-tsep", "aria-hidden": "true" }),
    h("div", { class: "lib-tgrp lib-zoom" }, zout, zl, zin));
  v.tools.hidden = false;
  v.ui = { input, prev, next, zout, zin, zl, total };
}
function fitScale(v) {
  const pad = PHONE.matches ? 16 : 56;
  const w = Math.max(160, Math.min(PHONE.matches ? 4000 : 820, v.stage.clientWidth - pad));
  return Math.max(0.25, Math.min(4, w / v.base.w));
}
function layout(v) {
  if (v.fit) v.scale = fitScale(v);
  for (const p of v.pages) { p.el.style.width = Math.floor(p.w * v.scale) + "px"; p.el.style.height = Math.floor(p.h * v.scale) + "px"; }
  v.tops = v.pages.map(p => p.el.offsetTop);
  if (v.ui) {
    v.ui.zl.textContent = Math.round(v.scale * 100) + "%";
    v.ui.zl.setAttribute("aria-pressed", String(v.fit));
    v.ui.zout.disabled = v.scale <= ZOOMS[0] + 1e-3;
    v.ui.zin.disabled = v.scale >= ZOOMS[ZOOMS.length - 1] - 1e-3;
    v.ui.prev.disabled = v.cur <= 1; v.ui.next.disabled = v.cur >= v.n;
  }
  v.vis.forEach(p => renderPage(v, p));
}
function zoomTo(v, s) {
  if (!v.pages.length) return;
  const i = v.cur - 1, st = v.stage;
  const top = v.tops[i] || 0, hgt = v.pages[i].el.offsetHeight || 1;
  const frac = (st.scrollTop - top) / hgt, cx = (st.scrollLeft + st.clientWidth / 2) / Math.max(1, st.scrollWidth);
  if (s != null) { v.fit = false; v.scale = s; }
  layout(v);
  st.scrollTop = v.tops[i] + frac * v.pages[i].el.offsetHeight;
  st.scrollLeft = Math.max(0, cx * st.scrollWidth - st.clientWidth / 2);
}
function stepZoom(v, dir) {
  const s = v.scale;
  const nx = dir > 0 ? ZOOMS.find(z => z > s * 1.02) : [...ZOOMS].reverse().find(z => z < s / 1.02);
  if (nx) zoomTo(v, nx);
}
function goPage(v, n) {
  if (!v.n) return;
  n = Math.max(1, Math.min(v.n, n | 0));
  v.stage.scrollTo({ top: Math.max(0, v.tops[n - 1] - (PHONE.matches ? 8 : 20)), behavior: "auto" });
  setCur(v, n);
}
function trackPage(v) {
  if (!v.tops.length) return;
  const y = v.stage.scrollTop + v.stage.clientHeight * 0.4;
  let lo = 0, hi = v.tops.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (v.tops[mid] <= y) lo = mid; else hi = mid - 1; }
  if (v.stage.scrollTop + v.stage.clientHeight >= v.stage.scrollHeight - 2) lo = v.n - 1;
  setCur(v, lo + 1);
}
function setCur(v, n) {
  if (n === v.cur && v.ui && v.ui.input.value === String(n)) return;
  v.cur = n;
  if (v.ui) {
    if (D.activeElement !== v.ui.input) v.ui.input.value = String(n);
    v.ui.prev.disabled = n <= 1; v.ui.next.disabled = n >= v.n;
  }
  if (v.cont && n > 1) hideContinue(v);
  clearTimeout(v.saveT);
  v.saveT = setTimeout(() => { v.saveT = 0; setLastPage(v.f.id, v.cur); }, 700);
}
async function renderPage(v, pg) {
  if (v.closed || !v.doc) return;
  if (pg.canvas && pg.scale === v.scale) return;
  if (pg.want === v.scale) return;                       // already rendering at this zoom
  const job = pg.want = v.scale;
  if (pg.task) { try { pg.task.cancel(); } catch (e) {} pg.task = null; }
  try {
    const page = await v.doc.getPage(pg.i);
    if (v.closed || pg.want !== job || !v.vis.has(pg)) return;
    if (!pg.sized) {
      const b = page.getViewport({ scale: 1 }); pg.sized = true;
      if (Math.abs(b.width - pg.w) > 1 || Math.abs(b.height - pg.h) > 1) { pg.w = b.width; pg.h = b.height; layout(v); }
    }
    const vp = page.getViewport({ scale: job });
    let ratio = Math.min(W.devicePixelRatio || 1, 2);
    const px = vp.width * vp.height * ratio * ratio, MAXPX = 16e6;
    if (px > MAXPX) ratio *= Math.sqrt(MAXPX / px);
    const c = h("canvas", { class: "lib-pg-c", "aria-hidden": "true" });
    c.width = Math.max(1, Math.floor(vp.width * ratio)); c.height = Math.max(1, Math.floor(vp.height * ratio));
    const task = pg.task = page.render({ canvasContext: c.getContext("2d", { alpha: false }), viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null });
    await task.promise;
    if (pg.task === task) pg.task = null;
    if (v.closed || pg.want !== job) { c.width = c.height = 0; return; }
    if (pg.canvas) { pg.canvas.width = pg.canvas.height = 0; pg.canvas.remove(); }
    pg.canvas = c; pg.scale = job;
    pg.el.appendChild(c); pg.el.classList.add("on");
  } catch (e) {
    /* cancelled or failed: the placeholder stays and is rendered again when it scrolls back into view */
  } finally { if (pg.want === job) pg.want = 0; }
}
function dropPage(v, pg) {
  const live = v.pages.filter(p => p.canvas).length;
  if (live <= 10 || !pg.canvas) return;
  if (pg.task) try { pg.task.cancel(); } catch (e) {}
  pg.task = null; pg.want = 0;
  pg.canvas.width = pg.canvas.height = 0; pg.canvas.remove(); pg.canvas = null; pg.scale = 0; pg.el.classList.remove("on");
}
function offerContinue(v, n) {
  const box = h("div", { class: "lib-cont", role: "status", "data-lib-continue": String(n) },
    h("span", null, "You were on page " + n + "."),
    h("button", { class: "lib-cont-go", type: "button", onclick: () => { hideContinue(v); goPage(v, n); } }, "Continue from page " + n),
    h("button", { class: "lib-cont-x", type: "button", "aria-label": "Start from page 1", onclick: () => { hideContinue(v); v.stage.focus({ preventScroll: true }); } }, I("x")));
  v.cont = box; v.body.appendChild(box);
}
function hideContinue(v) { if (v.cont) { v.cont.remove(); v.cont = null; } }
function onViewerKey(v, e) {
  const t = e.target, typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
  if (typing || e.altKey || e.metaKey) return;
  if (e.ctrlKey && (e.key === "=" || e.key === "+" || e.key === "-")) { e.preventDefault(); if (v.n) stepZoom(v, e.key === "-" ? -1 : 1); else if (v.img) imgZoom(v, e.key === "-" ? -1 : 1); return; }
  if (e.ctrlKey) return;
  if (v.n) {
    const map = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 };
    if (map[e.key]) { e.preventDefault(); goPage(v, v.cur + map[e.key]); return; }
    if (e.key === "Home" && t === v.stage) { e.preventDefault(); goPage(v, 1); return; }
    if (e.key === "End" && t === v.stage) { e.preventDefault(); goPage(v, v.n); return; }
    if (e.key === "+" || e.key === "=") { e.preventDefault(); stepZoom(v, 1); return; }
    if (e.key === "-") { e.preventDefault(); stepZoom(v, -1); return; }
    if (e.key === "0") { e.preventDefault(); v.fit = true; zoomTo(v, null); }
  } else if (v.img) {
    if (e.key === "+" || e.key === "=") { e.preventDefault(); imgZoom(v, 1); }
    else if (e.key === "-") { e.preventDefault(); imgZoom(v, -1); }
    else if (e.key === "0") { e.preventDefault(); imgFit(v); }
  }
}

/* ---- image ---- */
async function openImage(v) {
  const blob = await fetchFor(v, "Opening " + v.f.name);
  if (!blob) return;
  const u = URL.createObjectURL(blob); v.urls.push(u);
  const img = h("img", { class: "lib-img", src: u, alt: v.f.name, decoding: "async", draggable: "false" });
  const box = h("div", { class: "lib-imgbox" }, img);
  img.addEventListener("load", () => {
    if (v.closed) return;
    v.img = { el: img, w: img.naturalWidth || 1, h: img.naturalHeight || 1, box };
    F.dom.clear(v.stage).appendChild(box);
    const zout = h("button", { class: "lib-tbtn", type: "button", "aria-label": "Zoom out", "data-lib-zout": "", onclick: () => imgZoom(v, -1) }, I("minus"));
    const zin = h("button", { class: "lib-tbtn", type: "button", "aria-label": "Zoom in", "data-lib-zin": "", onclick: () => imgZoom(v, 1) }, I("plus"));
    const zl = h("button", { class: "lib-zl", type: "button", "aria-label": "Fit to screen", "data-lib-fit": "", onclick: () => imgFit(v) }, "Fit");
    F.dom.clear(v.tools).append(h("span", { class: "lib-tinfo" }, v.img.w + " × " + v.img.h), h("span", { class: "lib-tsep", "aria-hidden": "true" }), h("div", { class: "lib-tgrp lib-zoom" }, zout, zl, zin));
    v.tools.hidden = false; v.ui = { zout, zin, zl };
    imgFit(v);
    v.ro = new ResizeObserver(() => { if (v.img && v.img.fit) imgFit(v); }); v.ro.observe(v.stage);
    img.addEventListener("click", () => { if (v.img.fit) imgSet(v, 1); else imgFit(v); });
    say(v.f.name + " opened.");
  }, { once: true });
  img.addEventListener("error", () => { if (!v.closed) stageMessage(v, "alert", "This image couldn't be shown", "You can still download it.", false); }, { once: true });
}
function imgSet(v, s, fit) {
  const im = v.img; im.s = s; im.fit = !!fit;
  im.el.style.width = Math.round(im.w * s) + "px"; im.el.style.height = Math.round(im.h * s) + "px";
  im.box.classList.toggle("zoomed", !fit && (im.w * s > v.stage.clientWidth || im.h * s > v.stage.clientHeight));
  v.ui.zl.textContent = fit ? "Fit" : Math.round(s * 100) + "%";
  v.ui.zl.setAttribute("aria-pressed", String(!!fit));
}
function imgFit(v) {
  const pad = PHONE.matches ? 24 : 64, im = v.img;
  imgSet(v, Math.min(1.5, (v.stage.clientWidth - pad) / im.w, (v.stage.clientHeight - pad) / im.h), true);
}
function imgZoom(v, dir) {
  if (!v.img) return;
  const s = v.img.s;
  const nx = dir > 0 ? ZOOMS.find(z => z > s * 1.02) : [...ZOOMS].reverse().find(z => z < s / 1.02);
  if (nx) imgSet(v, nx, false);
}

/* ---- text ---- */
async function openText(v) {
  const blob = await fetchFor(v, "Opening " + v.f.name);
  if (!blob) return;
  const t = await blob.text();
  if (v.closed) return;
  F.dom.clear(v.stage).appendChild(h("div", { class: "lib-text" }, h("pre", null, t)));
}

/* ---- anything else: Drive's own previewer in a frame ---- */
function openPreview(v, why) {
  const url = drive().previewUrl(v.f);
  const note = h("p", { class: "lib-pv-note" }, I("alert"),
    h("span", null, why || "Shown with Google's previewer. If it asks you to sign in, use your IIM Ranchi account, or download the file."));
  let frame;
  if (url) frame = h("iframe", { class: "lib-pv", src: url, title: v.f.name, allow: "autoplay; fullscreen", referrerpolicy: "strict-origin-when-cross-origin",
    sandbox: "allow-scripts allow-same-origin allow-presentation", loading: "eager" });
  else frame = h("div", { class: "lib-pv lib-pv-demo", "data-lib-preview": "demo" }, badge(kindOf(v.f.mimeType), "lg"), h("b", null, v.f.name),
    h("p", null, "Demo mode: here the Library shows Google Drive's previewer for Word, PowerPoint, Excel and video files."));
  F.dom.clear(v.stage).append(note, frame);
  v.stage.classList.add("pv");
  v.tools.hidden = true;
}

/* ================================================================ upload ================================================== */
function openUpload() {
  if (!canUpload()) return;
  let file = null, busy = false;
  const input = h("input", { type: "file", class: "sr-only", id: "libUpFile", "data-lib-file": "" });
  const chosen = h("div", { class: "lib-up-file", hidden: true });
  const prog = h("div", { class: "lib-prog", role: "progressbar", "aria-label": "Upload progress", hidden: true }, h("i"));
  const status = h("p", { class: "lib-up-status", role: "status" });
  const drop = h("label", { class: "lib-drop", for: "libUpFile" }, I("upload"), h("b", null, "Choose a file"), h("span", null, PHONE.matches ? "Up to 100 MB" : "or drop it here · up to 100 MB"), input);
  const pick = f => {
    if (!f) return;
    if (f.size > MAX_UPLOAD) { status.textContent = "That file is larger than 100 MB. Share a smaller version."; status.className = "lib-up-status bad"; return; }
    file = f; status.textContent = ""; status.className = "lib-up-status";
    F.dom.clear(chosen).append(badge(kindOf(f.type)), h("span", { class: "lib-up-n" }, h("b", null, f.name), h("span", null, fmtSize(f.size))),
      h("button", { class: "lib-iconbtn", type: "button", "aria-label": "Remove file", onclick: () => { file = null; chosen.hidden = true; drop.hidden = false; input.value = ""; } }, I("x")));
    chosen.hidden = false; drop.hidden = true;
  };
  input.addEventListener("change", () => pick(input.files && input.files[0]));
  ["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => pick(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));
  const m = F.ui.modal({
    title: "Add a file to the Library",
    className: "lib-up", size: "md",
    body: [
      h("p", null, "Your file goes to the club's upload folder. A Finspire admin reviews each upload and moves it into the right folder, so it won't show up in the Library straight away."),
      h("ul", { class: "fs-si-list" }, h("li", null, "Share your own work, or files that are free to share. No paid or copyrighted course material."),
        h("li", null, "Name it “Topic – Your name – Year”.")),
      drop, chosen, prog, status
    ],
    actions: [{ label: "Cancel", kind: "ghost" }, { label: "Upload", kind: "primary", keepOpen: true, onClick: (mm, ev) => start(ev.currentTarget) }]
  });
  m.card.setAttribute("data-lib-upload-dialog", "");
  async function start(b) {
    if (busy) return;
    if (!file) { status.textContent = "Choose a file first."; status.className = "lib-up-status bad"; return; }
    busy = true; b.disabled = true; prog.hidden = false; prog.classList.add("indet");
    status.className = "lib-up-status"; status.textContent = "Uploading…";
    const bar = prog.firstChild;
    try {
      const res = await drive().upload(file, S.inbox, (got, total) => {
        prog.classList.remove("indet"); bar.style.transform = "scaleX(" + (total ? got / total : 0) + ")";
        status.textContent = "Uploading… " + (total ? Math.round(got / total * 100) : 0) + "%";
      });
      S.lists.delete(S.inbox);
      bar.style.transform = "scaleX(1)";
      F.dom.clear(m.body).appendChild(h("div", { class: "lib-up-done", "data-lib-uploaded": (res && res.id) || "" },
        h("span", { class: "lib-done-ic" }, I("check")),
        h("b", null, "Sent for review"),
        h("p", null, "“" + ((res && res.name) || file.name) + "” is in the club's upload folder. A Finspire admin will review it and add it to the right folder. Thank you for sharing.")));
      m.card.classList.add("lib-up-ok");
      const acts = m.card.querySelector(".fs-modal-acts");
      if (acts) F.dom.clear(acts).appendChild(h("button", { class: "fs-mbtn primary", type: "button", onclick: () => m.close() }, "Done"));
      F.ui.toast("Uploaded " + ((res && res.name) || file.name), { kind: "ok" });
    } catch (e) {
      busy = false; b.disabled = false; prog.hidden = true;
      status.className = "lib-up-status bad";
      const msg = String(e && e.message || "");
      status.textContent = e.kind === "access" ? "You can't add files to the upload folder yet. Ask a Finspire admin to give IIM Ranchi access."
        : /popup_closed|scope-denied|access_denied/.test(msg) ? "Google needs your permission to add the file. Press Upload and allow it."
        : e.kind === "network" ? "Couldn't reach Google Drive. Check your connection and try again."
        : "The upload didn't finish. Try again.";
    }
  }
}

/* ================================================================ boot ==================================================== */
async function initDemo() {
  const q = new URLSearchParams(location.search).get("demo-drive");
  if (q === "1") sset("fs.lib.demo", "1"); else if (q === "0") { sset("fs.lib.demo", null); sset("fs.lib.open", null); }
  if (!F.auth.isDemo() || sget("fs.lib.demo") !== "1") return null;
  try { return makeDemo(await F.fetchJSON("_demo/drive.json")); } catch (e) { return null; }
}
/* Links from the home page's Drive cards use library/?f=<folder id>; the Library routes on #f=<path>. Turn the
   query form into the hash form once, so Back to the Library home and later navigation keep working. */
function folderLinkToHash() {
  let sp; try { sp = new URLSearchParams(location.search); } catch (e) { return; }
  const f = sp.get("f");
  if (f == null) return;
  sp.delete("f");
  const qs = sp.toString(), ok = /^[A-Za-z0-9_-]{10,}$/.test(f);
  const hash = ok && !/^#f=/.test(location.hash) ? "#f=" + f : location.hash;
  try { history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + hash); } catch (e) {}
}
async function boot() {
  folderLinkToHash();
  root.setAttribute("aria-busy", "true");
  const siteP = F.fetchJSON("data/site-data.json", { bust: true }).catch(() => null);
  await F.auth.ready.catch(() => null);
  S.demo = await initDemo();
  S.site = await siteP;
  buildFolders();
  // sign-in switched off: folders shared "anyone with the link" can still be browsed with the public API key
  if (!signinOn() && (S.demo || F.cfg.driveApiKey)) { S.keyMode = true; S.opened = true; }
  // the header copy promises sign-in; say only what is true for this site's switches
  const lede = head && head.querySelector(".lede");
  if (lede && (!signinOn() || !F.feature("library"))) lede.textContent = "Notes, templates and past work from Finspire members, read and downloaded inside the site.";
  root.removeAttribute("aria-busy");
  route();
  F.on("auth", u => {
    S.lists.clear(); blobs.clear(); S.searchIds.clear();
    if (!u) { S.opened = false; sset("fs.lib.open", null); }
    UI = null; route();
  });
  F.on("store", key => {
    if (!(key === "lib.recent" || key === "*") || !S.opened || S.path.length || S.q || !UI || !root.contains(UI.wrap)) return;
    if (VW && !VW.closed) S.homeStale = true; else renderHome();
  });
  W.addEventListener("popstate", onPop);
  W.addEventListener("hashchange", onPop);
}
boot();
})();
