// Service worker: first-run setup + automatic My Apps sync.
//
// Sync can only read My Apps when a signed-in My Apps tab is loaded (an
// extension can't log in to Entra headlessly), so we sync opportunistically:
//   1. whenever a My Apps tab finishes loading (you visit the portal), and
//   2. on a periodic alarm, against an already-open My Apps tab.
// Both triggers can be switched off independently in the options page.
//
// An empty/failed scrape is NEVER acted on, so a logged-out or half-loaded page
// can't touch your list. Removal has three further rails on top of that — see
// "When a read may remove" below.

import { scrapeAppsFromDocument, scrollMyAppsStepInPage } from './lib/importer.js';
import {
  applySyncRead,
  isSuspectRead,
  mergeApps,
  migrateStats,
  normalizeAppList,
} from './lib/apps.js';
import {
  mutateApps,
  getApps,
  getStats,
  saveStats,
  getSettings,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
} from './lib/storage.js';
import { accumulateApps } from './lib/collector.js';

const MYAPPS_PREFIX = 'https://myapplications.microsoft.com/';
const MYAPPS_PATTERN = 'https://myapplications.microsoft.com/*';
const SYNC_ALARM = 'beeline-sync';
const VISIT_DEBOUNCE_MS = 15000;
const READ_BUDGET_MS = 90000; // walking a few hundred tiles takes a while
// While a manual import is in progress it OWNS the My Apps grid's scrolling. If
// auto-sync also scrolled it, the two interleave, skip virtualised slices, and a
// read could strike apps that are perfectly present. options.js sets this flag (a
// timestamp) for the duration; we treat it as live for a bounded window so a
// crashed import can't pause sync forever.
const IMPORT_FLAG = 'beelineImporting';
const IMPORT_FLAG_TTL_MS = 5 * 60 * 1000;

const lastSync = new Map(); // tabId -> timestamp, debounces the SPA's repeated 'complete' events

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
  ensureAlarm();
  healIdentities();
});

/**
 * One-off on install/update: an app's id comes from its URL, so changing what
 * counts as identity renames every record. Re-key the launch stats first, then
 * re-normalise the list — which is what actually collapses two tiles that were
 * only ever one app (a portal handing out Planner twice, once per locale).
 * Order matters: the stats have to be moved while the OLD ids are still what
 * `legacyAppId` reconstructs from the stored URL.
 */
async function healIdentities() {
  try {
    const apps = await getApps();
    if (apps.length === 0) return;
    const moved = migrateStats(apps, await getStats());
    if (moved) await saveStats(moved);
    await mutateApps((current) => {
      const cleaned = normalizeAppList(current);
      return JSON.stringify(cleaned) === JSON.stringify(current) ? undefined : cleaned;
    });
  } catch {
    /* storage unavailable — the options page heals the list on its next load */
  }
}

chrome.runtime.onStartup.addListener(ensureAlarm);

// Re-arm as soon as the interval is changed in the options page, rather than
// leaving the old period running until the next browser restart.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes?.[SETTINGS_KEY]) ensureAlarm();
});

async function settings() {
  return await getSettings().catch(() => ({ ...DEFAULT_SETTINGS }));
}

async function ensureAlarm() {
  const { syncIntervalMin } = await settings();
  // Promise form works on both Chrome (MV3) and Firefox; the callback form does
  // not. A failed read must not become an unhandled rejection in the worker.
  const existing = await chrome.alarms.get(SYNC_ALARM).catch(() => null);
  if (!syncIntervalMin) {
    if (existing) await chrome.alarms.clear(SYNC_ALARM).catch(() => {});
    return;
  }
  // create() replaces an alarm of the same name, so this both arms a missing one
  // and re-periods an existing one after a settings change. An alarm that
  // already has the right period is left alone: re-creating it restarts its
  // phase, so a browser opened every morning would keep pushing the sync back.
  // An alarm that does not report a period is taken at its word.
  if (existing && (existing.periodInMinutes ?? syncIntervalMin) === syncIntervalMin) return;
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: syncIntervalMin });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncOpenTab();
});

// Auto-sync whenever you land on My Apps.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab.url?.startsWith(MYAPPS_PREFIX)) return;
  const now = Date.now();
  if (now - (lastSync.get(tabId) || 0) < VISIT_DEBOUNCE_MS) return;
  lastSync.set(tabId, now);
  // Let the SPA render its tiles before scraping. The setting is read inside, so
  // the debounce above stays synchronous and two events can't both slip past it.
  setTimeout(async () => {
    if ((await settings()).syncOnVisit) syncTab(tabId);
  }, 4000);
});

