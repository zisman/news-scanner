"use strict";
/* News scanner front end. Data: data.json (written by scan.py). Lean map: leans.js. */

const LEANS = window.SOURCE_LEANS || {};
const LEAN_ORDER = ["L", "C", "R"];
const LEAN_HE = { L: "שמאל", C: "מרכז", R: "ימין" };
const LEAN_FROM = { L: "מהשמאל", C: "מהמרכז", R: "מהימין" };
const POLITICS = "פוליטיקה";
const FREQS = [["3plus", "כשמדווחים 3+ מקורות"], ["hourly", "כל שעה"], ["morning", "תקציר בוקר"]];
const LAYOUTS = [["front", "עמוד ראשון"], ["compact", "קומפקטי"], ["spectrum", "ספקטרום"]];

const store = {
  get(k, d) { try { const v = localStorage.getItem("ns." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("ns." + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
};

const S = {
  saved: store.get("saved", []),          // [{l, title, at}]
  follow: store.get("follow", {}),        // {"cat|sub": {alert:true}}  sub "*" = whole category
  freq: store.get("freq", "3plus"),
  excluded: store.get("excluded", []),    // source names
  layout: store.get("layout", "front"),
  onboarded: store.get("onboarded", false),
  prevVisit: store.get("lastVisit", 0)
};
store.set("lastVisit", Date.now());

let DATA = null, ARTICLES = [], CLUSTERS = [], BY_LINK = new Map();
let loading = false, loadError = false, onbStep = 0, feedLimit = 40, lastFeedHash = "#";
const navStack = [];

/* ---------- helpers ---------- */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}
const icon = (name, fill) => h("i", { class: (fill ? "ph-fill" : "ph-duotone") + " ph-" + name, "aria-hidden": "true" });
const save = (k) => store.set(k, S[k]);
function thumb(src, site, cls) {
  const plate = () => h("div", { class: (cls || "thumb") + " plate", "aria-hidden": "true" }, h("span", { dir: "auto" }, site || ""));
  if (!src) return plate();
  return h("img", { class: cls || "thumb", src, alt: "", loading: "lazy", referrerpolicy: "no-referrer",
    onerror: (e) => e.target.replaceWith(plate()) });
}

function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "עכשיו";
  if (m < 60) return "לפני " + m + " דק׳";
  const hr = Math.round(m / 60);
  if (hr < 24) return "לפני " + hr + " שע׳";
  return new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
}
function hhmm(iso) {
  const d = new Date(iso), t = d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? t : d.getDate() + "." + (d.getMonth() + 1) + " " + t;
}
const isToday = (iso) => Date.now() - Date.parse(iso) < 24 * 3600e3;
const plural = (n, one, many) => n === 1 ? one : n + " " + many;
const sourcesLabel = (n) => plural(n, "מקור אחד", "מקורות");
const storiesLabel = (n) => plural(n, "סיפור אחד", "סיפורים");

function hashOf(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? "#" + s : "#";
}
function route() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { v: p.get("v") || "feed", c: p.get("c") || "", s: p.get("s") || "", l: p.get("l") || "", q: p.get("q") || "" };
}
const storyHref = (cl) => hashOf({ v: "story", l: cl.lead.link });
const articleHref = (a) => hashOf({ v: "article", l: a.link });

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ---------- data ---------- */
const STOP = new Set(("של על את עם לא כי גם אחרי בין זה זו זאת היא הוא הם הן או אם כל יותר כך עוד רק מה מי איך למה אבל יש אין היום אחד אחת " +
  "the a an of to in on for and or with at by from is are was were be as after over into new says said will his her its their vs not").split(" "));
const PREFIX = "הובלמשכ";
function toks(t) {
  const out = new Set();
  for (let w of t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)) {
    if (w.length < 2 || STOP.has(w)) continue;
    if (/^[א-ת]/.test(w) && w.length > 3 && PREFIX.includes(w[0])) w = w.slice(1);
    if (w.length > 1 && !STOP.has(w)) out.add(w);
  }
  return out;
}

