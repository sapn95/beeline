// @vitest-environment jsdom
//
// Drives the real options markup + options.js against a fake chrome API. The
// destructive paths (reconcile on import, remove all, edit-during-sync) are the
// ones that can silently lose a user's app list, so they carry the most tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeChrome,
  loadPage,
  stubDomExtras,
  stubWindowScroll,
  rebuildInjected,
  flush,
  click,
} from './helpers/extension.js';
import { appId } from '../src/lib/apps.js';

// Stored apps are always in normalised form, ids included — build the fixture
// the same way, so "load + heal" has nothing to rewrite.
const app = (name, url, source) => ({ id: appId(url), name, url, source });
const APPS = [
  app('Jira', 'https://jira.example.com/', 'myapps'),
  app('Wiki', 'https://wiki.example.com/', 'manual'),
];

/** Boot the options page with a given storage state. */
async function mount({ apps = APPS, settings = {}, chromeOptions = {} } = {}) {
  globalThis.chrome = makeChrome({ local: { apps }, sync: { settings }, ...chromeOptions });
  loadPage('options');
  vi.resetModules();
  await import('../src/options/options.js');
  await flush();
}

const $ = (id) => document.getElementById(id);
const status = () => $('status').textContent;
const rows = () => [...$('list').children];
const rowNames = () =>
  rows().map((li) => li.querySelector('.app-name')?.textContent ?? li.textContent);
const stored = () => globalThis.chrome.storage.local.store.apps;

/** A My Apps tile as the portal renders it (used by the real scraper). */
function addTile(name, id, { account = 'me@example.com', parent = document.body } = {}) {
  const a = document.createElement('a');
  a.href = `https://launcher.myapps.microsoft.com/api/signin/${id}?login_hint=${account}`;
  a.setAttribute('aria-label', name);
  const img = document.createElement('img');
  img.src = `https://cdn.example.com/${id}.png`;
  a.append(img);
  parent.append(a);
  return a;
}

/** Advance fake timers in slices so long, sleep-driven flows settle. */
async function tick(total = 30000, step = 250) {
  for (let elapsed = 0; elapsed < total; elapsed += step) {
    await vi.advanceTimersByTimeAsync(step);
  }
}

beforeEach(() => {
  stubDomExtras();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete globalThis.chrome;
});

