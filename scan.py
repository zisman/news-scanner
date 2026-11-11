#!/usr/bin/env python3
"""News scanner: reads RSS feeds, keeps items that match the keywords in config.json,
and writes docs/data.json for the web page. Standard library only."""
import html, json, re, sys, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "docs" / "data.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
IMG_RE = re.compile(r'https?://[^\s"\'<>]+?\.(?:jpe?g|png|webp)(?:\?[^\s"\'<>]*)?', re.I)
HEB = "א-ת"


def fetch(url, limit=3_000_000):
    if not url.startswith("http"):                      # local file, used in tests
        return Path(url).read_bytes()
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, text/html, */*",
        "Accept-Language": "he-IL,he;q=0.9,en;q=0.8"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read(limit)


def norm(s):
    for a, b in (("״", '"'), ("”", '"'), ("“", '"'), ("׳", "'"), ("’", "'"),
                 ("־", "-"), ("–", "-")):
        s = s.replace(a, b)
    return s


def clean(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def term_regex(term):
    """Whole-word match that tolerates Hebrew prefix letters (ה/ב/ל/ו/מ/ש/כ)."""
    t = re.escape(norm(term))
    lead = rf"(?<![{HEB}])[ובהלמשכ]{{0,3}}" if re.match(rf"[{HEB}]", term) else ""
    return re.compile(lead + t + rf"(?![{HEB}])")


def local(tag):
    return tag.rsplit("}", 1)[-1].lower()


def parse_date(s):
    s = (s or "").strip()
    if not s:
        return None
    try:
        d = parsedate_to_datetime(s)
    except Exception:
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def parse_feed(raw):
    root = ET.fromstring(raw)
    out = []
    for it in root.iter():
        if local(it.tag) not in ("item", "entry"):
            continue
        f = {"title": "", "link": "", "desc": "", "date": "", "image": ""}
        blob = []
        for c in it.iter():
            if c is it:
                continue
            name, text = local(c.tag), (c.text or "").strip()
            blob.append(text)
            if name == "title" and not f["title"]:
                f["title"] = clean(text)
            elif name == "link" and not f["link"]:
                f["link"] = text or c.attrib.get("href", "")
            elif name in ("description", "summary") and not f["desc"]:
                f["desc"] = text
            elif name in ("pubdate", "published", "updated", "date") and not f["date"]:
                f["date"] = text
            elif name in ("enclosure", "content", "thumbnail") and not f["image"]:
                u = c.attrib.get("url", "")
                kind = c.attrib.get("type", "") + c.attrib.get("medium", "")
                if u and ("image" in kind or IMG_RE.match(u) or name == "thumbnail"):
                    f["image"] = u
        if not f["image"]:
            m = IMG_RE.search(" ".join(blob))
            if m:
                f["image"] = html.unescape(m.group(0))
        if f["title"] and f["link"]:
            out.append(f)
    return out


def og_image(url):
    try:
        page = fetch(url, 400_000).decode("utf-8", "ignore")
    except Exception:
        return ""
    m = (re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)', page) or
         re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']', page))
    return html.unescape(m.group(1)) if m else ""


def two_sentences(text, title):
    text = clean(text)
    if not text or text == title:
        return ""
    parts = re.split(r"(?<=[.!?])\s+", text)
    s = " ".join(parts[:2])
    return s if len(s) <= 280 else s[:277].rsplit(" ", 1)[0] + "…"


def main():
    cfg = json.loads((ROOT / "config.json").read_text("utf-8"))
    now = datetime.now(timezone.utc)
    old = {}
    if OUT.exists():
        try:
            old = {i["link"]: i for i in json.loads(OUT.read_text("utf-8")).get("items", [])}
        except Exception:
            old = {}

    rules = []          # (category, subcategory, sites, [(keyword name, [regex])])
    for cat in cfg["categories"]:
        for sub in cat["subcategories"]:
            kws = [(k["name"], [term_regex(t) for t in k["match"]]) for k in sub["keywords"]]
            rules.append((cat["name"], sub["name"], set(cat["sites"]), kws))

    items, status = dict(old), []
    for site in cfg["sites"]:
        for url in site["feeds"]:
            st = {"site": site["name"], "url": url, "ok": False, "found": 0, "matched": 0, "error": ""}
            try:
                entries = parse_feed(fetch(url))
                st["ok"], st["found"] = True, len(entries)
            except Exception as e:
                st["error"] = f"{type(e).__name__}: {e}"[:160]
                entries = []
            for e in entries:
                hay = norm(e["title"] + " \n " + clean(e["desc"]))
                for cat, sub, sites, kws in rules:
                    if site["name"] not in sites:
                        continue
                    hits = [name for name, rxs in kws if any(r.search(hay) for r in rxs)]
                    if not hits:
                        continue
                    st["matched"] += 1
                    link = e["link"].strip()
                    prev = items.get(link, {})
                    d = parse_date(e["date"])
                    items[link] = {
                        "site": site["name"], "category": cat, "subcategory": sub,
                        "keywords": sorted(set(hits) | set(prev.get("keywords", []))),
                        "title": e["title"], "summary": two_sentences(e["desc"], e["title"]),
                        "link": link, "image": e["image"] or prev.get("image", ""),
                        "published": (d or now).isoformat(timespec="seconds") if (d or not prev) else prev["published"],
                        "first_seen": prev.get("first_seen", now.isoformat(timespec="seconds")),
                    }
                    break
            status.append(st)
            print(("OK  " if st["ok"] else "FAIL"), site["name"], url, st["found"], st["matched"], st["error"])

    cutoff = (now - timedelta(days=cfg.get("max_age_days", 7))).isoformat()
    keep = [i for i in items.values() if i["published"] >= cutoff or i["first_seen"] >= cutoff]
    keep.sort(key=lambda i: i["published"], reverse=True)
    keep = keep[: cfg.get("max_items", 300)]
    budget = 25                                          # page fetches per run for missing images
    for i in keep:
        if not i["image"] and budget:
            budget -= 1
            i["image"] = og_image(i["link"])

    data = {"updated": now.isoformat(timespec="seconds"), "feeds": status,
            "taxonomy": [{"name": c["name"], "subcategories": [s["name"] for s in c["subcategories"]]}
                         for c in cfg["categories"]],
            "items": keep}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    print(f"{len(keep)} items saved")
    if not any(s["ok"] for s in status):
        sys.exit("no feed could be read")


if __name__ == "__main__":
    main()