function build() {
  const ex = new Set(S.excluded);
  const byLink = new Map();
  for (const i of DATA.items || []) {
    if (ex.has(i.site)) continue;
    const key = i.url || i.link;
    let a = byLink.get(key);
    if (!a) {
      a = { link: key, site: i.site, title: i.title, summary: i.summary || "", image: i.image || "", published: i.published,
        cats: new Set(), subs: new Set(), keywords: new Set() };
      byLink.set(key, a);
    }
    a.cats.add(i.category); a.subs.add(i.category + "|" + i.subcategory);
    (i.keywords || []).forEach((k) => a.keywords.add(k));
    if (!a.image && i.image) a.image = i.image;
    if (!a.summary && i.summary) a.summary = i.summary;
  }
  ARTICLES = [...byLink.values()].sort((x, y) => (y.published > x.published ? 1 : -1));

  const idx = new Map(), cls = [];
  for (const a of ARTICLES) {
    a.tok = toks(a.title);
    let best = -1, bestScore = 0;
    if (a.tok.size >= 2) {
      const cand = new Map();
      for (const t of a.tok) { const s = idx.get(t); if (s) for (const ci of s) cand.set(ci, (cand.get(ci) || 0) + 1); }
      for (const [ci, n] of cand) {
        if (n < 2) continue;
        const cl = cls[ci];
        if (Math.abs(Date.parse(cl.oldest) - Date.parse(a.published)) > 36 * 3600e3) continue;
        if (![...a.cats].some((c) => cl.cats.has(c))) continue;
        for (const m of cl.items.slice(0, 6)) {
          let sh = 0;
          for (const t of a.tok) if (m.tok.has(t)) sh++;
          const sc = sh / Math.min(a.tok.size, m.tok.size || 1);
          if (((sh >= 2 && sc >= 0.5) || (sh >= 3 && sc >= 0.4)) && sc > bestScore) { bestScore = sc; best = ci; }
        }
      }
    }
    if (best < 0) { best = cls.length; cls.push({ items: [], cats: new Set(), subs: new Set(), oldest: a.published }); }
    const cl = cls[best];
    cl.items.push(a);
    a.cats.forEach((x) => cl.cats.add(x)); a.subs.forEach((x) => cl.subs.add(x));
    if (a.published < cl.oldest) cl.oldest = a.published;
    for (const t of a.tok) { let s = idx.get(t); if (!s) { s = new Set(); idx.set(t, s); } s.add(best); }
  }

  BY_LINK = new Map();
  CLUSTERS = cls.map((cl) => {
    const desc = cl.items.slice().sort((x, y) => (y.published > x.published ? 1 : -1));
    const asc = desc.slice().reverse();
    const lead = desc.find((i) => i.image && i.summary) || desc.find((i) => i.image) || desc.find((i) => i.summary) || desc[0];
    const sites = [...new Set(asc.map((i) => i.site))];
    const lean = { L: 0, C: 0, R: 0, other: 0 };
    sites.forEach((s) => { const k = LEANS[s]; if (k) lean[k]++; else lean.other++; });
    const c = { items: desc, first: asc[0], latest: desc[0].published, lead, title: lead.title,
      summary: lead.summary || (desc.find((i) => i.summary) || {}).summary || "", image: lead.image || (desc.find((i) => i.image) || {}).image || "",
      sites, lean, cats: cl.cats, subs: cl.subs, pol: cl.cats.has(POLITICS),
      keywords: new Set(desc.flatMap((i) => [...i.keywords])) };
    desc.forEach((i) => BY_LINK.set(i.link, c));
    return c;
  }).sort((x, y) => (y.latest > x.latest ? 1 : -1));
}

async function load() {
  if (loading) return;
  loading = true; renderRail();
  try {
    const r = await fetch("data.json?t=" + Date.now(), { cache: "no-store" });
    DATA = await r.json(); loadError = false;
    build();
  } catch (e) { loadError = true; }
  loading = false;
  render();
}

