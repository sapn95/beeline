// @vitest-environment jsdom
//
// The service worker syncs in the background, where nobody is watching — so the
// rules that keep it safe are the ones under test: never scrape without
// permission, never fight a manual import, and never remove an app.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeChrome, rebuildInjected, flush } from './helpers/extension.js';
import { appId } from '../src/lib/apps.js';

const MYAPPS_URL = 'https://myapplications.microsoft.com/';
const app = (name, url, source) => ({ id: appId(url), name, url, source });
const EXISTING = [app('Wiki', 'https://wiki.example.com/', 'manual')];

async function boot({ local = { apps: EXISTING }, granted = true, chromeOptions = {} } = {}) {
  globalThis.chrome = makeChrome({ local, granted, ...chromeOptions });
  document.body.innerHTML = '';
  vi.resetModules();
  await import('../src/background.js');
  await flush();
  return globalThis.chrome;
}

/** A My Apps tile the injected scraper will pick up. */
function addTile(name, id) {
  const a = document.createElement('a');
  a.href = `https://launcher.myapps.microsoft.com/api/signin/${id}`;
  a.setAttribute('aria-label', name);
  document.body.append(a);
}

/** Let the sync loop (scrape → scroll → wait 600ms, up to 40 rounds) finish. */
async function runSync(ms = 40000, step = 200) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(step);
  }
}

const storedApps = () => globalThis.chrome.storage.local.store.apps;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.chrome;
});

describe('first run and alarms', () => {
  it('opens the options page on install and schedules the periodic sync', async () => {
    const c = await boot();
    await c.runtime.onInstalled.emit({ reason: 'install' });
    await flush();
    expect(c.runtime.openOptionsPage).toHaveBeenCalled();
    expect(c.alarms.get).toHaveBeenCalledWith('beeline-sync'); // same name it creates
    expect(c.alarms.create).toHaveBeenCalledWith('beeline-sync', { periodInMinutes: 360 });
  });

  it('does not reopen the options page on an update', async () => {
    const c = await boot();
    await c.runtime.onInstalled.emit({ reason: 'update' });
    await flush();
    expect(c.runtime.openOptionsPage).not.toHaveBeenCalled();
    expect(c.alarms.create).toHaveBeenCalled();
  });

  it('keeps an existing alarm instead of resetting its schedule', async () => {
    const c = await boot();
    c.alarms.get = vi.fn(async () => ({ name: 'beeline-sync' }));
    await c.runtime.onStartup.emit();
    await flush();
    expect(c.alarms.create).not.toHaveBeenCalled();
  });
});

