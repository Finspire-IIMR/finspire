#!/usr/bin/env python3
"""Assemble the deployable site into dist/ (or --out DIR).

  site/            copied as-is
  src/home.html    rendered to index.html with data/site-data.json embedded at __SITE_DATA__
  data/            site-data.json, policy-manual.json and data/live/*.json copied to <out>/data/
  content/glossary built to <out>/data/glossary/ by scripts/build_glossary.py
Missing generated data gets empty stubs so every page still loads."""
import argparse, json, pathlib, shutil, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
STUBS = {
    "markets.json": {"updated": None, "quotes": {}, "policy": [], "curve": None},
    "news.json": {"updated": None, "items": [], "regions": {}, "markets": {}},
    "news-archive.json": {"updated": None, "items": []},
    "news-terms.json": {},
    "status.json": {"updated": None, "sources": []},
}

def enc(o):
    return json.dumps(o, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "dist"))
    ap.add_argument("--demo", action="store_true", help="also copy tests/fixtures/demo to <out>/_demo (local testing only)")
    args = ap.parse_args()
    out = pathlib.Path(args.out).resolve()
    if out == ROOT or ROOT not in out.parents and not str(out).startswith("/tmp") and not str(out).startswith("/private"):
        sys.exit(f"refusing to build into {out}")
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "site", out, ignore=shutil.ignore_patterns(".DS_Store", "_*"))
    (out / ".nojekyll").write_text("")

    data = json.loads((ROOT / "data/site-data.json").read_text())
    home = ROOT / "src/home.html"
    if home.exists():
        tpl = home.read_text()
        assert tpl.count("__SITE_DATA__") == 1, "src/home.html must contain __SITE_DATA__ exactly once"
        (out / "index.html").write_text(tpl.replace("__SITE_DATA__", enc(data), 1))
    else:
        print("warning: src/home.html missing, no index.html", file=sys.stderr)

    d = out / "data"
    (d / "live").mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "data/site-data.json", d / "site-data.json")
    if (ROOT / "data/policy-manual.json").exists():
        shutil.copy2(ROOT / "data/policy-manual.json", d / "policy-manual.json")
    live = ROOT / "data/live"
    for name, stub in STUBS.items():
        src = live / name
        if src.exists():
            shutil.copy2(src, d / "live" / name)
        else:
            (d / "live" / name).write_text(json.dumps(stub))

    bg = ROOT / "scripts/build_glossary.py"
    if bg.exists():
        subprocess.run([sys.executable, str(bg), "--out", str(d / "glossary")], check=True)
        # news-terms shards: the dictionary page loads one small file per topic (data/live/news-terms/<cat>.json)
        try:
            idx = json.loads((d / "glossary/index.json").read_text())
            terms = json.loads((d / "live/news-terms.json").read_text())
            cat_of = {row[0]: row[2] for row in idx.get("t", [])}
            shards = {}
            for tid, items in terms.items():
                shards.setdefault(cat_of.get(tid, "other"), {})[tid] = items
            (d / "live/news-terms").mkdir(parents=True, exist_ok=True)
            for cat in idx.get("cats", {}):
                (d / "live/news-terms" / f"{cat}.json").write_text(json.dumps(shards.get(cat, {}), ensure_ascii=False, separators=(",", ":")))
        except Exception as e:
            print("warning: news-terms shards not built:", e, file=sys.stderr)
    else:
        print("warning: scripts/build_glossary.py missing, no glossary", file=sys.stderr)
    demo = ROOT / "tests/fixtures/demo"
    if args.demo and demo.exists():
        shutil.copytree(demo, out / "_demo")
    n = sum(1 for _ in out.rglob("*") if _.is_file())
    print(f"built {out} ({n} files)")

if __name__ == "__main__":
    main()
