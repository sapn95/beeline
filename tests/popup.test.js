// @vitest-environment jsdom
//
// Drives the real popup markup + popup.js against a fake chrome API: what the
// user sees (ranked rows, highlighting, fallback rows) and every way an app can
// be launched, since a wrong launch target is the one bug that reaches the user
// immediately.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeChrome,
  loadPage,
  stubDomExtras,
  stubLocalStorage,
  flush,
  press,
  click,
} from './helpers/extension.js';
import { bookmarkKey } from '../src/lib/bookmarks.js';

const APPS = [
  { id: 'a1', name: 'Jira', url: 'https://jira.example.com/', source: 'myapps' },
  {
    id: 'a2',
    name: 'Confluence',
    url: 'https://wiki.example.com/',
    iconUrl: 'https://cdn.example.com/c.png',
    source: 'myapps',
  },
  { id: 'a3', name: 'AWS Console', url: 'https://aws.example.com/signin', source: 'manual' },
];

let writeText;

function mount(overrides = {}) {
  globalThis.chrome = makeChrome({
    local: { apps: APPS, stats: { a1: { count: 5, lastLaunched: 1000 } } },
    sync: { settings: overrides.settings ?? {} },
    ...overrides.chrome,
  });
  if (overrides.mutate) overrides.mutate(globalThis.chrome);
  loadPage('popup');
  vi.resetModules();
  return import('../src/popup/popup.js');
}

const rows = () => [...document.getElementById('results').children];
const names = () => rows().map((li) => li.querySelector('.name').textContent);
const selectedIndex = () => rows().findIndex((li) => li.classList.contains('selected'));

beforeEach(() => {
  stubDomExtras();
  writeText = vi.fn(async () => {});
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete globalThis.chrome;
});

describe('rendering', () => {
  it('lists every stored app with its host, most-used first', async () => {
    await mount();
    expect(names()).toEqual(['Jira', 'AWS Console', 'Confluence']); // Jira has stats, then alphabetical
    expect(rows()[0].querySelector('.host').textContent).toBe('jira.example.com');
    expect(document.getElementById('empty').hidden).toBe(true);
    expect(selectedIndex()).toBe(0);
  });

  it('renders the scraped icon when the app has one', async () => {
    await mount();
    const [, , confluence] = rows();
    expect(confluence.querySelector('img').src).toBe('https://cdn.example.com/c.png');
  });

  it("borrows the browser's cached favicon for an app with no logo", async () => {
    // chrome.bookmarks carries no icon and hand-added apps have none either, so
    // the local favicon store fills the gap — no network request.
    await mount();
    const src = rows()[0].querySelector('img').src;
    expect(src).toContain('/_favicon/');
    expect(src).toContain(`pageUrl=${encodeURIComponent('https://jira.example.com/')}`);
    expect(src).toContain('size=32');
  });

  it('keeps the initial for My Apps links, whose favicon is the same for all', async () => {
    await mount({
      chrome: {
        local: {
          apps: [
            {
              id: 'm1',
              name: 'SAP Gateway',
              url: 'https://launcher.myapps.microsoft.com/api/signin/abc',
              source: 'myapps',
            },
          ],
        },
      },
    });
    const icon = rows()[0].querySelector('.icon');
    expect(icon.querySelector('img')).toBeNull();
    expect(icon.textContent).toBe('S');
  });

  it('falls back to the initial when the favicon does not load', async () => {
    // Firefox has no _favicon/ endpoint, and Chrome has nothing cached for a
    // page never visited — a broken image would be worse than a letter.
    await mount();
    const icon = rows()[0].querySelector('.icon');
    icon.querySelector('img').dispatchEvent(new Event('error'));
    expect(icon.querySelector('img')).toBeNull();
    expect(icon.textContent).toBe('J');
  });

  it('shows the empty state when there are no apps', async () => {
    await mount({ chrome: { local: { apps: [] } } });
    expect(document.getElementById('empty').hidden).toBe(false);
    expect(rows()).toHaveLength(0);
  });

  it('still works when storage cannot be read', async () => {
    await mount({
      mutate: (c) => {
        c.storage.local.get = vi.fn(async () => {
          throw new Error('storage unavailable');
        });
      },
    });
    expect(document.getElementById('empty').hidden).toBe(false);
    // Wired before the storage read, so the popup is usable rather than dead.
    await click(document.getElementById('open-options'));
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
  });

  it('filters as you type and highlights the matched letters', async () => {
    await mount();
    const search = document.getElementById('search');
    search.value = 'jir';
    search.dispatchEvent(new Event('input'));
    expect(names()).toEqual(['Jira']);
    expect([...rows()[0].querySelectorAll('mark')].map((m) => m.textContent)).toEqual([
      'J',
      'i',
      'r',
    ]);
  });

  it('applies the saved theme and mirrors it for the pre-paint boot script', async () => {
    await mount({ settings: { theme: 'dark' } });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('beeline-theme')).toBe('dark');
  });

  it('still renders when localStorage is unavailable', async () => {
    stubLocalStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error('denied');
      },
    });
    await mount({ settings: { theme: 'light' } });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(names()).toHaveLength(3);
  });
});

