# Demo fixtures (local testing only)

`python3 scripts/build_site.py --demo --out .dev/<name>` copies this folder to `<out>/_demo/`. Nothing here is ever
deployed: the normal build (and GitHub Actions) never passes `--demo`.

| File | Used by | Purpose |
|---|---|---|
| `demo.json` | `finspire.js` (auth) | Marker. `?demo-user=1` signs in a fake student only on localhost / 127.0.0.1 **and** only when this file is served. |
| `shell.html` | `tests/shell.test.mjs` | Test page for the shared runtime: header, account, tooltip, annotate, store, dialogs. Open `/_demo/shell.html?demo-user=1`. |
| `drive.json` + files | `library.js` (`?demo-drive=1`) | Fake Drive listing for the Library. Added by the Library part. |

Rules: fixture pages use `<meta name="fs-root" content="../">` (they live one level down, in `_demo/`), only relative
URLs, and no real personal data.
