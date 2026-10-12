/* Finspire Dictionary page (site/dictionary/index.html). Uses window.Finspire only; defines no globals.
   Search (combobox over the term list) · topics · level · A–Z · chunked list · term of the day ·
   entry view (desktop: sticky reading panel; ≤960px: full-screen sheet) with deep links #t=<id> ·
   personal desk (#me: recent lookups, saved words, Revise) · Revise quiz with Leitner boxes in dict.srs.
   All feed and dictionary text is inserted as text nodes (Finspire.dom.h), never as HTML. */
(() => {
"use strict";
const F = window.Finspire;
if (!F) return;
const D = document, W = window;
const { h, clear, icon, ext } = F.dom;
const G = F.glossary, S = F.store;
const $ = id => D.getElementById(id);
const LEVELS = G.LEVELS || { b: "Beginner", i: "Intermediate", a: "Advanced" };
const CAT_ORDER = ["accounting", "ratios", "corp-fin", "valuation", "modeling", "equities", "trading", "india-mkts", "india-econ",
  "bonds", "rates", "central-banks", "macro", "fiscal", "fx-trade", "derivatives", "options", "commodities", "banking", "credit",
  "ib-deals", "pe-vc", "funds", "portfolio", "quant", "behavioral", "personal", "tax", "fintech", "crypto", "esg", "real-estate",
  "history", "jargon", "governance", "strategy", "cfa"];
const CHUNK = 60, CATS_COLLAPSED = 11, DAY = 864e5, BOX_DAYS = [1, 2, 4, 8, 16], QUIZ_N = 10;
const VIA = { search: "via search", browse: "via browse", tooltip: "via tooltip", news: "via news" };
const mqDesk = W.matchMedia("(min-width: 961px)");
const mqReduce = W.matchMedia("(prefers-reduced-motion: reduce)");
const num = n => F.fmt.num(n, 0);
const plural = (n, one, many) => num(n) + " " + (n === 1 ? one : (many || one + "s"));
const scrollOpts = () => (mqReduce.matches ? "auto" : "smooth");

/* ---------- small helpers ---------- */
function svg(paths, cls, sw) {
  return h("svg:svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": sw || "1.8",
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: cls || null },
    [].concat(paths).map(d => h("svg:path", { d })));
}
const IC = {
  link: () => svg(["M10 13.5a4.5 4.5 0 0 0 6.4.2l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2", "M14 10.5a4.5 4.5 0 0 0-6.4-.2l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"]),
  back: () => svg(["M19 12H5", "M11 6l-6 6 6 6"], null, "2"),
  out: () => svg(["M14 4h6v6", "M20 4l-8.5 8.5", "M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"]),
  blocks: () => svg(["M3.5 13.5h7.5V21H3.5z", "M13 13.5h7.5V21H13z", "M8.25 3.5h7.5V11h-7.5z"], null, "1.7"),
  revise: () => svg(["M4.5 12a7.5 7.5 0 0 1 13-5.1L19.5 9", "M19.5 4v5h-5", "M19.5 12a7.5 7.5 0 0 1-13 5.1L4.5 15", "M4.5 20v-5h5"]),
  search: () => svg(["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "m20 20-3.6-3.6"], null, "2")
};
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sortKey = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, "").trim();
function letterOf(term) { const c = sortKey(term).charAt(0).toUpperCase(); return c >= "A" && c <= "Z" ? c : "#"; }
function catName(id) { const c = G.cats()[id]; return (c && c.name) || id || ""; }
function lvlPill(level) { return LEVELS[level] ? h("span", { class: "gl-lvl " + level }, LEVELS[level]) : null; }
function isTyping(el) { return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); }
function arr(v) { return Array.isArray(v) ? v : []; }
function obj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }

/* ---------- state + elements ---------- */
const st = { q: "", cat: "", level: "", letter: "", rows: [], shown: 0, active: -1, open: null, ready: false, failed: false,
  sorted: [], catsOpen: false, news: undefined, newsP: null, token: 0, returnTo: null, meRecentAll: false, meSavedAll: false };
const el = {
  q: $("dcQ"), qx: D.querySelector(".dc-q-x"), lede: $("dcLede"), tod: $("dcTodBody"), todDate: $("dcTodDate"),
  cats: $("dcCats"), catsMore: $("dcCatsMore"), levels: $("dcLevels"), az: $("dcAz"), count: $("dcCount"), title: $("dcListTitle"),
  list: $("dcList"), empty: $("dcEmpty"), sentinel: $("dcSentinel"), side: $("dcSide"), entry: $("dcEntry"), desk: $("dcDesk"),
  me: $("me"), meSlot: $("dcMeSlot"), work: $("dcWork"), main: $("main")
};
if (!el.list || !el.q) return;