async function syncOpenTab() {
  // Sync the first LIVE My Apps tab. Skipping discarded/frozen tabs avoids
  // hanging executeScript; checking all matches (not just the first) means one
  // discarded tab doesn't make the alarm skip a live one. An ACTIVE tab is worth
  // more than a background one (see below), so prefer one if there is a choice.
  // Rejects when the optional My Apps origin has not been granted yet.
  const tabs = await chrome.tabs.query({ url: MYAPPS_PATTERN }).catch(() => []);
  const live = tabs.filter((t) => !t.discarded);
  const best = live.find((t) => t.active) ?? live[0];
  if (best) await syncTab(best.id);
}

// Like the options page: a frozen/discarded tab can make executeScript hang, so
// bound every injection.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function syncTab(tabId) {
  const allowed = await chrome.permissions
    .contains({ origins: [MYAPPS_PATTERN] })
    .catch(() => false);
  if (!allowed) return;

  // Stand down while a manual import owns the grid (see IMPORT_FLAG). A failed
  // READ also stands down: it can't prove no import is running, and two loops
  // scrolling the same virtualised grid make each other skip tiles.
  const flag = await chrome.storage.local.get(IMPORT_FLAG).catch(() => null);
  if (!flag) return;
  const ts = flag[IMPORT_FLAG] || 0;
  if (ts && Date.now() - ts < IMPORT_FLAG_TTL_MS) return;

  // Whether the tab is the one on screen decides how much this read is worth.
  // A background tab's My Apps SPA throttles or skips rendering its virtualised
  // grid entirely, so a walk of it can come back short through no fault of the
  // user's — exactly the read that must never be allowed to remove anything.
  const onScreen = () =>
    chrome.tabs
      .get(tabId)
      .then((t) => !!t?.active)
      .catch(() => false);
  const wasForeground = await onScreen();

  const scraped = await collectTilesFromTab(tabId);
  if (!scraped || scraped.length === 0) return;

  // Asked again AFTER the walk, because the walk owns the tab for up to
  // READ_BUDGET_MS and the user is free to switch away in the middle of it. A
  // tab that started in front and finished behind was throttled for part of the
  // read, which is exactly the short read this rail exists to distrust.
  const foreground = wasForeground && (await onScreen());

  // When a read may remove, on top of the non-empty check above:
  //   1. the tab was in the foreground, so the grid really rendered;
  //   2. the read is not missing an implausible slice of the list;
  //   3. the app has now been missing from `strikes` such reads in a row.
  // Anything short of that merges: a background sync can then only ever ADD,
  // which is what it has always done. mutateApps serialises against the options
  // page so neither clobbers the other.
  try {
    await mutateApps((existing) => {
      const next =
        foreground && !isSuspectRead(existing, scraped)
          ? applySyncRead(existing, scraped).apps
          : mergeApps(existing, scraped);
      return JSON.stringify(next) === JSON.stringify(existing) ? undefined : next;
    });
  } catch {
    /* quota or transient error — leave the list as-is */
  }
}

// Walk the virtualised grid the same way the options page's Import does, so a
// background read is worth as much as a manual one and can be trusted to decide
// what is gone. Returns the tiles (tagged 'myapps'), or null when the page isn't
// ready. The bottom signal is NOT required: what matters here is how much of the
// grid was seen, which applySyncRead's rails judge for themselves.
async function collectTilesFromTab(tabId) {
  const deadline = Date.now() + READ_BUDGET_MS;
  try {
    const { apps } = await accumulateApps({
      scrapeRound: () => scrapeTab(tabId),
      scrollRound: () => scrollStep(tabId),
      sleep: wait,
      deadline,
    });
    return apps.map((a) => ({ ...a, source: 'myapps' }));
  } catch {
    return null; // sign-in origin / page not ready
  }
}

async function scrapeTab(tabId) {
  try {
    const res = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId }, func: scrapeAppsFromDocument }),
      8000,
    );
    return res?.[0]?.result ?? [];
  } catch {
    return null; // retried by the collector, never counted as an empty page
  }
}

async function scrollStep(tabId) {
  try {
    const res = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId }, func: scrollMyAppsStepInPage }),
      8000,
    );
    // null (not 0) for a missing/non-number result so a failed scroll is never
    // mistaken for "reached the bottom".
    return typeof res?.[0]?.result === 'number' ? res[0].result : null;
  } catch {
    return null;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