describe('keyboard navigation', () => {
  it('moves the selection with the arrow keys and wraps around', async () => {
    await mount();
    const search = document.getElementById('search');
    press(search, 'ArrowDown');
    expect(selectedIndex()).toBe(1);
    press(search, 'ArrowUp');
    press(search, 'ArrowUp');
    expect(selectedIndex()).toBe(2); // wrapped past the start
  });

  it('ignores the arrows when nothing matches', async () => {
    await mount({ chrome: { local: { apps: [] } } });
    press(document.getElementById('search'), 'ArrowDown');
    expect(selectedIndex()).toBe(-1);
  });

  it('follows the mouse', async () => {
    await mount();
    rows()[2].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(selectedIndex()).toBe(2);
    rows()[2].dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); // no-op re-hover
    expect(selectedIndex()).toBe(2);
  });

  it('clears the query on Escape, then closes the popup', async () => {
    await mount();
    const search = document.getElementById('search');
    search.value = 'jira';
    search.dispatchEvent(new Event('input'));
    press(search, 'Escape');
    expect(search.value).toBe('');
    expect(window.close).not.toHaveBeenCalled();
    press(search, 'Escape');
    expect(window.close).toHaveBeenCalled();
  });
});

describe('launching', () => {
  it('opens the selected app in a new tab and records the launch', async () => {
    await mount();
    press(document.getElementById('search'), 'Enter');
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://jira.example.com/' });
    expect(chrome.storage.local.store.stats.a1.count).toBe(6);
    expect(window.close).toHaveBeenCalled();
  });

  it('reuses the current tab when "open in new tab" is off', async () => {
    await mount({ settings: { openInNewTab: false, closeAfterLaunch: false } });
    await click(rows()[2]);
    expect(chrome.tabs.update).toHaveBeenCalledWith({ url: 'https://wiki.example.com/' });
    expect(window.close).not.toHaveBeenCalled();
  });

  it('Ctrl/Cmd+Enter opens a background tab and keeps the popup open', async () => {
    await mount();
    press(document.getElementById('search'), 'Enter', { metaKey: true });
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://jira.example.com/',
      active: false,
    });
    expect(window.close).not.toHaveBeenCalled();
  });

  it('Alt+n quick-launches the n-th result', async () => {
    await mount();
    press(document.getElementById('search'), '2', { altKey: true, code: 'Digit2' });
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://aws.example.com/signin' });
  });

  it('Alt+n works on macOS, where Option+2 arrives as “™”', async () => {
    await mount();
    press(document.getElementById('search'), '™', { altKey: true, code: 'Digit2' });
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://aws.example.com/signin' });
  });

  it('still opens the app when writing the launch stats fails', async () => {
    await mount({
      mutate: (c) => {
        c.storage.local.set = vi.fn(async () => {
          throw new Error('QUOTA_BYTES exceeded');
        });
      },
    });
    press(document.getElementById('search'), 'Enter');
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://jira.example.com/' });
  });

  it('does nothing when the index has no result', async () => {
    await mount();
    press(document.getElementById('search'), '9', { altKey: true, code: 'Digit9' });
    await flush();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('adds the AWS region deep link for AWS apps when a region is configured', async () => {
    await mount({ settings: { awsRegion: 'eu-central-2' } });
    press(document.getElementById('search'), '2', { altKey: true, code: 'Digit2' });
    await flush();
    const { url } = chrome.tabs.create.mock.calls[0][0];
    expect(url).toContain('RelayState=');
    expect(decodeURIComponent(url)).toContain('region=eu-central-2');
  });
});

