#!/usr/bin/env python3
"""Package pages of the new site for the claude.ai artifact (the club's current live link).

The artifact's main page stays the single-file home page (../build.py → ../finspire.html). Next to it this script lays
out the Dictionary page (and, with --with-markets, the Markets & News page) plus the files they load in
../artifact-out/, with the same relative paths the pages use:

  dictionary/index.html   links rewritten for the artifact host (home is "../", page links end in index.html)
  markets/index.html      only with --with-markets
  config.js               switched-off pages are hidden; sign-in is always off here (Google only allows sign-in on
                          addresses registered with the club's OAuth client, and claude.ai is not one), so personal
                          features (saved words, history, revision, "Your words" in the news) stay in the viewer's browser
  assets/…                shared runtime + page styles and scripts, logos
  data/glossary/…         the built dictionary (index + one file per topic)
  data/live/…             news-terms.json; with --with-markets also markets.json and news.json (a snapshot: the
                          artifact cannot run the 15-minute refresh, so news is as fresh as the last publish; live
                          prices load in the browser only if the host allows the quote feeds, otherwise the page says
                          it is showing saved prices)

It prints the `files` map to pass to the Artifact tool. Nothing here changes the GitHub Pages build, which is where
the full site (Markets & News, Library, IIM Ranchi sign-in) lives."""
import argparse, json, os, pathlib, shutil, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent          # finspire-site/
TOP = ROOT.parent                                             # session folder with build.py and finspire.html
OUT = TOP / "artifact-out"

BASE = ["assets/css/pages.css", "assets/css/shell.css", "assets/js/finspire.js",
        "assets/img/logo-light.png", "assets/img/logo-dark.png"]
PAGES = {
    "dictionary": {"copy": ["assets/css/dictionary.css", "assets/js/dictionary.js"], "live": ["news-terms.json"]},
    "markets": {"copy": ["assets/css/markets.css", "assets/js/markets.js", "assets/js/news.js"],
                "live": ["markets.json", "news.json", "news-terms.json"]},
}

def config(names):
    feats = {"markets": "markets" in names, "dictionary": True, "library": False, "signin": False}
    pages = {"home": ""}
    pages.update({n: n + "/index.html" for n in names})
    label = " + ".join(n.capitalize() for n in names)
    return ("/* Finspire settings for the claude.ai launch: " + label + ". Switch features back on here when they ship.\n"
            "   Sign-in stays off on claude.ai: Google only allows it on the site's own address (GitHub Pages). */\n"
            "window.FINSPIRE_CONFIG = {\n"
            '  googleClientId: "",\n'
            '  allowedDomain: "iimranchi.ac.in",\n'
            "  features: {" + ", ".join(k + ": " + json.dumps(v) for k, v in feats.items()) + "},\n"
            "  pages: " + json.dumps(pages) + "\n"
            "};\n")

def rewrite(page, names):
    # the artifact serves the home page at the folder itself and does not resolve folder index pages
    page = page.replace('href="../index.html#', 'href="../#').replace('href="../index.html"', 'href="../"')
    for n in names:
        page = page.replace('href="../' + n + '/"', 'href="../' + n + '/index.html"')
    return page

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-markets", action="store_true", help="also package the Markets & News page (news feed)")
    ap.add_argument("--out", default=str(OUT), help="output folder (default ../artifact-out, the folder the Artifact publish uses)")
    args = ap.parse_args()
    out = pathlib.Path(args.out).resolve()
    if out in (ROOT, TOP) or ROOT in out.parents and ".dev" not in out.parts:
        sys.exit(f"refusing to build into {out}")
    names = ["dictionary"] + (["markets"] if args.with_markets else [])
    subprocess.run([sys.executable, str(TOP / "build.py")], check=True, cwd=TOP)
    if out.exists(): shutil.rmtree(out)
    copy = list(BASE)
    for n in names: copy += PAGES[n]["copy"]
    for rel in dict.fromkeys(copy):
        dst = out / rel; dst.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(ROOT / "site" / rel, dst)
    (out / "config.js").write_text(config(names))
    for n in names:
        page = rewrite((ROOT / "site" / n / "index.html").read_text(), names)
        (out / n).mkdir(parents=True, exist_ok=True); (out / n / "index.html").write_text(page)
    subprocess.run([sys.executable, str(ROOT / "scripts/build_glossary.py"), "--out", str(out / "data/glossary")], check=True)
    (out / "data/live").mkdir(parents=True, exist_ok=True)
    stubs = {"markets.json": {"updated": None, "quotes": {}, "policy": [], "curve": None},
             "news.json": {"updated": None, "items": [], "regions": {}, "markets": {}}, "news-terms.json": {}}
    for name in dict.fromkeys(x for n in names for x in PAGES[n]["live"]):
        src = ROOT / "data/live" / name
        if src.exists(): shutil.copy2(src, out / "data/live" / name)
        else: (out / "data/live" / name).write_text(json.dumps(stubs[name]))
    files = {str(p.relative_to(out)): os.path.relpath(p, TOP) for p in sorted(out.rglob("*")) if p.is_file()}
    total = sum((out / k).stat().st_size for k in files)
    (out / "_files.json").write_text(json.dumps(files, indent=1))
    print(f"{out.name} ({' + '.join(names)}): {len(files)} files, {total/1e6:.2f} MB; page {(TOP / 'finspire.html').stat().st_size/1e3:.0f} KB")

if __name__ == "__main__":
    main()
