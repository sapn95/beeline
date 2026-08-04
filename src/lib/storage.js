// Promise wrappers around chrome.storage.
//
// The app list and launch stats live in `local` — a My Apps import can pull
// 100+ apps, which blows past chrome.storage.sync's ~8 KB-per-item quota and
// makes set() fail. `local` has a ~10 MB budget. Small user settings stay in
// `sync` so they follow the user across signed-in Chrome instances. All
// accessors degrade gracefully to in-memory defaults when chrome.storage is
// unavailable (e.g. in unit tests that don't stub it).

const APPS_KEY = 'apps';
const STATS_KEY = 'stats';
export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = {
  openInNewTab: true,
  closeAfterLaunch: true,
  fallbackSearch: 'myapps', // 'myapps' | 'web' | 'both' | 'off'
  awsRegion: '', // when set, apps with "aws" in the name launch into this region
  theme: 'auto', // 'auto' (follow OS) | 'light' | 'dark'
  // Off by default: it needs the optional `bookmarks` permission, which the
  // options page asks for only when you tick the box.
  includeBookmarks: false,
  // How often the periodic sync runs, in minutes; 0 turns the timer off. The
  // options page offers a fixed set (see SYNC_INTERVALS) rather than a free
  // number, because a few minutes would leave the grid being walked constantly.
  syncIntervalMin: 360, // 6 hours
  // Also sync whenever you land on the My Apps portal yourself. This is the
  // trigger that can actually PRUNE, because the tab is then in the foreground
  // and the virtualised grid really renders — see background.js.
  syncOnVisit: true,
  // How a Firefox container shows up on a popup row. The name badge is on every
  // marked row whatever this says — it is the part that survives colour
  // blindness and a deleted container — and this chooses how loudly the ROW
  // itself joins in: 'chip' lets the badge do it alone, 'fill' paints the whole
  // row, 'outline' frames it, 'edge' marks the left side. The badge alone is
  // the default: it identifies the container exactly as well and leaves the
  // list quiet enough to read.
  containerStyle: 'chip', // 'chip' | 'fill' | 'outline' | 'edge'
  // Containers whose apps the popup does NOT show. Stored as the hidden set
  // rather than the shown one on purpose: an empty list then means "show
  // everything", which is the right default and the right answer on a browser
  // with no containers at all. The other way round, an empty list would be
  // indistinguishable from "the user unticked every box".
  // '' stands for the ordinary, container-less context.
  hiddenContainers: [],
};

/** The container-marking choices the options page offers. */
export const CONTAINER_STYLES = [
  { value: 'chip', label: 'Just the container badge' },
  { value: 'fill', label: 'Fill the whole row' },
  { value: 'outline', label: 'Outline the whole row' },
  { value: 'edge', label: 'Mark the left edge only' },
];

/** The periodic-sync choices the options page offers, in minutes. */
export const SYNC_INTERVALS = [
  { value: 0, label: 'Off' },
  { value: 60, label: 'Every hour' },
  { value: 360, label: 'Every 6 hours' },
  { value: 720, label: 'Every 12 hours' },
  { value: 1440, label: 'Every 24 hours' },
];

function syncArea() {
  return globalThis.chrome && chrome.storage ? chrome.storage.sync : null;
}

function localArea() {
  return globalThis.chrome && chrome.storage ? chrome.storage.local : null;
}

export async function getApps() {
  const area = localArea();
  if (!area) return [];
  const res = await area.get(APPS_KEY);
  return Array.isArray(res?.[APPS_KEY]) ? res[APPS_KEY] : [];
}

export async function saveApps(apps) {
  const area = localArea();
  if (area) await area.set({ [APPS_KEY]: apps });
}

/**
 * Atomic read-modify-write of the app list. The options page and the background
 * sync share one extension origin and both write the list, so a plain
 * get()+set() can clobber. We serialise writers with the Web Locks API (held
 * across both contexts), falling back to a direct read-modify-write where locks
 * are unavailable (e.g. unit tests). `mutator(current)` returns the next list,
 * or `undefined` to make no change. Resolves to the stored list.
 */
export async function mutateApps(mutator) {
  const run = async () => {
    const current = await getApps();
    const next = await mutator(current);
    if (next === undefined) return current;
    await saveApps(next);
    return next;
  };
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request('beeline-apps', run) : run();
}

export async function getStats() {
  const area = localArea();
  if (!area) return {};
  const res = await area.get(STATS_KEY);
  const stats = res?.[STATS_KEY];
  return stats && typeof stats === 'object' ? stats : {};
}

export async function saveStats(stats) {
  const area = localArea();
  if (area) await area.set({ [STATS_KEY]: stats });
  return stats;
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
  return { ...DEFAULT_SETTINGS, ...res?.[SETTINGS_KEY] };
}

export async function saveSettings(settings) {
  const area = syncArea();
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  if (area) await area.set({ [SETTINGS_KEY]: merged });
  return merged;
}