describe('initial render', () => {
  it('lists the stored apps, badges the imported ones and shows the count', async () => {
    await mount();
    expect(rowNames()).toEqual(['Jira', 'Wiki']);
    expect($('count').textContent).toBe('2');
    expect(rows()[0].querySelector('.badge').textContent).toBe('My Apps');
    expect(rows()[1].querySelector('.badge')).toBeNull();
    expect(document.querySelector('.appver').textContent).toBe('Beeline v9.9.9');
  });

  it('shows a friendly empty state', async () => {
    await mount({ apps: [] });
    expect(rows()[0].textContent).toMatch(/No apps yet/);
  });

  it('heals legacy names saved before the hyphen fix, in place', async () => {
    await mount({ apps: [{ ...app('X -Y', 'https://sap.example.com/'), source: undefined }] });
    expect(rowNames()).toEqual(['X-Y']);
    expect(stored()[0].name).toBe('X-Y'); // written back, not just displayed
  });

  it('does not rewrite storage when nothing needs healing', async () => {
    await mount();
    expect(globalThis.chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('stays usable when the storage heal fails', async () => {
    // The page must not end up dead-but-pretty: the apps still render, the
    // failure is named, and the controls are wired (they are bound first).
    globalThis.chrome = makeChrome({
      local: { apps: [{ ...app('X -Y', 'https://x.example.com/') }] },
    });
    globalThis.chrome.storage.local.set = vi.fn(async () => {
      throw new Error('QUOTA_BYTES exceeded');
    });
    loadPage('options');
    vi.resetModules();
    await import('../src/options/options.js');
    await flush();

    // The heal could not be persisted, so the stored (uncleaned) name is what
    // is shown — honest, rather than displaying something that was not saved.
    expect(rowNames()).toEqual(['X -Y']);
    expect(status()).toMatch(/Could not read your apps: QUOTA_BYTES exceeded/);
    $('app-filter').value = 'zzz';
    $('app-filter').dispatchEvent(new Event('input'));
    expect(rows()[0].textContent).toMatch(/No apps match/); // the controls live
  });

  it('falls back to default settings when they cannot be read', async () => {
    globalThis.chrome = makeChrome({ local: { apps: APPS } });
    globalThis.chrome.storage.sync.get = vi.fn(async () => {
      throw new Error('sync unavailable');
    });
    loadPage('options');
    vi.resetModules();
    await import('../src/options/options.js');
    await flush();

    expect(rowNames()).toEqual(['Jira', 'Wiki']);
    expect(status()).toMatch(/Could not read your settings/);
    expect(document.querySelector('.appver')).not.toBeNull(); // init ran to the end
  });

  it('refuses to save settings that were never loaded', async () => {
    globalThis.chrome = makeChrome({
      local: { apps: APPS },
      sync: { settings: { openInNewTab: true, fallbackSearch: 'both', theme: 'dark' } },
    });
    globalThis.chrome.storage.sync.get = vi.fn(async () => {
      throw new Error('sync unavailable');
    });
    loadPage('options');
    vi.resetModules();
    await import('../src/options/options.js');
    await flush();

    $('theme').value = 'light';
    $('theme').dispatchEvent(new Event('change'));
    await flush();
    // The form is showing markup defaults; writing it back would silently reset
    // fallbackSearch, the region and both checkboxes.
    expect(globalThis.chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(status()).toMatch(/not loaded/);
  });

  it('offers every AWS region with the recommended ones first', async () => {
    await mount();
    const sel = $('aws-region');
    expect(sel.options[0].value).toBe('');
    expect([...sel.querySelectorAll('optgroup')].map((g) => g.label)[0]).toBe('Recommended');
    expect([...sel.options].map((o) => o.value)).toContain('eu-central-2');
  });

  it('reflects the saved settings in the form and applies the theme', async () => {
    await mount({
      settings: {
        openInNewTab: false,
        closeAfterLaunch: false,
        fallbackSearch: 'web',
        awsRegion: 'eu-central-1',
        theme: 'dark',
      },
    });
    expect($('open-in-new-tab').checked).toBe(false);
    expect($('fallback-search').value).toBe('web');
    expect($('aws-region').value).toBe('eu-central-1');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('beeline-theme')).toBe('dark');
  });

  it('saves settings when a control changes', async () => {
    await mount();
    $('theme').value = 'light';
    $('fallback-search').value = 'both';
    $('theme').dispatchEvent(new Event('change'));
    await flush();
    expect(globalThis.chrome.storage.sync.store.settings).toMatchObject({
      theme: 'light',
      fallbackSearch: 'both',
    });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(status()).toBe('Settings saved.');
  });
});

describe('adding and removing apps', () => {
  async function submitAdd(name, url) {
    $('name').value = name;
    $('url').value = url;
    $('add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
  }

  it('adds a valid app', async () => {
    await mount();
    await submitAdd('Grafana', 'https://grafana.example.com/');
    expect(rowNames()).toContain('Grafana');
    expect(stored()).toHaveLength(3);
    expect(status()).toBe('Added “Grafana”.');
    expect($('name').value).toBe(''); // the form resets
  });

  it('rejects a non-https URL instead of storing junk', async () => {
    await mount();
    await submitAdd('Bad', 'ftp://nope.example.com/');
    expect(stored()).toHaveLength(2);
    expect(status()).toMatch(/valid https:\/\/ URL/);
  });

  it('removes a single app', async () => {
    await mount();
    await click(rows()[0].querySelector('.danger'));
    expect(rowNames()).toEqual(['Wiki']);
    expect(status()).toBe('Removed.');
  });

  it('removes everything only after the confirmation', async () => {
    await mount();
    globalThis.confirm.mockReturnValueOnce(false);
    await click($('clear'));
    expect(stored()).toHaveLength(2);

    await click($('clear'));
    expect(stored()).toEqual([]);
    expect(status()).toBe('Removed all apps.');
  });

  it('does not even ask when the list is already empty', async () => {
    await mount({ apps: [] });
    await click($('clear'));
    expect(globalThis.confirm).not.toHaveBeenCalled();
  });
});

describe('filtering', () => {
  it('shows how many of the total matched', async () => {
    await mount();
    $('app-filter').value = 'jir';
    $('app-filter').dispatchEvent(new Event('input'));
    expect(rowNames()).toEqual(['Jira']);
    expect($('count').textContent).toBe('1 found · 2 total');
  });

  it('says so when nothing matches', async () => {
    await mount();
    $('app-filter').value = 'nothing-like-this';
    $('app-filter').dispatchEvent(new Event('input'));
    expect(rows()[0].textContent).toMatch(/No apps match/);
  });
});

describe('editing a row', () => {
  async function startEdit(index = 0) {
    const buttons = [...rows()[index].querySelectorAll('button')];
    await click(buttons.find((b) => b.textContent === 'Edit'));
    return rows().find((li) => li.classList.contains('editing'));
  }

  const editInputs = (row) => [...row.querySelectorAll('input[type="text"], input[type="url"]')];
  const button = (row, label) =>
    [...row.querySelectorAll('button')].find((b) => b.textContent === label);

  it('renames an app and pins it as manual so sync leaves it alone', async () => {
    await mount();
    const row = await startEdit(0);
    const [name] = editInputs(row);
    name.value = 'Jira (prod)';
    name.dispatchEvent(new Event('input'));
    await click(button(row, 'Save'));
    expect(stored().find((a) => a.name === 'Jira (prod)').source).toBe('manual');
    expect(status()).toBe('Saved “Jira (prod)”.');
  });

  it('keeps the icon when an app is renamed', async () => {
    const withIcon = { ...APPS[0], iconUrl: 'https://cdn.example.com/jira.png' };
    await mount({ apps: [withIcon, APPS[1]] });
    const row = await startEdit(0);
    const [name] = editInputs(row);
    name.value = 'Jira (prod)';
    name.dispatchEvent(new Event('input'));
    await click(button(row, 'Save'));
    // A pinned ('manual') app is never touched by a sync again, so an icon lost
    // here would be lost for good.
    expect(stored().find((a) => a.name === 'Jira (prod)').iconUrl).toBe(
      'https://cdn.example.com/jira.png',
    );
  });

  it('keeps the app linked to My Apps when the "keep my changes" box is cleared', async () => {
    await mount();
    const row = await startEdit(0);
    const keep = row.querySelector('input[type="checkbox"]');
    keep.checked = false;
    keep.dispatchEvent(new Event('change'));
    await click(button(row, 'Save'));
    expect(stored().find((a) => a.id === APPS[0].id).source).toBe('myapps');
    expect(status()).toMatch(/still linked to My Apps/);
  });

  it('remembers an unchecked "keep my changes" box across a re-render', async () => {
    await mount();
    const row = await startEdit(0);
    const keep = row.querySelector('input[type="checkbox"]');
    keep.checked = false;
    keep.dispatchEvent(new Event('change'));
    $('app-filter').value = 'j';
    $('app-filter').dispatchEvent(new Event('input')); // forces a re-render
    const again = rows().find((li) => li.classList.contains('editing'));
    expect(again.querySelector('input[type="checkbox"]').checked).toBe(false);
    await click(button(again, 'Save'));
    // Still linked to My Apps, as the user asked — not silently re-pinned.
    expect(stored().find((a) => a.id === APPS[0].id).source).toBe('myapps');
  });

  it('has no keep-checkbox for a manually added app', async () => {
    await mount();
    const row = await startEdit(1);
    expect(row.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('refuses to save an invalid URL', async () => {
    await mount();
    const row = await startEdit(0);
    editInputs(row)[1].value = 'not-a-url';
    await click(button(row, 'Save'));
    expect(status()).toMatch(/valid https:\/\/ URL/);
    expect(stored()).toHaveLength(2);
  });

  it('refuses to overwrite a different app that already owns the new URL', async () => {
    await mount();
    const row = await startEdit(0);
    editInputs(row)[1].value = 'https://wiki.example.com/'; // the OTHER app's URL
    await click(button(row, 'Save'));
    expect(status()).toMatch(/Another app already uses that URL/);
    expect(stored()).toHaveLength(2);
    expect(rows().some((li) => li.classList.contains('editing'))).toBe(true); // still editable
  });

  it('keeps what you typed across a re-render', async () => {
    await mount();
    const row = await startEdit(0);
    editInputs(row)[0].value = 'half-typed name';
    editInputs(row)[0].dispatchEvent(new Event('input'));
    $('app-filter').value = 'j';
    $('app-filter').dispatchEvent(new Event('input')); // forces a re-render
    const again = rows().find((li) => li.classList.contains('editing'));
    expect(editInputs(again)[0].value).toBe('half-typed name');
  });

  it('defers a storage change until the edit is finished, then applies it', async () => {
    await mount();
    const row = await startEdit(0);
    globalThis.chrome.storage.local.store.apps = [
      ...APPS,
      app('Added elsewhere', 'https://new.example.com/', 'myapps'),
    ];
    await globalThis.chrome.storage.onChanged.emit({ apps: {} }, 'local');
    expect(rowNames()).not.toContain('Added elsewhere'); // edit row untouched

    await click(button(row, 'Cancel'));
    await flush();
    expect(rowNames()).toContain('Added elsewhere');
  });

  it('ignores changes to other areas and other keys', async () => {
    await mount();
    globalThis.chrome.storage.local.store.apps = [];
    await globalThis.chrome.storage.onChanged.emit({ apps: {} }, 'sync');
    await globalThis.chrome.storage.onChanged.emit({ settings: {} }, 'local');
    expect(rowNames()).toEqual(['Jira', 'Wiki']);
  });

  it('re-renders when another context changes the app list', async () => {
    await mount();
    globalThis.chrome.storage.local.store.apps = [APPS[1]];
    await globalThis.chrome.storage.onChanged.emit({ apps: {} }, 'local');
    await flush();
    expect(rowNames()).toEqual(['Wiki']);
  });
});

describe('JSON export and import', () => {
  it('exports the current list as a download', async () => {
    await mount();
    await click($('export'));
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:beeline/1');
    expect(status()).toBe('Exported.');
  });

  it('exports the freshest list, including a sync deferred by an open edit', async () => {
    await mount();
    const edit = [...rows()[0].querySelectorAll('button')].find((b) => b.textContent === 'Edit');
    await click(edit); // refreshes are deferred while a row is being edited
    globalThis.chrome.storage.local.store.apps = [
      ...APPS,
      app('Added elsewhere', 'https://new.example.com/', 'myapps'),
    ];
    await globalThis.chrome.storage.onChanged.emit({ apps: {} }, 'local');

    await click($('export'));
    const blob = URL.createObjectURL.mock.calls[0][0];
    const exported = JSON.parse(await blob.text());
    expect(exported.map((a) => a.name)).toContain('Added elsewhere');
  });

  async function importFile(text) {
    const input = $('import-file');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{ text: async () => text }],
    });
    input.dispatchEvent(new Event('change'));
    await flush();
  }

  it('merges apps from a JSON file', async () => {
    await mount();
    await importFile(JSON.stringify([{ name: 'Grafana', url: 'https://grafana.example.com/' }]));
    expect(rowNames()).toContain('Grafana');
    expect(status()).toBe('Imported 1 new app(s) from file.');
  });

  it('ignores a non-array payload rather than wiping the list', async () => {
    await mount();
    await importFile(JSON.stringify({ not: 'an array' }));
    expect(stored()).toHaveLength(2);
  });

  it('distinguishes a storage failure from a bad file', async () => {
    await mount();
    globalThis.chrome.storage.local.set = vi.fn(async () => {
      throw new Error('QUOTA_BYTES exceeded');
    });
    await importFile(JSON.stringify([{ name: 'Grafana', url: 'https://grafana.example.com/' }]));
    expect(status()).toBe('Could not save the imported apps: QUOTA_BYTES exceeded');
  });

  it('reports invalid JSON', async () => {
    await mount();
    await importFile('{not json');
    expect(status()).toBe('That file is not valid JSON.');
  });

  it('does nothing when the file dialog is cancelled', async () => {
    await mount();
    const input = $('import-file');
    Object.defineProperty(input, 'files', { configurable: true, value: [] });
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(status()).toBe('');
  });
});

describe('import from My Apps', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** Replace executeScript with canned per-round scrape/scroll results. */
  function scriptStub({ scrapes, scrolls }) {
    let round = 0;
    globalThis.chrome.scripting.executeScript = vi.fn(async ({ func }) => {
      if (func.name === 'scrapeAppsFromDocument') {
        return [{ result: scrapes[Math.min(round, scrapes.length - 1)] }];
      }
      if (func.name === 'scrollMyAppsStepInPage') {
        const value = scrolls[Math.min(round, scrolls.length - 1)];
        round += 1;
        return [{ result: value }];
      }
      return [{ result: undefined }]; // the MAIN-world visibility helper
    });
  }

  const tile = (n, account = 'me@example.com') => ({
    name: `App ${n}`,
    url: `https://launcher.myapps.microsoft.com/api/signin/${n}?login_hint=${account}`,
  });

  it('cannot be started twice by an impatient double-click', async () => {
    await mount();
    addTile('App 1', '1');
    let allow;
    let asked = 0;
    globalThis.chrome.permissions.request = vi.fn(() => {
      asked += 1;
      // Only the FIRST prompt hangs; a second one would sail straight through.
      return asked === 1 ? new Promise((resolve) => (allow = resolve)) : Promise.resolve(true);
    });
    await click($('import-myapps'));
    await click($('import-myapps')); // while the permission bubble is still open
    allow(true);
    await tick();
    // Two imports would scroll the same grid and release the lock under each other.
    expect(asked).toBe(1);
    expect(globalThis.chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('stops when access is refused', async () => {
    await mount({ chromeOptions: { granted: false } });
    await click($('import-myapps'));
    await tick(1000);
    expect(status()).toBe('Permission denied — cannot read My Apps.');
    expect(globalThis.chrome.windows.create).not.toHaveBeenCalled();
  });

  it('scrapes the live page, reconciles, and reports the account', async () => {
    await mount({
      apps: [...APPS, app('Retired', 'https://retired.example.com/', 'myapps')],
    });
    addTile('App 1', '1');
    addTile('App 2', '2');

    await click($('import-myapps'));
    await tick();

    const names = stored().map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(['App 1', 'App 2', 'Wiki']));
    expect(names).not.toContain('Retired'); // a complete scrape prunes vanished apps
    expect(names).not.toContain('Jira'); // ...including previously imported ones
    expect(status()).toMatch(/Synced 2 app\(s\) from My Apps \(account: me@example\.com\)/);
    // Injected into the helper window's tab, not just "some" tab.
    // EVERY injection goes to the helper window's tab — not just the first.
    const targets = globalThis.chrome.scripting.executeScript.mock.calls.map(
      (c) => c[0].target.tabId,
    );
    expect([...new Set(targets)]).toEqual([42]);
    expect(globalThis.chrome.windows.remove).toHaveBeenCalledWith(7); // helper window closed
    expect(globalThis.chrome.storage.local.store.beelineImporting).toBe(0); // flag released
  });

  it('opens the helper window unfocused so the page keeps rendering', async () => {
    await mount();
    addTile('App 1', '1');
    await click($('import-myapps'));
    await tick();
    expect(globalThis.chrome.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'popup', focused: false }),
    );
    expect(globalThis.chrome.permissions.request).toHaveBeenCalledWith({
      origins: ['https://myapplications.microsoft.com/*'],
    });
  });

  it('waits for the My Apps tab to finish loading before scraping it', async () => {
    await mount();
    addTile('App 1', '1');
    globalThis.chrome.tabs.get = vi.fn(async () => ({ status: 'loading' }));

    await click($('import-myapps'));
    await vi.advanceTimersByTimeAsync(0); // permission + window + load listener
    expect(globalThis.chrome.scripting.executeScript).not.toHaveBeenCalled();

    await globalThis.chrome.tabs.onUpdated.emit(999, { status: 'complete' }); // another tab
    await globalThis.chrome.tabs.onUpdated.emit(42, { status: 'loading' }); // not done yet
    await vi.advanceTimersByTimeAsync(5000);
    expect(globalThis.chrome.scripting.executeScript).not.toHaveBeenCalled();

    await globalThis.chrome.tabs.onUpdated.emit(42, { status: 'complete' }); // ours, ready
    await tick();
    expect(stored().map((a) => a.name)).toContain('App 1');
    expect(globalThis.chrome.tabs.onUpdated.listeners).toHaveLength(0); // listener cleaned up
  });

  it('gives up waiting after the safety timeout rather than hanging', async () => {
    await mount();
    addTile('App 1', '1');
    globalThis.chrome.tabs.get = vi.fn(async () => ({ status: 'loading' }));
    await click($('import-myapps'));
    await tick(180000); // never emits 'complete'
    expect(stored().map((a) => a.name)).toContain('App 1');
    expect(globalThis.chrome.tabs.onUpdated.listeners).toHaveLength(0);
  });

  it('carries on when the tab cannot be queried at all', async () => {
    await mount();
    addTile('App 1', '1');
    globalThis.chrome.tabs.get = vi.fn(async () => {
      throw new Error('No tab with id: 42');
    });
    await click($('import-myapps'));
    await tick();
    expect(stored().map((a) => a.name)).toContain('App 1');
  });

  it('only adds — never removes — when the grid never reaches the bottom', async () => {
    await mount();
    scriptStub({
      scrapes: [[tile(1)], [tile(1), tile(2)], [tile(2), tile(3)]],
      scrolls: [900, 900, 900], // always more to scroll: the run can never be "complete"
    });
    await click($('import-myapps'));
    await tick(60000);
    const names = stored().map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(['Jira', 'Wiki', 'App 3']));
    // Even a partial import tags what it found, so a later complete sync can
    // prune it — untagged records would linger forever.
    expect(stored().find((a) => a.name === 'App 3').source).toBe('myapps');
    expect(status()).toMatch(/didn't reach the end, so nothing was removed/);
  });

  it('shows a sign-in hint while the page is not readable yet', async () => {
    await mount();
    globalThis.chrome.scripting.executeScript = vi.fn(async ({ func }) => {
      if (func.name === 'scrapeAppsFromDocument') throw new Error('no access');
      return [{ result: 0 }];
    });
    await click($('import-myapps'));
    await vi.advanceTimersByTimeAsync(6000);
    expect($('list').textContent).toMatch(/Waiting for you to sign in/);
    await tick(180000);
    expect(status()).toMatch(/No apps found/);
  });

  it('reports a failure to open the My Apps window', async () => {
    await mount();
    globalThis.chrome.windows.create = vi.fn(async () => ({ id: undefined, tabs: [] }));
    await click($('import-myapps'));
    await tick(10000);
    expect(status()).toMatch(/^Import failed: could not open a My Apps window/);
    expect($('import-myapps').disabled).toBe(false); // the button is restored
  });

  it('never prunes a grid that scrolls but never reaches the bottom', async () => {
    // The panel really moves (so `moved` is true) but the content grows just as
    // fast, so the bottom is never reached. Reporting the remaining distance —
    // rather than 0 — is the single line that stops reconcileApps from deleting
    // everything outside the current virtualised slice.
    await mount({ apps: [...APPS, app('Retired', 'https://retired.example.com/', 'myapps')] });
    const panel = document.createElement('div');
    document.body.append(panel);
    let top = 0;
    let height = 9000;
    Object.defineProperties(panel, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => 800 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (v) => {
          top = v;
          height += v - top + 4000; // the list keeps growing underneath us
        },
      },
    });
    addTile('App 1', '1', { parent: panel });

    await click($('import-myapps'));
    await tick(180000);
    expect(panel.scrollTop).toBeGreaterThan(0); // it really did scroll
    const names = stored().map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(['Jira', 'Wiki', 'Retired', 'App 1']));
    expect(status()).toMatch(/nothing was removed/);
  });

  it('abandons a scrape that outlives its timeout', async () => {
    await mount();
    addTile('App 1', '1');
    const run = globalThis.chrome.scripting.executeScript;
    globalThis.chrome.scripting.executeScript = vi.fn((args) => {
      if (args.func.name !== 'scrapeAppsFromDocument') return run(args);
      // Resolves 20s late: without the 8s timeout the import would use it.
      return new Promise((resolve) => {
        setTimeout(
          () => resolve([{ result: [{ name: 'Late', url: 'https://late.example.com/' }] }]),
          20000,
        );
      });
    });
    await click($('import-myapps'));
    await tick(260000);
    expect(stored().map((a) => a.name)).not.toContain('Late');
    expect(status()).toMatch(/No apps found/);
  });

  it('never prunes when the scroll injection itself fails', async () => {
    // scrollMyAppsStep's catch returns null ("unknown"), not 0 ("bottom") — if it
    // returned 0 the first virtualised slice would pass as a complete read.
    await mount({ apps: [...APPS, app('Retired', 'https://retired.example.com/', 'myapps')] });
    addTile('App 1', '1');
    const run = globalThis.chrome.scripting.executeScript;
    globalThis.chrome.scripting.executeScript = vi.fn(async (args) => {
      if (args.func.name === 'scrollMyAppsStepInPage') throw new Error('frame detached');
      return run(args);
    });

    await click($('import-myapps'));
    await tick(180000);
    expect(stored().map((a) => a.name)).toEqual(
      expect.arrayContaining(['Jira', 'Wiki', 'Retired', 'App 1']),
    );
    expect(status()).toMatch(/nothing was removed/);
  });

  it('never prunes when the grid has a scroller it cannot drive', async () => {
    // The tiles live in a container that reports plenty of room left but refuses
    // to scroll (shadow root / iframe / body-level scroller in the wild). Only
    // the first virtualised slice is ever visible — treating that as "the whole
    // list" would delete everything else.
    await mount({ apps: [...APPS, app('Retired', 'https://retired.example.com/', 'myapps')] });
    const panel = document.createElement('div');
    document.body.append(panel);
    Object.defineProperties(panel, {
      scrollHeight: { configurable: true, get: () => 9000 },
      clientHeight: { configurable: true, get: () => 800 },
      scrollTop: { configurable: true, get: () => 0, set: () => {} }, // immovable
    });
    addTile('App 1', '1', { parent: panel });

    await click($('import-myapps'));
    await tick(180000);
    const names = stored().map((a) => a.name);
    expect(names).toContain('App 1');
    expect(names).toEqual(expect.arrayContaining(['Jira', 'Wiki', 'Retired'])); // nothing pruned
    expect(status()).toMatch(/didn't reach the end, so nothing was removed/);
  });

  it('keeps the list visible when saving the import fails', async () => {
    await mount();
    addTile('App 1', '1');
    globalThis.chrome.storage.local.set = vi.fn(async (obj) => {
      if ('apps' in obj) throw new Error('QUOTA_BYTES exceeded');
    });
    await click($('import-myapps'));
    await tick();
    expect(rowNames()).toEqual(['Jira', 'Wiki']); // not stuck on "importing…"
    expect($('count').textContent).toBe('2');
  });

  it('keeps every stored app when the scrape comes back empty', async () => {
    await mount(); // no tiles in the document at all
    await click($('import-myapps'));
    await tick();
    expect(stored().map((a) => a.name)).toEqual(['Jira', 'Wiki']);
    expect(rowNames()).toEqual(['Jira', 'Wiki']);
    expect(status()).toMatch(/No apps found/);
  });

  it('never prunes when the background sync could not be paused', async () => {
    await mount({
      apps: [...APPS, app('Retired', 'https://retired.example.com/', 'myapps')],
    });
    addTile('App 1', '1');
    const realSet = globalThis.chrome.storage.local.set;
    globalThis.chrome.storage.local.set = vi.fn(async (obj) => {
      if ('beelineImporting' in obj) throw new Error('storage unavailable');
      return realSet(obj);
    });

    await click($('import-myapps'));
    await tick();
    const names = stored().map((a) => a.name);
    expect(names).toContain('App 1'); // still imported
    expect(names).toContain('Retired'); // ...but a complete read may NOT prune
    expect(status()).toMatch(/background sync could not be paused, so nothing was removed/);
  });

  it('reports a storage failure instead of pretending the import worked', async () => {
    await mount();
    addTile('App 1', '1');
    globalThis.chrome.storage.local.set = vi.fn(async (obj) => {
      if ('apps' in obj) throw new Error('QUOTA_BYTES exceeded');
    });
    await click($('import-myapps'));
    await tick();
    expect(status()).toMatch(/saving failed: QUOTA_BYTES exceeded/);
  });

  it('drops an open edit row that the reconcile removed', async () => {
    await mount();
    const edit = [...rows()[0].querySelectorAll('button')].find((b) => b.textContent === 'Edit');
    await click(edit);
    expect(rows().some((li) => li.classList.contains('editing'))).toBe(true);

    addTile('App 1', '1'); // Jira (the edited row) is not in this scrape
    await click($('import-myapps'));
    await tick();
    expect(rows().some((li) => li.classList.contains('editing'))).toBe(false);
    expect(rowNames()).toEqual(['App 1', 'Wiki']);

    // The edit state must be really gone, not just invisible: otherwise every
    // later storage change is deferred forever and the list stops updating.
    globalThis.chrome.storage.local.store.apps = [
      ...stored(),
      app('Added later', 'https://later.example.com/', 'myapps'),
    ];
    await globalThis.chrome.storage.onChanged.emit({ apps: {} }, 'local');
    await flush();
    expect(rowNames()).toContain('Added later');
  });

  it('confirms the bottom over several rounds before calling a read complete', async () => {
    // Behavioural pin on the stableLimit the page asks for: one lucky
    // at-the-bottom round must not be enough to authorise pruning.
    await mount();
    addTile('App 1', '1');
    let scrapes = 0;
    const run = globalThis.chrome.scripting.executeScript;
    globalThis.chrome.scripting.executeScript = vi.fn(async (args) => {
      if (args.func.name === 'scrapeAppsFromDocument') scrapes += 1;
      return run(args);
    });
    await click($('import-myapps'));
    await tick();
    expect(status()).toMatch(/^Synced/); // it did complete...
    expect(scrapes).toBeGreaterThanOrEqual(5); // ...but only after re-checking
  });

  it('scrolls the WINDOW when the page has no inner scroll panel', async () => {
    // Some layouts scroll the document itself. jsdom no-ops window scrolling, so
    // without this stub the window branch of the scroll step is never exercised.
    await mount();
    stubWindowScroll({ height: 4000, viewport: 768 });
    addTile('App 1', '1');
    await click($('import-myapps'));
    await tick(120000);
    expect(window.scrollY).toBeGreaterThan(0); // the page really was scrolled
    expect(stored().map((a) => a.name)).toContain('App 1');
  });

  it('injects only self-contained functions', async () => {
    // chrome.scripting serialises the function and evaluates it in the page, so
    // a reference to anything in module scope would throw there. Rebuild each
    // injected function from its source and call it: a closure reference fails
    // here instead of silently breaking the import in a real browser.
    await mount();
    const injected = [];
    const run = globalThis.chrome.scripting.executeScript;
    globalThis.chrome.scripting.executeScript = vi.fn(async (args) => {
      injected.push(args.func);
      return run(args);
    });
    addTile('App 1', '1');
    await click($('import-myapps'));
    await tick();

    expect(injected.length).toBeGreaterThanOrEqual(3); // visibility, scrape, scroll
    for (const func of new Set(injected)) {
      expect(() => rebuildInjected(func)(), func.name).not.toThrow();
    }
  });

  it('walks a virtualised grid: scrolls the tiles’ own scroll container', async () => {
    await mount();
    // A real-ish grid: tiles inside a panel that can still scroll, so the
    // injected scroll step reports the remaining distance instead of 0.
    const panel = document.createElement('div');
    document.body.append(panel);
    Object.defineProperties(panel, {
      scrollHeight: { configurable: true, get: () => 4000 },
      clientHeight: { configurable: true, get: () => 800 },
    });
    let top = 0;
    Object.defineProperty(panel, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v) => {
        top = Math.min(v, 3200);
      },
    });
    addTile('App 1', '1', { parent: panel });

    await click($('import-myapps'));
    await tick(60000);
    expect(panel.scrollTop).toBeGreaterThan(0); // the grid really was scrolled
    expect(stored().map((a) => a.name)).toContain('App 1');
  });
});