/* ================================================================ list: rows, filters, rendering ================== */
function computeRows() {
  if (!st.ready) return [];
  const q = st.q.trim();
  if (q) {
    let res = G.search(q, { limit: 400, cat: st.cat || undefined });
    if (st.level) res = res.filter(r => r.level === st.level);
    return res;
  }
  return st.sorted.filter(r => (!st.cat || r.cat === st.cat) && (!st.level || r.level === st.level) && (!st.letter || r._l === st.letter));
}
function optId(i) { return "dco-" + i; }
function rowEl(r, i) {
  const searching = !!st.q.trim();
  return h("li", { class: "dc-row" + (r.id === st.open ? " dc-on" : "") + (i === st.active ? " dc-act" : ""), role: "option",
      id: optId(i), "aria-selected": String(i === st.active), dataset: { i: String(i), id: r.id } },
    h("span", { class: "dc-row-top" },
      h("span", { class: "dc-row-term" }, r.term),
      searching && !st.cat ? h("span", { class: "dc-row-cat" }, catName(r.cat)) : null,
      lvlPill(r.level)),
    r.short ? h("span", { class: "dc-row-short" }, r.short) : null);
}
function appendChunk(upTo) {
  const end = Math.min(st.rows.length, Math.max(st.shown + CHUNK, upTo == null ? 0 : upTo + 1));
  if (end <= st.shown) return;
  const frag = D.createDocumentFragment();
  const grouped = !st.q.trim() && !st.letter;
  for (let i = st.shown; i < end; i++) {
    const r = st.rows[i];
    if (grouped && (i === 0 || st.rows[i - 1]._l !== r._l)) frag.appendChild(h("li", { class: "dc-lhead", role: "presentation", "aria-hidden": "true" }, r._l === "#" ? "0–9" : r._l));
    frag.appendChild(rowEl(r, i));
  }
  el.list.appendChild(frag);
  st.shown = end;
  el.sentinel.hidden = st.shown >= st.rows.length;
}
function renderList() {
  st.rows = computeRows();
  st.shown = 0;
  st.active = st.q.trim() && st.rows.length ? 0 : -1;
  clear(el.list);
  el.list.removeAttribute("aria-activedescendant");
  el.q.removeAttribute("aria-activedescendant");
  if (st.ready) appendChunk();
  if (st.active >= 0) { el.q.setAttribute("aria-activedescendant", optId(0)); el.list.setAttribute("aria-activedescendant", optId(0)); }
  el.q.setAttribute("aria-expanded", String(!!st.q.trim() && st.rows.length > 0));
  el.list.hidden = !st.rows.length;
  renderCount();
  renderEmpty();
  renderAz();
  el.main.classList.toggle("dc-searching", !!st.q.trim());
}
function renderCount() {
  if (!st.ready) { el.count.textContent = st.failed ? "" : "Loading the dictionary…"; return; }
  const n = st.rows.length, q = st.q.trim(), lv = st.level ? " · " + LEVELS[st.level] : "";
  el.title.textContent = q ? "Search results" : (st.cat ? catName(st.cat) : "All terms");
  if (q) el.count.textContent = (n ? plural(n, "result") : "No results") + " for “" + q + "”" + (st.cat ? " in " + catName(st.cat) : "") + lv;
  else el.count.textContent = plural(n, "term") + (st.letter ? " starting with " + (st.letter === "#" ? "a number" : st.letter) : "") + lv;
}
function closeMatches(q) {
  const seen = new Set(), out = [];
  const add = list => list.forEach(r => { if (!seen.has(r.id) && out.length < 6) { seen.add(r.id); out.push(r); } });
  if (st.cat || st.level) add(G.search(q, { limit: 6 }));
  const words = q.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
  if (words.length > 1) words.forEach(w => add(G.search(w, { limit: 3 })));
  for (let n = q.length - 1; n >= 3 && out.length < 3; n--) add(G.search(q.slice(0, n), { limit: 4 }));
  return out;
}
function renderEmpty() {
  clear(el.empty);
  if (!st.ready) {
    el.empty.hidden = !st.failed;
    if (st.failed) el.empty.append(h("b", null, "The dictionary is not available right now."),
      h("p", null, "Check your connection and try again."), h("button", { class: "btn btn-ghost sm", type: "button", onclick: boot }, "Try again"));
    return;
  }
  el.empty.hidden = st.rows.length > 0;
  if (st.rows.length) return;
  const q = st.q.trim();
  if (!q) {
    el.empty.append(h("b", null, "No terms here yet."), h("p", null, "Try another level or letter."),
      h("button", { class: "btn btn-ghost sm", type: "button", onclick: () => { st.level = ""; st.letter = ""; renderLevels(); renderList(); } }, "Show all levels"));
    return;
  }
  const sug = closeMatches(q);
  el.empty.append(h("b", null, "No terms match “" + q + "”" + (st.cat ? " in " + catName(st.cat) : "") + "."));
  if (sug.length) {
    el.empty.append(h("p", null, "Close matches:"),
      h("div", { class: "dc-sug" }, sug.map(r => h("button", { class: "chip", type: "button", onclick: e => { st.returnTo = { kind: "el", node: e.currentTarget }; openEntry(r.id, { via: "search", push: true }); } }, r.term))));
  } else el.empty.append(h("p", null, "Try a shorter word, or browse by topic."));
  const acts = h("div", { class: "dc-empty-acts" });
  if (st.cat || st.level) acts.append(h("button", { class: "btn btn-ghost sm", type: "button", onclick: () => { st.cat = ""; st.level = ""; renderCats(); renderLevels(); renderList(); } }, "Search all topics"));
  acts.append(h("button", { class: "btn btn-ghost sm", type: "button", onclick: () => { setQuery(""); el.q.focus(); } }, "Clear search"));
  el.empty.append(acts);
}

/* active option (shared by the search box and the list) */
function setActive(i, scroll) {
  if (!st.rows.length) return;
  i = Math.max(-1, Math.min(st.rows.length - 1, i));
  if (i >= st.shown) appendChunk(i);
  const prev = st.active >= 0 ? $(optId(st.active)) : null;
  if (prev) { prev.classList.remove("dc-act"); prev.setAttribute("aria-selected", "false"); }
  st.active = i;
  if (i < 0) { el.q.removeAttribute("aria-activedescendant"); el.list.removeAttribute("aria-activedescendant"); return; }
  const o = $(optId(i));
  if (!o) return;
  o.classList.add("dc-act"); o.setAttribute("aria-selected", "true");
  el.q.setAttribute("aria-activedescendant", o.id); el.list.setAttribute("aria-activedescendant", o.id);
  if (scroll !== false) {
    const hdr = D.querySelector(".hdr"), r = o.getBoundingClientRect();
    const top = (hdr ? hdr.getBoundingClientRect().bottom : 72) + 8;
    if (r.top < top || r.bottom > W.innerHeight - 8) o.scrollIntoView({ block: "nearest" });
  }
}
function openActive() {
  const i = st.active >= 0 ? st.active : 0;
  const r = st.rows[i];
  if (r) { st.returnTo = { kind: "row", id: r.id, from: D.activeElement === el.q ? "q" : "list" }; openEntry(r.id, { via: st.q.trim() ? "search" : "browse", push: true }); }
}
function setQuery(v) {
  el.q.value = v; st.q = v; if (v.trim()) st.letter = "";
  el.qx.hidden = !v;
  renderList();
}

