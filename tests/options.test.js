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
  stubUnscrollableDocument,
  fakeScroller,
  rebuildInjected,
  flush,
  click,
  press,
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
async function mount({ apps = APPS, settings = {}, chromeOptions = {}, mutate } = {}) {
  globalThis.chrome = makeChrome({ local: { apps }, sync: { settings }, ...chromeOptions });
  if (mutate) mutate(globalThis.chrome); // patch the fake API before the page reads it
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

/**
 * Advance fake timers in slices so long, sleep-driven flows settle. Stops once
 * the Import button is back — running the clock on past the end would also run
 * out the status toast's own fade, and these tests are about what the import
 * reported, not about how long the message then stays up.
 */
async function tick(total = 30000, step = 250) {
  for (let elapsed = 0; elapsed < total; elapsed += step) {
    await vi.advanceTimersByTimeAsync(step);
    if (!$('import-myapps').disabled) {
      await vi.advanceTimersByTimeAsync(step); // let the tail of the flow settle
      return;
    }
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

  it('offers the sync intervals and shows the saved one', async () => {
    await mount({ settings: { syncIntervalMin: 720, syncOnVisit: false } });
    expect([...$('sync-interval').options].map((o) => o.value)).toEqual([
      '0',
      '60',
      '360',
      '720',
      '1440',
    ]);
    expect($('sync-interval').value).toBe('720');
    expect($('sync-on-visit').checked).toBe(false);
  });

  it('saves the interval as a number so the alarm can use it directly', async () => {
    await mount();
    $('sync-interval').value = '60';
    $('sync-on-visit').checked = false;
    $('sync-interval').dispatchEvent(new Event('change'));
    await flush();
    expect(globalThis.chrome.storage.sync.store.settings).toMatchObject({
      syncIntervalMin: 60, // a string here would never match an alarm's period
      syncOnVisit: false,
    });
  });

  it('saves "Off" as 0 rather than an empty string', async () => {
    await mount();
    $('sync-interval').value = '0';
    $('sync-interval').dispatchEvent(new Event('change'));
    await flush();
    expect(globalThis.chrome.storage.sync.store.settings.syncIntervalMin).toBe(0);
  });
});

describe('the status toast', () => {
  /** Submit the add form with nothing in it — the shortest path to an error. */
  const badSubmit = async () => {
    $('add-form').dispatchEvent(new Event('submit'));
    await flush();
  };

  it('clears a plain confirmation quickly and anything actionable eventually', async () => {
    vi.useFakeTimers();
    await mount();
    $('theme').dispatchEvent(new Event('change'));
    await flush();
    expect(status()).toBe('Settings saved.');
    expect($('status').dataset.tone).toBe('ok');

    await vi.advanceTimersByTimeAsync(5000);
    expect(status()).toBe(''); // gone, so it never sits there stale

    // Something you may have to act on gets reading time — but it does not park
    // itself on screen for the rest of the session waiting to be replaced.
    await badSubmit();
    expect($('status').dataset.tone).toBe('error');
    await vi.advanceTimersByTimeAsync(5000);
    expect(status()).toBe('Enter a name and a valid https:// URL.');
    await vi.advanceTimersByTimeAsync(11000);
    expect(status()).toBe('');
  });

  it('can be dismissed with a click', async () => {
    await mount();
    await badSubmit();
    expect(status()).not.toBe('');
    await click($('status'));
    expect(status()).toBe('');
    expect($('status').dataset.tone).toBe('');
  });

  it('can be dismissed from the keyboard', async () => {
    // <output> is a live region, not a control, so it is deliberately not in
    // the tab order — Esc is what keeps it dismissable without a mouse.
    await mount();
    await badSubmit();
    press(document, 'Escape');
    await flush();
    expect(status()).toBe('');
  });
});

describe('the launcher shortcut', () => {
  it('shows the binding the browser actually has', async () => {
    await mount();
    expect([...$('shortcut').querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      'Ctrl',
      'Shift',
      'Space',
    ]);
  });

  it('says so when no key is bound, rather than repeating the manifest', async () => {
    // Chrome drops a suggested key another extension already owns — claiming it
    // works would send the user hunting for a shortcut that does nothing.
    await mount({
      chromeOptions: {},
      mutate: (c) => {
        c.commands.getAll = vi.fn(async () => [{ name: '_execute_action', shortcut: '' }]);
      },
    });
    expect($('shortcut').textContent).toBe('no shortcut set yet');
    expect($('shortcut').querySelector('kbd')).toBeNull();
  });

  it('opens the browser page where the key is rebound', async () => {
    await mount();
    await click($('change-shortcut'));
    expect(globalThis.chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome://extensions/shortcuts',
    });
  });

  it('renders the newest binding when two reads overlap', async () => {
    // init() and the on-focus refresh can be in flight together. If the slower
    // one painted last, the page would show a key that is no longer bound.
    let answerFirst;
    await mount({
      mutate: (c) => {
        c.commands.getAll = vi.fn(() => new Promise((resolve) => (answerFirst = resolve)));
      },
    });
    globalThis.chrome.commands.getAll = vi.fn(async () => [
      { name: '_execute_action', shortcut: 'Alt+K' },
    ]);
    window.dispatchEvent(new Event('focus')); // second read, answers first
    await flush();
    answerFirst([{ name: '_execute_action', shortcut: 'Ctrl+Shift+Space' }]);
    await flush();
    expect([...$('shortcut').querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      'Alt',
      'K',
    ]);
  });

  it('uses the Firefox API instead of a URL Firefox will not open', async () => {
    // Firefox refuses to navigate to chrome://extensions/shortcuts — the button
    // used to raise a toast and go nowhere. It has its own API for this.
    const openShortcutSettings = vi.fn(async () => {});
    await mount({
      mutate: (c) => {
        c.runtime.getURL = vi.fn((p) => `moz-extension://beeline/${p}`);
        c.commands.openShortcutSettings = openShortcutSettings;
      },
    });
    await click($('change-shortcut'));
    expect(openShortcutSettings).toHaveBeenCalled();
    expect(globalThis.chrome.tabs.create).not.toHaveBeenCalled();
    expect(status()).toBe('');
  });

  it('names the clicks on a Firefox too old for that API', async () => {
    // No openShortcutSettings() and no page it may navigate to: saying exactly
    // where to click is all that is left.
    await mount({
      mutate: (c) => {
        c.runtime.getURL = vi.fn((p) => `moz-extension://beeline/${p}`);
      },
    });
    await click($('change-shortcut'));
    expect(globalThis.chrome.tabs.create).not.toHaveBeenCalled(); // never on Firefox
    expect(status()).toMatch(/about:addons.*Manage Extension Shortcuts/);
  });

  it('explains where to look when that page cannot be opened', async () => {
    await mount({
      mutate: (c) => {
        c.tabs.create = vi.fn(async () => {
          throw new Error('Access denied');
        });
      },
    });
    await click($('change-shortcut'));
    expect(status()).toMatch(/extension-shortcut settings/);
  });
});