describe('syncing when you visit My Apps', () => {
  it('syncs once the page has finished loading', async () => {
    const c = await boot();
    addTile('App 1', '1');
    await c.tabs.onUpdated.emit(11, { status: 'complete' }, { url: `${MYAPPS_URL}?x=1` });
    await runSync();
    expect(storedApps().map((a) => a.name)).toEqual(expect.arrayContaining(['Wiki', 'App 1']));
  });

  it('ignores half-loaded pages and other sites', async () => {
    const c = await boot();
    addTile('App 1', '1');
    await c.tabs.onUpdated.emit(11, { status: 'loading' }, { url: MYAPPS_URL });
    await c.tabs.onUpdated.emit(12, { status: 'complete' }, { url: 'https://example.com/' });
    await c.tabs.onUpdated.emit(13, { status: 'complete' }, {});
    await runSync(5000);
    expect(c.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('debounces the SPA firing "complete" over and over', async () => {
    const c = await boot();
    addTile('App 1', '1');
    await c.tabs.onUpdated.emit(11, { status: 'complete' }, { url: MYAPPS_URL });
    await c.tabs.onUpdated.emit(11, { status: 'complete' }, { url: MYAPPS_URL });
    await vi.advanceTimersByTimeAsync(5000);
    // One debounced sync, not two: both runs would interleave their scrolling.
    expect(c.permissions.contains).toHaveBeenCalledTimes(1);
    await runSync();
  });
});

describe('the periodic alarm', () => {
  it('syncs the first live My Apps tab, skipping discarded ones', async () => {
    const c = await boot();
    c.tabs.query = vi.fn(async () => [
      { id: 5, discarded: true },
      { id: 6, discarded: false },
    ]);
    addTile('App 1', '1');
    await c.alarms.onAlarm.emit({ name: 'beeline-sync' });
    await runSync();
    // It must look for My Apps tabs specifically — not inject into any old tab.
    expect(c.tabs.query).toHaveBeenCalledWith({ url: 'https://myapplications.microsoft.com/*' });
    expect(c.scripting.executeScript.mock.calls[0][0].target).toEqual({ tabId: 6 });
  });

  it('does nothing when no My Apps tab is open, or for another alarm', async () => {
    const c = await boot();
    await c.alarms.onAlarm.emit({ name: 'beeline-sync' }); // tabs.query -> []
    await c.alarms.onAlarm.emit({ name: 'some-other-alarm' });
    await runSync(5000);
    expect(c.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe('safety rules', () => {
  async function visit(c, ms) {
    await c.tabs.onUpdated.emit(11, { status: 'complete' }, { url: MYAPPS_URL });
    await runSync(ms);
  }

  it('never scrapes without the host permission', async () => {
    const c = await boot({ granted: false });
    addTile('App 1', '1');
    await visit(c);
    // Asserts the ORIGIN it checks, not just that it checked something.
    expect(c.permissions.contains).toHaveBeenCalledWith({
      origins: ['https://myapplications.microsoft.com/*'],
    });
    expect(c.scripting.executeScript).not.toHaveBeenCalled();
    expect(storedApps()).toEqual(EXISTING);
  });

  it('stands down while a manual import owns the grid', async () => {
    const c = await boot({ local: { apps: EXISTING, beelineImporting: Date.now() } });
    addTile('App 1', '1');
    await visit(c);
    expect(c.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('resumes when a crashed import left a stale flag behind', async () => {
    const c = await boot({
      local: { apps: EXISTING, beelineImporting: Date.now() - 10 * 60 * 1000 },
    });
    addTile('App 1', '1');
    await visit(c);
    expect(storedApps().map((a) => a.name)).toContain('App 1');
  });

  it('adds new apps but never removes ones missing from the scrape', async () => {
    const stale = app('Retired', 'https://retired.example.com/', 'myapps');
    const c = await boot({ local: { apps: [...EXISTING, stale] } });
    addTile('App 1', '1');
    await visit(c);
    const names = storedApps().map((a) => a.name);
    expect(names).toContain('App 1');
    expect(names).toContain('Retired'); // only a full manual import may prune
    // Tagged as scraped, so a later complete import may prune it; an untagged
    // record would linger forever and lose its badge.
    expect(storedApps().find((a) => a.name === 'App 1').source).toBe('myapps');
  });

  it('writes nothing when the scrape brings nothing new', async () => {
    // The stored name still needs the hyphen heal, so merging an EMPTY scrape
    // would produce a different list and write — unless the empty-scrape guard
    // returns first, which is exactly what this pins.
    const c = await boot({
      local: { apps: [{ ...app('X -Y', 'https://x.example.com/'), source: 'myapps' }] },
    });
    await visit(c); // no tiles in the page at all
    expect(c.storage.local.set).not.toHaveBeenCalled();
  });

  it('writes nothing when every scraped app is already stored', async () => {
    const known = app('App 1', 'https://launcher.myapps.microsoft.com/api/signin/1', 'myapps');
    const c = await boot({ local: { apps: [known] } });
    addTile('App 1', '1');
    await visit(c);
    expect(c.storage.local.set).not.toHaveBeenCalled();
  });

  it('gives up quietly when the page cannot be scripted', async () => {
    const c = await boot();
    c.scripting.executeScript = vi.fn(async () => {
      throw new Error('Cannot access contents of the page');
    });
    await visit(c);
    expect(c.storage.local.set).not.toHaveBeenCalled();
  });

  it('abandons an injection that outlives its timeout', async () => {
    const c = await boot();
    // Resolves with real tiles, but long after the 8s injection timeout. Without
    // that timeout the loop would wait, get the result, and store it — so this
    // "nothing was written" really does prove the timeout fired.
    c.scripting.executeScript = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve([{ result: [{ name: 'Late', url: 'https://late.example.com/' }] }]),
            20000,
          );
        }),
    );
    // Budget far beyond the late result, so "nothing stored" can only mean the
    // 8s timeout fired and the answer was thrown away.
    await visit(c, 260000);
    expect(c.scripting.executeScript).toHaveBeenCalled();
    expect(storedApps().map((a) => a.name)).not.toContain('Late');
    expect(c.storage.local.set).not.toHaveBeenCalled();
  });

  it.each(['scrapeAppsFromDocument', 'scrollStep'])(
    'abandons the round when the %s injection outlives its timeout',
    async (slow) => {
      const c = await boot();
      const run = c.scripting.executeScript;
      // Only ONE of the two injections is slow, so each timeout is pinned on its
      // own rather than the pair being covered collectively. It DOES resolve —
      // 20s late — so without the 8s timeout the loop would happily use the
      // result and write; "nothing written" can only mean the timeout fired.
      c.scripting.executeScript = vi.fn((args) => {
        if (args.func.name !== slow) return run(args);
        return new Promise((resolve) => {
          setTimeout(
            () => resolve([{ result: [{ name: 'Late', url: 'https://late.example.com/' }] }]),
            20000,
          );
        });
      });
      addTile('App 1', '1');
      await visit(c, 260000);
      expect(c.storage.local.set).not.toHaveBeenCalled();
    },
  );

  it('stands down when the import flag cannot even be read', async () => {
    const c = await boot();
    c.storage.local.get = vi.fn(async (key) => {
      if (key === 'beelineImporting') throw new Error('storage unavailable');
      return { apps: EXISTING };
    });
    addTile('App 1', '1');
    await visit(c);
    // Can't prove a manual import isn't running -> must not scroll the same grid.
    expect(c.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('injects only self-contained functions', async () => {
    const c = await boot();
    const injected = [];
    const run = c.scripting.executeScript;
    c.scripting.executeScript = vi.fn(async (args) => {
      injected.push(args.func);
      return run(args);
    });
    addTile('App 1', '1');
    await visit(c);
    expect(injected.length).toBeGreaterThanOrEqual(2); // scrape + scroll step
    for (const func of new Set(injected)) {
      expect(() => rebuildInjected(func)(), func.name).not.toThrow();
    }
  });

  it('survives a storage write that fails', async () => {
    const c = await boot();
    c.storage.local.set = vi.fn(async () => {
      throw new Error('QUOTA_BYTES exceeded');
    });
    addTile('App 1', '1');
    // The list must survive untouched, and the rejection must be swallowed — an
    // unhandled one would fail this run through Vitest's rejection reporter.
    await expect(visit(c)).resolves.toBeUndefined();
    expect(storedApps()).toEqual(EXISTING);
  });
});