/* ---------- topics, levels, A–Z ---------- */
function catList() {
  const cats = G.cats(), ids = Object.keys(cats).filter(k => cats[k] && cats[k].n > 0);
  return ids.sort((a, b) => { const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : 1); });
}
function renderCats() {
  if (!st.ready) return;
  const ids = catList(), mix = {};
  for (const r of st.sorted) { const m = mix[r.cat] || (mix[r.cat] = { b: 0, i: 0, a: 0 }); if (m[r.level] != null) m[r.level]++; }
  const card = (id, name, n, m, i) => {
    const on = st.cat === id;
    const total = m ? (m.b + m.i + m.a) || 1 : 1;
    return h("button", { class: "dc-cat" + (i > CATS_COLLAPSED ? " dc-x" : ""), type: "button", "aria-pressed": String(on), dataset: { cat: id },
        onclick: () => selectCat(on && id ? "" : id) },
      h("span", { class: "dc-cat-name" }, name),
      h("span", { class: "dc-cat-n" }, num(n)),
      m ? h("span", { class: "dc-mix", "aria-hidden": "true" },
        ["b", "i", "a"].map(k => m[k] ? h("i", { class: k, style: { flexGrow: String(m[k] / total) } }) : null)) : null);
  };
  clear(el.cats);
  const all = { b: 0, i: 0, a: 0 }; Object.values(mix).forEach(m => { all.b += m.b; all.i += m.i; all.a += m.a; });
  el.cats.append(card("", "All topics", st.sorted.length, all, 0));
  ids.forEach((id, i) => el.cats.append(card(id, catName(id), G.cats()[id].n, mix[id] || { b: 0, i: 0, a: 0 }, i + 1)));
  const extra = ids.length + 1 - (CATS_COLLAPSED + 1);
  el.catsMore.hidden = extra <= 0;
  el.cats.classList.toggle("dc-open", st.catsOpen);
  el.catsMore.textContent = st.catsOpen ? "Show fewer topics" : "Show all " + ids.length + " topics";
  el.catsMore.setAttribute("aria-expanded", String(st.catsOpen));
}
function selectCat(id) {
  st.cat = id; st.letter = "";
  renderCats(); renderList();
  const r = el.work.getBoundingClientRect();
  if (r.top > W.innerHeight * 0.6) el.work.scrollIntoView({ behavior: scrollOpts(), block: "start" });
  const b = el.cats.querySelector('.dc-cat[aria-pressed="true"]');
  if (b && !mqDesk.matches) b.scrollIntoView({ block: "nearest", inline: "center", behavior: scrollOpts() });
}
function renderLevels() {
  clear(el.levels);
  [["", "All levels"], ["b", "Beginner"], ["i", "Intermediate"], ["a", "Advanced"]].forEach(([k, label]) =>
    el.levels.append(h("button", { class: "dc-seg" + (k ? " " + k : ""), type: "button", "aria-pressed": String(st.level === k), dataset: { level: k },
      onclick: () => { st.level = k; renderLevels(); renderList(); } }, label)));
}
function renderAz() {
  if (!st.ready) return;
  const have = new Set();
  for (const r of st.sorted) if ((!st.cat || r.cat === st.cat) && (!st.level || r.level === st.level)) have.add(r._l);
  if (st.letter && !have.has(st.letter) && !st.q.trim()) { st.letter = ""; }
  clear(el.az);
  el.az.hidden = !!st.q.trim();
  const btn = (k, label, aria) => h("button", { class: "dc-l" + (k === "" ? " dc-l-all" : ""), type: "button", "aria-pressed": String(st.letter === k),
    disabled: k !== "" && !have.has(k), "aria-label": aria || null, dataset: { l: k },
    onclick: () => { st.letter = st.letter === k ? "" : k; renderList(); } }, label);
  el.az.append(btn("", "All", "All letters"));
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach(c => el.az.append(btn(c, c)));
  if (have.has("#")) el.az.append(btn("#", "0–9", "Numbers"));
}

/* ================================================================ term of the day ================================ */
function renderTod() {
  const r = G.termOfDay();
  clear(el.tod);
  try { el.todDate.textContent = F.fmt.date(Date.now(), { timeZone: "Asia/Kolkata" }); } catch (e) { el.todDate.textContent = ""; }
  if (!r) { el.tod.append(h("p", { class: "muted" }, st.failed ? "Not available right now." : "Updating…")); return; }
  el.tod.dataset.id = r.id;
  el.tod.append(
    h("h2", { class: "dc-tod-term" }, h("a", { href: "#t=" + encodeURIComponent(r.id), onclick: e => { e.preventDefault(); st.returnTo = { kind: "el", node: e.currentTarget }; openEntry(r.id, { via: "browse", push: true, reveal: true }); } }, r.term)),
    h("p", { class: "dc-tod-meta" }, lvlPill(r.level), h("span", null, catName(r.cat))),
    h("p", { class: "dc-tod-def" }, r.short || ""),
    h("a", { class: "btn btn-ghost sm dc-tod-go", href: "#t=" + encodeURIComponent(r.id), onclick: e => { e.preventDefault(); st.returnTo = { kind: "el", node: e.currentTarget }; openEntry(r.id, { via: "browse", push: true, reveal: true }); } },
      "Read the entry", icon("arrow")));
}