/* ---------- shared pieces ---------- */
function taxonomy() { return (DATA && DATA.taxonomy) || []; }
function crumbFor(cl, preferCat) {
  let sub = [...cl.subs].find((x) => preferCat && x.startsWith(preferCat + "|")) || [...cl.subs][0] || "";
  const [c, s] = sub.split("|");
  return s ? c + " › " + s : c || "";
}
function leanBar(lean, large) {
  const total = LEAN_ORDER.reduce((n, k) => n + lean[k], 0);
  const bar = h("div", { class: "bar" + (large ? " lg" : ""), role: "img",
    "aria-label": LEAN_ORDER.map((k) => LEAN_HE[k] + " " + lean[k]).join(", ") });
  if (!total) return bar;
  for (const k of LEAN_ORDER) {
    if (!lean[k]) continue;
    const share = lean[k] / total;
    bar.append(h("div", { class: "seg " + k, style: "flex-grow:" + lean[k] }, share >= 0.3 ? LEAN_HE[k] + " " + lean[k] : String(lean[k])));
  }
  return bar;
}
function blindspot(lean) {
  const total = LEAN_ORDER.reduce((n, k) => n + lean[k], 0);
  if (total < 2) return "";
  const miss = LEAN_ORDER.filter((k) => !lean[k]);
  if (!miss.length) return "";
  return "אין סיקור " + miss.map((k) => LEAN_FROM[k]).join(" ו");
}
function siteNames(cl, n) {
  const shown = cl.sites.slice(0, n).join(", ");
  return cl.sites.length > n ? shown + " + עוד " + (cl.sites.length - n) : shown;
}
function backBtn() {
  return h("button", { class: "icon-btn", "aria-label": "חזרה", onclick: goBack }, icon("arrow-right"));
}
function goBack() {
  if (navStack.length > 1) history.back();
  else location.hash = lastFeedHash;
}
function isSaved(link) { return S.saved.some((x) => x.l === link); }
function toggleSave(cl) {
  if (isSaved(cl.lead.link)) S.saved = S.saved.filter((x) => !cl.items.some((i) => i.link === x.l));
  else { S.saved.unshift({ l: cl.lead.link, title: cl.title, at: Date.now() }); toast("נשמר"); }
  save("saved"); render();
}
async function share(title) {
  const url = location.href;
  try {
    if (navigator.share) await navigator.share({ title, url });
    else { await navigator.clipboard.writeText(url); toast("הקישור הועתק"); }
  } catch (e) { /* cancelled */ }
}
function storyRow(cl, opts = {}) {
  return h("a", { class: "story src-row with-thumb", href: storyHref(cl) },
    h("div", { class: "grow" },
      h("div", { class: "kicker" }, crumbFor(cl, opts.cat)),
      h("h3", { class: "row-head", dir: "auto" }, cl.title),
      h("div", { class: "meta" }, sourcesLabel(cl.sites.length) + " · " + ago(cl.latest), opts.isNew ? h("span", { class: "tag-2" }, " · חדש") : null)),
    thumb(cl.image, cl.lead.site));
}

