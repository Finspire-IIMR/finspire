/* Finspire shared runtime: window.Finspire (the only global this file defines).
   Load on every page, after config.js:   <script src="ROOT/config.js"></script><script src="ROOT/assets/js/finspire.js"></script>
   Every method is safe to call before sign-in or the glossary has finished loading. Contract: ARCHITECTURE.md.

   Core
     Finspire.cfg                        merged config (defaults + window.FINSPIRE_CONFIG)
     Finspire.root / url(p)              "./" or "../" from <meta name="fs-root">;  url("dictionary/#t=gdp") → "../dictionary/#t=gdp"
     Finspire.on(evt, fn) → unsubscribe; off(evt, fn); emit(evt, data)
                                          events: "auth" (user|null) · "store" (key, "*" = everything) · "glossary" (index)
     Finspire.fetchJSON(p, {bust})       → Promise<JSON>; bust adds ?t=<minute>; rejects on HTTP errors
     Finspire.fmt  num(n, dp=2) "24,812.35" · signed(n, dp=2) "+46.18" / "−46.18" · pct(n, dp=2) "+0.59%" (signed)
                   ago(isoOrMs) "5 min ago" · time(msOrIso, tz?) "14:05" · date(isoOrMs, opts?) "12 Oct 2026"
                   Missing or non-numeric values give "—". Negative numbers use a true minus sign (U+2212).
     Finspire.dom  h(tag, attrs, ...children)   element builder. Strings become text nodes (never HTML).
                     attrs: class, text, style (string|object), dataset {…}, on<event>: fn, true → boolean attribute,
                     null/false → skipped. Tag "svg:path" makes an SVG element.
                   esc(s) HTML-escape · safeUrl(u) → absolute http(s) URL or null · clear(el)
                   ext(href, attrs, ...children)  <a target=_blank rel="noopener noreferrer"> for http(s), else <span>
                   icon(name)  small inline SVG: google, chev, star, x, arrow, book, folder, out, user, check

   UI  (styles in assets/css/shell.css; class prefixes fs- and gl-)
     Finspire.ui.toast(msg, {kind: "ok"|"error"|"info", ms})
     Finspire.ui.modal(opts) → {el, card, body, close(result), closed: Promise}
         opts: title, body (Node | string | array), actions [{label, kind: "primary"|"ghost", onClick(m, ev), keepOpen,
               href, node}], size "md"|"lg", label (aria-label when no title), dismissable (default true),
               className, onClose(result), initialFocus (element or selector)
         Accessible base: role=dialog + aria-modal, focus trap, Escape and scrim click close, page scroll lock,
         focus returns to the opener. Bottom sheet on phones.
     Finspire.ui.mountAccount(el)        Sign-in pill / avatar + menu; re-renders on "auth". [data-fs-account] auto-mounts.
     Finspire.ui.signInDialog(reason)    explains IIM Ranchi sign-in and offers the Google button
     Finspire.header.init()              sub-page header: scrolled state, burger menu, aria-current, light-band mode,
                                          account mount, footer year. Runs automatically for <header data-fs-header>.
     Finspire.header.refresh()           re-scan .light bands after a page adds them

   Auth (Google Identity Services token flow; profile kept in localStorage, tokens only in memory)
     Finspire.auth.ready (Promise<user|null>) · user() · enabled() · isAdmin() · isDemo()
     Finspire.auth.signIn()              call from a click. Rejects on cancel / wrong domain / not configured.
     Finspire.auth.signOut()             revokes tokens, forgets the profile
     Finspire.auth.getToken(scopes)      call from a click when consent may be needed. scopes: array or space string;
                                          short names allowed ("drive.readonly", "drive.file", "drive.appdata")
     Finspire.auth.hasToken(scopes)      a live token already covers scopes (no popup)
     Finspire.auth.SCOPES                {driveReadonly, driveFile, driveAppdata}
     Demo (tests only): on localhost / 127.0.0.1, ?demo-user=1 together with a --demo build (_demo/demo.json) signs in
     a fake student; it stays on for the browser tab session. ?demo-user=0 turns it off.

   Store (per-user localStorage, namespaced "fs:<sub|guest>:<key>")
     Finspire.store.get(key, fallback) · set(key, value) · update(key, fn, fallback) · clear()
     Helpers: addHistory(id, via) · isSaved(id) · toggleSaved(id, on?) → boolean · sync({interactive}) → Promise
     Keys: dict.history [{id, at, via}] newest first (max 200, one row per term) · dict.saved [id] ·
           dict.srs {id: {box, due, seen, right}} · lib.recent [{id, name, mime, folder, at}] · lib.pos {fileId: page} ·
           news.seen ms
     Drive mirror: when a token with drive.appdata exists, changes upload to appDataFolder/finspire-profile.json 4 s
     after the last change; the remote copy is merged once per session when such a token first appears.

   Glossary
     Finspire.glossary.load() → Promise<index> · get(id) · cats() · rows() · search(q, {limit, cat}) · entry(id)
                      match(text) → [{id, start, end}] · annotate(el, {max, once}) → [ids] · termOfDay(date?)
                      LEVELS {b: "Beginner", i: "Intermediate", a: "Advanced"}
     annotate() called before the index has loaded is applied as soon as it loads (and returns []).

   Tip
     Finspire.tip   automatic for .gl-term and any [data-term="<id>"] element (hover 120 ms / focus / tap → sheet).
                    show(elOrId, {anchor, mode}) · hide() · isOpen()
*/
(() => {
"use strict";
if (window.Finspire) return;
const W = window, D = document;

/* ---------- safe storage ---------- */
const store_ = name => { try { const s = W[name]; const k = "__fs"; s.setItem(k, "1"); s.removeItem(k); return s; } catch (e) { return null; } };
const LS = store_("localStorage"), SS = store_("sessionStorage");
const sget = (s, k) => { try { return s ? s.getItem(k) : null; } catch (e) { return null; } };
const sset = (s, k, v) => { try { if (s) { s.setItem(k, v); return true; } } catch (e) {} return false; };
const sdel = (s, k) => { try { if (s) s.removeItem(k); } catch (e) {} };
const parse = (raw, fb) => { if (raw == null) return fb; try { return JSON.parse(raw); } catch (e) { return fb; } };

/* ---------- config, root, url ---------- */
const DEFAULTS = { googleClientId: "", allowedDomain: "iimranchi.ac.in", driveApiKey: "", admins: [],
  github: { owner: "", repo: "", branch: "main" }, siteUrl: "", marketsPollSeconds: 15, newsPollSeconds: 180,
  /* Feature switches: a site can launch with only some pages and switch the rest on later without code changes.
     signin:false = no Google sign-in; personal features (history, saved words, revision) then work for everyone and
     are kept in this browser. */
  features: { markets: true, dictionary: true, library: true, signin: true },
  /* Where each page lives, relative to the site root (hosts that do not serve folder index pages can use ".../index.html"). */
  pages: { home: "index.html", markets: "markets/", dictionary: "dictionary/", library: "library/" } };
const UC = (W.FINSPIRE_CONFIG && typeof W.FINSPIRE_CONFIG === "object") ? W.FINSPIRE_CONFIG : {};
const cfg = Object.assign({}, DEFAULTS, UC, { github: Object.assign({}, DEFAULTS.github, UC.github || {}),
  features: Object.assign({}, DEFAULTS.features, UC.features || {}), pages: Object.assign({}, DEFAULTS.pages, UC.pages || {}) });
/* Sign-in rollout: the account control and every sign-in prompt appear only when sign-in can actually work, i.e. the
   switch is on AND an admin has pasted the Google client id (or local demo mode is on). Until then feature("signin") is
   false and everyone is a local guest. */
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const demoQ = isLocal ? new URLSearchParams(location.search).get("demo-user") : null;
let demoWanted = isLocal && (demoQ === "1" || (demoQ !== "0" && sget(SS, "fs.demo.user") === "1"));   // confirmed in auth.ready
const signinUsable = () => cfg.features.signin !== false && (!!cfg.googleClientId || demoWanted);
const feature = name => name === "signin" ? signinUsable() : cfg.features[name] !== false;
/* Without usable sign-in everyone is a local guest: personal features work and stay in this browser. */
const GUEST = Object.freeze({ sub: "guest", email: "", name: "", given: "", picture: "", hd: "", guest: true });
const me = () => feature("signin") ? user : GUEST;   // the person personal features belong to
cfg.googleClientId = String(cfg.googleClientId || "").trim();
cfg.allowedDomain = String(cfg.allowedDomain || "").trim().toLowerCase().replace(/^@/, "");
cfg.admins = (Array.isArray(cfg.admins) ? cfg.admins : []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
/* adminHashes: SHA-256 (hex) of lower-case admin emails, so config.js in a public repo never shows the addresses */
cfg.adminHashes = (Array.isArray(cfg.adminHashes) ? cfg.adminHashes : []).map(s => String(s).trim().toLowerCase()).filter(Boolean);

const rootMeta = D.querySelector('meta[name="fs-root"]');
let root = (rootMeta && rootMeta.getAttribute("content")) || "./";
if (!/\/$/.test(root)) root += "/";
function url(p) {
  p = p == null ? "" : String(p);
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(p)) return p;
  return root + p.replace(/^\/+/, "");
}

/* ---------- events ---------- */
const subs = Object.create(null);
function on(evt, fn) { (subs[evt] || (subs[evt] = new Set())).add(fn); return () => off(evt, fn); }
function off(evt, fn) { if (subs[evt]) subs[evt].delete(fn); }
function emit(evt, data) {
  if (!subs[evt]) return;
  [...subs[evt]].forEach(fn => { try { fn(data); } catch (err) { setTimeout(() => { throw err; }); } });
}

/* ---------- fetch ---------- */
/* bust: true = a new URL every 5 minutes (the data pipeline runs every 15), so moving between pages inside that window
   hits the HTTP cache or gets a cheap 304; a number = that period in ms (markets.js passes 60000 for the 2.6 KB snapshot). */
function fetchJSON(p, opts = {}) {
  let u = url(p);
  const period = typeof opts.bust === "number" && opts.bust > 0 ? opts.bust : 300000;
  if (opts.bust) u += (u.includes("?") ? "&" : "?") + "t=" + Math.floor(Date.now() / period);
  return fetch(u, { cache: opts.bust ? "no-cache" : "default", credentials: "same-origin" }).then(r => {
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + p);
    return r.json();
  });
}

/* ---------- formatting ---------- */
const MINUS = "−", NF = {}, TF = {}, DF = {};
const nf = dp => NF[dp] || (NF[dp] = new Intl.NumberFormat("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const isNum = n => n !== null && n !== "" && n !== undefined && typeof n !== "boolean" && isFinite(+n);
const toMs = x => typeof x === "number" ? x : (x instanceof Date ? x.getTime() : Date.parse(x));
const fmt = {
  num(n, dp = 2) {
    if (!isNum(n)) return "—";
    n = +n; const s = nf(dp).format(Math.abs(n));
    return (n < 0 && /[1-9]/.test(s) ? MINUS : "") + s;
  },
  signed(n, dp = 2) {
    if (!isNum(n)) return "—";
    n = +n; const s = nf(dp).format(Math.abs(n));
    return (/[1-9]/.test(s) ? (n < 0 ? MINUS : "+") : "") + s;
  },
  pct(n, dp = 2) { return isNum(n) ? fmt.signed(n, dp) + "%" : "—"; },
  ago(x) {
    const t = toMs(x); if (!isFinite(t)) return "";
    const s = (Date.now() - t) / 1000;
    if (s < 45) return "just now";
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    if (s < 172800) return "yesterday";
    if (s < 604800) return Math.floor(s / 86400) + " days ago";
    return fmt.date(t);
  },
  time(x, tz) {
    const t = toMs(x); if (!isFinite(t)) return "";
    const k = tz || "";
    try {
      const f = TF[k] || (TF[k] = new Intl.DateTimeFormat("en-GB", Object.assign({ hour: "2-digit", minute: "2-digit", hour12: false }, tz ? { timeZone: tz } : {})));
      return f.format(t);
    } catch (e) { return ""; }
  },
  date(x, opts) {
    let t, o = Object.assign({ day: "numeric", month: "short", year: "numeric" }, opts || {});
    if (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x)) { const [y, m, d] = x.split("-").map(Number); t = Date.UTC(y, m - 1, d); o.timeZone = "UTC"; }
    else t = toMs(x);
    if (!isFinite(t)) return "";
    const k = JSON.stringify(o);
    try { return (DF[k] || (DF[k] = new Intl.DateTimeFormat("en-GB", o))).format(t); } catch (e) { return ""; }
  }
};

/* ---------- DOM helpers ---------- */
const SVGNS = "http://www.w3.org/2000/svg";
function h(tag, attrs, ...kids) {
  const svg = tag.startsWith("svg:");
  const el = svg ? D.createElementNS(SVGNS, tag.slice(4)) : D.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === "class" || k === "className") { if (svg) el.setAttribute("class", v); else el.className = v; }
    else if (k === "text") el.textContent = v;
    else if (k === "style") { if (typeof v === "string") el.style.cssText = v; else Object.assign(el.style, v); }
    else if (k === "dataset" || k === "data") { for (const d in v) if (v[d] != null) el.dataset[d] = v[d]; }
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (!svg && (k === "value" || k === "checked" || k === "selected" || k === "disabled" || k === "hidden")) el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const c of kids) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) add(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(D.createTextNode(String(c)));
  }
}
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function safeUrl(u) {
  try { const x = new URL(String(u || "").trim()); return (x.protocol === "https:" || x.protocol === "http:") ? x.href : null; } catch (e) { return null; }
}
function ext(href, attrs, ...kids) {
  const u = safeUrl(href);
  return u ? h("a", Object.assign({}, attrs, { href: u, target: "_blank", rel: "noopener noreferrer" }), ...kids) : h("span", attrs, ...kids);
}
const clear = el => { if (el) el.textContent = ""; return el; };
/* static, trusted markup only */
const ICONS = {
  google: '<svg class="fs-g" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>',
  chev: '<svg class="fs-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M10 8l-4 4 4 4M6 12h10"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'
};
function icon(name) { const t = D.createElement("template"); t.innerHTML = ICONS[name] || ""; return t.content.firstChild || D.createTextNode(""); }
const dom = { h, esc, safeUrl, ext, clear, icon };