/* ================================================================ entry view ===================================== */
function loadNews() {
  if (st.newsP) return st.newsP;
  st.newsP = F.fetchJSON("data/live/news-terms.json", { bust: true }).then(j => { st.news = obj(j); return st.news; },
    () => { st.news = null; st.newsP = null; return null; });
  return st.newsP;
}
function numberize(text) {
  // wrap amounts, percentages and figures so examples read like a worksheet; text nodes only
  const frag = D.createDocumentFragment();
  const re = /[₹$€£¥]?\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|per cent|crore|lakh|million|billion|trillion|bn|mn|cr|bps|basis points|x)(?![A-Za-z]))?/g;
  let pos = 0, m;
  while ((m = re.exec(text))) {
    let s = m[0], start = m.index;
    const lead = s.match(/^\s+/); if (lead) { start += lead[0].length; s = s.slice(lead[0].length); }
    const prev = text.charAt(start - 1);
    if (/[A-Za-z]/.test(prev)) continue;                  // Q2, FY27, CO2 …
    s = s.replace(/,+$/, "");
    if (!/\d/.test(s)) continue;
    if (start > pos) frag.appendChild(D.createTextNode(text.slice(pos, start)));
    frag.appendChild(h("span", { class: "dc-n", "data-no-gloss": "" }, s));
    pos = start + s.length;
  }
  if (pos < text.length) frag.appendChild(D.createTextNode(text.slice(pos)));
  return frag;
}
function paras(text, numbers) {
  return String(text || "").split(/\n\s*\n+/).map(t => t.trim()).filter(Boolean).map(t => h("p", null, numbers ? numberize(t) : t));
}
function unwrapSelf(root, id) {
  root.querySelectorAll('.gl-term[data-term="' + CSS.escape(id) + '"]').forEach(s => s.replaceWith(D.createTextNode(s.textContent)));
}
function section(cls, title, ...kids) {
  const hid = "dcs-" + cls;
  return h("section", { class: "dc-s dc-s-" + cls, "aria-labelledby": hid }, h("h3", { class: "dc-s-h", id: hid }, title), ...kids);
}
function saveBtn(id) {
  const on = !!F.auth.user() && S.isSaved(id);
  return h("button", { class: "dc-ebtn dc-save", type: "button", "aria-pressed": String(on), "aria-label": on ? "Saved. Remove from saved words" : "Save this word",
    onclick: () => {
      if (!F.auth.user()) { signInFor("Sign in with your IIM Ranchi account to save words and revise them later."); return; }
      const now = S.toggleSaved(id);
      F.ui.toast(now ? "Saved to your dictionary" : "Removed from saved words", { kind: now ? "ok" : "info", ms: 2200 });
    } }, icon("star"), h("span", { class: "dc-ebtn-t" }, on ? "Saved" : "Save"));
}
function syncSave() {
  const b = el.entry.querySelector(".dc-save");
  if (!b || !st.open) return;
  const on = !!F.auth.user() && S.isSaved(st.open);
  b.setAttribute("aria-pressed", String(on));
  b.setAttribute("aria-label", on ? "Saved. Remove from saved words" : "Save this word");
  b.querySelector(".dc-ebtn-t").textContent = on ? "Saved" : "Save";
}
async function copyLink(id) {
  const u = location.href.split("#")[0] + "#t=" + encodeURIComponent(id);
  let ok = false;
  try { if (navigator.clipboard && W.isSecureContext) { await navigator.clipboard.writeText(u); ok = true; } } catch (e) {}
  if (!ok) {
    const ta = h("textarea", { class: "sr-only", readonly: true, "aria-hidden": "true" }); ta.value = u; D.body.appendChild(ta);
    try { ta.select(); ok = D.execCommand("copy"); } catch (e) {}
    ta.remove();
  }
  F.ui.toast(ok ? "Link copied" : "Couldn't copy. The link is in the address bar.", { kind: ok ? "ok" : "info", ms: 2200 });
}
function entryHead(r) {
  const bar = h("div", { class: "dc-ebar" },
    h("button", { class: "dc-back", type: "button", onclick: () => closeEntry() }, IC.back(), h("span", null, "Back")),
    h("span", { class: "dc-ebar-cat" }, catName(r.cat)),
    h("span", { class: "dc-ebar-acts" },
      saveBtn(r.id),
      h("button", { class: "dc-ebtn dc-ico", type: "button", "aria-label": "Copy link to this entry", title: "Copy link", onclick: () => copyLink(r.id) }, IC.link()),
      h("button", { class: "dc-ebtn dc-ico dc-close", type: "button", "aria-label": "Close entry", title: "Close", onclick: () => closeEntry({ all: true }) }, icon("x"))));
  const aka = [...new Set(arr(r.aliases).concat(arr(r.abbr)))].filter(a => a && a.toLowerCase() !== String(r.term).toLowerCase()).slice(0, 4);
  const head = h("header", { class: "dc-ehead" },
    h("p", { class: "eyebrow dc-ecat" }, catName(r.cat)),
    h("h2", { class: "dc-eterm", id: "dcTerm", tabindex: "-1" }, r.term),
    h("p", { class: "dc-emeta" }, lvlPill(r.level), aka.length ? h("span", { class: "dc-aka" }, "Also called ", aka.join(", ")) : null),
    h("p", { class: "dc-ecta" },
      h("button", { class: "btn btn-ghost sm dc-quizme", type: "button", onclick: () => startQuiz({ focus: r.id }) }, IC.revise(), "Quiz me on this")));
  return [bar, head];
}
// header + plain meaning come from the index straight away; the rest fills .dc-ebody when the category file arrives,
// so the focused heading is never replaced
function renderEntrySkeleton(r) {
  clear(el.entry);
  el.entry.append(...entryHead(r),
    section("plain", "Plain meaning", h("p", { class: "dc-plain" }, r.short || "No short meaning yet.")),
    h("div", { class: "dc-ebody", "aria-busy": "true" }, h("div", { class: "dc-eload", "aria-hidden": "true" },
      h("span", { class: "skel skel-block" }), h("span", { class: "skel skel-line w80" }), h("span", { class: "skel skel-line w60" }), h("span", { class: "skel skel-line w80" }))));
}
function renderEntry(e) {
  let body = el.entry.querySelector(".dc-ebody");
  if (!body) { renderEntrySkeleton(e); body = el.entry.querySelector(".dc-ebody"); }
  clear(body); body.removeAttribute("aria-busy");
  const out = { append: (...n) => body.append(...n) };
  if (e.kid) out.append(h("section", { class: "dc-s dc-kid", "aria-labelledby": "dcs-kid" },
    h("span", { class: "dc-kid-ic" }, IC.blocks()),
    h("div", null, h("h3", { class: "dc-s-h", id: "dcs-kid" }, "Like I’m three"), ...paras(e.kid))));
  let detail = null, example = null;
  if (e.detail) out.append(section("detail", "In detail", detail = h("div", { class: "dc-prose" }, paras(e.detail))));
  if (e.example) out.append(section("example", "Example", example = h("div", { class: "dc-example" }, paras(e.example, true))));
  if (e.formula) out.append(section("formula", "Formula", h("pre", { class: "dc-formula", tabindex: "0", "aria-label": "Formula" }, h("code", null, e.formula))));
  const rel = arr(e.related).map(id => G.get(id)).filter(Boolean);
  if (rel.length) out.append(section("related", "Related terms", h("div", { class: "dc-rel" }, rel.map(r =>
    h("button", { class: "chip dc-relchip", type: "button", dataset: { id: r.id }, onclick: () => openEntry(r.id, { via: "browse", push: true }) }, r.term, icon("arrow"))))));
  const news = h("div", { class: "dc-news", "aria-busy": "true" }, h("span", { class: "skel skel-line w80" }), h("span", { class: "skel skel-line w60" }));
  out.append(section("news", "In the news", news));
  out.append(h("p", { class: "dc-efoot" }, "Found a mistake or a term we should add? Tell a Finspire member."));
  [detail, example].forEach(n => { if (n) { G.annotate(n); unwrapSelf(n, e.id); } });
  const id = e.id;
  loadNews().then(map => { if (st.open === id) fillNews(news, map, id); });
}
function fillNews(box, map, id) {
  clear(box); box.removeAttribute("aria-busy");
  if (map == null) { box.append(h("p", { class: "dc-news-none" }, "Not available right now.")); return; }
  const items = arr(map[id]).filter(x => x && x.t && F.dom.safeUrl(x.u)).slice(0, 6);
  if (!items.length) { box.append(h("p", { class: "dc-news-none" }, "Not in the news this month.")); return; }
  box.append(h("ul", { class: "dc-news-list" }, items.map(x => h("li", null,
    ext(x.u, { class: "dc-news-a" },
      h("span", { class: "dc-news-t" }, x.t),
      h("span", { class: "dc-news-m" }, [x.src, x.ts ? F.fmt.ago(x.ts) : ""].filter(Boolean).join(" · ")),
      IC.out())))));
}
function renderMissing(id) {
  clear(el.entry);
  const guess = st.ready ? G.search(String(id).replace(/-/g, " "), { limit: 5 }) : [];
  el.entry.append(
    h("div", { class: "dc-ebar" },
      h("button", { class: "dc-back", type: "button", onclick: () => closeEntry() }, IC.back(), h("span", null, "Back")),
      h("span", { class: "dc-ebar-cat" }, "Dictionary"),
      h("span", { class: "dc-ebar-acts" }, h("button", { class: "dc-ebtn dc-ico dc-close", type: "button", "aria-label": "Close", onclick: () => closeEntry({ all: true }) }, icon("x")))),
    h("header", { class: "dc-ehead" }, h("h2", { class: "dc-eterm", id: "dcTerm", tabindex: "-1" }, st.ready ? "Term not found" : "Not available right now"),
      h("p", { class: "dc-plain" }, st.ready ? "This term isn’t in the dictionary yet." : "The dictionary could not be loaded. Try again in a moment.")),
    guess.length ? section("related", "Did you mean", h("div", { class: "dc-rel" }, guess.map(r =>
      h("button", { class: "chip dc-relchip", type: "button", onclick: () => openEntry(r.id, { via: "browse", push: false, replace: true }) }, r.term, icon("arrow"))))) : null);
}
function record(id, via) {
  const hst = S.get("dict.history", []);
  if (Array.isArray(hst) && hst[0] && hst[0].id === id) return;     // same word again: keep one row
  S.addHistory(id, via);
}
function markOpenRow() {
  el.list.querySelectorAll(".dc-row.dc-on").forEach(n => n.classList.remove("dc-on"));
  if (st.open) el.list.querySelectorAll('.dc-row[data-id="' + CSS.escape(st.open) + '"]').forEach(n => n.classList.add("dc-on"));
}
function sheetMode() { return !mqDesk.matches; }
function applyMode() {
  const open = !!st.open, sheet = open && sheetMode();
  D.documentElement.classList.toggle("dc-sheet", sheet);
  el.side.classList.toggle("dc-has-entry", open);
  if (sheet) { el.side.setAttribute("role", "dialog"); el.side.setAttribute("aria-modal", "true"); el.side.setAttribute("aria-labelledby", "dcTerm"); }
  else { el.side.removeAttribute("role"); el.side.removeAttribute("aria-modal"); el.side.removeAttribute("aria-labelledby"); }
  const host = mqDesk.matches ? el.desk : el.meSlot;
  if (el.me.parentNode !== host) host.appendChild(el.me);
}
function openEntry(id, o = {}) {
  if (!id) return;
  if (o.push || o.replace) {
    const hash = "#t=" + encodeURIComponent(id);
    if (location.hash !== hash) {
      if (o.replace) history.replaceState({ dc: 1, t: id }, "", hash);
      else history.pushState({ dc: 1, t: id, n: (history.state && history.state.dc ? (+history.state.n || 1) : 0) + 1 }, "", hash);
    }
  }
  st.open = id;
  const tok = ++st.token;
  el.entry.hidden = false;
  applyMode();
  markOpenRow();
  if (!st.ready) { if (st.failed) renderMissing(id); else renderEntrySkeletonPlain(); return; }
  const r = G.get(id);
  if (!r) { renderMissing(id); }
  else {
    renderEntrySkeleton(r);
    record(id, o.via || "browse");
    G.entry(id).then(e => { if (st.token === tok) renderEntry(e); }, () => {
      if (st.token !== tok) return;
      const box = el.entry.querySelector(".dc-ebody");
      if (box) box.replaceChildren(h("div", { class: "dc-err" }, h("p", null, "The full entry is not available right now."),
        h("button", { class: "btn btn-ghost sm", type: "button", onclick: () => openEntry(id, { via: "browse" }) }, "Try again")));
    });
    loadNews();
  }
  el.side.scrollTop = 0;
  if (o.reveal && !sheetMode()) {
    const wr = el.work.getBoundingClientRect();
    if (wr.top > 120 || wr.bottom < W.innerHeight * 0.5) el.work.scrollIntoView({ behavior: o.instant ? "auto" : scrollOpts(), block: "start" });
  }
  if (o.focus !== false) { const t = $("dcTerm"); if (t) { try { t.focus({ preventScroll: true }); } catch (e) {} } }
}
function renderEntrySkeletonPlain() {
  clear(el.entry);
  el.entry.append(h("div", { class: "dc-eload" }, h("span", { class: "skel skel-line w40" }), h("span", { class: "skel skel-block" }), h("span", { class: "skel skel-line w80" })));
}
function closeEntry(o = {}) {
  if (!st.open) return;
  if (!o.fromHistory) {
    // Back (phone bar) steps back one entry; Close goes all the way back to the list. popstate finishes the job.
    const hs = history.state, depth = hs && hs.dc ? (+hs.n || 1) : 0;
    if (depth) { if (o.all) st.closeAfterPop = true; history.go(o.all ? -depth : -1); return; }
    history.replaceState(null, "", location.pathname + location.search);
  }
  st.open = null; st.token++;
  el.entry.hidden = true; clear(el.entry);
  applyMode();
  markOpenRow();
  restoreFocus();
}
function restoreFocus() {
  const rt = st.returnTo; st.returnTo = null;
  let t = null;
  if (rt && rt.kind === "row") {
    if (rt.from === "q") t = el.q;
    else { const i = st.rows.findIndex(r => r.id === rt.id); if (i >= 0) { setActive(i, false); t = el.list; } }
  } else if (rt && rt.kind === "el" && rt.node && rt.node.isConnected) t = rt.node;
  if (!t) t = sheetMode() ? el.q : (mqDesk.matches ? el.me : el.q);
  try { t.focus({ preventScroll: true }); } catch (e) {}
}