/* ---------- feed ---------- */
function renderRail() {
  const rail = document.querySelector(".rail");
  if (!rail) return;
  const btn = document.querySelector(".refresh i");
  if (btn) btn.classList.toggle("spin", loading);
  const nSources = DATA ? new Set((DATA.feeds || []).map((f) => f.site)).size : 0;
  rail.replaceChildren(
    h("span", null, new Date().toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", year: "numeric" })),
    h("span", { "aria-live": "polite" }, loading ? "סורק " + (nSources || "") + " מקורות…" : loadError ? "הטעינה נכשלה" : DATA ? "נסרק " + ago(DATA.updated) : ""));
}
function masthead() {
  return h("header", { class: "mast" },
    h("div", { class: "mast-row" },
      h("h1", { class: "masthead" }, "סורק חדשות"),
      h("button", { class: "icon-btn refresh", "aria-label": "רענון", onclick: load }, icon("arrows-clockwise")),
      h("a", { class: "icon-btn", href: "#v=settings", "aria-label": "הגדרות" }, icon("sliders-horizontal"))),
    h("div", { class: "rail" }));
}
function feedView(r) {
  const tax = taxonomy();
  const cat = tax.find((t) => t.name === r.c) || tax[0];
  const app = [masthead()];
  if (!cat) { app.push(h("p", { class: "empty" }, loadError ? "לא הצלחתי לטעון את הנתונים. נסה לרענן." : "טוען…")); return app; }
  const subs = cat.subcategories.map((x) => x.name);
  const sub = subs.includes(r.s) ? r.s : "";
  lastFeedHash = hashOf({ c: cat.name, s: sub });

  app.push(h("nav", { class: "cat-tabs", role: "tablist", "aria-label": "קטגוריות" },
    tax.map((t) => h("a", { class: "cat-tab", role: "tab", href: hashOf({ c: t.name }), "aria-selected": String(t.name === cat.name) }, t.name))));
  if (subs.length) {
    app.push(h("div", { class: "chips scroll sub-chips", role: "group", "aria-label": "נושאים" },
      ["", ...subs].map((s) => h("a", { class: "chip", href: hashOf({ c: cat.name, s }), "aria-pressed": String(s === sub) }, s || "הכל"))));
  }
  const list = CLUSTERS.filter((cl) => (sub ? cl.subs.has(cat.name + "|" + sub) : cl.cats.has(cat.name)));
  const fkey = cat.name + "|" + (sub || "*");
  const followed = !!S.follow[fkey];
  app.push(h("div", { class: "crumb-row" },
    h("span", { class: "meta" }, cat.name + (sub ? " › " + sub : "") + " · " + storiesLabel(list.length)),
    subs.length ? h("button", { class: "text-btn", "aria-pressed": String(followed), onclick: () => {
      if (followed) delete S.follow[fkey]; else { S.follow[fkey] = { alert: true }; toast("נוסף למעקב"); }
      save("follow"); render();
    } }, icon("bell-simple", followed), " ", followed ? "במעקב" : "עקוב") : null));

  if (!subs.length) { app.push(h("p", { class: "empty" }, "עוד לא הוגדרו נושאים בקטגוריה הזו.")); return app; }
  if (!list.length) { app.push(h("p", { class: "empty" }, "אין כרגע סיפורים בנושא הזה.")); return app; }

  const feed = h("section", { class: "feed" });
  const shown = list.slice(0, feedLimit);
  if (S.layout === "compact") feed.append(...shown.map(compactItem));
  else if (S.layout === "spectrum") feed.append(...shown.map(spectrumItem));
  else {
    const top = shown.slice(0, 12);
    const lead = top.reduce((b, c) => (c.sites.length > b.sites.length ? c : b), top[0]);
    feed.append(leadItem(lead));
    const rest = shown.filter((c) => c !== lead);
    feed.append(h("ol", { class: "list" }, rest.map((cl, i) => h("li", null,
      h("span", { class: "num", "aria-hidden": "true" }, String(i + 1)),
      h("a", { class: "story", href: storyHref(cl) },
        h("h3", { dir: "auto" }, cl.title),
        h("div", { class: "meta-line" }, h("span", { class: "tag" }, sourcesLabel(cl.sites.length)), h("span", { class: "meta" }, ago(cl.latest)))),
      thumb(cl.image, cl.lead.site)))));
  }
  app.push(feed);
  if (list.length > feedLimit) app.push(h("button", { class: "block-btn", onclick: () => { feedLimit += 40; render(); } }, "עוד סיפורים"));
  return app;
}
function leadItem(cl) {
  return h("a", { class: "story lead", href: storyHref(cl) },
    thumb(cl.image, cl.lead.site, "lead-img"),
    h("h2", { dir: "auto" }, cl.title),
    cl.summary ? h("p", { dir: "auto" }, cl.summary) : null,
    h("div", { class: "meta-line" },
      h("span", { class: "tag" }, sourcesLabel(cl.sites.length)),
      h("span", { class: "meta" }, siteNames(cl, 2) + " · " + ago(cl.latest))));
}
function compactItem(cl) {
  return h("a", { class: "story src-row with-thumb", href: storyHref(cl) },
    h("div", { class: "grow" },
      h("div", { class: "meta" }, ago(cl.latest) + " · ראשון: " + cl.first.site + " | " + sourcesLabel(cl.sites.length)),
      h("h3", { class: "row-head", dir: "auto" }, cl.title),
      h("div", { class: "ticks", "aria-hidden": "true" }, cl.sites.map((s) => h("span", { class: "tick" + (cl.pol && LEANS[s] ? " " + LEANS[s] : "") })))),
    thumb(cl.image, cl.lead.site));
}
function spectrumItem(cl) {
  const blind = cl.pol ? blindspot(cl.lean) : "";
  return h("a", { class: "story src-row", href: storyHref(cl) },
    h("div", { class: "with-thumb" }, h("h3", { class: "row-head grow", dir: "auto" }, cl.title), thumb(cl.image, cl.lead.site)),
    cl.pol ? leanBar(cl.lean) : null,
    h("div", { class: "meta-line" },
      blind ? h("span", { class: "tag-2" }, blind + " · ") : null,
      h("span", { class: "meta" }, sourcesLabel(cl.sites.length) + " · " + ago(cl.latest))));
}

/* ---------- story ---------- */
function storyView(r) {
  const cl = BY_LINK.get(r.l);
  if (!cl) return [h("div", { class: "screen-head" }, backBtn()), h("p", { class: "empty" }, DATA ? "הסיפור הזה כבר לא מופיע בנתונים." : "טוען…")];
  const saved = isSaved(cl.lead.link) || cl.items.some((i) => isSaved(i.link));
  const out = [
    h("div", { class: "screen-head" }, backBtn(), h("span", { class: "spacer" }),
      h("button", { class: "icon-btn" + (saved ? " on" : ""), "aria-label": saved ? "הסר משמורים" : "שמור", "aria-pressed": String(saved), onclick: () => toggleSave(cl) }, icon("bookmark-simple", saved)),
      h("button", { class: "icon-btn", "aria-label": "שיתוף", onclick: () => share(cl.title) }, icon("share-network"))),
    h("div", { class: "kicker" }, crumbFor(cl)),
    h("h1", { class: "story-h", dir: "auto" }, cl.title),
    h("div", { class: "meta" }, "סוכם מ־" + sourcesLabel(cl.sites.length) + " · עודכן " + hhmm(cl.latest)),
    thumb(cl.image, cl.lead.site, "hero"),
    cl.summary ? h("p", { class: "reader-body", dir: "auto" }, cl.summary) : null
  ];
  const blind = cl.pol ? blindspot(cl.lean) : "";
  out.push(h("section", { class: "section" },
    h("h2", { class: "section-h" }, "סיקור"),
    cl.pol ? leanBar(cl.lean, true) : h("div", { class: "meta" }, sourcesLabel(cl.sites.length)),
    h("p", { class: "meta", style: "margin-block-start:var(--space-2)" }, "דווח לראשונה ע״י " + cl.first.site + " בשעה " + hhmm(cl.first.published)),
    blind ? h("p", { class: "tag-2" }, blind) : null));

  const groups = cl.pol ? [...LEAN_ORDER, "other"] : ["all"];
  const sec = h("section", { class: "section" }, h("h2", { class: "section-h" }, "כותרות בהשוואה"));
  for (const g of groups) {
    const rows = cl.items.filter((i) => g === "all" || (g === "other" ? !LEANS[i.site] : LEANS[i.site] === g));
    if (g === "other" && !rows.length) continue;
    const label = g === "all" ? "כל המקורות" : g === "other" ? "ללא סיווג" : LEAN_HE[g];
    sec.append(h("div", { class: "group" },
      h("div", { class: "group-h" }, h("span", { class: "swatch " + g, "aria-hidden": "true" }), label, h("span", { class: "meta" }, String(rows.length))),
      rows.length ? rows.map(articleRow) : h("p", { class: "empty" }, "אין סיקור עדיין")));
  }
  out.push(sec);
  return out;
}
function articleRow(a) {
  return h("a", { class: "src-row with-thumb", href: articleHref(a) },
    h("div", { class: "grow" },
      h("div", { class: "src-meta" }, h("b", { dir: "auto" }, a.site), h("span", { class: "meta" }, hhmm(a.published))),
      h("div", { class: "row-h", dir: "auto" }, a.title)),
    thumb(a.image, a.site));
}

/* ---------- article reader ---------- */
function articleView(r) {
  const cl = BY_LINK.get(r.l);
  const a = cl && cl.items.find((i) => i.link === r.l);
  if (!a) return [h("div", { class: "screen-head" }, backBtn()), h("p", { class: "empty" }, DATA ? "הכתבה הזו כבר לא מופיעה בנתונים." : "טוען…")];
  const others = [];
  for (const i of cl.items) if (i.site !== a.site && !others.some((o) => o.site === i.site)) others.push(i);
  const lean = LEANS[a.site];
  return [
    h("div", { class: "screen-head" }, backBtn(), h("span", { class: "spacer" }),
      h("button", { class: "icon-btn", "aria-label": "שיתוף", onclick: () => share(a.title) }, icon("share-network"))),
    h("div", { class: "src-meta", style: "display:flex;gap:var(--space-2);align-items:baseline;margin-block-start:var(--space-2)" },
      h("b", { dir: "auto" }, a.site), h("span", { class: "lean-tag" }, lean ? LEAN_HE[lean] : "ללא סיווג")),
    h("h1", { class: "story-h", dir: "auto" }, a.title),
    h("div", { class: "meta" }, "פורסם " + hhmm(a.published) + " · " + ago(a.published)),
    thumb(a.image, a.site, "hero"),
    h("p", { class: "reader-body", dir: a.summary ? "auto" : null }, a.summary || "לכתבה הזו אין תקציר זמין. הטקסט המלא נמצא באתר המקור."),
    h("div", { class: "section" },
      h("a", { class: "block-btn primary", href: a.link, target: "_blank", rel: "noopener noreferrer" }, "לקריאה המלאה ב־" + a.site + " ↗")),
    others.length ? h("section", { class: "section" },
      h("h2", { class: "section-h" }, "זוויות נוספות"),
      others.slice(0, 3).map(articleRow),
      h("div", { style: "margin-block-start:var(--space-4)" },
        h("a", { class: "block-btn", href: storyHref(cl) }, "השווה את כל " + cl.sites.length + " המקורות"))) : null
  ];
}

/* ---------- search ---------- */
function searchView(r) {
  const input = h("input", { class: "input", type: "search", value: r.q, placeholder: "שם, נושא או מקור", "aria-label": "חיפוש" });
  const results = h("div", { class: "section" });
  const fill = (q) => {
    q = q.trim();
    if (!q) {
      const counts = new Map();
      ARTICLES.filter((a) => isToday(a.published)).forEach((a) => a.keywords.forEach((k) => counts.set(k, (counts.get(k) || 0) + 1)));
      const top = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 14).map((x) => x[0]);
      results.replaceChildren(h("h2", { class: "section-h" }, "חם עכשיו"),
        h("div", { class: "chips" }, top.map((k) => h("button", { class: "chip", onclick: () => { input.value = k; update(); } }, k))));
      return;
    }
    const words = q.toLowerCase().split(/\s+/);
    const hits = CLUSTERS.filter((cl) => {
      const hay = (cl.title + " " + cl.summary + " " + [...cl.keywords].join(" ") + " " + cl.sites.join(" ") + " " + cl.items.map((i) => i.title).join(" ")).toLowerCase();
      return words.every((w) => hay.includes(w));
    }).slice(0, 50);
    results.replaceChildren(h("div", { class: "meta" }, hits.length ? storiesLabel(hits.length) : "לא נמצאו סיפורים"), hits.map((cl) => storyRow(cl)));
  };
  let t;
  const update = () => {
    clearTimeout(t);
    t = setTimeout(() => { history.replaceState(null, "", hashOf({ v: "search", q: input.value.trim() })); fill(input.value); }, 200);
  };
  input.addEventListener("input", update);
  fill(r.q);
  setTimeout(() => { if (!r.q) input.focus(); }, 0);
  return [h("h1", { class: "screen-title" }, "חיפוש"), input, results];
}

