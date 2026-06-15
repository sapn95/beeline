// Service worker: first-run setup + automatic My Apps sync.
//
// Sync can only read My Apps when a signed-in My Apps tab is loaded (an
// extension can't log in to Entra headlessly), so we sync opportunistically:
//   1. whenever a My Apps tab finishes loading (you visit the portal), and
//   2. on a periodic alarm, against an already-open My Apps tab.
// An empty/failed scrape is NEVER reconciled, so a logged-out or half-loaded
// page can't wipe your list.

import { scrapeAppsFromDocument } from './lib/importer.js';
import { reconcileApps } from './lib/apps.js';
import { getApps, saveApps } from './lib/storage.js';

const MYAPPS_PREFIX = 'https://myapplications.microsoft.com/';
const MYAPPS_PATTERN = 'https://myapplications.microsoft.com/*';
const SYNC_ALARM = 'beeline-sync';
const SYNC_PERIOD_MIN = 360; // every 6 hours
const VISIT_DEBOUNCE_MS = 15000;

const lastSync = new Map(); // tabId -> timestamp, debounces the SPA's repeated 'complete' events

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
  ensureAlarm();
});

chrome.runtime.onStartup.addListener(ensureAlarm);

function ensureAlarm() {
  chrome.alarms.get(SYNC_ALARM, (existing) => {
    if (!existing) chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncOpenTab();
});

// Auto-sync whenever you land on My Apps.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab.url || !tab.url.startsWith(MYAPPS_PREFIX)) return;
  const now = Date.now();
  if (now - (lastSync.get(tabId) || 0) < VISIT_DEBOUNCE_MS) return;
  lastSync.set(tabId, now);
  // Let the SPA render its tiles before scraping.
  setTimeout(() => syncTab(tabId), 4000);
});

async function syncOpenTab() {
  const [tab] = await chrome.tabs.query({ url: MYAPPS_PATTERN });
  if (tab) await syncTab(tab.id);
}

async function syncTab(tabId) {
  const allowed = await chrome.permissions
    .contains({ origins: [MYAPPS_PATTERN] })
    .catch(() => false);
  if (!allowed) return;

  let scraped = [];
  try {
    // A few scroll+scrape rounds to load lazy/virtualised tiles. Kept short so
    // the worker doesn't get killed mid-run.
    for (let i = 0; i < 4; i++) {
      await chrome.scripting.executeScript({ target: { tabId }, func: scrollToBottom });
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrapeAppsFromDocument,
      });
      const got = res?.[0]?.result ?? [];
      if (got.length > scraped.length) scraped = got;
      await wait(800);
    }
  } catch {
    return; // sign-in origin / page not ready
  }

  if (scraped.length === 0) return; // never reconcile (delete) on an empty scrape

  const existing = await getApps();
  const reconciled = reconcileApps(existing, scraped);
  if (JSON.stringify(reconciled) !== JSON.stringify(existing)) {
    try {
      await saveApps(reconciled);
    } catch {
      /* quota or transient error — leave the list as-is */
    }
  }
}

// Injected into the My Apps page.
function scrollToBottom() {
  window.scrollTo(0, document.body.scrollHeight);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