describe('fallback search', () => {
  async function noMatch(settings) {
    await mount({ settings });
    const search = document.getElementById('search');
    search.value = 'zzzz';
    search.dispatchEvent(new Event('input'));
    return search;
  }

  it('offers both fallbacks when configured, and none when off', async () => {
    await noMatch({ fallbackSearch: 'both' });
    expect(names()).toEqual(['Search My Apps for “zzzz”', 'Search the web for “zzzz”']);
    await noMatch({ fallbackSearch: 'off' });
    expect(rows()).toHaveLength(0);
  });

  it('hands the query to the browser search engine', async () => {
    await noMatch({ fallbackSearch: 'web' });
    await click(rows()[0]);
    expect(chrome.search.query).toHaveBeenCalledWith({ text: 'zzzz', disposition: 'NEW_TAB' });
  });

  it('falls back to DuckDuckGo where chrome.search is unavailable (Firefox)', async () => {
    await mount({ settings: { fallbackSearch: 'web' }, mutate: (c) => delete c.search });
    const search = document.getElementById('search');
    search.value = 'zz z';
    search.dispatchEvent(new Event('input'));
    await click(rows()[0]);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://duckduckgo.com/?q=zz%20z' });
  });

  it('opens the My Apps portal for the My Apps fallback', async () => {
    await noMatch({ fallbackSearch: 'myapps' });
    press(document.getElementById('search'), 'Enter');
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://myapplications.microsoft.com/',
    });
  });
});