let uid = 0;
const nextId = p => p + "-" + (++uid);
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),iframe,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

/* ================================================================ UI: toast + modal ================================ */
let toastBox = null;
function toast(msg, o = {}) {
  if (!toastBox) {
    toastBox = h("div", { class: "fs-toasts", role: "status", "aria-live": "polite" });
    D.body.appendChild(toastBox);
  }
  const t = h("div", { class: "fs-toast " + (o.kind || "info") }, h("i", { "aria-hidden": "true" }), h("span", null, String(msg)));
  toastBox.appendChild(t);
  while (toastBox.children.length > 3) toastBox.firstChild.remove();
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("fs-show")));
  const ms = o.ms || Math.min(7000, 2600 + String(msg).length * 30);
  setTimeout(() => { t.classList.remove("fs-show"); setTimeout(() => t.remove(), 320); }, ms);
  return t;
}

let lockN = 0;
function lockScroll(on) {
  const de = D.documentElement;
  if (on) {
    if (lockN++ === 0) {
      const sbw = W.innerWidth - de.clientWidth;
      if (sbw > 0) de.style.setProperty("--fs-sbw", sbw + "px"), D.body.style.paddingRight = sbw + "px";
      de.classList.add("fs-lock");
    }
  } else if (lockN > 0 && --lockN === 0) {
    de.classList.remove("fs-lock"); D.body.style.paddingRight = ""; de.style.removeProperty("--fs-sbw");
  }
}
const modals = [];
function modal(o = {}) {
  const opener = D.activeElement;
  const dismissable = o.dismissable !== false;
  const titleId = nextId("fs-mt");
  let done = false, resolveClosed;
  const closed = new Promise(r => resolveClosed = r);
  const m = {};
  const acts = (o.actions || []).length ? h("div", { class: "fs-modal-acts" }, o.actions.map(a => {
    if (a.node) return a.node;
    const cls = "fs-mbtn" + (a.kind ? " " + a.kind : "");
    const btn = a.href ? h("a", { class: cls, href: a.href, target: a.target || null, rel: a.target ? "noopener noreferrer" : null }, a.label)
                       : h("button", { class: cls, type: "button" }, a.label);
    if (a.autofocus) btn.setAttribute("data-autofocus", "");
    btn.addEventListener("click", ev => { const r = a.onClick ? a.onClick(m, ev) : undefined; if (!a.keepOpen && r !== false) m.close(a.value); });
    return btn;
  })) : null;
  const body = h("div", { class: "fs-modal-body" }, typeof o.body === "string" ? h("p", null, o.body) : o.body);
  const card = h("div", { class: "fs-modal-card" + (o.size ? " " + o.size : ""), role: "dialog", "aria-modal": "true",
      "aria-labelledby": o.title ? titleId : null, "aria-label": o.title ? null : (o.label || "Dialog"), tabindex: "-1" },
    dismissable ? h("button", { class: "fs-modal-x", type: "button", "aria-label": "Close", onclick: () => m.close() }, icon("x")) : null,
    o.head || null,
    o.title ? h("h2", { class: "fs-modal-title", id: titleId }, o.title) : null,
    body, acts);
  const el = h("div", { class: "fs-modal" + (o.className ? " " + o.className : "") }, card);
  el.addEventListener("mousedown", e => { if (e.target === el && dismissable) m.close(); });
  el.addEventListener("keydown", e => {
    if (e.key === "Escape" && dismissable) { e.stopPropagation(); m.close(); }
    else if (e.key === "Tab") {
      const f = [...card.querySelectorAll(FOCUSABLE)].filter(visible);
      if (!f.length) { e.preventDefault(); card.focus(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (D.activeElement === first || D.activeElement === card)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && D.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  Object.assign(m, {
    el, card, body, closed,
    close(result) {
      if (done) return; done = true;
      el.classList.remove("fs-show");
      lockScroll(false);
      const i = modals.indexOf(m); if (i >= 0) modals.splice(i, 1);
      setTimeout(() => el.remove(), 240);
      if (opener && opener.focus && D.contains(opener)) { try { opener.focus({ preventScroll: true }); } catch (e) {} }
      if (o.onClose) { try { o.onClose(result); } catch (e) { setTimeout(() => { throw e; }); } }
      resolveClosed(result);
    }
  });
  D.body.appendChild(el);
  modals.push(m);
  lockScroll(true);
  if (tipApi) tipApi.hide();
  requestAnimationFrame(() => el.classList.add("fs-show"));
  let f = o.initialFocus ? (typeof o.initialFocus === "string" ? card.querySelector(o.initialFocus) : o.initialFocus) : null;
  f = f || card.querySelector("[data-autofocus]") || card.querySelector(".fs-modal-acts .primary, .fs-modal-acts .fs-gbtn") || card;
  try { f.focus({ preventScroll: true }); } catch (e) {}
  return m;
}

/* ================================================================ Auth ============================================== */
const AUTH_KEY = "fs.auth.user";
const GAPI = "https://www.googleapis.com/auth/";
const SCOPES = { driveReadonly: GAPI + "drive.readonly", driveFile: GAPI + "drive.file", driveAppdata: GAPI + "drive.appdata" };
const BASE = ["openid", "email", "profile"];
const DEMO_USER = { sub: "demo-student", email: "demo.student@iimranchi.ac.in", name: "Demo Student", given: "Demo", picture: "", hd: "iimranchi.ac.in" };
let user = null, demo = false, tokens = [], gisP = null, tokenClient = null, pending = null;

function normScopes(s) {
  const list = Array.isArray(s) ? s : String(s || "").split(/[\s,]+/);
  return [...new Set(list.map(x => String(x).trim()).filter(Boolean).map(x => (x.includes("://") || BASE.includes(x)) ? x : GAPI + x))];
}
function liveToken(scopes) {
  const now = Date.now();
  tokens = tokens.filter(t => t.exp - 60000 > now);
  return tokens.find(t => scopes.every(s => BASE.includes(s) || t.scopes.has(s))) || null;
}
function validUser(u) { return u && typeof u === "object" && typeof u.sub === "string" && typeof u.email === "string" && u.email.toLowerCase().endsWith("@" + cfg.allowedDomain); }
function setUser(u) {
  const prev = user ? user.sub : null;
  user = u ? Object.freeze(Object.assign({}, u)) : null;
  checkAdminHash(user);
  storeCache.clear();
  if ((user ? user.sub : null) !== prev) { syncState.merged = false; syncState.fileId = null; }
  emit("auth", user);
  emit("store", "*");
}
function loadGis() {
  if (gisP) return gisP;
  gisP = new Promise((res, rej) => {
    const ok = () => W.google && W.google.accounts && W.google.accounts.oauth2;
    if (ok()) return res();
    const s = D.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.defer = true;
    s.onload = () => ok() ? res() : rej(new Error("gis-missing"));
    s.onerror = () => { gisP = null; rej(new Error("gis-load")); };
    D.head.appendChild(s);
  }).then(() => {
    tokenClient = W.google.accounts.oauth2.initTokenClient({
      client_id: cfg.googleClientId, scope: BASE.join(" "), hd: cfg.allowedDomain || undefined, include_granted_scopes: true,
      callback: r => { const p = pending; pending = null; if (p) p.onToken(r); },
      error_callback: e => { const p = pending; pending = null; if (p) p.onError(e); }
    });
  });
  gisP.catch(() => {});
  return gisP;
}
function revoke(tok) { try { if (tok && W.google && W.google.accounts) W.google.accounts.oauth2.revoke(tok, () => {}); } catch (e) {} }
function requestToken(scopes, prompt) {
  if (pending) { const p = pending; pending = null; p.reject(new Error("superseded")); }
  return new Promise((resolve, reject) => {
    pending = {
      reject,
      onToken(r) {
        if (!r || r.error || !r.access_token) return reject(new Error((r && r.error) || "no-token"));
        const extra = scopes.filter(s => !BASE.includes(s));
        let granted = true;
        try { if (extra.length) granted = W.google.accounts.oauth2.hasGrantedAllScopes(r, ...extra); } catch (e) { granted = false; }
        if (!granted) return reject(new Error("scope-denied"));
        const tok = { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3599) * 1000, scopes: new Set(String(r.scope || "").split(/\s+/).filter(Boolean)) };
        tokens.push(tok);
        resolve(tok);
        if (user && tok.scopes.has(SCOPES.driveAppdata)) syncAfterToken();
      },
      onError(e) {
        const type = (e && e.type) || "popup_error";
        if (type === "popup_failed_to_open") toast("Your browser blocked the Google window. Allow pop-ups for this site and try again.", { kind: "error" });
        reject(new Error(type));
      }
    };
    const o = { scope: scopes.join(" "), prompt, include_granted_scopes: true };
    if (prompt !== "select_account" && user && user.email) o.login_hint = user.email;
    try { tokenClient.requestAccessToken(o); } catch (e) { pending = null; reject(e); }
  });
}
async function signIn() {
  if (demo) {
    sset(SS, "fs.demo.in", "1");
    setUser(DEMO_USER); afterSignIn(DEMO_USER);
    return user;
  }
  if (!cfg.googleClientId) { signInDialog(); throw new Error("not-configured"); }
  if (!tokenClient) {
    // first click as a guest: the script is not loaded yet; wait for it (still inside the user activation on fast
    // connections; otherwise say so instead of silently doing nothing)
    try { await Promise.race([loadGis(), new Promise((_, rej) => setTimeout(() => rej(new Error("gis-loading")), 2500))]); }
    catch (e) { toast(e.message === "gis-loading" ? "Google sign-in is still loading. Try again in a moment." : "Couldn't load Google sign-in. Check your connection and try again.", { kind: "error" }); throw e; }
  }
  const tok = await requestToken(BASE, "select_account");
  let p;
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + tok.token } });
    if (!r.ok) throw new Error("userinfo " + r.status);
    p = await r.json();
  } catch (e) {
    toast("Couldn't reach Google to finish signing in. Please try again.", { kind: "error" });
    throw e;
  }
  const email = String(p.email || "").toLowerCase(), domain = email.split("@")[1] || "", hd = String(p.hd || "").toLowerCase();
  const verified = p.email_verified === true || p.email_verified === "true";
  if (!verified || !(hd === cfg.allowedDomain || domain === cfg.allowedDomain)) {
    revoke(tok.token); tokens = tokens.filter(t => t !== tok);
    toast("Finspire sign-in is for @" + cfg.allowedDomain + " accounts", { kind: "error", ms: 6000 });
    throw new Error("wrong-domain");
  }
  const u = { sub: String(p.sub), email, name: p.name || email.split("@")[0], given: p.given_name || String(p.name || "").split(" ")[0] || email.split("@")[0], picture: safeUrl(p.picture) || "", hd: hd || domain };
  sset(LS, AUTH_KEY, JSON.stringify(u));
  setUser(u); afterSignIn(u);
  if (tok.scopes.has(SCOPES.driveAppdata)) syncAfterToken();
  return user;
}
function afterSignIn(u) {
  // carry what this browser kept for the local guest (lookups, saved words, revision, library) into the account
  const guest = {}; let any = false;
  SYNC_KEYS.forEach(k => { const v = parse(sget(LS, "fs:guest:" + k), null); if (v != null) { guest[k] = v; any = true; } });
  if (any) {
    const merged = mergeProfile(snapshot(), guest);
    SYNC_KEYS.forEach(k => { if (merged[k] != null && JSON.stringify(merged[k]) !== JSON.stringify(store.get(k, null))) store.set(k, merged[k]); });
    SYNC_KEYS.forEach(k => sdel(LS, "fs:guest:" + k));
  }
  toast("Signed in as " + (u.name || u.email), { kind: "ok" });
}
async function signOut() {
  const was = user, toks = tokens.slice();
  if (syncState.timer && was && !demo) { clearTimeout(syncState.timer); syncState.timer = 0; try { await Promise.race([pushProfile(), new Promise(r => setTimeout(r, 2500))]); } catch (e) {} }
  tokens = [];
  toks.forEach(t => revoke(t.token));
  sdel(LS, AUTH_KEY);
  if (demo) sset(SS, "fs.demo.in", "0");
  setUser(null);
  if (was) toast("Signed out");
}
function getToken(scopes) {
  const sc = normScopes(scopes);
  if (!user) return Promise.reject(new Error("signed-out"));
  if (demo) return Promise.resolve("demo-token");
  const t = liveToken(sc);
  if (t) return Promise.resolve(t.token);
  if (!tokenClient) return loadGis().then(() => requestToken(sc, "")).then(tok => tok.token);
  return requestToken(sc, "").then(tok => tok.token);
}
function hasToken(scopes) { if (!user) return false; if (demo) return true; return !!liveToken(normScopes(scopes)); }
let adminByHash = false;   // set once the signed-in email's hash is known (see setUser)
function isAdmin() { return feature("signin") && !!user && (cfg.admins.includes(String(user.email).toLowerCase()) || adminByHash); }
function checkAdminHash(u) {
  adminByHash = false;
  if (!u || !cfg.adminHashes.length || !(W.crypto && W.crypto.subtle)) return;
  const sub = u.sub;
  W.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(u.email).trim().toLowerCase())).then(buf => {
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    if (!user || user.sub !== sub) return;
    adminByHash = cfg.adminHashes.includes(hex);
    if (adminByHash) emit("auth", user);   // let pages show admin controls
  }).catch(() => {});
}

