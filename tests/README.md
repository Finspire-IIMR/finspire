# Tests

Everything at once (build, serve under a sub-folder on a free port, every suite, summary): `bash tests/run_all.sh`
(add `--live` to refresh data and run the full pipeline test, `--only home,integrate` to pick suites).

Headless-Chrome checks. Build first, serve, then run (Node 20 needs `--experimental-websocket`):

    python3 scripts/build_site.py --demo --out .dev/test
    python3 -m http.server 8800 -d .dev/test &
    node --experimental-websocket tests/<page>.test.mjs http://127.0.0.1:8800/

`tests/lib/cdp.mjs` is the shared driver (launch Chrome, open a page at a viewport, run JS, click/hover/type, screenshot,
collect console errors). Each test file takes the site base URL as its first argument and exits non-zero on failure.
Sign-in is tested with demo mode (`?demo-user=1`, localhost only).

`integrate.test.mjs` takes the base URL of a build served under a sub-folder (e.g. `http://127.0.0.1:8800/finspire/`)
and, optionally, a third argument: the base URL of the claude.ai dictionary build (`scripts/build_artifact.py`) served
the same way with `../finspire.html` wrapped by `../tools/wrap.py` as its `index.html`. `run_all.sh` sets both up.