/* ---------- saved ---------- */
function savedView() {
  const out = [h("h1", { class: "screen-title" }, "שמורים")];
  if (!S.saved.length) { out.push(h("p", { class: "empty" }, "עוד לא שמרת סיפורים. סימן השמירה בכל סיפור יוסיף אותו לכאן.")); return out; }
  out.push(...S.saved.map((x) => {
    const cl = BY_LINK.get(x.l);
    if (cl) return storyRow(cl);
    return h("a", { class: "src-row", href: x.l, target: "_blank", rel: "noopener noreferrer" },
      h("div", { class: "kicker" }, "כבר לא בפיד"), h("h3", { class: "row-head", dir: "auto" }, x.title), h("div", { class: "meta" }, "נשמר " + ago(new Date(x.at).toISOString())));
  }));
  return out;
}

/* ---------- following ---------- */
function followLabel(key) { const [c, s] = key.split("|"); return s === "*" ? c + " · הכל" : c + " › " + s; }
function clustersFor(key) {
  const [c, s] = key.split("|");
  return CLUSTERS.filter((cl) => (s === "*" ? cl.cats.has(c) : cl.subs.has(key)));
}
function switchEl(on, label, onchange) {
  return h("button", { class: "switch", role: "switch", "aria-checked": String(on), "aria-label": label, onclick: onchange });
}
function followingView() {
  const out = [h("h1", { class: "screen-title" }, "במעקב")];
  const keys = Object.keys(S.follow);
  if (!keys.length) out.push(h("p", { class: "empty" }, "עוד לא עקבת אחרי נושא. אפשר לעקוב מכל נושא בפיד."));
  else out.push(h("section", null, keys.map((k) => h("div", { class: "switch-row" },
    h("div", { class: "grow" },
      h("a", { class: "name", href: hashOf({ c: k.split("|")[0], s: k.split("|")[1] === "*" ? "" : k.split("|")[1] }) }, followLabel(k)),
      h("div", { class: "meta" }, storiesLabel(clustersFor(k).filter((cl) => isToday(cl.latest)).length) + " היום · ",
        h("button", { class: "text-btn", style: "min-block-size:auto;padding:0", onclick: () => { delete S.follow[k]; save("follow"); render(); } }, "הסר"))),
    switchEl(S.follow[k].alert, "התראות עבור " + followLabel(k), () => { S.follow[k].alert = !S.follow[k].alert; save("follow"); render(); })))));

  out.push(h("section", { class: "section" },
    h("h2", { class: "section-h" }, "תדירות התראות"),
    h("div", { class: "chips" }, FREQS.map(([v, l]) => h("button", { class: "chip", "aria-pressed": String(S.freq === v), onclick: () => { S.freq = v; save("freq"); render(); } }, l))),
    h("p", { class: "note" }, "האתר הוא דף סטטי, ולכן ההתראות מופיעות כאן ולא כהודעה בטלפון. ההגדרה נשמרת לשלב שבו יחובר שירות התראות.")));

  const alertKeys = keys.filter((k) => S.follow[k].alert);
  const seen = new Set();
  let recent = [];
  for (const k of alertKeys) for (const cl of clustersFor(k)) if (!seen.has(cl)) { seen.add(cl); recent.push(cl); }
  if (S.freq === "3plus") recent = recent.filter((cl) => cl.sites.length >= 3);
  recent = recent.filter((cl) => isToday(cl.latest)).sort((x, y) => (y.latest > x.latest ? 1 : -1)).slice(0, 15);
  out.push(h("section", { class: "section" },
    h("h2", { class: "section-h" }, "התראות אחרונות"),
    alertKeys.length ? (recent.length ? recent.map((cl) => storyRow(cl, { isNew: Date.parse(cl.latest) > S.prevVisit })) : h("p", { class: "empty" }, "אין התראות מהיממה האחרונה."))
      : h("p", { class: "empty" }, "הפעל התראות לנושא כדי לראות כאן עדכונים.")));
  return out;
}

