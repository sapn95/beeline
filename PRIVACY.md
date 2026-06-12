# Privacy Policy — Beeline (Fast App Launcher)

**Effective date:** 12 June 2026

Beeline is a browser extension that lets you search and open your own
Microsoft My Apps / Microsoft Entra single sign-on applications from a fast,
keyboard-driven popup. This policy explains exactly what data Beeline handles
and what it does **not** do.

## Summary

- Beeline stores your data **locally in your browser**. It does **not** send any
  of your data to the developer or to any third party.
- There is **no analytics, no telemetry, no tracking, and no advertising**.
- Beeline **never** handles your passwords, credentials, or any authentication
  data. Apps open through their normal single sign-on flow.

## What data Beeline handles

Beeline stores, only on your device:

1. **Your app list** — the names and URLs of the apps you add manually or
   import. When you choose **Import from My Apps**, Beeline reads the app tile
   names and URLs (website content) from your currently open
   `myapplications.microsoft.com` tab so it can add them to your launcher. This
   happens only when you click Import, and only on that site.
2. **Your preferences** — small settings such as "open in a new tab" and
   "close after launching."
3. **Local usage counts** — how often and how recently you launch each app, used
   only to rank your results so your most-used apps appear first.

Beeline does **not** collect personally identifiable information, health data,
financial or payment data, authentication data, personal communications,
location, or your web browsing history.

## Where the data is stored

- The app list and preferences are stored in `chrome.storage.sync`.
- Usage counts are stored in `chrome.storage.local`.

This data stays within your browser. If you have **Chrome Sync** enabled,
Chrome itself may synchronise `chrome.storage.sync` data across your signed-in
devices via your Google Account. That synchronisation is performed by Google
under Google's own privacy policy; the Beeline developer has no access to it.

## Permissions and why they are used

- **storage** — to save your app list, preferences, and local usage counts.
- **scripting** — used only when you click **Import from My Apps**, to read the
  app names and URLs from your open My Apps tab. A small function bundled inside
  the extension is injected for this; no remotely-hosted code is ever loaded or
  executed.
- **Host access to `https://myapplications.microsoft.com/*`** — an _optional_
  permission, requested only at the moment you choose to import, and used solely
  to read your own app tiles from that page.

## Data sharing

Beeline does not sell, transfer, or share your data with any third party. Your
data is not used for any purpose other than providing the launcher, and is never
used for creditworthiness or lending purposes.

## Removing your data

Removing apps in the options page deletes them from storage. Uninstalling the
extension removes all data Beeline stored on your device.

## Changes

If this policy changes, the updated version will be published in this file in the
project repository, with a new effective date.

## Contact

Questions or concerns: please open an issue at
<https://github.com/sapn95/myapps-launcher/issues>, or use the publisher contact
email shown on the extension's Chrome Web Store listing.