/* ================================================================ routing (#t=<id>, #me) ========================= */
function parseHash() {
  const raw = location.hash.replace(/^#/, "");
  if (raw === "me") return { me: true };
  const m = /^t=([^&]+)/.exec(raw);
  if (m) { try { return { t: decodeURIComponent(m[1]) }; } catch (e) { return { t: m[1] }; } }
  return {};
}
function route(initial) {
  let r = parseHash();
  if (st.closeAfterPop) {               // Close stepped back past our own entries and landed on one opened by a plain #t= link
    st.closeAfterPop = false;
    if (r.t) { history.replaceState(null, "", location.pathname + location.search); r = {}; }
  }
  if (r.t) { if (r.t !== st.open) openEntry(r.t, { via: "browse", reveal: true, instant: initial }); return; }
  if (st.open) closeEntry({ fromHistory: true });
  if (r.me) showMe();
}
function showMe() {
  applyMode();
  const target = mqDesk.matches ? el.work : el.me;
  requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: scrollOpts(), block: "start" });
    try { el.me.focus({ preventScroll: true }); } catch (e) {}
  });
}

/* ================================================================ personal desk (#me) ============================ */
function srsMap() { return obj(S.get("dict.srs", {})); }
function dueIds() {
  const srs = srsMap(), saved = arr(S.get("dict.saved", [])), now = Date.now();
  const due = Object.keys(srs).filter(id => G.get(id) && srs[id] && +srs[id].due <= now);
  const fresh = saved.filter(id => G.get(id) && !srs[id]);
  return [...new Set(due.concat(fresh))];
}
function signInFor(reason) {
  if (F.auth.enabled()) F.ui.signInDialog(reason);
  else F.ui.signInDialog();
}
function termBtn(id, extra, cls) {
  const r = G.get(id);
  if (!r) return null;
  return h("button", { class: cls || "dc-me-row", type: "button", dataset: { id },
    onclick: e => { st.returnTo = { kind: "el", node: e.currentTarget }; openEntry(id, { via: "browse", push: true, reveal: true }); } },
    h("span", { class: "dc-me-term" }, r.term), extra || null);
}
let meQueued = false;
function queueMe() { if (meQueued) return; meQueued = true; requestAnimationFrame(() => { meQueued = false; renderMe(); }); }
function renderMe() {
  const u = F.auth.user();
  const hadFocus = el.me.contains(D.activeElement) ? (D.activeElement.dataset && D.activeElement.dataset.focusKey) : null;
  clear(el.me);
  el.me.classList.toggle("dc-me-out", !u);
  if (!u) {
    el.me.append(
      h("span", { class: "dc-me-ic" }, icon("star")),
      h("div", { class: "dc-me-txt" },
        h("h2", { class: "dc-h2", id: "dcMeTitle" }, "Your dictionary"),
        h("p", null, "Sign in with your IIM Ranchi account to keep your history, save words and revise.")),
      h("button", { class: "btn btn-ghost sm dc-me-in", type: "button", dataset: { focusKey: "signin" },
        onclick: () => { if (F.auth.enabled()) F.auth.signIn().catch(() => {}); else F.ui.signInDialog(); } }, icon("google"), "Sign in"));
    return;
  }
  if (!st.ready) { el.me.append(h("h2", { class: "dc-h2", id: "dcMeTitle" }, "Your dictionary"), h("p", { class: "muted" }, "Updating…")); return; }
  const srs = srsMap(), due = dueIds(), hist = arr(S.get("dict.history", [])).filter(x => x && G.get(x.id)), saved = arr(S.get("dict.saved", [])).filter(id => G.get(id));
  const boxes = [0, 0, 0, 0, 0];
  Object.keys(srs).forEach(id => { const b = Math.min(5, Math.max(1, +srs[id].box || 1)); if (G.get(id)) boxes[b - 1]++; });
  const tracked = boxes.reduce((a, b) => a + b, 0);
  const nDue = due.length;

  const rev = h("div", { class: "dc-card dc-rev" },
    h("div", { class: "dc-rev-top" },
      h("span", { class: "dc-rev-ic" }, IC.revise()),
      h("h3", { class: "dc-h3" }, "Revise"),
      tracked ? h("span", { class: "dc-card-n" }, num(tracked) + " in review") : null),
    h("p", { class: "dc-rev-txt" }, nDue ? "A ten-question round from your saved and recent words. Right answers come back later; misses come back tomorrow."
      : (tracked ? "Nothing is due right now. You can still practise." : "Save a few words or look some up, then test yourself here.")),
    tracked ? h("div", { class: "dc-boxes", role: "img", "aria-label": "Words by box: " + boxes.map((n, i) => "box " + (i + 1) + " " + n).join(", ") },
      boxes.map((n, i) => h("span", { class: "dc-box" + (n ? " on" : "") }, h("b", null, num(n)), h("small", null, BOX_DAYS[i] + "d")))) : null,
    h("button", { class: "btn btn-primary dc-rev-go", type: "button", dataset: { focusKey: "revise" }, onclick: () => startQuiz({}) },
      IC.revise(), nDue ? "Revise · " + plural(nDue, "word") + " due" : "Revise now"));

  const recentN = st.meRecentAll ? 40 : 6;
  const recent = h("div", { class: "dc-card dc-recent" },
    h("div", { class: "dc-card-h" }, h("h3", { class: "dc-h3" }, "Recent lookups"), hist.length ? h("span", { class: "dc-card-n" }, num(hist.length)) : null),
    hist.length ? h("ul", { class: "dc-me-list" }, hist.slice(0, recentN).map(x => h("li", null,
      termBtn(x.id, h("span", { class: "dc-me-via" }, x.via && x.via !== "browse" && VIA[x.via] ? h("span", { class: "dc-via v-" + x.via }, VIA[x.via]) : null, h("span", { class: "dc-ago" }, F.fmt.ago(x.at))))))) :
      h("p", { class: "dc-me-empty" }, "Words you open here, and terms you hover on the Markets page, show up here."),
    hist.length > 6 ? h("button", { class: "dc-more-btn", type: "button", dataset: { focusKey: "recentAll" }, onclick: () => { st.meRecentAll = !st.meRecentAll; renderMe(); } },
      st.meRecentAll ? "Show fewer" : "Show all " + num(Math.min(hist.length, 40))) : null);

  const savedN = st.meSavedAll ? 200 : 10;
  const sv = h("div", { class: "dc-card dc-saved" },
    h("div", { class: "dc-card-h" }, h("h3", { class: "dc-h3" }, "Saved words"), saved.length ? h("span", { class: "dc-card-n" }, num(saved.length)) : null),
    saved.length ? h("div", { class: "dc-chips" }, saved.slice(0, savedN).map(id => termBtn(id, null, "chip dc-savechip"))) :
      h("p", { class: "dc-me-empty" }, "Use the star on any entry to keep a word here."),
    saved.length > 10 ? h("button", { class: "dc-more-btn", type: "button", dataset: { focusKey: "savedAll" }, onclick: () => { st.meSavedAll = !st.meSavedAll; renderMe(); } },
      st.meSavedAll ? "Show fewer" : "Show all " + num(saved.length)) : null);

  el.me.append(
    h("div", { class: "dc-me-head" }, h("h2", { class: "dc-h2", id: "dcMeTitle" }, "Your dictionary"),
      h("p", { class: "muted small" }, u.guest ? "Saved in this browser" : "Signed in as " + (u.given || u.name || u.email))),
    h("div", { class: "dc-me-grid" }, rev, recent, sv));
  if (hadFocus) { const n = el.me.querySelector('[data-focus-key="' + hadFocus + '"]'); if (n) n.focus({ preventScroll: true }); }
}