/* ================================================================ Store ============================================= */
const storeCache = new Map();
const SYNC_KEYS = ["dict.history", "dict.saved", "dict.srs", "lib.recent", "lib.pos", "news.seen"];
const HISTORY_VIA = ["search", "tooltip", "news", "browse"];
const nsKey = key => "fs:" + (user ? user.sub : "guest") + ":" + key;
const store = {
  get(key, fb) {
    const k = nsKey(key);
    let raw = storeCache.has(k) ? storeCache.get(k) : (storeCache.set(k, sget(LS, k)), storeCache.get(k));
    const v = parse(raw, undefined);
    return v === undefined ? fb : v;
  },
  set(key, value, opt = {}) {
    const k = nsKey(key);
    let raw; try { raw = JSON.stringify(value); } catch (e) { return false; }
    if (raw === undefined) { storeCache.delete(k); sdel(LS, k); }
    else { storeCache.set(k, raw); sset(LS, k, raw); }
    emit("store", key);
    if (!opt.noSync && SYNC_KEYS.includes(key)) scheduleSync();
    return true;
  },
  update(key, fn, fb) { const v = fn(store.get(key, fb)); store.set(key, v); return v; },
  clear() {
    const pre = "fs:" + (user ? user.sub : "guest") + ":";
    try { if (LS) for (let i = LS.length - 1; i >= 0; i--) { const k = LS.key(i); if (k && k.startsWith(pre)) LS.removeItem(k); } } catch (e) {}
    storeCache.clear();
    emit("store", "*");
    scheduleSync();
  },
  addHistory(id, via) {
    if (!id) return;
    via = HISTORY_VIA.includes(via) ? via : "browse";
    store.update("dict.history", hst => [{ id, at: Date.now(), via }].concat((Array.isArray(hst) ? hst : []).filter(x => x && x.id !== id)).slice(0, 200), []);
  },
  isSaved(id) { const s = store.get("dict.saved", []); return Array.isArray(s) && s.includes(id); },
  toggleSaved(id, force) {
    const s = store.get("dict.saved", []), list = Array.isArray(s) ? s : [];
    const on = force === undefined ? !list.includes(id) : !!force;
    store.set("dict.saved", on ? [id].concat(list.filter(x => x !== id)) : list.filter(x => x !== id));
    return on;
  },
  sync(o = {}) { return syncNow(!!o.interactive); }
};
W.addEventListener("storage", e => {
  if (!e.key) { storeCache.clear(); emit("store", "*"); return; }
  if (e.key === AUTH_KEY && !demo) {
    const u = parse(e.newValue, null);
    if (!(user && u && u.sub === user.sub)) setUser(validUser(u) ? u : null);
    return;
  }
  const pre = "fs:" + (user ? user.sub : "guest") + ":";
  if (e.key.startsWith(pre)) { storeCache.delete(e.key); emit("store", e.key.slice(pre.length)); }
});

