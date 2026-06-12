# Architecture

Beeline is a Manifest V3 Chrome extension with **no runtime dependencies** and
no build-time bundler — the source under `src/` is the artifact. `npm run build`
just copies `src/` into `dist/` and stamps the manifest version.

> Diagrams use Mermaid — it renders natively on GitHub.

## Components

```mermaid
flowchart TB
  user(["User"])

  subgraph ext["Extension · Manifest V3"]
    direction TB
    popup["popup.js<br/>search · rank · launch"]
    options["options.js<br/>add · import · export · settings"]
    bg["background.js<br/>opens options on first install"]

    subgraph lib["src/lib — pure logic, unit-tested"]
      direction LR
      ranking["ranking.js"] --> fuzzy["fuzzy.js"]
      apps["apps.js"]
      importer["importer.js"]
      storage["storage.js"]
    end
  end

  store[("chrome.storage")]
  myapps[["My Apps tab<br/>myapplications.microsoft.com"]]
  opened[["Opened app · via SSO"]]

  user -->|"⌘/Ctrl + Shift + Space"| popup
  bg -. first run .-> options

  popup --> ranking
  popup --> storage
  popup -->|"chrome.tabs.create"| opened

  options --> apps
  options --> storage
  options -->|"chrome.scripting"| importer
  importer -->|"reads app tiles"| myapps

  storage <-->|"sync: apps + settings<br/>local: launch stats"| store

  classDef pure fill:#eef6ff,stroke:#5b8def,color:#15325b;
  classDef extern fill:#fff7e6,stroke:#e0a93b,color:#5b4413;
  class ranking,fuzzy,apps,importer,storage pure;
  class store,myapps,opened extern;
```

## Import flow

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant O as options.js
  participant Perm as chrome.permissions
  participant Scr as chrome.scripting
  participant Tab as My Apps tab
  participant St as storage.js

  U->>O: Click "Import from My Apps"
  O->>Perm: request(myapplications.microsoft.com)
  Perm-->>O: granted (or denied → stop)
  O->>Scr: executeScript(scrapeAppsFromDocument)
  Scr->>Tab: run in page context
  Tab-->>O: [ { name, url, iconUrl } ]
  O->>O: mergeApps() — dedupe by URL hash
  O->>St: saveApps()
  St-->>U: launcher list updated
```

## Why this shape

- **The `src/lib/` core is pure** — no `chrome` APIs or DOM globals in the hot
  path — so it is fully unit-testable and carries the coverage gate (see
  `vitest.config.js`). UI glue (`popup`, `options`, `background`) is thin and
  verified by load-unpacked smoke testing.
- **Least privilege.** The manifest requests only `storage` and `scripting`.
  Access to `myapplications.microsoft.com` is an _optional_ host permission,
  requested the moment the user clicks **Import from My Apps** and never before.
- **The importer is injected, not bundled.** `scrapeAppsFromDocument` is passed
  to `chrome.scripting.executeScript({ func })`, so it must stay self-contained
  (no imports). It is exported only so the unit test can run it against a jsdom
  fixture.
- **Stable identity.** Each app's id is an FNV-1a hash of its canonical URL, so
  re-importing never duplicates an app and launch stats survive re-imports.

## Storage layout

| Key        | Area    | Contents                            | Why                                      |
| ---------- | ------- | ----------------------------------- | ---------------------------------------- |
| `apps`     | `sync`  | curated app list                    | follows the user across signed-in Chrome |
| `settings` | `sync`  | open-in-new-tab, close-after-launch | small, user-level                        |
| `stats`    | `local` | per-app `{count, lastLaunched}`     | high-write, device-specific              |

> NOTE: `chrome.storage.sync` has an ~8 KB-per-item / ~100 KB-total quota. For a
> very large app list, move `apps` to `local` in `src/lib/storage.js`.

## Data flow: ranking

`rankApps(apps, query, now, stats)` scores each app as
`fuzzyScore(name) + usageBoost(stats)`, falling back to a (weighted) host match
when the name doesn't match, then sorts best-first with an alphabetical
tiebreak. Matched character positions are returned so the popup can `<mark>`
them.