/* ================================================================ Revise quiz ===================================== */
function quizIds(focus) {
  const srs = srsMap(), now = Date.now(), out = [];
  const saved = arr(S.get("dict.saved", [])), hist = arr(S.get("dict.history", [])).map(x => x && x.id).filter(Boolean);
  const add = id => { if (out.length < QUIZ_N && id && G.get(id) && !out.includes(id)) out.push(id); };
  add(focus);
  Object.keys(srs).filter(id => srs[id] && +srs[id].due <= now).sort((a, b) => srs[a].due - srs[b].due).forEach(add);
  saved.filter(id => !srs[id]).forEach(add);
  hist.filter(id => !srs[id]).forEach(add);
  [...new Set(saved.concat(hist))].filter(id => srs[id]).sort((a, b) => srs[a].due - srs[b].due).forEach(add);
  shuffle(G.rows().filter(r => r.level === "b" && !srs[r.id] && r.short)).forEach(r => add(r.id));
  shuffle(G.rows().filter(r => r.short)).forEach(r => add(r.id));
  const first = focus && out[0] === focus ? out.shift() : null;
  shuffle(out);
  if (first) out.unshift(first);
  return out;
}
function masker(r) {
  const names = [r.term, String(r.term).replace(/\s*\([^)]*\)\s*/g, " ").trim(), ...(String(r.term).match(/\(([^)]+)\)/g) || []).map(s => s.slice(1, -1))]
    .concat(arr(r.aliases), arr(r.abbr)).filter(s => s && s.length > 1);
  const uniq = [...new Set(names)].sort((a, b) => b.length - a.length);
  if (!uniq.length) return t => t;
  const re = new RegExp("(^|[^A-Za-z0-9])(" + uniq.map(reEsc).join("|") + ")(?![A-Za-z0-9])", "gi");
  return t => String(t || "").replace(re, (m, pre) => pre + "____");
}
function distractors(r, want, test) {
  const pool = G.rows().filter(x => x.id !== r.id && x.short && x.short !== r.short && x.term.toLowerCase() !== r.term.toLowerCase());
  const same = shuffle(pool.filter(x => x.cat === r.cat));
  const out = [];
  const take = list => { for (const x of list) { if (out.length >= want) break; if (!out.includes(x) && (!test || test(x, out))) out.push(x); } };
  take(same.filter(x => x.level === r.level)); take(same);
  if (out.length < want) take(shuffle(pool.filter(x => x.level === r.level))), take(shuffle(pool.slice()));
  return out;
}
async function buildQuiz(ids) {
  const ents = await Promise.all(ids.map(id => G.entry(id).catch(() => G.get(id))));
  const kinds = shuffle(["meaning", "term", "kid"]);
  let k = 0;
  return ents.filter(Boolean).map(e => {
    const can = kinds.filter(t => t !== "kid" || e.kid);
    let type = can[k++ % can.length];
    if (!can.includes(type)) type = can[0];
    const ds = distractors(e, 3);
    const opts = shuffle([e].concat(ds));
    const mask = masker(e);
    let prompt, label, options;
    if (type === "term") {             // show the term, pick its meaning
      label = "What does this term mean?";
      prompt = e.term;
      options = opts.map(o => ({ id: o.id, text: masker(o)(o.short) }));
    } else if (type === "kid") {
      label = "Like I’m three: which term is this?";
      prompt = mask(e.kid);
      options = opts.map(o => ({ id: o.id, text: o.term }));
    } else {
      label = "Which term means this?";
      prompt = mask(e.short);
      options = opts.map(o => ({ id: o.id, text: o.term }));
    }
    return { id: e.id, term: e.term, type, label, prompt, options };
  });
}
function grade(id, ok) {
  S.update("dict.srs", m => {
    const srs = Object.assign({}, obj(m));
    const r = obj(srs[id]);
    const box = ok ? Math.min(5, Math.max(1, +r.box || 1) + 1) : 1;      // new words start in box 1
    srs[id] = { box, due: Date.now() + BOX_DAYS[box - 1] * DAY, seen: (+r.seen || 0) + 1, right: (+r.right || 0) + (ok ? 1 : 0) };
    return srs;
  }, {});
}
function startQuiz(o = {}) {
  if (!F.auth.user()) { signInFor("Sign in with your IIM Ranchi account to revise words and keep your progress."); return; }
  if (!st.ready) { F.ui.toast("The dictionary is still loading."); return; }
  const body = h("div", { class: "dc-qz" });
  const m = F.ui.modal({ title: "Revise", body, size: "md", className: "dc-qz-modal", initialFocus: ".dc-qz" });
  body.setAttribute("tabindex", "-1");
  runQuiz(m, body, o.focus);
}
async function runQuiz(m, body, focus) {
  clear(body);
  body.append(h("div", { class: "dc-qz-load" }, h("span", { class: "skel skel-line w40" }), h("span", { class: "skel skel-block" }), h("span", { class: "skel skel-line w80" }), h("span", { class: "skel skel-line w80" })));
  let qs;
  try { qs = await buildQuiz(quizIds(focus)); } catch (e) { qs = null; }
  if (!body.isConnected) return;
  if (!qs || !qs.length) { clear(body); body.append(h("p", null, "Revise is not available right now. Please try again in a moment.")); return; }
  const res = [];
  let i = 0, keyH = null;
  const off = () => { if (keyH) body.removeEventListener("keydown", keyH); keyH = null; };
  m.closed.then(off);
  const show = () => {
    off();
    const q = qs[i];
    clear(body);
    const fb = h("div", { class: "dc-qz-fb", "aria-live": "polite" });
    const next = h("button", { class: "btn btn-primary dc-qz-next", type: "button", hidden: true, onclick: () => { i++; if (i < qs.length) show(); else end(); } },
      i === qs.length - 1 ? "See results" : "Next question", icon("arrow"));
    let answered = false;
    const buttons = q.options.map((op, k) => h("button", { class: "dc-opt" + (q.type === "term" ? " dc-opt-long" : ""), type: "button", dataset: { id: op.id },
      onclick: () => pick(k) }, h("span", { class: "dc-opt-k", "aria-hidden": "true" }, "ABCD"[k]), h("span", { class: "dc-opt-t" }, op.text)));
    const pick = k => {
      if (answered) return; answered = true;
      const op = q.options[k], ok = op.id === q.id;
      res.push({ id: q.id, ok });
      grade(q.id, ok);
      buttons.forEach((b, j) => {
        b.disabled = true;
        if (q.options[j].id === q.id) { b.classList.add("ok"); b.append(h("span", { class: "dc-opt-mark" }, icon("check"))); }
        else if (j === k) b.classList.add("no");
      });
      fb.append(h("p", { class: "dc-qz-res " + (ok ? "ok" : "no") }, ok ? "Correct." : q.type === "term" ? "Not quite. The right meaning is marked in green." : "Not quite. The answer is " + q.term + "."),
        h("button", { class: "dc-qz-read", type: "button", onclick: () => { m.close(); openEntry(q.id, { via: "browse", push: true, reveal: true }); } }, "Read the entry for " + q.term, icon("arrow")));
      next.hidden = false;
      try { next.focus({ preventScroll: true }); } catch (e) {}
    };
    const promptEl = q.type === "kid"
      ? h("div", { class: "dc-qz-prompt dc-qz-kid" }, h("span", { class: "dc-kid-ic" }, IC.blocks()), h("p", null, q.prompt))
      : h("p", { class: "dc-qz-prompt" + (q.type === "term" ? " dc-qz-term" : "") }, q.prompt);
    body.append(
      h("div", { class: "dc-qz-prog" }, h("span", null, "Question " + (i + 1) + " of " + qs.length), h("span", { class: "dc-qz-score" }, res.filter(x => x.ok).length + " right")),
      h("div", { class: "dc-qz-bar", "aria-hidden": "true" }, h("i", { style: { width: ((i) / qs.length * 100) + "%" } })),
      h("p", { class: "dc-qz-label", id: "dcQzLabel" }, q.label),
      promptEl,
      h("div", { class: "dc-qz-opts", role: "group", "aria-labelledby": "dcQzLabel" }, buttons),
      fb, h("div", { class: "dc-qz-acts" }, next));
    keyH = e => {
      if (answered || e.altKey || e.ctrlKey || e.metaKey) return;
      const k = "1234".indexOf(e.key) >= 0 ? "1234".indexOf(e.key) : "abcd".indexOf(e.key.toLowerCase());
      if (k >= 0 && k < buttons.length && e.key.length === 1) { e.preventDefault(); pick(k); }
    };
    body.addEventListener("keydown", keyH);
    try { (buttons[0] || body).focus({ preventScroll: true }); } catch (e) {}
    body.scrollTop = 0; m.card.scrollTop = 0;
  };
  const end = () => {
    off();
    clear(body);
    const right = res.filter(x => x.ok).length, n = res.length;
    const miss = res.filter(x => !x.ok).map(x => x.id);
    const msg = right === n ? "Perfect round. These words move up a box." : right >= n * 0.7 ? "Good round. Misses come back tomorrow." :
      right >= n * 0.4 ? "Getting there. Misses come back tomorrow." : "Keep going. These words come back tomorrow.";
    const again = h("button", { class: "btn btn-primary", type: "button", onclick: () => runQuiz(m, body) }, IC.revise(), "Revise again");
    body.append(
      h("div", { class: "dc-qz-end" },
        h("p", { class: "eyebrow" }, "Round complete"),
        h("p", { class: "dc-qz-big" }, h("b", null, String(right)), h("span", null, " / " + n)),
        h("p", { class: "dc-qz-msg" }, msg)),
      miss.length ? h("div", { class: "dc-qz-review" }, h("h3", { class: "dc-s-h" }, "Words to review"),
        h("div", { class: "dc-chips" }, miss.map(id => h("button", { class: "chip", type: "button", onclick: () => { m.close(); openEntry(id, { via: "browse", push: true, reveal: true }); } }, (G.get(id) || {}).term || id)))) : null,
      h("div", { class: "dc-qz-acts dc-qz-endacts" }, again, h("button", { class: "btn btn-ghost", type: "button", onclick: () => m.close() }, "Done")));
    try { again.focus({ preventScroll: true }); } catch (e) {}
  };
  show();
}

