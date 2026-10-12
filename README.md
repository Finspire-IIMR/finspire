# Finspire website

The website of Finspire, the finance club of the IPM programme at IIM Ranchi. It is a plain static site (HTML, CSS and
JavaScript, no frameworks) hosted free on GitHub Pages, with four pages:

- **Home**: learning paths, the resource repository, events and the club's Drive folders, plus a live Markets & News
  strip and the term of the day.
- **Markets & News**: live prices for Indian and world markets, policy rates, the U.S. yield curve and a news feed in
  which finance words explain themselves.
- **Dictionary**: finance terms in plain words, with examples, related terms and the headlines they appeared in. Saved
  words, recent lookups and a revision quiz are kept for each reader.
- **Library**: the club's Google Drive files, opened inside the site for IIM Ranchi students.

Sign-in uses IIM Ranchi Google accounts only. Until an admin adds the Google client id, the site has no sign-in at all:
everyone is a guest, personal features (saved words, history, revision) are kept in that browser, and the Library says
it opens once IIM Ranchi sign-in is switched on.

**Setting it up (GitHub Pages, Google sign-in, Drive, admins):** see [SETUP.md](SETUP.md). No coding is needed.
**How it is built (folders, design tokens, data formats, the shared runtime):** see [ARCHITECTURE.md](ARCHITECTURE.md).

## Build and preview locally

You need Python 3.9 or later. Nothing to install.

```sh
python3 scripts/build_site.py --out .dev/preview          # builds the site into .dev/preview
python3 -m http.server 8000 -d .dev/preview               # then open http://127.0.0.1:8000/
```

Fresh prices and news (optional; the build uses whatever is in `data/live/`, or empty placeholders):

```sh
python3 scripts/fetch_markets.py
python3 scripts/build_glossary.py --out /tmp/fs-g && python3 scripts/fetch_news.py --glossary /tmp/fs-g/index.json
```

On GitHub, `.github/workflows/site.yml` does all of this every 15 minutes and publishes the result.

## Tests

Needs Node 20 or later and Google Chrome as well.

```sh
bash tests/run_all.sh           # build, serve under a sub-folder like GitHub Pages, run every suite, print a summary
bash tests/run_all.sh --live    # also refresh markets + news and run the full data-pipeline test (uses the network)
```

A `--demo` build (`python3 scripts/build_site.py --demo …`) adds local-only test hooks: `?demo-user=1` signs in a fake
student and `?demo-drive=1` serves a sample Drive, on localhost only. See `tests/README.md`.

## The claude.ai link

The club's current claude.ai artifact is the older single-page site. `python3 scripts/build_artifact.py` packages the
Dictionary page next to it (`--with-markets` adds the Markets & News page with a saved news snapshot). Google sign-in
cannot work on claude.ai, so the full site, with sign-in and the Library, lives on GitHub Pages.