/* ---------- sources ---------- */
function allSources() {
  const names = new Set((DATA && DATA.feeds || []).map((f) => f.site));
  const today = new Map();
  const seen = new Set();
  for (const i of (DATA && DATA.items) || []) {
    if (seen.has(i.link) || !isToday(i.published)) continue;
    seen.add(i.link); today.set(i.site, (today.get(i.site) || 0) + 1);
  }
  return [...names].sort((a, b) => a.localeCompare(b, "he")).map((n) => ({ name: n, lean: LEANS[n] || "", today: today.get(n) || 0 }));
}
function mixOf(list) {
  const lean = { L: 0, C: 0, R: 0 };
  list.forEach((s) => { if (s.lean && !S.excluded.includes(s.name)) lean[s.lean]++; });
  return lean;
}
function mixBlock(list) {
  const lean = mixOf(list);
  return [leanBar(lean, true), h("p", { class: "meta", style: "margin-block-start:var(--space-2)" }, LEAN_ORDER.map((k) => lean[k] + " " + LEAN_HE[k]).join(" · "))];
}
function sourcesView() {
  const list = allSources();
  const out = [h("h1", { class: "screen-title" }, "מקורות"), ...mixBlock(list),
    h("p", { class: "note" }, "מקור שמכבים מוסר מכל הספירות, הפסים וההשוואות באתר. את הסיווג אפשר לערוך בקובץ leans.js.")];
  for (const g of [...LEAN_ORDER, ""]) {
    const rows = list.filter((s) => s.lean === g);
    if (!rows.length) continue;
    out.push(h("section", { class: "group" },
      h("div", { class: "group-h" }, h("span", { class: "swatch " + g, "aria-hidden": "true" }), g ? LEAN_HE[g] : "ללא סיווג", h("span", { class: "meta" }, String(rows.length))),
      rows.map((s) => {
        const on = !S.excluded.includes(s.name);
        return h("div", { class: "switch-row" },
          h("div", { class: "grow" }, h("div", { class: "name", dir: "auto" }, s.name), h("div", { class: "meta" }, storiesLabel(s.today) + " היום")),
          switchEl(on, (on ? "הוצא את " : "כלול את ") + s.name, () => {
            S.excluded = on ? [...S.excluded, s.name] : S.excluded.filter((x) => x !== s.name);
            save("excluded"); build(); render();
          }));
      })));
  }
  return out;
}

