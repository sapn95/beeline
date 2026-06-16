// Service worker: first-run setup + automatic My Apps sync.
//
// Sync can only read My Apps when a signed-in My Apps tab is loaded (an
// extension can't log in to Entra headlessly), so we sync opportunistically:
//   1. whenever a My Apps tab finishes loading (you visit the portal), and
//   2. on a periodic alarm, against an already-open My Apps tab.
// An empty/failed scrape is NEVER reconciled, so a logged-out or half-loaded
// page can't wipe your list.

import { scrapeAppsFromDocument } from './lib/importer.js';
import { mergeApps } from './lib/apps.js';
import { mutateApps } from './lib/storage.js';

const MYAPPS_PREFIX = 'https://myapplications.microsoft.com/';
const MYAPPS_PATTERN = 'https://myapplications.microsoft.com/*';
const SYNC_ALARM = 'beeline-sync';
const SYNC_PERIOD_MIN = 360; // every 6 hours
const VISIT_DEBOUNCE_MS = 15000;
// While a manual import is in progress it OWNS the My Apps grid's scrolling. If
// auto-sync also scrolled it, the two interleave, skip virtualised slices, and a
// "complete" read could reconcile away apps. options.js sets this flag (a
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
});

chrome.runtime.onStartup.addListener(ensureAlarm);

async function ensureAlarm() {
  // Promise form works on both Chrome (MV3) and Firefox; the callback form does not.
  const existing = await chrome.alarms.get(SYNC_ALARM);
  if (!existing) chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN });
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
  // Let the SPA render its tiles before scraping.
  setTimeout(() => syncTab(tabId), 4000);
});

async function syncOpenTab() {
  // Sync the first LIVE My Apps tab. Skipping discarded/frozen tabs avoids
  // hanging executeScript; checking all matches (not just the first) means one
  // discarded tab doesn't make the alarm skip a live one.
  const tabs = await chrome.tabs.query({ url: MYAPPS_PATTERN });
  const live = tabs.find((t) => !t.discarded);
  if (live) await syncTab(live.id);
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

  // Stand down while a manual import owns the grid (see IMPORT_FLAG).
  const flag = await chrome.storage.local.get(IMPORT_FLAG).catch(() => null);
  const ts = flag?.[IMPORT_FLAG] || 0;
  if (ts && Date.now() - ts < IMPORT_FLAG_TTL_MS) return;

  const scraped = await collectTilesFromTab(tabId);
  if (!scraped || scraped.length === 0) return;

  // Background sync only ADDS (mergeApps) — removal is left to a full manual
  // import, so a partial/throttled background read can never delete apps.
  // mutateApps serialises against the options page so neither clobbers the other.
  try {
    await mutateApps((existing) => {
      const merged = mergeApps(existing, scraped);
      return JSON.stringify(merged) === JSON.stringify(existing) ? undefined : merged;
    });
  } catch {
    /* quota or transient error — leave the list as-is */
  }
}

// Scroll through the virtualised grid, accumulating the UNION of rendered tiles
// (tagged 'myapps'). Returns the tiles, or null when the page isn't ready.
async function collectTilesFromTab(tabId) {
  const seen = new Map();
  let stable = 0;
  try {
    for (let i = 0; i < 40 && stable < 4; i++) {
      const res = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId }, func: scrapeAppsFromDocument }),
        8000,
      );
      const got = res?.[0]?.result ?? [];
      const before = seen.size;
      for (const a of got) if (a?.url) seen.set(a.url, a);
      stable = seen.size > before ? 0 : stable + 1;
      await withTimeout(
        chrome.scripting.executeScript({ target: { tabId }, func: scrollStep }),
        8000,
      );
      await wait(600);
    }
  } catch {
    return null; // sign-in origin / page not ready
  }
  return [...seen.values()].map((a) => ({ ...a, source: 'myapps' }));
}

// Injected into the My Apps page: advance window + the largest inner scroll
// container by ~a viewport so a virtualised grid renders its next slice.
function scrollStep() {
  const step = Math.round(window.innerHeight * 0.85);
  window.scrollBy(0, step);
  let target = null;
  let max = 0;
  for (const el of document.querySelectorAll('main, section, div, ul')) {
    if (el.scrollHeight - el.clientHeight > 200 && el.clientHeight > 200 && el.scrollHeight > max) {
      max = el.scrollHeight;
      target = el;
    }
  }
  if (target) target.scrollTop += step;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