describe('the bookmarks setting', () => {
  const box = () => $('include-bookmarks');
  const toggle = async (checked) => {
    box().checked = checked;
    box().dispatchEvent(new Event('change'));
    await flush();
  };

  it('is off by default and asks for the permission when switched on', async () => {
    await mount();
    expect(box().checked).toBe(false);
    await toggle(true);
    expect(globalThis.chrome.permissions.request).toHaveBeenCalledWith({
      permissions: ['bookmarks'],
    });
    expect(globalThis.chrome.storage.sync.store.settings.includeBookmarks).toBe(true);
  });

  it('unticks itself and saves nothing when the permission is denied', async () => {
    await mount({ chromeOptions: { granted: false } });
    await toggle(true);
    expect(box().checked).toBe(false);
    expect(globalThis.chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(status()).toMatch(/denied/);
  });

  it('hands the permission back when switched off', async () => {
    await mount({ settings: { includeBookmarks: true } });
    expect(box().checked).toBe(true);
    await toggle(false);
    expect(globalThis.chrome.permissions.remove).toHaveBeenCalledWith({
      permissions: ['bookmarks'],
    });
    expect(globalThis.chrome.storage.sync.store.settings.includeBookmarks).toBe(false);
  });

  it('locks the box while the permission bubble is open', async () => {
    await mount();
    let grant;
    globalThis.chrome.permissions.request = vi.fn(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    box().checked = true;
    box().dispatchEvent(new Event('change'));
    await flush();
    // The options page stays interactive behind the prompt — a second click
    // must not be able to revoke what is still being asked for.
    expect(box().disabled).toBe(true);
    grant(true);
    await flush();
    expect(box().disabled).toBe(false);
    expect(globalThis.chrome.storage.sync.store.settings.includeBookmarks).toBe(true);
  });

  it('shows it as off when the permission was revoked in the browser', async () => {
    await mount({ settings: { includeBookmarks: true }, chromeOptions: { granted: false } });
    expect(box().checked).toBe(false);
  });

  it('does not save (and puts the box back) before the settings have loaded', async () => {
    globalThis.chrome = makeChrome({ local: { apps: APPS } });
    globalThis.chrome.storage.sync.get = vi.fn(async () => {
      throw new Error('sync unavailable');
    });
    loadPage('options');
    vi.resetModules();
    await import('../src/options/options.js');
    await flush();

    await toggle(true);
    expect(box().checked).toBe(false);
    expect(globalThis.chrome.permissions.request).not.toHaveBeenCalled();
    expect(status()).toMatch(/not loaded yet/);
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

describe('the full URL on hover', () => {
  it('spells out the whole launch URL, which the row itself truncates', async () => {
    // These URLs carry the account, the tenant and the region — the tail that
    // gets cut off is the part that tells two near-identical rows apart.
    await mount();
    expect(rows()[0].querySelector('.app-url').title).toBe('https://jira.example.com/');
  });
});

describe('containers are invisible on a browser that has none', () => {
  it('hides every container control, not just the picker', async () => {
    // Chrome has no such feature, and a Firefox with privacy.userContext off
    // reports none either. A dead dropdown is worse than no dropdown.
    await mount();
    expect($('import-container-row').hidden).toBe(true);
    expect($('filter-container-wrap').hidden).toBe(true);
    expect($('container-style-row').hidden).toBe(true);
  });
});

describe('removing what the filter is showing', () => {
  const WORK = 'firefox-container-2';
  const url = (n) => `https://app${n}.example.com/`;
  const SOME = [
    { id: appId(url(1)), name: 'Plain one', url: url(1), source: 'myapps' },
    { id: appId(url(2), WORK), name: 'Work one', url: url(2), source: 'myapps', container: WORK },
    { id: appId(url(3), WORK), name: 'Work two', url: url(3), source: 'myapps', container: WORK },
  ];

  const mountWork = () =>
    mount({
      apps: SOME,
      mutate: (c) => {
        c.contextualIdentities = {
          query: vi.fn(async () => [{ cookieStoreId: WORK, name: 'SBB', color: 'red' }]),
        };
      },
    });

  it('removes only the filtered apps, not the whole list', async () => {
    // A button next to a filtered list that says "Remove all" and empties
    // everything behind it is a trap.
    await mountWork();
    await flush();
    $('filter-container').value = WORK;
    $('filter-container').dispatchEvent(new Event('change'));
    await click($('clear'));
    expect(stored().map((a) => a.name)).toEqual(['Plain one']);
    expect(status()).toBe('Removed 2 app(s).');
  });

  it('says how many of how many are going', async () => {
    await mountWork();
    await flush();
    $('app-filter').value = 'work two';
    $('app-filter').dispatchEvent(new Event('input'));
    await click($('clear'));
    expect(globalThis.confirm).toHaveBeenCalledWith(
      'Remove the 1 app(s) currently shown, out of 3? This cannot be undone.',
    );
    expect(stored()).toHaveLength(2);
  });

  it('still empties everything when nothing is filtered', async () => {
    await mountWork();
    await flush();
    await click($('clear'));
    expect(globalThis.confirm).toHaveBeenCalledWith('Remove all 3 apps? This cannot be undone.');
    expect(stored()).toEqual([]);
    expect(status()).toBe('Removed all apps.');
  });

  it('does nothing when the filter matches nothing', async () => {
    await mountWork();
    await flush();
    $('app-filter').value = 'nothing matches this';
    $('app-filter').dispatchEvent(new Event('input'));
    await click($('clear'));
    expect(globalThis.confirm).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(3);
  });
});

describe('adding an app into a container', () => {
  const WORK = 'firefox-container-2';

  const withContainers = (apps = []) => ({
    apps,
    mutate: (c) => {
      c.contextualIdentities = {
        query: vi.fn(async () => [{ cookieStoreId: WORK, name: 'SBB', color: 'red' }]),
      };
    },
  });

  it('offers the containers on the add form', async () => {
    await mount(withContainers());
    await flush();
    expect($('add-container-row').hidden).toBe(false);
    expect([...$('add-container').options].map((o) => o.textContent)).toEqual([
      'No container',
      'SBB',
    ]);
  });

  it('asks for the cookies permission before promising a container', async () => {
    // Without it the cookieStoreId is dropped at launch: the app would wear a
    // container badge and quietly open as the wrong identity.
    await mount({
      ...withContainers(),
      mutate: (c) => {
        c.contextualIdentities = {
          query: vi.fn(async () => [{ cookieStoreId: WORK, name: 'SBB', color: 'red' }]),
        };
        c.permissions.request = vi.fn(async () => false);
      },
    });
    await flush();
    $('name').value = 'Denied';
    $('url').value = 'https://denied.example.com/';
    $('add-container').value = WORK;
    $('add-form').dispatchEvent(new Event('submit'));
    await flush();
    expect(globalThis.chrome.permissions.request).toHaveBeenCalledWith({
      permissions: ['cookies'],
    });
    // Added, but honestly — without the container it cannot honour.
    expect(stored()[0].container).toBeUndefined();
    expect(status()).toMatch(/added without one/);
  });

  it('stores the app in the chosen container, id and all', async () => {
    // The same URL opened as two identities is two destinations, so the
    // container has to reach the id — not just the label.
    await mount(withContainers());
    await flush();
    $('name').value = 'By hand';
    $('url').value = 'https://byhand.example.com/';
    $('add-container').value = WORK;
    $('add-form').dispatchEvent(new Event('submit'));
    await flush();
    expect(stored()[0]).toMatchObject({
      name: 'By hand',
      container: WORK,
      source: 'manual',
      id: appId('https://byhand.example.com/', WORK),
    });
  });

  it('adds a container-less app when none is chosen', async () => {
    await mount(withContainers());
    await flush();
    $('name').value = 'Plain';
    $('url').value = 'https://plain.example.com/';
    $('add-form').dispatchEvent(new Event('submit'));
    await flush();
    expect(stored()[0].container).toBeUndefined();
  });

  it('hides the picker on a browser without containers', async () => {
    await mount();
    await flush();
    expect($('add-container-row').hidden).toBe(true);
  });
});

describe('the launcher pre-filter setting', () => {
  const WORK = 'firefox-container-2';

  const withContainers = {
    apps: [],
    mutate: (c) => {
      c.contextualIdentities = {
        query: vi.fn(async () => [{ cookieStoreId: WORK, name: 'SBB', color: 'red' }]),
      };
    },
  };

  it('starts with everything ticked', async () => {
    await mount(withContainers);
    await flush();
    const boxes = [...document.querySelectorAll('#popup-containers input')];
    expect(boxes.map((b) => b.dataset.scope)).toEqual(['', WORK]);
    expect(boxes.every((b) => b.checked)).toBe(true);
  });

  it('saves the UNTICKED ones, so an empty list means show everything', async () => {
    await mount(withContainers);
    await flush();
    const box = document.querySelector(`#popup-containers input[data-scope="${WORK}"]`);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await flush();
    // Kept out of SYNC on purpose: a cookieStoreId is handed out per profile,
    // so the same string names a different container on another machine.
    expect(globalThis.chrome.storage.local.store.localSettings.hiddenContainers).toEqual([WORK]);
    expect(globalThis.chrome.storage.sync.store.settings.hiddenContainers).toBeUndefined();
  });

  it('shows what was already unticked', async () => {
    await mount({
      ...withContainers,
      chromeOptions: { local: { apps: [], localSettings: { hiddenContainers: [''] } } },
    });
    await flush();
    const none = document.querySelector('#popup-containers input[data-scope=""]');
    expect(none.checked).toBe(false);
  });

  it('stays hidden on a browser without containers', async () => {
    await mount();
    await flush();
    expect($('popup-containers-row').hidden).toBe(true);
  });
});

describe('a JSON file is not a browser', () => {
  const WORK = 'firefox-container-2';

  async function importFile(records, containers = []) {
    await mount({
      apps: [],
      mutate: (c) => {
        c.contextualIdentities = { query: vi.fn(async () => containers) };
      },
    });
    await flush();
    const input = $('import-file');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{ text: async () => JSON.stringify(records) }],
    });
    input.dispatchEvent(new Event('change'));
    await flush();
    await flush();
  }

  const record = (extra) => ({
    name: 'Restored',
    url: 'https://restored.example.com/',
    ...extra,
  });

  it('drops a container this browser does not have', async () => {
    // An id from another profile is either gone, or belongs to a DIFFERENT
    // container here — which opens as the wrong identity.
    await importFile(
      [record({ container: 'firefox-container-99' })],
      [{ cookieStoreId: WORK, name: 'SBB' }],
    );
    expect(stored()[0].container).toBeUndefined();
  });

  it('keeps the container when there is no list to judge it against', async () => {
    // Stripping it would MERGE two apps that differ only by container into one,
    // and one identity's row would vanish. An unknown container is handled
    // everywhere else; a silently lost app is not.
    const url = 'https://portal.example.com/';
    await importFile([
      { name: 'Portal', url, container: 'firefox-container-2' },
      { name: 'Portal', url, container: 'firefox-container-3' },
    ]);
    expect(stored()).toHaveLength(2);
    expect(
      stored()
        .map((a) => a.container)
        .sort(),
    ).toEqual(['firefox-container-2', 'firefox-container-3']);
  });

  it('keeps a container this browser really has', async () => {
    await importFile([record({ container: WORK })], [{ cookieStoreId: WORK, name: 'SBB' }]);
    expect(stored()[0].container).toBe(WORK);
  });

  it('refuses a strike count that would delete the app on the next sync', async () => {
    // missing:9 would make the very next read that misses it remove the app,
    // straight past the two-read rail.
    await importFile([record({ missing: 9 })]);
    expect(stored()[0].missing).toBeUndefined();
  });

  it('restores apps as manual, so the next import cannot wipe the backup', async () => {
    await importFile([record({ source: 'myapps' })]);
    expect(stored()[0].source).toBe('manual');
  });
});

describe('filtering by container', () => {
  const WORK = 'firefox-container-2';
  const HOME = 'firefox-container-3';
  const url = 'https://outlook.example.com/';
  const CONTAINED = [
    { id: appId(url), name: 'Calendar', url, source: 'myapps' },
    { id: appId(url, WORK), name: 'Calendar', url, source: 'myapps', container: WORK },
    {
      id: appId('https://jira.example.com/', HOME),
      name: 'Jira',
      url: 'https://jira.example.com/',
      source: 'myapps',
      container: HOME,
    },
  ];

  const withContainers = {
    apps: CONTAINED,
    mutate: (c) => {
      c.contextualIdentities = {
        query: vi.fn(async () => [
          { cookieStoreId: WORK, name: 'SBB', color: 'red' },
          { cookieStoreId: HOME, name: 'Personal', color: 'green' },
        ]),
      };
    },
  };

  it('offers the containers, with an "all" and a "no container" choice', async () => {
    await mount(withContainers);
    await flush();
    expect([...$('filter-container').options].map((o) => o.textContent)).toEqual([
      'All containers',
      'No container',
      'SBB',
      'Personal',
    ]);
    expect($('filter-container-wrap').hidden).toBe(false);
  });

  it('narrows the list to one container', async () => {
    await mount(withContainers);
    await flush();
    $('filter-container').value = WORK;
    $('filter-container').dispatchEvent(new Event('change'));
    expect(rowNames()).toEqual(['Calendar']);
    expect(rows()[0].querySelector('.badge').textContent).toContain('SBB');
  });

  it('can show the ones with no container, which no text can express', async () => {
    await mount(withContainers);
    await flush();
    $('filter-container').value = '';
    $('filter-container').dispatchEvent(new Event('change'));
    expect(rowNames()).toEqual(['Calendar']);
    expect(rows()[0].querySelector('.badge').textContent).toBe('My Apps'); // no container chip
  });

  it('matches a container name typed into the text box', async () => {
    // Same tile from two containers has an identical name and URL, so the
    // container is the only thing that tells the two rows apart.
    await mount(withContainers);
    await flush();
    $('app-filter').value = 'sbb';
    $('app-filter').dispatchEvent(new Event('input'));
    expect(rowNames()).toEqual(['Calendar']);
    expect($('count').textContent).toBe('1 found · 3 total');
  });

  it('stays hidden on a browser without containers', async () => {
    await mount({ apps: CONTAINED });
    await flush();
    expect($('filter-container-wrap').hidden).toBe(true);
    expect(rows()).toHaveLength(3); // everything still listed
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

  it('keeps the progress message up for as long as the import takes', async () => {
    await mount();
    let allow;
    globalThis.chrome.permissions.request = vi.fn(() => new Promise((r) => (allow = r)));
    await click($('import-myapps'));
    expect($('status').dataset.tone).toBe('busy');
    // Reading a few hundred tiles out of a virtualised grid can run for
    // minutes. A progress line that timed out mid-run would read as "it died".
    await vi.advanceTimersByTimeAsync(60000);
    expect(status()).toMatch(/Requesting access to My Apps/);
    allow(false);
    await tick();
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
    expect(status()).toMatch(/the page never reported the end of the list, so nothing was removed/);
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

    // …and it KEEPS waiting. The portal has bounced us to Microsoft and there
    // is nothing to read until a human types a password; spending the reading
    // budget on that made every import from a fresh container fail and need
    // starting again. Three minutes in, it is still holding the door open.
    await tick(180000);
    expect(status()).toMatch(/Reading your apps/);

    // It does give up eventually — the grace is ten minutes, not forever.
    await tick(600000);
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
    // Past the sign-in grace: a scrape that never answers looks exactly like a
    // login screen from here, and waiting it out is now the first response.
    await tick(800000);
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
    expect(status()).toMatch(/the page never reported the end of the list, so nothing was removed/);
  });

  it('finishes on an app shell whose document height can never be scrolled away', async () => {
    // The regression that made EVERY import end merge-only ("Run Import again to
    // finish"): the shell reports a document far taller than the viewport but
    // swallows window scrolling, so the document-level distance never fell to 0 —
    // even long after the grid's OWN scroller had bottomed out and the union had
    // stopped growing. The tiles' scroller is the one that counts here.
    await mount({ apps: [...APPS, app('Retired', 'https://retired.example.com/', 'myapps')] });
    const restore = stubUnscrollableDocument({ height: 9000, viewport: 768 });
    try {
      const panel = fakeScroller(document.createElement('div'), {
        scrollHeight: 1600,
        clientHeight: 800,
      });
      document.body.append(panel);
      addTile('App 1', '1', { parent: panel });

      await click($('import-myapps'));
      await tick(180000);
      expect(status()).toMatch(/^Synced/); // a complete read, so it may reconcile
      const names = stored().map((a) => a.name);
      expect(names).toEqual(expect.arrayContaining(['App 1', 'Wiki']));
      expect(names).not.toContain('Retired'); // gone from My Apps → pruned
    } finally {
      restore();
    }
  });

  it('still believes the window when the tiles have no scroller of their own', async () => {
    // Flip side of the fix: with no inner scroller the window IS the grid's
    // scroller, so a document that claims room left must stay "unknown". Calling
    // that the bottom would let the first virtualised slice prune the rest.
    await mount({ apps: [...APPS, app('Retired', 'https://retired.example.com/', 'myapps')] });
    const restore = stubUnscrollableDocument({ height: 9000, viewport: 768 });
    try {
      addTile('App 1', '1'); // straight onto <body>: no scrollable ancestor

      await click($('import-myapps'));
      await tick(180000);
      expect(status()).toMatch(/never reported the end of the list, so nothing was removed/);
      expect(stored().map((a) => a.name)).toEqual(
        expect.arrayContaining(['Jira', 'Wiki', 'Retired', 'App 1']),
      );
    } finally {
      restore();
    }
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
