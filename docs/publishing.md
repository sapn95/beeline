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
npm run package          # produces myapps-launcher-v0.1.0.zip
```

- In the dashboard, **New item → upload** the zip.
- Fill in the listing: name, description, category (Productivity), a 128×128
  icon, at least one 1280×800 (or 640×400) screenshot, and the privacy section.
- **Privacy:** declare that the extension stores the user's app list locally /
  in Chrome sync and does **not** transmit it anywhere. It requests the
  `myapplications.microsoft.com` host permission only to import the user's own
  app tiles, on demand.
- Submit for review and note the **Item ID** (32 lowercase letters) — that's
  `CHROME_EXTENSION_ID`.

### 3. Create API credentials for automated updates

Follow Google's guide:
<https://developer.chrome.com/docs/webstore/using-api>

1. In Google Cloud Console, create an OAuth client (type **Desktop app**) and
   enable the **Chrome Web Store API**. This gives you a **client ID** and
   **client secret**. (On the OAuth consent screen, add your Google account as a
   **test user** — the app can stay in "Testing".)
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

## Shipping an update

```bash
# bump the version (single source of truth: package.json)
npm version patch            # or minor / major  -> creates a vX.Y.Z git tag
git push --follow-tags
```

The tag push triggers `release.yml`, which:

1. installs, lints, tests (with coverage), and packages the zip;
2. creates a GitHub release with the zip attached and auto-generated notes;
3. uploads the zip to the Chrome Web Store and publishes it.

> `npm version` writes the version into `package.json`; `scripts/build.mjs`
> copies it into `dist/manifest.json` at build time, so the two never drift.

## Local testing before you publish

1. `npm run build`
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select the `dist/` folder.
3. Open the popup with the toolbar button or `Ctrl/Cmd+Shift+Space`.

## Firefox (AMO)

The same source also builds a Firefox add-on. `npm run build:firefox` emits
`dist-firefox/` (event-page background + a `browser_specific_settings.gecko`
id), and `npm run package` produces `myapps-launcher-firefox-vX.Y.Z.zip`
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
