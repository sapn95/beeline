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
// A previously-scraped app with no tile in the DOM: the thing a sync is
// supposed to notice is gone — and the thing a bad read must never take away.
const GONE = app('Gone', 'https://launcher.myapps.microsoft.com/api/signin/gone', 'myapps');

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
    c.alarms.get = vi.fn(async () => ({ name: 'beeline-sync', periodInMinutes: 360 }));
    await c.runtime.onStartup.emit();
    await flush();
    expect(c.alarms.create).not.toHaveBeenCalled();
  });

  it('uses the interval from the settings', async () => {
    const c = await boot({ chromeOptions: { sync: { settings: { syncIntervalMin: 60 } } } });
    await c.runtime.onStartup.emit();
    await flush();
    expect(c.alarms.create).toHaveBeenCalledWith('beeline-sync', { periodInMinutes: 60 });
  });

  it('clears the alarm when the periodic sync is switched off', async () => {
    const c = await boot({ chromeOptions: { sync: { settings: { syncIntervalMin: 0 } } } });
    c.alarms.get = vi.fn(async () => ({ name: 'beeline-sync', periodInMinutes: 360 }));
    await c.runtime.onStartup.emit();
    await flush();
    expect(c.alarms.clear).toHaveBeenCalledWith('beeline-sync');
    expect(c.alarms.create).not.toHaveBeenCalled();
  });

  it('re-arms as soon as the interval is changed', async () => {
    // Without this the old period would keep running until the next browser
    // restart, and picking "every hour" would look like it did nothing.
    const c = await boot();
    c.alarms.create.mockClear();
    c.alarms.get = vi.fn(async () => ({ name: 'beeline-sync', periodInMinutes: 360 }));
    c.storage.sync.store.settings = { syncIntervalMin: 1440 };
    await c.storage.onChanged.emit({ settings: { newValue: { syncIntervalMin: 1440 } } }, 'sync');
    await flush();
    expect(c.alarms.create).toHaveBeenCalledWith('beeline-sync', { periodInMinutes: 1440 });
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

  it('stays out of the way when the visit sync is switched off', async () => {
    const c = await boot({ chromeOptions: { sync: { settings: { syncOnVisit: false } } } });
    addTile('App 1', '1');
    await c.tabs.onUpdated.emit(11, { status: 'complete' }, { url: MYAPPS_URL });
    await runSync();
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

describe('removing apps that are gone from My Apps', () => {
  async function visit(c, ms) {
    await c.tabs.onUpdated.emit(11, { status: 'complete' }, { url: MYAPPS_URL });
    await runSync(ms);
  }

  const stored = (name) => storedApps().find((a) => a.name === name);

  it('drops an app only after two syncs in a row have missed it', async () => {
    const c = await boot({ local: { apps: [...EXISTING, GONE] } });
    addTile('App 1', '1'); // 'Gone' has no tile: it is no longer in the portal

    await visit(c);
    // One read is never enough. Any single walk of a virtualised grid can come
    // back short, so the first miss only marks the app.
    expect(stored('Gone')).toMatchObject({ missing: 1 });

    await visit(c);
    expect(stored('Gone')).toBeUndefined();
    expect(stored('Wiki')).toBeDefined(); // a manual app is never touched
    expect(stored('App 1')).toBeDefined();
  });

  it('forgives an app that turns up again', async () => {
    const c = await boot({ local: { apps: [...EXISTING, GONE] } });
    addTile('App 1', '1');
    await visit(c);
    expect(stored('Gone')).toMatchObject({ missing: 1 });

    // The tile is back, so the earlier miss was the read's fault, not the
    // portal's. The count has to reset, or two unlucky reads a week apart
    // would add up and delete an app that never went anywhere.
    addTile('Gone', 'gone');
    await visit(c);
    expect(stored('Gone').missing).toBeUndefined();
  });

  it('only ever adds when you switch away mid-read', async () => {
    // The walk owns the tab for up to 90s. A tab that started in front and
    // finished behind was throttled for part of the read, so what it did not
    // find says nothing — asking only once, before the walk, would miss this.
    const c = await boot({ local: { apps: [...EXISTING, GONE] } });
    let active = true;
    c.tabs.get = vi.fn(async () => {
      const answer = { status: 'complete', active };
      active = false; // in front when the walk starts, behind when it ends
      return answer;
    });
    addTile('App 1', '1');
    await visit(c);
    expect(stored('Gone').missing).toBeUndefined();
    expect(stored('App 1')).toBeDefined();
  });

  it('only ever adds when the tab is not the one on screen', async () => {
    // A background tab's My Apps throttles rendering, so a short read there says
    // nothing about what the user still has.
    const c = await boot({ local: { apps: [...EXISTING, GONE] } });
    c.tabs.get = vi.fn(async () => ({ status: 'complete', active: false }));
    addTile('App 1', '1');
    await visit(c);
    await visit(c);
    expect(stored('Gone')).toBeDefined();
    expect(stored('Gone').missing).toBeUndefined();
    expect(stored('App 1')).toBeDefined(); // adding still works
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

  /**
   * Make one of the two injections resolve 20s late, the other run for real.
   * `late` is that injection's own valid answer shape — a tile array for the
   * scrape, a remaining-distance number for the scroll — so a test can only
   * pass because the 8s timeout threw the answer away, never because the answer
   * was malformed and would have been ignored anyway.
   */
  function slowInjection(c, slow, late = [{ name: 'Late', url: 'https://late.example.com/' }]) {
    const run = c.scripting.executeScript;
    c.scripting.executeScript = vi.fn((args) => {
      if (args.func.name !== slow) return run(args);
      return new Promise((resolve) => {
        setTimeout(() => resolve([{ result: late }]), 20000);
      });
    });
  }

  it('abandons the round when the scrape injection outlives its timeout', async () => {
    const c = await boot();
    // It DOES resolve — 20s late — so without the 8s timeout the loop would
    // happily use the result and write. "Nothing written" can only mean the
    // timeout fired: a scrape that never answers leaves nothing to store.
    slowInjection(c, 'scrapeAppsFromDocument');
    addTile('App 1', '1');
    await visit(c, 260000);
    expect(c.storage.local.set).not.toHaveBeenCalled();
  });

  it('may add but never remove when the scroll injection times out', async () => {
    const c = await boot({ local: { apps: [...EXISTING, GONE] } });
    // A scroll that never answers means the walk cannot advance, so the read
    // only ever sees the first slice of a virtualised grid. That is a partial
    // read by definition — it is allowed to add the tile it really did see, but
    // must not conclude anything about the apps it never got to. 600 is a
    // perfectly valid scroll answer, so only the timeout explains the stall.
    slowInjection(c, 'scrollMyAppsStepInPage', 600);
    addTile('App 1', '1');
    await visit(c, 260000);
    expect(storedApps().map((a) => a.name)).toEqual(
      expect.arrayContaining(['Wiki', 'Gone', 'App 1']),
    );
  });

  it('discards a read that suddenly cannot find most of the list', async () => {
    // 20 known apps, 2 tiles rendered. Far likelier to be a read that stalled
    // than 18 apps revoked at once — so the read is dropped whole: it neither
    // removes NOR strikes, and the next sync gets to decide instead.
    const many = Array.from({ length: 20 }, (_, i) =>
      app(`App ${i}`, `https://launcher.myapps.microsoft.com/api/signin/${i}`, 'myapps'),
    );
    const c = await boot({ local: { apps: many } });
    addTile('App 0', '0');
    addTile('App 1', '1');
    await visit(c);
    expect(storedApps()).toHaveLength(20); // all still there...
    expect(storedApps().some((a) => a.missing)).toBe(false); // ...and unblemished
  });

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