/* ================================================================ events ========================================= */
let qRaf = 0;
el.q.addEventListener("input", () => {
  st.q = el.q.value; el.qx.hidden = !el.q.value;
  if (st.q.trim()) st.letter = "";
  if (!qRaf) qRaf = requestAnimationFrame(() => { qRaf = 0; renderList(); });
});
el.q.addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { e.preventDefault(); setActive(st.active + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setActive(st.active - 1); }
  else if (e.key === "Enter") { e.preventDefault(); if (qRaf) { cancelAnimationFrame(qRaf); qRaf = 0; renderList(); } if (st.rows.length && (st.q.trim() || st.active >= 0)) openActive(); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (el.q.value) setQuery(""); else el.q.blur(); }
});
el.qx.addEventListener("click", () => { setQuery(""); el.q.focus(); });
el.list.addEventListener("click", e => {
  const o = e.target.closest(".dc-row");
  if (!o) return;
  const i = +o.dataset.i;
  setActive(i, false);
  st.returnTo = { kind: "row", id: o.dataset.id, from: "list" };
  openEntry(o.dataset.id, { via: st.q.trim() ? "search" : "browse", push: true });
});
el.list.addEventListener("keydown", e => {
  const k = e.key;
  if (k === "ArrowDown") { e.preventDefault(); setActive(Math.max(0, st.active + 1)); }
  else if (k === "ArrowUp") { e.preventDefault(); if (st.active <= 0 && st.q.trim()) { el.q.focus(); } else setActive(Math.max(0, st.active - 1)); }
  else if (k === "Home") { e.preventDefault(); setActive(0); }
  else if (k === "End") { e.preventDefault(); setActive(st.rows.length - 1); }
  else if (k === "PageDown") { e.preventDefault(); setActive(st.active + 10); }
  else if (k === "PageUp") { e.preventDefault(); setActive(Math.max(0, st.active - 10)); }
  else if (k === "Enter" || k === " ") { e.preventDefault(); if (st.active < 0) setActive(0); openActive(); }
});
el.list.addEventListener("focus", () => { if (st.active < 0 && st.rows.length) setActive(0); });
let pfT = 0;
el.list.addEventListener("pointerover", e => {      // warm the category file before the click
  const o = e.target.closest && e.target.closest(".dc-row");
  if (!o || e.pointerType === "touch") return;
  clearTimeout(pfT); pfT = setTimeout(() => { G.entry(o.dataset.id).catch(() => {}); }, 120);
});
el.catsMore.addEventListener("click", () => { st.catsOpen = !st.catsOpen; renderCats(); });

