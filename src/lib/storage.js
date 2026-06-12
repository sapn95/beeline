// Promise wrappers around chrome.storage.
//
// The curated app list lives in `sync` so it follows the user across their
// signed-in Chrome instances. The high-write, device-specific launch stats live
// in `local`. Settings are small and live in `sync`.
//
// NOTE: chrome.storage.sync has an ~8 KB-per-item / ~100 KB-total quota. A very
// large app list could exceed it; if that ever happens, move APPS_KEY to
// `local` (see docs/architecture.md). All accessors degrade gracefully to
// in-memory defaults when chrome.storage is unavailable (e.g. in unit tests
// that don't stub it).

const APPS_KEY = 'apps';
const STATS_KEY = 'stats';
const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = { openInNewTab: true, closeAfterLaunch: true };

function syncArea() {
  return globalThis.chrome && chrome.storage ? chrome.storage.sync : null;
}

function localArea() {
  return globalThis.chrome && chrome.storage ? chrome.storage.local : null;
}

export async function getApps() {
  const area = syncArea();
  if (!area) return [];
  const res = await area.get(APPS_KEY);
  return Array.isArray(res && res[APPS_KEY]) ? res[APPS_KEY] : [];
}

export async function saveApps(apps) {
  const area = syncArea();
  if (area) await area.set({ [APPS_KEY]: apps });
}

export async function getStats() {
  const area = localArea();
  if (!area) return {};
  const res = await area.get(STATS_KEY);
  const stats = res && res[STATS_KEY];
  return stats && typeof stats === 'object' ? stats : {};
}

export async function recordLaunch(id, now) {
  const area = localArea();
  const stats = await getStats();
  const cur = stats[id] || { count: 0, lastLaunched: 0 };
  stats[id] = { count: cur.count + 1, lastLaunched: now || cur.lastLaunched };
  if (area) await area.set({ [STATS_KEY]: stats });
  return stats;
}

export async function getSettings() {
  const area = syncArea();
  if (!area) return { ...DEFAULT_SETTINGS };
  const res = await area.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...((res && res[SETTINGS_KEY]) || {}) };
}

export async function saveSettings(settings) {
  const area = syncArea();
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  if (area) await area.set({ [SETTINGS_KEY]: merged });
  return merged;
}