/* ---- Drive appDataFolder mirror ---- */
const syncState = { timer: 0, fileId: null, merged: false, busy: null };
const PROFILE = "finspire-profile.json";
function mergeHistory(a, b) {
  const m = new Map();
  [].concat(a || [], b || []).forEach(x => { if (x && x.id) { const p = m.get(x.id); if (!p || (x.at || 0) > (p.at || 0)) m.set(x.id, x); } });
  return [...m.values()].sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, 200);
}
function mergeProfile(loc, rem) {
  const L = loc || {}, R = rem || {}, out = {};
  out["dict.history"] = mergeHistory(L["dict.history"], R["dict.history"]);
  out["dict.saved"] = [...new Set([].concat(L["dict.saved"] || [], R["dict.saved"] || []))];
  const srs = Object.assign({}, R["dict.srs"] || {});
  for (const [id, v] of Object.entries(L["dict.srs"] || {})) {
    const r = srs[id];
    if (!r || (v.seen || 0) > (r.seen || 0) || ((v.seen || 0) === (r.seen || 0) && (v.due || 0) >= (r.due || 0))) srs[id] = v;
  }
  out["dict.srs"] = srs;
  out["lib.recent"] = mergeHistory(L["lib.recent"], R["lib.recent"]).slice(0, 50);
  out["lib.pos"] = Object.assign({}, R["lib.pos"] || {}, L["lib.pos"] || {});
  out["news.seen"] = Math.max(+L["news.seen"] || 0, +R["news.seen"] || 0) || null;
  return out;
}
const snapshot = () => { const o = {}; SYNC_KEYS.forEach(k => { o[k] = store.get(k, null); }); return o; };
async function gfetch(tok, u, o = {}) {
  const r = await fetch(u, Object.assign({}, o, { headers: Object.assign({ Authorization: "Bearer " + tok }, o.headers || {}) }));
  if (!r.ok) throw new Error("drive " + r.status);
  return r;
}
async function findProfile(tok) {
  if (syncState.fileId) return syncState.fileId;
  const q = encodeURIComponent("name='" + PROFILE + "'");
  const j = await (await gfetch(tok, "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&pageSize=10&fields=files(id,modifiedTime)&orderBy=modifiedTime%20desc&q=" + q)).json();
  syncState.fileId = (j.files && j.files[0] && j.files[0].id) || null;
  return syncState.fileId;
}
async function pushProfile() {
  syncState.timer = 0;
  const t = user && !demo ? liveToken([SCOPES.driveAppdata]) : null;
  if (!t) return false;
  const body = JSON.stringify({ v: 1, updated: new Date().toISOString(), data: snapshot() });
  const id = await findProfile(t.token);
  if (id) {
    await gfetch(t.token, "https://www.googleapis.com/upload/drive/v3/files/" + encodeURIComponent(id) + "?uploadType=media", { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
  } else {
    const b = "fs" + Math.random().toString(36).slice(2);
    const multipart = "--" + b + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify({ name: PROFILE, parents: ["appDataFolder"] }) +
      "\r\n--" + b + "\r\nContent-Type: application/json\r\n\r\n" + body + "\r\n--" + b + "--";
    const j = await (await gfetch(t.token, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + b }, body: multipart })).json();
    syncState.fileId = j.id || null;
  }
  return true;
}
function scheduleSync() {
  if (!user || demo || !liveToken([SCOPES.driveAppdata])) return;
  clearTimeout(syncState.timer);
  syncState.timer = setTimeout(() => { pushProfile().catch(() => {}); }, 4000);
}
async function pullAndMerge() {
  const t = liveToken([SCOPES.driveAppdata]);
  if (!t || !user) return false;
  const sub = user.sub;
  const id = await findProfile(t.token);
  let remote = null;
  if (id) { try { remote = (await (await gfetch(t.token, "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "?alt=media")).json()).data || null; } catch (e) { remote = null; } }
  if (!user || user.sub !== sub) return false;
  const loc = snapshot(), merged = remote ? mergeProfile(loc, remote) : loc;
  SYNC_KEYS.forEach(k => { if (JSON.stringify(merged[k]) !== JSON.stringify(loc[k]) && merged[k] != null) store.set(k, merged[k], { noSync: true }); });
  syncState.merged = true;
  if (!remote || JSON.stringify(mergeProfile(remote, {})) !== JSON.stringify(mergeProfile(merged, {}))) await pushProfile();
  return true;
}
function syncAfterToken() {
  if (syncState.merged || syncState.busy || demo) return;
  syncState.busy = pullAndMerge().catch(() => false).finally(() => { syncState.busy = null; });
}
async function syncNow(interactive) {
  if (!user || demo) return false;
  if (!liveToken([SCOPES.driveAppdata])) {
    if (!interactive) return false;
    await getToken([SCOPES.driveAppdata]);
  }
  if (syncState.busy) await syncState.busy;
  return pullAndMerge();
}

const ready = (async () => {
  if (isLocal) {
    const q = demoQ;
    if (q === "1") { sset(SS, "fs.demo.user", "1"); sset(SS, "fs.demo.in", "1"); }
    else if (q === "0") { sdel(SS, "fs.demo.user"); sdel(SS, "fs.demo.in"); }
    if (sget(SS, "fs.demo.user") === "1") {
      if (sget(SS, "fs.demo.ok") !== "1") {
        try { const r = await fetch(url("_demo/demo.json"), { cache: "no-store" }); if (r.ok) sset(SS, "fs.demo.ok", "1"); } catch (e) {}
      }
      if (sget(SS, "fs.demo.ok") === "1") {
        demo = true;
        if (sget(SS, "fs.demo.in") !== "0") setUser(DEMO_USER);
        return user;
      }
    }
    if (demoWanted) { demoWanted = false; emit("auth", null); emit("store", "*"); }   // not a --demo build: back to guest
  }
  if (cfg.googleClientId && cfg.features.signin !== false) {
    const saved = parse(sget(LS, AUTH_KEY), null);
    if (validUser(saved)) { setUser(saved); loadGis(); }   // Google's 100 KB script only for someone who is signed in;
    else if (saved) sdel(LS, AUTH_KEY);                      // guests load it on the Sign in click (signIn/getToken)
  }
  return user;
})();

const auth = {
  ready, SCOPES,
  user: me,
  enabled: signinUsable,
  isDemo: () => demo,
  isAdmin, signIn, signOut, getToken, hasToken
};

/* ================================================================ Glossary ========================================== */
const LEVELS = { b: "Beginner", i: "Intermediate", a: "Advanced" };
const G = { p: null, idx: null, rows: [], byId: new Map(), S: [], ent: {}, hl: {}, shards: {}, trieH: null, trieA: null, compiled: false, finish: null, deferred: [] };
const norm = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
/* Phrase matching: a character trie per kind (hl lower-cased, abbr case-sensitive), walked only from word starts.
   Same rules as a word-bounded, longest-first alternation regex, but linear in the text length however large the
   dictionary gets (a single alternation of ~15k phrases is far too slow in browsers). */
const WORD = /[\p{L}\p{N}]/u;
const isWord = c => c !== undefined && c !== "" && WORD.test(c);
function buildTrie(map) {
  const root = new Map();
  for (const [k, id] of map) {
    let n = root;
    for (let i = 0; i < k.length; i++) { let nx = n.get(k[i]); if (!nx) { nx = new Map(); n.set(k[i], nx); } n = nx; }
    if (!n.has("\0")) n.set("\0", id);
  }
  return root;
}
function lowerSame(t) {
  const l = t.toLowerCase();
  if (l.length === t.length) return l;
  let o = ""; for (let i = 0; i < t.length; i++) { const c = t[i].toLowerCase(); o += c.length === 1 ? c : t[i]; }
  return o;
}
function scanTrie(T, trie, out) {
  if (!trie || !trie.size) return;
  for (let i = 0; i < T.length; i++) {
    if (i > 0 && isWord(T[i - 1])) continue;
    let n = trie, j = i, end = -1, id = null;
    while (j < T.length) { n = n.get(T[j]); if (!n) break; j++; const v = n.get("\0"); if (v !== undefined && !isWord(T[j])) { end = j; id = v; } }
    if (end > i) { out.push({ id, start: i, end }); i = end - 1; }
  }
}
/* Built glossary v2 (scripts/build_glossary.py): index.json has the rows (no highlight phrases; `hl` in a row is empty
   unless an older v1 index is served), phrases.json has {hl: {id: [phrase…]}}. Both are fetched together; search, get()
   and cats() work as soon as the index is parsed, loaded() and the "glossary" event wait for the phrase tries, which
   are built in idle slices of ≤ 8 ms so nothing blocks the main thread; a match()/annotate() call mid-build finishes the
   build on the spot. Neither file is cache-busted (they change only on deploy). */
const idle = fn => (W.requestIdleCallback ? W.requestIdleCallback(fn, { timeout: 400 }) : setTimeout(() => fn({ timeRemaining: () => 8 }), 0));
function load() {
  if (G.p) return G.p;
  G.loading = true;
  const ixP = fetchJSON("data/glossary/index.json").then(ix => {
    const rows = [], byId = new Map(), S = [];
    for (const t of (ix && ix.t) || []) {
      if (!Array.isArray(t) || !t[0]) continue;
      const r = { id: t[0], term: t[1] || t[0], cat: t[2] || "", level: t[3] || "b", short: t[4] || "", aliases: t[5] || [], hl: t[6] || [], abbr: t[7] || [] };
      rows.push(r); byId.set(r.id, r);
      const tn = norm(r.term), al = [...new Set(r.aliases.concat(r.abbr).map(norm).filter(Boolean))];
      S.push({ r, t: tn, tw: tn.split(" "), al, alw: al.map(a => a.split(" ")) });
    }
    Object.assign(G, { idx: ix, rows, byId, S, shards: (ix && ix.shards) || {} });
    return ix;
  });
  const phP = fetchJSON("data/glossary/phrases.json").then(j => (j && j.hl) || {}, () => null);   // v1 index: phrases are in the rows
  G.p = Promise.all([ixP, phP]).then(([ix, hl]) => {
    G.hl = hl || {};
    return new Promise(res => compileSlices(res));
  }).then(() => {
    const ix = G.idx;
    emit("glossary", ix);
    const d = G.deferred.splice(0); d.forEach(([el, o]) => { if (el.isConnected) annotate(el, o); });
    return ix;
  }, err => { G.p = null; G.loading = false; throw err; });
  return G.p;
}
const phrasesOf = r => (r.hl && r.hl.length) ? r.hl : (G.hl[r.id] || []);
function compileSlices(done) {
  const trieH = new Map(), trieA = new Map(), seenH = new Set(), seenA = new Set();
  const rows = G.rows; let i = 0;
  const insert = (root, k, id) => { let n = root; for (let c = 0; c < k.length; c++) { let nx = n.get(k[c]); if (!nx) { nx = new Map(); n.set(k[c], nx); } n = nx; } if (!n.has("\0")) n.set("\0", id); };
  const step = (budget) => {
    const t0 = performance.now();
    while (i < rows.length) {
      const r = rows[i++];
      for (const p of phrasesOf(r)) { const k = String(p).toLowerCase().trim(); if (k && !seenH.has(k)) { seenH.add(k); insert(trieH, k, r.id); } }
      for (const a of r.abbr || []) { const k = String(a).trim(); if (k && !seenA.has(k)) { seenA.add(k); insert(trieA, k, r.id); } }
      if (budget && (i & 31) === 0 && performance.now() - t0 > budget) return false;
    }
    G.trieH = trieH; G.trieA = trieA; G.compiled = true; G.finish = null;
    return true;
  };
  G.compiled = false;
  G.finish = () => { if (!G.compiled) step(0); };          // match()/annotate() called mid-build: finish now
  const tick = () => { if (G.compiled || step(8)) { done(); return; } idle(tick); };
  idle(tick);
}
function compile() { compileSlices(() => {}); G.finish && G.finish(); }   // synchronous fallback (tests, old callers)
function rawMatches(text) {
  const out = [];
  if (G.finish) G.finish();
  scanTrie(lowerSame(text), G.trieH, out);
  scanTrie(text, G.trieA, out);
  return out.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
}
function pick(cands, seen, once) {
  const res = []; let lastEnd = -1;
  // longest wins on overlap
  const byLen = cands.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const taken = [];
  for (const c of byLen) {
    if (once && seen.has(c.id)) continue;
    if (taken.some(t => c.start < t.end && t.start < c.end)) continue;
    taken.push(c); if (once) seen.add(c.id);
  }
  taken.sort((a, b) => a.start - b.start);
  for (const t of taken) { if (t.start >= lastEnd) { res.push(t); lastEnd = t.end; } }
  return res;
}
function match(text) {
  if (!G.idx || !text) return [];
  if (!G.compiled && !G.finish) return [];   // index in, phrases still on the wire
  // first occurrence of each term: choose by position, longest among overlaps
  const c = rawMatches(String(text)), seen = new Set(), res = [];
  let lastEnd = -1;
  for (let i = 0; i < c.length; i++) {
    const m = c[i];
    if (m.start < lastEnd || seen.has(m.id)) continue;
    // a longer overlapping candidate starting later? keep the longest of an overlap cluster
    let best = m;
    for (let j = i + 1; j < c.length && c[j].start < best.end; j++) if ((c[j].end - c[j].start) > (best.end - best.start) && !seen.has(c[j].id)) best = c[j];
    seen.add(best.id); res.push({ id: best.id, start: best.start, end: best.end }); lastEnd = best.end;
  }
  return res;
}
const SKIP = "input,textarea,select,option,code,pre,kbd,samp,script,style,noscript,button,svg,math,iframe,.gl-term,[data-term],[data-no-gloss],[contenteditable=''],[contenteditable='true'],.fs-menu,.gl-tip";
function annotate(el, o = {}) {
  if (!el) return [];
  if (!G.idx || (!G.compiled && !G.finish)) { G.deferred.push([el, o]); load().catch(() => {}); return []; }
  if (G.finish) G.finish();
  const max = o.max == null ? Infinity : o.max, once = o.once !== false;
  if (el.closest && el.closest(SKIP) && el.closest(SKIP) !== el) return [];
  const walker = D.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.nodeType === 1 ? (n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP)
                                       : (/[A-Za-z]/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  });
  const nodes = []; let n; while ((n = walker.nextNode())) nodes.push(n);
  const seen = new Set(), ids = [];
  for (const tn of nodes) {
    if (ids.length >= max) break;
    const text = tn.nodeValue;
    let ms = once ? match(text).filter(m => !seen.has(m.id)) : pick(rawMatches(text), seen, false);
    if (!ms.length) continue;
    const frag = D.createDocumentFragment(); let pos = 0;
    for (const m of ms) {
      if (ids.length >= max) break;
      if (m.start > pos) frag.appendChild(D.createTextNode(text.slice(pos, m.start)));
      frag.appendChild(h("span", { class: "gl-term", "data-term": m.id, tabindex: "0", role: "button", "aria-haspopup": "dialog", "aria-expanded": "false" }, text.slice(m.start, m.end)));
      pos = m.end; seen.add(m.id); if (!ids.includes(m.id)) ids.push(m.id);
    }
    if (pos === 0) continue;
    if (pos < text.length) frag.appendChild(D.createTextNode(text.slice(pos)));
    tn.parentNode.replaceChild(frag, tn);
  }
  return ids;
}
function osa(a, b, maxD) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > maxD) return maxD + 1;
  let p2 = null, p1 = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + cost);
      if (p2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);
      cur[j] = v; if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxD) return maxD + 1;
    p2 = p1; p1 = cur;
  }
  return p1[lb];
}
function wordPrefix(words, qw) {
  const used = new Set();
  for (const q of qw) {
    let ok = false;
    for (let i = 0; i < words.length; i++) if (!used.has(i) && words[i].startsWith(q)) { used.add(i); ok = true; break; }
    if (!ok) return false;
  }
  return true;
}
function score(s, q, qw) {
  if (s.t === q) return 1000;
  if (s.al.includes(q)) return 950;
  if (s.t.startsWith(q)) return 800;
  if (wordPrefix(s.tw, qw)) return 700;
  for (let i = 0; i < s.al.length; i++) if (s.al[i].startsWith(q) || wordPrefix(s.alw[i], qw)) return 600;
  if (s.t.includes(q)) return 500;
  for (const a of s.al) if (a.includes(q)) return 400;
  if (q.length >= 4) {
    const maxD = q.length >= 8 ? 2 : 1;
    let d = osa(q, s.t, maxD);
    if (d > maxD && s.t.length > q.length) d = Math.min(d, osa(q, s.t.slice(0, q.length), maxD) + 0.5);
    if (d > maxD && qw.length === 1) for (const w of s.tw) { if (w.length >= 4) d = Math.min(d, osa(q, w, maxD) + 0.25); if (d <= maxD) break; }
    if (d > maxD) for (const a of s.al) { d = Math.min(d, osa(q, a, maxD) + 0.25); if (d <= maxD) break; }
    if (d <= maxD) return 300 - d * 40;
  }
  return 0;
}
function search(q, o = {}) {
  const nq = norm(q);
  if (!G.idx || !nq) return [];
  const qw = nq.split(" "), limit = o.limit || 20, cat = o.cat || null, LV = { b: 0, i: 1, a: 2 };
  const hits = [];
  for (const s of G.S) {
    if (cat && s.r.cat !== cat) continue;
    const sc = score(s, nq, qw);
    if (sc) hits.push([sc, s]);
  }
  hits.sort((a, b) => b[0] - a[0] || a[1].t.length - b[1].t.length || (LV[a[1].r.level] || 0) - (LV[b[1].r.level] || 0) || (a[1].t < b[1].t ? -1 : 1));
  return hits.slice(0, limit).map(x => x[1].r);
}
function entry(id) {
  return load().then(() => {
    const r = G.byId.get(id);
    if (!r) throw new Error("unknown term " + id);
    // entries/<cat>.json, or the shard (<cat>-2.json …) whose sorted-id range holds this id (index.json "shards")
    const starts = G.shards[r.cat] || []; let n = 1;
    for (const s of starts) { if (id >= s) n++; else break; }
    const file = r.cat + (n > 1 ? "-" + n : "");
    const p = G.ent[file] || (G.ent[file] = fetchJSON("data/glossary/entries/" + encodeURIComponent(file) + ".json").catch(e => { delete G.ent[file]; throw e; }));
    return p.then(map => {
      const e = (map && map[id]) || {};
      const cats = (G.idx && G.idx.cats) || {};
      return Object.assign({}, r, { catName: (cats[r.cat] && cats[r.cat].name) || r.cat, levelName: LEVELS[r.level] || "",
        kid: e.kid || "", detail: e.detail || "", example: e.example || "", formula: e.formula || "", related: (e.related || []).filter(x => G.byId.has(x)) });
    });
  });
}
function termOfDay(date) {
  if (!G.idx) return null;
  const d = date instanceof Date ? date : (date ? new Date(date) : new Date());
  let key;
  try { key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
  catch (e) { key = new Date(d.getTime() + 19800000).toISOString().slice(0, 10); }
  const pool = G.rows.filter(r => (r.level === "b" || r.level === "i") && r.short).sort((a, b) => a.id < b.id ? -1 : 1);
  const list = pool.length ? pool : G.rows;
  if (!list.length) return null;
  let hsh = 2166136261;
  for (const ch of "finspire:" + key) { hsh ^= ch.charCodeAt(0); hsh = Math.imul(hsh, 16777619) >>> 0; }
  return list[hsh % list.length];
}
/* Term of the day without the index: scripts/build_glossary.py writes data/glossary/tod.json ({days: {"YYYY-MM-DD": row}}
   for yesterday, today and tomorrow IST, same pick as termOfDay). ~1 KB, so a card can paint before the 300 KB index. */
let todP = null;
function today() {
  if (!todP) todP = fetchJSON("data/glossary/tod.json", { bust: 3600000 }).then(j => {
    let key;
    try { key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
    catch (e) { key = new Date(Date.now() + 19800000).toISOString().slice(0, 10); }
    const r = j && j.days && j.days[key];
    if (!r || !r.id) throw new Error("tod-miss");
    return r;
  }).catch(() => load().then(() => { const r = termOfDay(); if (!r) throw new Error("no-terms");
    const cats = glossary.cats(); return Object.assign({ catName: (cats[r.cat] && cats[r.cat].name) || r.cat, kid: "" }, r); }));
  return todP;
}
const glossary = {
  LEVELS, load, search, entry, match, annotate, termOfDay, today,
  get: id => G.byId.get(id) || null,
  cats: () => (G.idx && G.idx.cats) || {},
  rows: () => G.rows,
  loaded: () => !!G.idx && (G.compiled || !!G.finish)   // index in and phrases ready to match (or finishable on demand)
};

/* ================================================================ Tooltip =========================================== */
let tipApi = null;
function initTip() {
  if (tipApi) return tipApi;
  const noHover = W.matchMedia ? W.matchMedia("(hover: none)") : { matches: false };
  const reduce = W.matchMedia ? W.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  let el = null, scrim = null, parts = null;
  let cur = null, curId = null, mode = null, open = false, openedAt = 0;
  let hoverT = 0, leaveT = 0, histT = 0, lastDown = 0, downTerm = null, lastPtr = "mouse", quietFocus = null;

  function build() {
    if (el) return;
    parts = {};
    parts.cat = h("span", { class: "gl-tip-cat" });
    parts.x = h("button", { class: "gl-tip-x", type: "button", "aria-label": "Close", onclick: () => hide(true) }, icon("x"));
    parts.term = h("span", { class: "gl-tip-term", id: "gl-tip-term" });
    parts.lvl = h("span", { class: "gl-lvl" });
    parts.def = h("p", { class: "gl-tip-def", id: "gl-tip-def" });
    parts.open = h("a", { class: "gl-tip-open", href: url(cfg.pages.dictionary) }, "Open in Dictionary", h("span", { "aria-hidden": "true" }, "→"));
    parts.save = h("button", { class: "gl-tip-save", type: "button", "aria-pressed": "false", onclick: onSave }, icon("star"), h("span", null, "Save"));
    parts.arrow = h("span", { class: "gl-tip-arrow", "aria-hidden": "true" });
    el = h("div", { class: "gl-tip", id: "gl-tip", role: "dialog", "aria-labelledby": "gl-tip-term", "aria-describedby": "gl-tip-def", tabindex: "-1" },
      h("div", { class: "gl-tip-in" },
        h("div", { class: "gl-tip-top" }, parts.cat, parts.x),
        h("div", { class: "gl-tip-head" }, parts.term, parts.lvl),
        parts.def,
        h("div", { class: "gl-tip-foot" }, parts.open, parts.save),
        parts.arrow));
    scrim = h("div", { class: "gl-scrim", hidden: true, onclick: () => hide(true) });
    // phone sheet: the grab handle drags; a pull of more than 60px closes it (no translate under reduced motion)
    const inner = el.firstChild; let dy0 = null, dy = 0;
    inner.addEventListener("touchstart", e => { if (mode !== "sheet" || e.touches.length !== 1) return; dy0 = e.touches[0].clientY; dy = 0; inner.style.transition = "none"; }, { passive: true });
    inner.addEventListener("touchmove", e => { if (dy0 == null) return; dy = Math.max(0, e.touches[0].clientY - dy0);
      if (!reduce.matches) inner.style.transform = dy ? "translateY(" + Math.round(dy) + "px)" : ""; }, { passive: true });
    const endDrag = () => { if (dy0 == null) return; const d = dy; dy0 = null; dy = 0;
      inner.style.transition = ""; inner.style.transform = "";
      if (d > 60) hide(true); };
    inner.addEventListener("touchend", endDrag); inner.addEventListener("touchcancel", endDrag);
    el.addEventListener("pointerenter", e => { if (e.pointerType !== "touch") clearTimeout(leaveT); });
    el.addEventListener("pointerleave", e => { if (e.pointerType !== "touch" && mode === "hover") scheduleHide(); });
    el.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); hide(true); } });
    parts.open.addEventListener("click", () => setTimeout(() => hide(false), 0));
    D.body.appendChild(scrim); D.body.appendChild(el);
  }
  function onSave() {
    if (!curId || !me()) return;
    const on = store.toggleSaved(curId);
    setSave(on);
    toast(on ? "Saved to your dictionary" : "Removed from saved words", { kind: on ? "ok" : "info", ms: 2200 });
  }
  function setSave(on) {
    parts.save.setAttribute("aria-pressed", String(!!on));
    parts.save.lastChild.textContent = on ? "Saved" : "Save";
    parts.save.setAttribute("aria-label", on ? "Saved. Remove from saved words" : "Save this word");
  }
  function fill(id) {
    const r = glossary.get(id);
    const cats = glossary.cats();
    parts.open.href = url(cfg.pages.dictionary + "#t=" + encodeURIComponent(id));
    if (r) {
      parts.cat.textContent = (cats[r.cat] && cats[r.cat].name) || "";
      parts.term.textContent = r.term;
      parts.lvl.className = "gl-lvl " + (LEVELS[r.level] ? r.level : "b");
      parts.lvl.textContent = LEVELS[r.level] || "";
      parts.lvl.hidden = !LEVELS[r.level];
      parts.def.textContent = r.short || "No short definition yet. Open the Dictionary for more.";
      parts.def.classList.remove("gl-tip-load");
    } else {
      const loading = !G.idx;
      parts.cat.textContent = loading ? "Dictionary" : "";
      parts.term.textContent = loading ? "Loading…" : "Not available right now";
      parts.lvl.hidden = true;
      parts.def.textContent = loading ? "" : "This word isn't in the dictionary yet.";
      parts.def.classList.toggle("gl-tip-load", loading);
    }
    parts.save.hidden = !(me() && r);
    if (me() && r) setSave(store.isSaved(id));
  }
  function anchorRect(t, px, py) {
    const rects = [...t.getClientRects()];
    if (!rects.length) return t.getBoundingClientRect();
    if (py != null && rects.length > 1) {
      const hit = rects.find(r => py >= r.top - 2 && py <= r.bottom + 2 && px >= r.left - 2 && px <= r.right + 2);
      if (hit) return hit;
    }
    return rects[0];
  }
  function place(t, px, py) {
    el.style.left = "0px"; el.style.top = "0px";
    const r = anchorRect(t, px, py);
    const vw = D.documentElement.clientWidth, vh = W.innerHeight;
    const tw = el.offsetWidth, th = el.offsetHeight, gap = 10, pad = 12;
    const hdr = D.querySelector(".hdr");
    const topLimit = Math.max(pad, hdr ? hdr.getBoundingClientRect().bottom + 6 : pad);
    let side = "top", top = r.top - gap - th;
    if (top < topLimit) {
      const below = r.bottom + gap;
      if (below + th <= vh - pad || (vh - r.bottom) > (r.top - topLimit)) { side = "bottom"; top = below; }
    }
    const cx = r.left + r.width / 2;
    const left = Math.round(Math.min(Math.max(pad, cx - tw / 2), Math.max(pad, vw - tw - pad)));
    const ax = Math.min(Math.max(cx - left, 18), tw - 18);
    el.dataset.side = side;
    el.style.left = left + "px"; el.style.top = Math.round(top) + "px";
    el.style.setProperty("--ax", ax + "px");
  }
  function show(target, o = {}) {
    build();
    let t = target, id;
    if (typeof target === "string") { id = target; t = o.anchor || null; }
    else id = t && t.getAttribute("data-term");
    if (!id) return;
    clearTimeout(hoverT); clearTimeout(leaveT);
    const sheet = o.mode === "sheet" || !t;
    if (cur && cur !== t) { cur.classList.remove("gl-on"); cur.removeAttribute("aria-describedby"); cur.setAttribute("aria-expanded", "false"); }
    const changed = id !== curId || !open;
    cur = t; curId = id; mode = sheet ? "sheet" : (o.mode || "hover");
    fill(id);
    if (!G.idx) load().then(() => { if (curId === id && open) { fill(id); if (!sheet && cur) place(cur); } }).catch(() => { if (curId === id && open) fill(id); });
    el.classList.toggle("gl-sheet", sheet);
    el.classList.toggle("gl-on-light", !!(t && t.closest(".light")));
    el.setAttribute("aria-modal", sheet ? "true" : "false");
    if (sheet) { el.style.left = ""; el.style.top = ""; el.removeAttribute("data-side"); scrim.hidden = false; requestAnimationFrame(() => scrim.classList.add("gl-show")); }
    else { scrim.classList.remove("gl-show"); scrim.hidden = true; place(t, o.x, o.y); }
    if (t) { t.classList.add("gl-on"); t.setAttribute("aria-describedby", "gl-tip-def"); termA11y(t); t.setAttribute("aria-expanded", "true"); }
    if (!open) { el.classList.remove("gl-show"); void el.offsetWidth; }
    el.classList.add("gl-show");
    open = true; openedAt = Date.now();
    if (sheet) { try { el.focus({ preventScroll: true }); } catch (e) {} }
    if (changed) {
      clearTimeout(histT);
      histT = setTimeout(() => { if (open && curId === id && glossary.get(id)) store.addHistory(id, "tooltip"); }, 1000);
    }
  }
  function hide(restore) {
    clearTimeout(hoverT); clearTimeout(leaveT); clearTimeout(histT);
    if (!open || !el) return;
    open = false;
    el.classList.remove("gl-show");
    if (scrim) { scrim.classList.remove("gl-show"); setTimeout(() => { if (!open) scrim.hidden = true; }, reduce.matches ? 0 : 220); }
    const t = cur;
    if (t) { t.classList.remove("gl-on"); t.removeAttribute("aria-describedby"); t.setAttribute("aria-expanded", "false"); }
    if (restore && t && t.isConnected && (el.contains(D.activeElement) || D.activeElement === D.body)) { quietFocus = t; try { t.focus({ preventScroll: true }); } catch (e) {} quietFocus = null; }
    else if (el.contains(D.activeElement)) D.activeElement.blur();
    cur = null; curId = null; mode = null;
  }
  function scheduleHide() { clearTimeout(leaveT); leaveT = setTimeout(() => hide(false), 180); }
  const termOf = n => (n && n.nodeType === 1 && n.closest) ? n.closest("[data-term]") : null;
  const inTip = n => !!(el && n && el.contains(n));
  /* every [data-term] is a button that opens a dialog (screen readers otherwise hear plain text): set once per element
     for what is on the page now and for whatever pages render later */
  function termA11y(t) {
    if (!t || t.tagName === "BUTTON" || t.tagName === "A" || t.hasAttribute("aria-haspopup")) return;
    if (!t.hasAttribute("role")) t.setAttribute("role", "button");
    t.setAttribute("aria-haspopup", "dialog");
    if (!t.hasAttribute("aria-expanded")) t.setAttribute("aria-expanded", "false");
    if (!t.hasAttribute("tabindex")) t.setAttribute("tabindex", "0");
  }
  const termA11yAll = rootEl => { if (rootEl.nodeType !== 1) return; if (rootEl.hasAttribute("data-term")) termA11y(rootEl); rootEl.querySelectorAll("[data-term]").forEach(termA11y); };
  termA11yAll(D.body || D.documentElement);
  if (W.MutationObserver) new MutationObserver(recs => { for (const r of recs) for (const n of r.addedNodes) termA11yAll(n); }).observe(D.documentElement, { childList: true, subtree: true });

  D.addEventListener("pointerdown", e => { lastPtr = e.pointerType || "mouse"; lastDown = Date.now(); downTerm = termOf(e.target); }, true);
  D.addEventListener("pointerover", e => {
    if (e.pointerType === "touch") return;
    const t = termOf(e.target);
    if (t && !inTip(t)) {
      clearTimeout(leaveT);
      if (t === cur && open) return;
      clearTimeout(hoverT);
      const x = e.clientX, y = e.clientY;
      hoverT = setTimeout(() => { if (mode !== "pin" || !open) show(t, { mode: "hover", x, y }); }, open ? 60 : 120);
    } else if (inTip(e.target)) clearTimeout(leaveT);
  });
  D.addEventListener("pointerout", e => {
    if (e.pointerType === "touch") return;
    const t = termOf(e.target), to = e.relatedTarget;
    if (t && to && t.contains(to)) return;
    if (t) { clearTimeout(hoverT); if (open && mode === "hover" && t === cur && !inTip(to)) scheduleHide(); }
  });
  D.addEventListener("click", e => {
    const t = termOf(e.target);
    if (t && !inTip(t)) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      if (t.parentElement && t.parentElement.closest("a[href],button,[role='link'],[role='button'],label,summary")) e.stopPropagation();
      const touch = lastPtr === "touch" || noHover.matches;
      if (open && cur === t && (mode === "pin" || mode === "sheet")) { hide(false); return; }
      show(t, { mode: touch ? "sheet" : "pin", x: e.clientX, y: e.clientY });
      return;
    }
    if (open && mode !== "sheet" && !inTip(e.target)) hide(false);
  }, true);
  D.addEventListener("focusin", e => {
    const t = termOf(e.target);
    if (t && !inTip(t)) {
      if (t === quietFocus) return;                      // focus handed back after Escape
      if (t === downTerm && Date.now() - lastDown < 1000) return;   // focus from a press: the click handler decides
      if (open && cur === t) return;
      show(t, { mode: "focus" });
    }
  });
  D.addEventListener("focusout", e => {
    if (!open || mode === "sheet") return;
    const to = e.relatedTarget;
    if (to && (inTip(to) || to === cur)) return;
    if (mode === "focus" || inTip(e.target)) setTimeout(() => { if (open && mode !== "sheet" && !inTip(D.activeElement) && D.activeElement !== cur) hide(false); }, 0);
  });
  D.addEventListener("keydown", e => {
    if (e.key === "Escape" && open) { hide(true); return; }
    const t = termOf(e.target);
    if (t && e.target === t && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      show(t, { mode: "pin" });
      requestAnimationFrame(() => { try { parts.open.focus(); } catch (er) {} });
    }
  });
  W.addEventListener("scroll", () => { if (open && mode !== "sheet") { if (Date.now() - openedAt > 250) hide(false); else if (cur) place(cur); } }, { passive: true, capture: true });
  W.addEventListener("resize", () => { if (open && mode !== "sheet") hide(false); }, { passive: true });
  on("auth", () => { if (open && curId) fill(curId); });
  D.addEventListener("visibilitychange", () => { if (D.hidden) hide(false); });

  tipApi = { show, hide: () => hide(false), isOpen: () => open, get el() { return el; } };
  return tipApi;
}