if ("IntersectionObserver" in W) {
  new IntersectionObserver(ents => { if (ents.some(x => x.isIntersecting) && st.shown < st.rows.length) appendChunk(); }, { rootMargin: "900px 0px" }).observe(el.sentinel);
}
D.addEventListener("keydown", e => {
  if (e.defaultPrevented) return;
  if (e.key === "/" && !isTyping(D.activeElement) && !D.querySelector(".fs-modal") && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (st.open && sheetMode()) closeEntry();
    el.q.focus({ preventScroll: true });
    el.q.select();
    const r = el.q.getBoundingClientRect();
    if (r.top < 80 || r.bottom > W.innerHeight) el.q.scrollIntoView({ block: "center", behavior: scrollOpts() });
  } else if (e.key === "Escape" && st.open && !D.querySelector(".fs-modal") && !(F.tip && F.tip.isOpen && F.tip.isOpen())) {
    if (D.activeElement === el.q) return;
    if (el.side.contains(D.activeElement) || sheetMode() || D.activeElement === D.body) { e.preventDefault(); closeEntry(); }
  } else if (e.key === "Tab" && st.open && sheetMode()) {            // keep focus inside the full-screen sheet
    const f = [...el.side.querySelectorAll('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(n => n.offsetWidth || n.offsetHeight);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!el.side.contains(D.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && D.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && D.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
W.addEventListener("popstate", () => route(false));
W.addEventListener("hashchange", () => route(false));
const onMq = () => { applyMode(); };
if (mqDesk.addEventListener) mqDesk.addEventListener("change", onMq); else if (mqDesk.addListener) mqDesk.addListener(onMq);
F.on("store", key => {
  if (key === "*" || /^dict\./.test(key)) { queueMe(); syncSave(); }
});
F.on("auth", () => { queueMe(); syncSave(); });

/* ================================================================ boot =========================================== */
function boot() {
  st.failed = false;
  renderLevels();
  renderCount(); renderEmpty();
  el.list.hidden = false;
  clear(el.list);
  for (let i = 0; i < 8; i++) el.list.append(h("li", { class: "dc-row dc-skel", "aria-hidden": "true" }, h("span", { class: "skel skel-line w40" }), h("span", { class: "skel skel-line w80" })));
  renderMe();
  G.load().then(() => {
    const rows = G.rows();
    rows.forEach(r => { r._l = letterOf(r.term); r._k = sortKey(r.term); });
    st.sorted = rows.slice().sort((a, b) => a._k < b._k ? -1 : a._k > b._k ? 1 : 0);
    st.ready = true;
    if (el.lede && rows.length) el.lede.textContent = "Plain meanings for " + num(rows.length) + " finance terms, with everyday analogies, worked examples and the headlines they appear in.";
    renderTod(); renderCats(); renderList(); renderMe();
    route(true);
  }, () => {
    st.failed = true;
    clear(el.list); el.list.hidden = true;
    renderCount(); renderEmpty(); renderTod();
    clear(el.cats); el.cats.append(h("p", { class: "muted" }, "Not available right now."));
    if (parseHash().t) route(true);
  });
}
applyMode();
el.qx.append(icon("x"));
const mqPhone = W.matchMedia("(max-width: 720px)");
const setPh = () => { el.q.placeholder = mqPhone.matches ? "Search a term, e.g. EBITDA" : "Search a term, e.g. repo rate or EBITDA"; };
setPh(); if (mqPhone.addEventListener) mqPhone.addEventListener("change", setPh);
if (el.q.value) { st.q = el.q.value; el.qx.hidden = false; }
boot();
})();