/* ---------- settings ---------- */
function settingsView() {
  return [
    h("div", { class: "screen-head" }, backBtn()),
    h("h1", { class: "screen-title" }, "הגדרות"),
    h("section", { class: "section" }, h("h2", { class: "section-h" }, "פריסת הפיד"),
      h("div", { class: "chips" }, LAYOUTS.map(([v, l]) => h("button", { class: "chip", "aria-pressed": String(S.layout === v), onclick: () => { S.layout = v; save("layout"); render(); } }, l)))),
    h("section", { class: "section stack" },
      h("a", { class: "block-btn", href: "#v=sources" }, "בחירת מקורות"),
      h("button", { class: "block-btn", onclick: () => { S.onboarded = false; save("onboarded"); onbStep = 0; render(); } }, "הצג שוב את מסך הפתיחה"))
  ];
}

/* ---------- onboarding ---------- */
function finishOnboarding(hash) {
  S.onboarded = true; save("onboarded");
  if (location.hash === hash) render(); else location.hash = hash;
}
function onboardingView() {
  if (onbStep === 0) return [h("div", { class: "onb" },
    h("h1", { class: "masthead" }, "סורק חדשות"),
    h("div", { class: "rail" }),
    h("p", { class: "promise" }, "כל הסיפורים החשובים, מכל המקורות, במקום אחד, עם תמונה של מי מדווח ומי שותק."),
    h("button", { class: "block-btn primary", onclick: () => { onbStep = 1; render(); } }, "בואו נתחיל"))];
  if (onbStep === 1) return [h("div", { class: "onb" },
    h("h1", { class: "screen-title" }, "על מה לעקוב?"),
    h("p", { class: "meta" }, "בחר נושאים. אפשר לשנות אחר כך במסך המעקב."),
    taxonomy().filter((t) => t.subcategories.length).map((t) => h("section", null,
      h("h2", { class: "section-h" }, t.name),
      h("div", { class: "chips" }, t.subcategories.map((s) => {
        const k = t.name + "|" + s.name;
        return h("button", { class: "chip", "aria-pressed": String(!!S.follow[k]), onclick: () => {
          if (S.follow[k]) delete S.follow[k]; else S.follow[k] = { alert: true };
          save("follow"); render();
        } }, s.name);
      })))),
    h("button", { class: "block-btn primary", onclick: () => { onbStep = 2; render(); } }, "המשך"))];
  const list = allSources();
  return [h("div", { class: "onb" },
    h("h1", { class: "screen-title" }, "איזה תמהיל מקורות?"),
    ...mixBlock(list),
    h("button", { class: "block-btn primary", onclick: () => { S.excluded = []; save("excluded"); build(); finishOnboarding(lastFeedHash); } }, "תמהיל מאוזן: כל המקורות"),
    h("button", { class: "block-btn", onclick: () => finishOnboarding("#v=sources") }, "אבחר בעצמי"))];
}