/* ================================================================ Account + sign-in dialog ========================== */
function initials(u) {
  const n = String(u.name || u.email || "?").trim().split(/\s+/).filter(Boolean);
  return ((n[0] || "?")[0] + (n.length > 1 ? n[n.length - 1][0] : "")).toUpperCase();
}
function avatar(u, big) {
  const a = h("span", { class: "fs-av" + (big ? " lg" : ""), "aria-hidden": "true" }, initials(u));
  const pic = safeUrl(u.picture);
  if (pic) {
    const img = h("img", { src: pic, alt: "", referrerpolicy: "no-referrer", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => img.remove());
    a.appendChild(img);
  }
  return a;
}
function mountAccount(el) {
  if (!el) return;
  el.classList.add("fs-acct");
  if (el._fsAcct) { el._fsAcct(); return; }
  let closeMenu = () => {};
  const render = () => {
    closeMenu();
    clear(el);
    // no account control at all until sign-in can actually work (see signinUsable)
    el.hidden = !feature("signin");
    if (el.hidden) return;
    if (!user) {
      el.appendChild(h("button", { class: "fs-acct-in", type: "button", "data-fs-signin": "",
        onclick: () => { if (!auth.enabled()) { signInDialog(); return; } signIn().catch(() => {}); } },
        icon("google"), h("span", null, "Sign in")));
      return;
    }
    const menuId = nextId("fs-menu");
    const btn = h("button", { class: "fs-acct-btn", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": menuId,
      "aria-label": "Account: " + (user.name || user.email) }, avatar(user), h("span", { class: "fs-acct-name" }, user.given || user.name), icon("chev"));
    const items = [
      h("a", { role: "menuitem", href: url(cfg.pages.dictionary + "#me") }, icon("book"), "My dictionary"),
      feature("library") ? h("a", { role: "menuitem", href: url(cfg.pages.library) }, icon("folder"), "Library") : null,
      h("hr", { role: "separator" }),
      h("button", { role: "menuitem", type: "button", class: "fs-out", onclick: () => { closeMenu(); signOut(); } }, icon("out"), "Sign out")
    ];
    const menu = h("div", { class: "fs-menu", id: menuId, role: "menu", hidden: true, "aria-label": "Account" },
      h("div", { class: "fs-menu-who" }, avatar(user, true), h("div", { class: "fs-menu-who-txt" }, h("b", null, user.name || user.given), h("span", null, user.email))),
      items);
    const focusables = () => items.filter(i => i.getAttribute("role") === "menuitem");
    const onDoc = e => { if (!e.target.closest || !e.target.closest(".fs-acct")) closeMenu(); };
    const onScroll = () => closeMenu();
    const onEsc = e => { if (e.key === "Escape") { e.preventDefault(); const back = menu.contains(D.activeElement) || D.activeElement === btn; closeMenu(); if (back) btn.focus(); } };
    const onKey = e => {
      const f = focusables(), i = f.indexOf(D.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); f[(i + 1) % f.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); f[(i - 1 + f.length) % f.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); f[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); f[f.length - 1].focus(); }
      else if (e.key === "Tab") closeMenu();
    };
    const openMenu = focusFirst => {
      menu.hidden = false; btn.setAttribute("aria-expanded", "true");
      if (W.innerWidth <= 720) {   // phones: full-width panel under the header, inside the 16px gutters
        const r = btn.getBoundingClientRect();
        Object.assign(menu.style, { position: "fixed", left: "16px", right: "16px", width: "auto", top: Math.round(r.bottom + 10) + "px" });
      } else menu.style.cssText = "";
      // outside tap on any input (pointerdown and, for browsers that only send touch events first, touchstart), scroll
      // and Escape all close it; listeners are attached only while it is open
      D.addEventListener("pointerdown", onDoc, true); D.addEventListener("touchstart", onDoc, { capture: true, passive: true });
      W.addEventListener("scroll", onScroll, { passive: true, capture: true });
      D.addEventListener("keydown", onEsc); menu.addEventListener("keydown", onKey);
      if (tipApi) tipApi.hide();
      if (focusFirst) focusables()[0].focus();
    };
    closeMenu = () => {
      if (menu.hidden) return;
      menu.hidden = true; btn.setAttribute("aria-expanded", "false");
      D.removeEventListener("pointerdown", onDoc, true); D.removeEventListener("touchstart", onDoc, { capture: true });
      W.removeEventListener("scroll", onScroll, { capture: true });
      D.removeEventListener("keydown", onEsc); menu.removeEventListener("keydown", onKey);
    };
    el._fsClose = () => closeMenu();
    btn.addEventListener("click", () => { if (menu.hidden) openMenu(false); else closeMenu(); });
    btn.addEventListener("keydown", e => { if ((e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") && menu.hidden) { e.preventDefault(); openMenu(true); } });
    menu.addEventListener("click", e => { if (e.target.closest("a")) closeMenu(); });
    el.append(btn, menu);
  };
  el._fsAcct = render;
  on("auth", render);
  render();
}
function signInDialog(reason) {
  if (!auth.enabled()) {
    return modal({
      title: "Sign-in isn't switched on yet",
      head: h("div", { class: "fs-si-mark" }, h("img", { src: url("assets/img/logo-light.png"), alt: "" })),
      body: [h("p", null, "Google sign-in for IIM Ranchi accounts is not switched on yet."),
             h("p", { class: "fs-si-note" }, "Markets, News and the Dictionary work without signing in.")],
      actions: [{ label: "OK", kind: "primary" }],
      className: "fs-si"
    });
  }
  const gbtn = h("button", { class: "fs-gbtn", type: "button", "data-autofocus": "" }, icon("google"), "Continue with Google");
  const m = modal({
    title: "Sign in to Finspire",
    head: h("div", { class: "fs-si-mark" }, h("img", { src: url("assets/img/logo-light.png"), alt: "" })),
    body: [
      h("p", null, reason || ("Use your IIM Ranchi Google account (@" + cfg.allowedDomain + ").")),
      h("ul", { class: "fs-si-list" },
        h("li", null, "Save words and keep your recent lookups"),
        h("li", null, "Open the club Library inside the site"),
        h("li", null, "Only @" + cfg.allowedDomain + " accounts can sign in")),
      h("p", { class: "fs-si-note" }, "Finspire sees your name, email and profile photo. Nothing is posted for you.")
    ],
    actions: [{ label: "Not now", kind: "ghost" }, { node: gbtn }],
    className: "fs-si"
  });
  gbtn.addEventListener("click", () => { m.close("signin"); signIn().catch(() => {}); });
  return m;
}
const ui = { toast, modal, mountAccount, signInDialog, lockScroll };   // lockScroll(on): nested page-scroll lock with scrollbar compensation

/* ================================================================ Sub-page header =================================== */
let hdrState = null;
function headerInit() {
  const hdr = D.querySelector("header[data-fs-header]") || D.querySelector("header.hdr");
  if (!hdr) return;
  if (hdrState && hdrState.hdr === hdr) { headerRefresh(); return; }
  hdrState = { hdr, io: null, bands: new Set() };
  // scrolled
  let ticking = false, sc = null;
  const upd = () => { ticking = false; const s = (W.scrollY || D.documentElement.scrollTop || 0) > 8; if (s !== sc) { sc = s; hdr.classList.toggle("scrolled", s); } };
  W.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(upd); } }, { passive: true });
  upd();
  // burger + mobile menu
  const burger = hdr.querySelector(".burger"), menu = hdr.querySelector(".mobile-menu");
  if (burger && menu) {
    if (!menu.id) menu.id = nextId("fs-mm");
    burger.setAttribute("aria-controls", menu.id);
    let isOpen = false;
    const set = openIt => {
      openIt = !!openIt;
      menu.hidden = !openIt;
      burger.setAttribute("aria-expanded", String(openIt));
      burger.setAttribute("aria-label", openIt ? "Close menu" : "Open menu");
      hdr.classList.toggle("menu-open", openIt);
      if (openIt !== isOpen) { isOpen = openIt; lockScroll(openIt); }   // the page must not scroll under the open menu
      if (openIt) { hdr.querySelectorAll(".fs-acct").forEach(a => { if (a._fsClose) a._fsClose(); }); if (tipApi) tipApi.hide(); }
    };
    set(false);
    burger.addEventListener("click", () => set(menu.hidden));
    menu.addEventListener("click", e => { if (e.target.closest("a")) set(false); });
    D.addEventListener("keydown", e => { if (e.key === "Escape" && !menu.hidden) { set(false); burger.focus(); } });
    D.addEventListener("pointerdown", e => { if (!menu.hidden && !hdr.contains(e.target)) set(false); }, true);
    D.addEventListener("visibilitychange", () => { if (D.hidden && !menu.hidden) set(false); });
    const mq = W.matchMedia("(min-width: 961px)");
    const onMq = () => { if (mq.matches) set(false); };
    if (mq.addEventListener) mq.addEventListener("change", onMq); else if (mq.addListener) mq.addListener(onMq);
    W.addEventListener("resize", () => { if (mq.matches && !menu.hidden) set(false); }, { passive: true });
  }
  // aria-current from the page path
  const normPath = p => decodeURI(p).replace(/\/index\.html?$/, "/");
  const here = normPath(location.pathname);
  D.querySelectorAll("header a[href], .fs-foot a[href]").forEach(a => {
    const raw = a.getAttribute("href");
    if (!raw || raw.startsWith("#") || /^[a-z]+:/i.test(raw) && !/^https?:/i.test(raw)) return;
    let u; try { u = new URL(raw, location.href); } catch (e) { return; }
    if (u.origin !== location.origin || u.hash) return;
    if (normPath(u.pathname) === here && !a.classList.contains("logo")) a.setAttribute("aria-current", "page");
  });
  // account + year
  hdr.querySelectorAll("[data-fs-account]").forEach(mountAccount);
  D.querySelectorAll("[data-fs-year]").forEach(e => { e.textContent = String(new Date().getFullYear()); });
  // light bands under the header → light header
  headerRefresh();
  let rz = 0;
  W.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(headerRefresh, 200); }, { passive: true });
}
function headerRefresh() {
  if (!hdrState) return;
  const { hdr } = hdrState;
  if (hdrState.io) hdrState.io.disconnect();
  hdrState.bands.clear();
  const bands = D.querySelectorAll("main .light, body > .light");
  if (!bands.length || !("IntersectionObserver" in W)) { hdr.classList.remove("light-mode"); return; }
  const y = Math.round(hdr.getBoundingClientRect().bottom / 2) || 36;
  hdrState.io = new IntersectionObserver(ents => {
    ents.forEach(en => { if (en.isIntersecting) hdrState.bands.add(en.target); else hdrState.bands.delete(en.target); });
    hdr.classList.toggle("light-mode", hdrState.bands.size > 0);
  }, { rootMargin: `-${y}px 0px -${Math.max(0, W.innerHeight - y - 1)}px 0px`, threshold: 0 });
  bands.forEach(b => hdrState.io.observe(b));
}
const header = { init: headerInit, refresh: headerRefresh };

