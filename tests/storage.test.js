import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getApps,
  saveApps,
  mutateApps,
  getStats,
  recordLaunch,
  getSettings,
  saveSettings,
  DEFAULT_SETTINGS,
} from '../src/lib/storage.js';

// In-memory stand-in for a chrome.storage area.
function makeArea() {
  const store = {};
  return {
    get: async (key) => (key in store ? { [key]: store[key] } : {}),
    set: async (obj) => {
      Object.assign(store, obj);
    },
  };
}

beforeEach(() => {
  globalThis.chrome = { storage: { sync: makeArea(), local: makeArea() } };
});

afterEach(() => {
  delete globalThis.chrome;
});

describe('apps storage', () => {
  it('returns [] before anything is saved', async () => {
    expect(await getApps()).toEqual([]);
  });

  it('round-trips the app list', async () => {
    const apps = [{ id: '1', name: 'A', url: 'https://a.com/' }];
    await saveApps(apps);
    expect(await getApps()).toEqual(apps);
  });
});

describe('corrupt storage', () => {
  it('returns [] when the stored apps value is not an array', async () => {
    // Anything else reaches renderList()/rankApps as a non-array and throws,
    // which would leave the user with a dead page instead of an empty list.
    await globalThis.chrome.storage.local.set({ apps: { not: 'an array' } });
    expect(await getApps()).toEqual([]);
  });
});

describe('mutateApps', () => {
  it('reads, applies the mutator, and persists the result', async () => {
    await saveApps([{ id: '1', name: 'A', url: 'https://a.com/' }]);
    const result = await mutateApps((current) => [
      ...current,
      { id: '2', name: 'B', url: 'https://b.com/' },
    ]);
    expect(result.map((a) => a.id)).toEqual(['1', '2']);
    expect((await getApps()).map((a) => a.id)).toEqual(['1', '2']);
  });

  it('persists nothing when the mutator returns undefined', async () => {
    await saveApps([{ id: '1', name: 'A', url: 'https://a.com/' }]);
    const result = await mutateApps(() => undefined);
    expect(result.map((a) => a.id)).toEqual(['1']); // returns the unchanged current list
    expect((await getApps()).map((a) => a.id)).toEqual(['1']);
  });

  it('uses the Web Locks API to serialise when available', async () => {
    const calls = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name, fn) => {
          calls.push(name);
          return fn();
        },
      },
    });
    try {
      await mutateApps((current) => [...current, { id: '9', name: 'Z', url: 'https://z.com/' }]);
      expect(calls).toEqual(['beeline-apps']);
      expect((await getApps()).map((a) => a.id)).toEqual(['9']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('launch stats', () => {
  it('increments count and updates lastLaunched', async () => {
    await recordLaunch('x', 123);
    await recordLaunch('x', 456);
    const stats = await getStats();
    expect(stats.x).toEqual({ count: 2, lastLaunched: 456 });
  });

  it('keeps the previous timestamp when now is falsy', async () => {
    await recordLaunch('x', 456);
    await recordLaunch('x', 0);
    expect((await getStats()).x).toEqual({ count: 2, lastLaunched: 456 });
  });
});

describe('settings', () => {
  it('returns defaults when unset', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('merges and persists partial settings', async () => {
    await saveSettings({ openInNewTab: false });
    const s = await getSettings();
    expect(s.openInNewTab).toBe(false);
    expect(s.closeAfterLaunch).toBe(DEFAULT_SETTINGS.closeAfterLaunch);
  });
});

describe('without chrome available', () => {
  it('degrades to safe defaults', async () => {
    delete globalThis.chrome;
    expect(await getApps()).toEqual([]);
    expect(await getStats()).toEqual({});
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    await expect(saveApps([])).resolves.toBeUndefined();
  });
});

describe('container settings live on this machine only', () => {
  const WORK = 'firefox-container-2';

  it('carries a pre-split value over, once', async () => {
    // Someone who set the filter before the split has it in the synced blob and
    // nothing locally. Dropping it outright would silently reset their choice.
    await chrome.storage.sync.set({ settings: { hiddenContainers: [WORK] } });
    await expect(getSettings()).resolves.toMatchObject({ hiddenContainers: [WORK] });
  });

  it('lets this machine overrule whatever is in sync', async () => {
    // A cookieStoreId is per profile, so a synced value is another machine's
    // container. Once this one has an answer of its own, that answer wins.
    await chrome.storage.sync.set({ settings: { hiddenContainers: [WORK] } });
    await chrome.storage.local.set({ localSettings: { hiddenContainers: [] } });
    await expect(getSettings()).resolves.toMatchObject({ hiddenContainers: [] });
  });

  it('never writes a container id into sync', async () => {
    await saveSettings({ theme: 'dark', hiddenContainers: [WORK] });
    const synced = (await chrome.storage.sync.get('settings')).settings;
    const here = (await chrome.storage.local.get('localSettings')).localSettings;
    expect(synced.hiddenContainers).toBeUndefined();
    expect(synced.theme).toBe('dark');
    expect(here.hiddenContainers).toEqual([WORK]);
  });

  it('still returns everything it was given', async () => {
    await expect(saveSettings({ hiddenContainers: [WORK] })).resolves.toMatchObject({
      hiddenContainers: [WORK],
    });
  });
});
