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
4. **Nothing from your bookmarks.** If you switch on the optional _"Also search
   this browser's bookmarks"_ setting, Beeline reads your bookmarks from the
   browser **while the launcher popup is open**, purely to show matching ones in
   the result list. They are **not stored** by Beeline, not copied into your app
   list, and not sent anywhere. Switching the setting off (or revoking the
   permission in your browser's extension settings) stops the reading
   immediately.

Beeline does **not** collect personally identifiable information, health data,
financial or payment data, authentication data, personal communications,
location, or your web browsing history.

## Where the data is stored

- The app list and usage counts are stored in `chrome.storage.local`.
- A few small settings are stored in `chrome.storage.sync`.

This data stays within your browser. If you have **Chrome Sync** enabled,
Chrome itself may synchronise the `chrome.storage.sync` settings across your
signed-in devices via your Google Account. That synchronisation is performed by
Google under Google's own privacy policy; the Beeline developer has no access to
it.

## Permissions and why they are used

- **storage** — to save your app list, preferences, and local usage counts.
- **scripting** — used only to read the app names and URLs from your My Apps tab
  (when you import, or when Beeline auto-syncs as you visit My Apps). A small
  function bundled inside the extension is injected for this; no remotely-hosted
  code is ever loaded or executed.
- **alarms** — to schedule a periodic background check that refreshes the list
  from an already-open My Apps tab.
- **search** — only used if you enable the "web" fallback: it runs your typed
  query in your browser's default search engine when no app matches.
- **favicon** _(Chrome only; the Firefox build ships without it)_ — to show each entry's site icon in the launcher. It reads the
  icon your browser has **already cached locally** for a page you have visited.
  No network request is made, no page is read, and nothing is transmitted. Only
  entries that carry no icon of their own (bookmarks, apps whose tenant uploaded
  no logo, apps you added by hand) are looked up this way.
- **Host access to `https://myapplications.microsoft.com/*`** — an _optional_
  permission, requested the first time you import, and used solely to read your
  own app tiles from that page (on import and on auto-sync).
- **bookmarks** — an _optional_ permission, requested only when you switch on
  "Also search this browser's bookmarks", and used solely to list matching
  bookmarks in the launcher popup. Switching the setting off gives the
  permission back. Nothing from your bookmarks is stored or transmitted.
- **contextualIdentities** _(Firefox only)_ — to read the **names and colours**
  of your containers, so an app can say which one it belongs to and be opened
  there. Firefox offers no optional form of this permission, which is why it is
  requested up front. It reads nothing else: not what is in a container, not
  what you do in one.
- **cookies** _(Firefox only)_ — an _optional_ permission, requested the first
  time you choose a container. Despite the name, Beeline never reads or writes a
  cookie: this permission is simply what makes Firefox honour "open this tab in
  that container" (`cookieStoreId`) at all. Without it a container-pinned app
  would silently open in the ordinary context.

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
<https://github.com/sapn95/beeline/issues>, or use the publisher contact
email shown on the extension's Chrome Web Store listing.