/* ================================================================ export + boot ===================================== */
const Finspire = { cfg, root, url, feature, on, off, emit, fetchJSON, fmt, dom, ui, header, auth, store, glossary, tip: null };
Object.defineProperty(Finspire, "tip", { enumerable: true, get: () => tipApi || initTip() });
W.Finspire = Finspire;

/* Hide navigation to pages that are switched off (and any element marked data-feature="<name>"). */
function applyFeatures() {
  ["markets", "library", "dictionary"].forEach(name => {
    if (feature(name)) return;
    const dir = name + "/";
    D.querySelectorAll("a[href]").forEach(a => {
      const href = a.getAttribute("href") || "";
      if (href.includes("/" + dir) || href.startsWith(dir) || href.includes(cfg.pages[name])) a.hidden = true;
    });
  });
  D.querySelectorAll("[data-feature]").forEach(n => { if (!feature(n.dataset.feature)) n.hidden = true; });
}

/* Cross-document view transitions: when the browser skips one (a slow page, a second click mid-transition) it rejects
   the transition's promises; nobody needs them, so keep them out of the console. */
const quietVT = e => { const vt = e && e.viewTransition; if (vt) ["ready", "finished", "updateCallbackDone"].forEach(k => { try { if (vt[k]) vt[k].catch(() => {}); } catch (er) {} }); };
W.addEventListener("pageswap", quietVT);
W.addEventListener("pagereveal", quietVT);

function boot() {
  applyFeatures();
  initTip();
  if (D.querySelector("header[data-fs-header]")) headerInit();
  D.querySelectorAll("[data-fs-account]").forEach(el => { if (!el._fsAcct) mountAccount(el); });
}
if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", boot, { once: true }); else boot();
})();
