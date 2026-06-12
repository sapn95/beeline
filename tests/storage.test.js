import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getApps,
  saveApps,
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