describe('copy menu', () => {
  const ctx = () => document.getElementById('ctx');
  const toast = () => document.getElementById('toast');

  async function openMenu(index = 0) {
    await mount();
    rows()[index].dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }),
    );
    return ctx();
  }

  it('opens at the pointer and copies the app name', async () => {
    const menu = await openMenu();
    expect(menu.hidden).toBe(false);
    expect(menu.style.left).toBe('20px');
    await click(menu.querySelector('[data-act="name"]'));
    expect(writeText).toHaveBeenCalledWith('Jira');
    expect(toast().textContent).toBe('Copied name');
    expect(menu.hidden).toBe(true);
  });

  it('stays inside the popup when you right-click near the edge', async () => {
    await mount();
    Object.defineProperties(ctx(), {
      offsetWidth: { configurable: true, get: () => 120 },
      offsetHeight: { configurable: true, get: () => 80 },
    });
    rows()[0].dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: window.innerWidth,
        clientY: window.innerHeight,
      }),
    );
    expect(ctx().style.left).toBe(`${window.innerWidth - 120 - 4}px`);
    expect(ctx().style.top).toBe(`${window.innerHeight - 80 - 4}px`);
  });

  it('copies the URL', async () => {
    const menu = await openMenu(2);
    await click(menu.querySelector('[data-act="url"]'));
    expect(writeText).toHaveBeenCalledWith('https://wiki.example.com/');
    expect(toast().textContent).toBe('Copied URL');
  });

  it('reports a failed copy instead of silently doing nothing', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    const menu = await openMenu();
    await click(menu.querySelector('[data-act="url"]'));
    expect(toast().textContent).toBe('Copy failed');
  });

  it('ignores clicks on the menu chrome itself', async () => {
    const menu = await openMenu();
    await click(menu);
    expect(writeText).not.toHaveBeenCalled();
    expect(menu.hidden).toBe(false);
  });

  it('leaves no listener behind that swallows the next popup’s clicks', async () => {
    const menu = await openMenu();
    await click(menu); // deliberately leave the menu open, then re-open the popup
    expect(menu.hidden).toBe(false);
    await mount();
    await click(document.getElementById('open-options'));
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it('closes on an outside click WITHOUT launching the row underneath', async () => {
    const menu = await openMenu();
    await click(rows()[2]);
    expect(menu.hidden).toBe(true);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('closes on Escape before the search box is cleared', async () => {
    const menu = await openMenu();
    const search = document.getElementById('search');
    search.value = 'ji';
    press(search, 'Escape');
    expect(menu.hidden).toBe(true);
    expect(search.value).toBe('ji');
  });

  it('closes when the list scrolls or the window loses focus', async () => {
    const menu = await openMenu();
    document.getElementById('results').dispatchEvent(new Event('scroll'));
    expect(menu.hidden).toBe(true);
    await openMenu();
    window.dispatchEvent(new Event('blur'));
    expect(ctx().hidden).toBe(true);
  });

  it('hides the toast again after a moment', async () => {
    vi.useFakeTimers();
    try {
      const menu = await openMenu();
      await click(menu.querySelector('[data-act="name"]'));
      await vi.advanceTimersByTimeAsync(0);
      expect(toast().hidden).toBe(false);
      await vi.advanceTimersByTimeAsync(1500);
      expect(toast().hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('bookmarks', () => {
  const TREE = [
    {
      title: '',
      children: [
        {
          title: 'Bookmarks bar',
          children: [
            { title: 'Jira handbook', url: 'https://handbook.example.com/jira' },
            { title: 'Jira', url: 'https://jira.example.com/' }, // same URL as the Jira app
            { title: 'AWS pricing', url: 'https://aws.amazon.com/pricing/' },
          ],
        },
      ],
    },
  ];

  async function type(query, overrides = {}) {
    await mount({
      settings: { includeBookmarks: true, ...overrides.settings },
      chrome: { bookmarks: TREE },
    });
    const search = document.getElementById('search');
    search.value = query;
    search.dispatchEvent(new Event('input'));
    return search;
  }

  it('is off unless the setting is on — and reads nothing at all', async () => {
    await mount({ chrome: { bookmarks: TREE } });
    const search = document.getElementById('search');
    search.value = 'handbook';
    search.dispatchEvent(new Event('input'));
    // No bookmark row — just the usual "nothing matched" fallback.
    expect(names()).toEqual(['Search My Apps for “handbook”']);
    expect(search.placeholder).toBe('Search apps…');
    // The permission may well be granted from an earlier session; the setting
    // alone decides whether Beeline touches the bookmarks at all.
    expect(chrome.bookmarks.getTree).not.toHaveBeenCalled();
  });

  it('never writes a bookmark into the stored app list', async () => {
    await type('jira');
    press(document.getElementById('search'), 'ArrowDown');
    press(document.getElementById('search'), 'Enter'); // launch the bookmark row
    await flush();
    // The whole promise of this feature: bookmarks are read, never stored.
    expect(chrome.storage.local.store.apps).toEqual(APPS);
    expect(JSON.stringify(chrome.storage.local.store)).not.toContain('handbook.example.com');
  });

  it('shows bookmarks only once you type, never in the resting list', async () => {
    await mount({ settings: { includeBookmarks: true }, chrome: { bookmarks: TREE } });
    expect(names()).toEqual(['Jira', 'AWS Console', 'Confluence']); // apps only
    expect(document.getElementById('search').placeholder).toBe('Search apps and bookmarks…');
    const search = document.getElementById('search');
    search.value = 'handbook';
    search.dispatchEvent(new Event('input'));
    expect(names()).toEqual(['Jira handbook']);
  });

  it('ranks the app above the bookmark at equal relevance, and labels the row', async () => {
    await type('jira');
    // The 'Jira' bookmark duplicates the Jira app's URL and is dropped entirely.
    expect(names()).toEqual(['Jira', 'Jira handbook']);
    expect(rows()[0].querySelector('.badge')).toBeNull();
    expect(rows()[1].querySelector('.badge').textContent).toBe('Bookmark');
    expect(rows()[1].querySelector('.host').textContent).toBe(
      'Bookmarks bar · handbook.example.com',
    );
  });

  it('launches a bookmark and remembers it', async () => {
    await type('handbook');
    press(document.getElementById('search'), 'Enter');
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://handbook.example.com/jira' });
    expect(Object.keys(chrome.storage.local.store.stats)).toContain(
      `bm:${bookmarkKey('https://handbook.example.com/jira')}`,
    );
  });

  it('never bolts a SAML RelayState onto a bookmark, but does set the console region', async () => {
    await type('aws pricing', { settings: { awsRegion: 'eu-central-2' } });
    press(document.getElementById('search'), 'Enter');
    await flush();
    // aws.amazon.com IS the console domain → plain ?region=; no RelayState.
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://aws.amazon.com/pricing/?region=eu-central-2',
    });
  });

  it('searches bookmarks (and still offers the fallback) with no apps at all', async () => {
    await mount({
      settings: { includeBookmarks: true, fallbackSearch: 'web' },
      chrome: { bookmarks: TREE, local: { apps: [] } },
    });
    // The "No apps yet" way out stays — bookmarks are a search source, not apps.
    expect(document.getElementById('empty').hidden).toBe(false);
    const search = document.getElementById('search');
    search.value = 'handbook';
    search.dispatchEvent(new Event('input'));
    expect(names()).toEqual(['Jira handbook']);
    search.value = 'zzzz';
    search.dispatchEvent(new Event('input'));
    expect(names()).toEqual(['Search the web for “zzzz”']);
  });

  it('keeps the row you already picked when a slow bookmark read lands', async () => {
    let release;
    const booting = mount({
      settings: { includeBookmarks: true },
      mutate: (c) => {
        c.bookmarks = {
          getTree: vi.fn(
            () =>
              new Promise((resolve) => {
                release = resolve;
              }),
          ),
        };
      },
    });
    // Wait for the first paint only — the bookmark read is still in flight,
    // which is exactly the window this test is about.
    for (let i = 0; i < 50 && rows().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const search = document.getElementById('search');
    search.value = 'a';
    search.dispatchEvent(new Event('input'));
    press(search, 'ArrowDown');
    const picked = names()[selectedIndex()];
    expect(selectedIndex()).toBe(1);

    release(TREE);
    await booting;
    await flush();
    // Bookmarks joined and reshuffled the list — the selection followed the row,
    // so the next Enter still opens what was highlighted.
    expect(names().length).toBeGreaterThan(3);
    expect(names()[selectedIndex()]).toBe(picked);
  });

  it('shows the apps anyway when the bookmark read fails', async () => {
    await mount({
      settings: { includeBookmarks: true },
      mutate: (c) => {
        c.bookmarks = {
          getTree: vi.fn(() => {
            throw new Error('permission revoked mid-flight');
          }),
        };
      },
    });
    expect(names()).toEqual(['Jira', 'AWS Console', 'Confluence']);
    expect(document.getElementById('search').placeholder).toBe('Search apps…');
  });
});

describe('manage apps', () => {
  it('opens the options page from both entry points', async () => {
    await mount();
    await click(document.getElementById('open-options'));
    await click(document.getElementById('manage'));
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(2);
  });

  it('falls back to opening the options page as a tab', async () => {
    await mount({ mutate: (c) => delete c.runtime.openOptionsPage });
    await click(document.getElementById('open-options'));
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://beeline/options/options.html',
    });
  });
});
