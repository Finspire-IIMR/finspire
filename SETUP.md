# Setting up the Finspire website

This guide is for Finspire admins. No coding is needed: every step is clicking through GitHub or Google and pasting a
value into one file. Budget about 30 minutes the first time.

The site has three moving parts:

| Part | What it does | Cost |
|---|---|---|
| **GitHub Pages** | Hosts the website and refreshes markets + news every 15 minutes | Free (public repository) |
| **Google sign-in** | Lets students sign in with their `@iimranchi.ac.in` account | Free |
| **Google Drive** | The Library opens the club's Drive files inside the site | Free |

Until Google sign-in is connected, everything public works (home, Markets & News, Dictionary) and there is no Sign in
button anywhere. Saved words, recent lookups and revision still work; each visitor's are kept in their own browser. The
Library says it opens once IIM Ranchi sign-in is switched on, and the home page's Drive cards open Google Drive
directly. After step 2, the Sign in button appears by itself, and the first time someone signs in, what they saved in
that browser moves into their account.

---

## 1. GitHub: publish the site

1. Open the repository on GitHub → **Settings** → **Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Open the **Actions** tab. If GitHub asks, click **I understand my workflows, go ahead and enable them**.
4. Click the **Build and deploy** workflow → **Run workflow**. After about two minutes the site is live at
   `https://<your-github-name>.github.io/<repository-name>/`.

You do not need to set any secrets. The optional repository variable `SITE_URL` (Settings → Secrets and variables →
Actions → Variables) is only needed if you later put the site on a custom domain.

From then on the site rebuilds itself whenever content changes and every 15 minutes to pull fresh prices and news.
(GitHub sometimes runs scheduled jobs a few minutes late; prices on the Markets page also update live in the browser
every 15 seconds, so this only affects the saved snapshot and the news list.)

> GitHub pauses scheduled jobs in a repository that has had no activity for 60 days. If the news stops updating,
> open **Actions → Build and deploy → Run workflow** once and it starts again.

## 2. Google: switch on sign-in

Do this signed in to Google **with your @iimranchi.ac.in account** if you can. That lets you mark the app "Internal",
and then Google itself blocks every account outside IIM Ranchi.

1. Go to <https://console.cloud.google.com/> → project picker → **New project** → name it `Finspire website` → Create.
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (on newer consoles: **Google Auth Platform → Branding / Audience**):
   - App name `Finspire`, support email your address, logo optional.
   - **User type / Audience: Internal.** (If "Internal" is greyed out, your account is not allowed to create
     internal apps — choose **External**, keep it in **Testing**, and add the members' emails as test users. Testing
     mode allows up to 100 accounts. Ask IIM Ranchi IT to create the project inside the institute's Google Workspace
     if you need more.)
   - **Data access / Scopes:** add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`,
     `.../auth/drive.readonly`, `.../auth/drive.file`, `.../auth/drive.appdata`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**, name `Finspire site`.
   - **Authorized JavaScript origins**: `https://<your-github-name>.github.io` (no path, no trailing slash).
     Add `http://localhost:8000` too if someone tests the site on their laptop.
   - Create, then copy the **Client ID** (it ends in `.apps.googleusercontent.com`).
5. In the repository open `site/config.js` → pencil icon → paste the Client ID between the quotes of
   `googleClientId: ""` → **Commit changes**. The site redeploys in about a minute.

The Client ID is meant to be public; it only works on the origin you listed.

## 3. Drive: let members open files in the Library

The Library shows the folders listed in the site's **Finspire Drive** section (Edit mode → each folder's link).

1. In Google Drive, right-click each Finspire folder → **Share** → **General access** → **IIM Ranchi** (anyone in the
   institute with the link) → **Viewer** → Done. Members then see the files; outsiders cannot open them even if they get
   the link, because Google checks the signed-in account.
2. For the **inbox** folder (where members add files from the Library's "Add a file" button), set general access for
   IIM Ranchi to **Editor** (or "Contributor" on a shared drive). Admins then move good files into the right folder.
3. Paste each folder's share link into the site in Edit mode (Finspire Drive section → folder → link), and the inbox
   link in the section's settings.

Optional: an **API key** lets the Library list folders that are shared "Anyone with the link" without a sign-in token.
Most clubs do not need it. If you want it: Credentials → Create credentials → API key → restrict it to the
**Google Drive API** and to websites `https://<your-github-name>.github.io/*` → paste into `driveApiKey` in `config.js`.

## 4. Admins and Edit mode

Edit mode (the "Edit site" button on the home page) saves changes straight to GitHub.

1. In `site/config.js` fill in:
   - `admins: ["first.admin@iimranchi.ac.in", "second.admin@iimranchi.ac.in"]`
   - `github: { owner: "<your-github-name>", repo: "<repository-name>", branch: "main" }`
   - `siteUrl: "https://<your-github-name>.github.io/<repository-name>/"`
2. Each admin makes a GitHub token once: GitHub → your photo → **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token** → Repository access: **Only select repositories** → this repository →
   Permissions: **Contents: Read and write** → Generate. The first time they click **Publish** in Edit mode, the site
   asks for this token and keeps it only in that browser ("Forget token" removes it).
3. Sign in on the home page with an admin account → **Edit site** → click any text to change it → **Publish**. The live
   site updates about a minute later.

You can also edit `data/site-data.json` directly on GitHub (pencil icon) — it holds every resource, path, event and
Drive folder.

## 5. Things to update by hand

- **Bank of Japan and People's Bank of China rates** have no free automatic source. After their policy meetings, edit
  `data/policy-manual.json` on GitHub (value, display text, as-of date). RBI, Fed, ECB and Bank of England rates update
  automatically.
- **The dictionary** lives in `content/glossary/*.json`. To fix or add a term, edit the right file on GitHub; the site
  rebuilds itself.

## 6. Where the data comes from

- Live prices: CNBC and Moneycontrol public quote feeds (may be delayed; used for education, with attribution).
- Policy rates: Reserve Bank of India, U.S. Federal Reserve (via FRED), European Central Bank (via FRED), Bank of
  England. Treasury yield curve: U.S. Department of the Treasury.
- News: headlines and short summaries from publishers' public RSS feeds (Economic Times, Mint, Business Standard,
  BusinessLine, CNBC, BBC, the Guardian, Financial Times, Nikkei Asia, SCMP, CoinDesk, OilPrice, central banks and
  Google News). Every story links to the original article.

The quote feeds are unofficial public endpoints. If one changes, the page keeps showing the last saved prices and says
so; nothing breaks.
