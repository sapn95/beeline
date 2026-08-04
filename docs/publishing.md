# Publishing to the Chrome Web Store

The `Release` workflow (`.github/workflows/release.yml`) automates **updates**.
The **first** publish must be done by hand because the store requires a human to
create the listing (screenshots, description, privacy disclosures). After that,
tagging a version ships a new release automatically.

> **This extension** — item ID `ahcijedndjdoigcipppnkklgmlndkhka`
> (store: <https://chromewebstore.google.com/detail/ahcijedndjdoigcipppnkklgmlndkhka>).
> First listing submitted for review on 2026-06-12. That item ID is the value for
> the `CHROME_EXTENSION_ID` secret below.

## One-time setup

### 1. Register as a Chrome Web Store developer

- Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
  and pay the one-time **US$5** registration fee.

### 2. First manual upload (creates the item + its ID)

```bash
npm run package          # produces beeline-v0.1.0.zip
```

- In the dashboard, **New item → upload** the zip.
- Fill in the listing: name, description, category (Productivity), a 128×128
  icon, at least one 1280×800 (or 640×400) screenshot, and the privacy section.
- **Privacy:** declare that the extension stores the user's app list locally /
  in Chrome sync and does **not** transmit it anywhere. It requests the
  `myapplications.microsoft.com` host permission only to import the user's own
  app tiles, on demand.
- **Permission justifications** (the dashboard asks for one per permission —
  including optional ones):
  - `bookmarks` — "Optional, and off by default. Requested only when the user
    switches on 'Also search this browser's bookmarks' in the options page, so
    their bookmarks can be listed alongside their apps in the launcher popup.
    Bookmarks are read live while the popup is open, are never stored by the
    extension, and are never transmitted anywhere. Unticking the setting calls
    `chrome.permissions.remove` and gives the permission back."
  - `contextualIdentities` (Firefox only) — "Reads the names and colours of the
    user's Firefox containers, so an app imported inside one can say which
    container it belongs to and be opened there. Firefox provides no optional
    form of this permission. Nothing inside a container is read."
  - `cookies` (Firefox only, optional) — "Requested the first time the user
    chooses a container. No cookie is ever read or written: this permission is
    what makes Firefox honour a cookieStoreId on tabs.create / windows.create,
    which is the only way to open a tab in a container."
  - `favicon` — "Used to show each entry's site icon in the launcher popup.
    Apps imported from My Apps that have no logo, bookmarks, and hand-added apps
    carry no icon of their own, so the extension reads the icon Chrome has
    already cached locally via the `_favicon/` endpoint. This makes no network
    request, reads no page content, and nothing is transmitted anywhere."
- Submit for review and note the **Item ID** (32 lowercase letters) — that's
  `CHROME_EXTENSION_ID`.

> NOTE: adding an **optional** permission does not disable the extension for
> existing users the way a new required permission would — nothing is granted
> until someone ticks the box. The store review may still take longer on the
> release that introduces it.

### 3. Create API credentials for automated updates

Follow Google's guide:
<https://developer.chrome.com/docs/webstore/using-api>

1. In Google Cloud Console, create an OAuth client (type **Desktop app**) and
   enable the **Chrome Web Store API**. This gives you a **client ID** and
   **client secret**. Publish the OAuth consent screen (**In production**) —
   leaving it in "Testing" makes every refresh token expire after ~7 days, see
   [Keeping the credentials alive](#keeping-the-credentials-alive).
2. Generate a **refresh token** once with the bundled helper, which opens the
   consent screen, captures the loopback redirect, and prints the token:

   ```bash
   node scripts/get-cws-token.mjs <CLIENT_ID> <CLIENT_SECRET>
   ```

### 4. Add the four GitHub Actions secrets

```bash
gh secret set CHROME_EXTENSION_ID  --body "ahcijedndjdoigcipppnkklgmlndkhka"
gh secret set CHROME_CLIENT_ID     --body "<client id>"
gh secret set CHROME_CLIENT_SECRET --body "<client secret>"
gh secret set CHROME_REFRESH_TOKEN --body "<refresh token>"
```

Or in the UI — Repo → **Settings → Secrets and variables → Actions → New
repository secret** — using the same names:

| Secret                 | Value                           |
| ---------------------- | ------------------------------- |
| `CHROME_EXTENSION_ID`  | the 32-char item ID from step 2 |
| `CHROME_CLIENT_ID`     | OAuth client ID                 |
| `CHROME_CLIENT_SECRET` | OAuth client secret             |
| `CHROME_REFRESH_TOKEN` | the refresh token from step 3   |

> If these are absent, the release job still builds and creates the GitHub
> release — it just prints a warning and skips the store publish.

## Keeping the credentials alive

A Chrome Web Store refresh token minted while the OAuth consent screen is in
**Testing** is killed by Google after about **7 days**. Publish the consent
screen (Google Cloud → APIs & Services → OAuth consent screen → **Publish app**,
i.e. Testing → **In production**) and the token stops expiring — that is the
permanent fix, and it needs no verification for an app that only requests the
`chromewebstore` scope for its own developer account.

Renewing by hand, when it does expire (`invalid_grant` in the release log):

```bash
node scripts/get-cws-token.mjs <CLIENT_ID> <CLIENT_SECRET>   # BROWSER="Google Chrome"
gh secret set CHROME_REFRESH_TOKEN --body "<the new token>"
```

Then re-publish the version that missed its store — **Actions → Release → Run
workflow**, with the `tag` input set to that tag (e.g. `v0.1.10`). That path
rebuilds from the tag and skips the version bump, so nothing else moves.

`.github/workflows/credentials-check.yml` runs `scripts/check-store-credentials.mjs`
every morning: it exchanges the Chrome refresh token and signs an AMO JWT, and
opens a GitHub issue the day either stops working — so a dead credential is
found days before a release needs it, instead of half-way through one. The issue
closes itself once the credentials work again.

## Shipping an update

```bash
# bump the version (single source of truth: package.json)
npm version patch            # or minor / major  -> creates a vX.Y.Z git tag
git push --follow-tags
```

### …or let it ship itself

`release.yml` also runs on a monthly schedule (1st, 06:00 UTC). That run:

1. **skips entirely** unless `src/` or `scripts/` changed since the last `v*`
   tag — a release that ships an identical build would only burn store review;
2. runs lint, `prettier --check` and the full coverage-gated test suite, and
   stops there if anything is red — no bump, no tag, nothing published;
3. picks the bump from the Conventional Commits since that tag (`feat:` → minor,
   `!` / `BREAKING CHANGE` → major, otherwise patch), runs `npm version`, and
   pushes the commit + tag;
4. continues into the normal build → GitHub release → store publish steps in the
   same run.

The tag push triggers `release.yml`, which:

1. installs, lints, tests (with coverage), and packages the zip;
2. creates a GitHub release with the zip attached and auto-generated notes;
3. uploads the zip to the Chrome Web Store and publishes it.

> `npm version` writes the version into `package.json`; `scripts/build.mjs`
> copies it into `dist/manifest.json` at build time, so the two never drift.

## When the release is green but the store is not

Two Chrome states end a release run **successfully with nothing published** — a
tag, a GitHub release and an AMO submission all exist, so it all looks shipped:

| What the store says              | What it means                                                               |
| -------------------------------- | --------------------------------------------------------------------------- |
| `400 Publish condition not met`  | The zip is uploaded, but the **Privacy practices** tab has to be completed. |
| `ITEM_NOT_UPDATABLE` / in review | Nothing was uploaded — a previous submission is still being reviewed.       |

Both open (and later auto-close) the issue **"Chrome Web Store: a released
version is not published"**, so the unshipped version can't quietly rot in a run
log. To clear the first one:

1. [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → the item
   → **Privacy practices**.
2. Fill in the single purpose and a justification per permission — the wording
   lives in [First manual upload](#2-first-manual-upload-creates-the-item--its-id)
   above. **Every newly added permission needs its own**, which is why an
   otherwise routine release suddenly stops publishing.
3. **Save draft** → **Submit for review** there, or re-run **Actions → Release →
   Run workflow** with `tag` set to the affected tag (that path re-uploads
   harmlessly and retries the publish).

There is no API for any of this: the Chrome Web Store Publish API exposes only
`upload`, `publish`, `fetchStatus`, `cancelSubmission` and
`setPublishedDeployPercentage` — the privacy declarations are dashboard-only, on
purpose, because they are legal statements by the publisher.

## Local testing before you publish

1. `npm run build`
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select the `dist/` folder.
3. Open the popup with the toolbar button or `Ctrl/Cmd+Shift+Space`.

## Firefox (AMO)

The same source also builds a Firefox add-on. `npm run build:firefox` emits
`dist-firefox/` (event-page background + a `browser_specific_settings.gecko`
id), and `npm run package` produces `beeline-firefox-vX.Y.Z.zip`
alongside the Chrome zip.

**Local testing:** `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on** → pick `dist-firefox/manifest.json`.

**Automated publish (AMO):** the release workflow signs + submits the Firefox
build when these secrets are set (otherwise it's skipped with a warning):

| Secret           | Where to get it                                                     |
| ---------------- | ------------------------------------------------------------------- |
| `AMO_JWT_ISSUER` | <https://addons.mozilla.org/developers/addon/api/key/> (JWT issuer) |
| `AMO_JWT_SECRET` | the matching JWT secret on that page                                |

As with the Chrome store, create the AMO listing once by hand; thereafter tagging
a version signs + uploads automatically via `web-ext sign`.

> Firefox notes: the web-search fallback uses DuckDuckGo (Firefox lacks
> `chrome.search.query`); import, sync, alarms, and the AWS-region feature all
> work the same.