/* ---------- shell ---------- */
const TABS = [["feed", "פיד", "newspaper"], ["search", "חיפוש", "magnifying-glass"], ["saved", "שמורים", "bookmark-simple"],
  ["following", "במעקב", "bell-simple"], ["sources", "מקורות", "broadcast"]];
function renderTabbar(v, hidden) {
  const bar = document.getElementById("tabbar");
  bar.hidden = hidden;
  const active = ["story", "article", "settings"].includes(v) ? "" : v;
  bar.replaceChildren(h("div", { class: "tabbar-in" }, TABS.map(([k, label, ic]) =>
    h("a", { href: k === "feed" ? lastFeedHash : "#v=" + k, "aria-current": active === k ? "page" : null }, icon(ic), label))));
}
function render() {
  const r = route();
  const app = document.getElementById("app");
  if (!S.onboarded && DATA) { app.replaceChildren(...onboardingView()); renderTabbar(r.v, true); renderRail(); return; }
  const views = { feed: feedView, story: storyView, article: articleView, search: searchView, saved: savedView,
    following: followingView, sources: sourcesView, settings: settingsView };
  const fn = views[r.v] || feedView;
  if (r.v === "search" && app.dataset.view === "search" && app.querySelector("input")) { renderTabbar(r.v, false); return; }
  app.dataset.view = r.v;
  app.replaceChildren(...fn(r).filter(Boolean));
  renderTabbar(r.v, false);
  renderRail();
}
addEventListener("hashchange", () => {
  const cur = location.hash;
  if (navStack.length > 1 && navStack[navStack.length - 2] === cur) navStack.pop(); else navStack.push(cur);
  feedLimit = 40;
  const v = route().v;
  if (v !== "search") document.getElementById("app").dataset.view = "";
  render();
  if (v !== "feed") scrollTo(0, 0);
});
navStack.push(location.hash);
render();
load();
setInterval(load, 5 * 60 * 1000);
setInterval(renderRail, 60 * 1000);
