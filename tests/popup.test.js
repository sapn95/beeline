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

describe('chunked painting', () => {
  // Enough apps to overrun the first slice. A real list is several hundred.
  const MANY = Array.from({ length: 60 }, (_, i) => ({
    id: `m${i}`,
    name: `App ${String(i + 1).padStart(2, '0')}`,
    url: `https://app${i + 1}.example.com/`,
    source: 'manual',
  }));

  const tick = () =>
    new Promise((resolve) =>
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => resolve())
        : setTimeout(resolve, 0),
    );

  /** Let the streamed tail land: one chunk per frame, with a runaway guard. */
  async function paintAll(expected) {
    for (let i = 0; i < 30 && rows().length < expected; i++) await tick();
    return rows().length;
  }

  it('paints a first slice right away and streams the rest in afterwards', async () => {
    await mount({ chrome: { local: { apps: MANY } } });
    // Building every row up front is what made the popup slow to open: with a
    // few hundred apps that is a few hundred icons nobody is looking at.
    expect(rows()).toHaveLength(20);
    expect(names()[0]).toBe('App 01');
    expect(await paintAll(60)).toBe(60);
    expect(names()[59]).toBe('App 60');
  });

  it('lets the keyboard outrun the tail', async () => {
    await mount({ chrome: { local: { apps: MANY } } });
    const search = document.getElementById('search');
    for (let i = 0; i < 25; i++) press(search, 'ArrowDown');
    // Row 26 is well past the first slice, so it has to be pulled in on demand.
    // Otherwise the arrows walk into rows that do not exist yet and Enter opens
    // nothing — the ranking is complete, only the painting is behind.
    expect(selectedIndex()).toBe(25);
    expect(rows()[25].querySelector('.name').textContent).toBe('App 26');
  });

  it('wraps to the last row before the tail has landed', async () => {
    await mount({ chrome: { local: { apps: MANY } } });
    press(document.getElementById('search'), 'ArrowUp');
    expect(selectedIndex()).toBe(59);
    expect(rows()).toHaveLength(60);
  });

  it('starts the paint over on a new query, leaving no stale rows behind', async () => {
    await mount({ chrome: { local: { apps: MANY } } });
    await paintAll(60);
    const search = document.getElementById('search');
    search.value = 'App 07';
    search.dispatchEvent(new Event('input'));
    expect(names()).toEqual(['App 07']);
    expect(selectedIndex()).toBe(0);
  });
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

  it('ranks the app above the bookmark at equal relevance, and says where it lives', async () => {
    await type('jira');
    // The 'Jira' bookmark duplicates the Jira app's URL and is dropped entirely.
    expect(names()).toEqual(['Jira', 'Jira handbook']);
    // The folder in the subtitle is what marks a bookmark — no extra badge, it
    // only repeated what the row already says.
    expect(rows()[0].querySelector('.host').textContent).toBe('jira.example.com');
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

describe('Firefox containers', () => {
  const WORK = 'firefox-container-2';
  const CONTAINED = [
    { id: 'c1', name: 'Outlook', url: 'https://outlook.example.com/', source: 'myapps' },
    {
      id: 'c2',
      name: 'Outlook',
      url: 'https://outlook.example.com/',
      source: 'myapps',
      container: WORK,
    },
  ];

  function mountFirefox({ granted = true, settings = {} } = {}) {
    globalThis.chrome = makeChrome({ local: { apps: CONTAINED }, sync: { settings } });
    globalThis.browser = {
      contextualIdentities: {
        query: vi.fn(async () => [{ cookieStoreId: WORK, name: 'SBB', color: 'red' }]),
      },
      permissions: { contains: vi.fn(async () => granted) },
    };
    loadPage('popup');
    vi.resetModules();
    return import('../src/popup/popup.js');
  }

  afterEach(() => {
    delete globalThis.browser;
  });

  it('marks the contained row with its container colour, not with words', async () => {
    // Two rows, identical name and URL. A colour is read at a glance where a
    // name has to be read word by word.
    await mountFirefox();
    await flush();
    const [plain, contained] = rows();
    expect(plain.classList.contains('contained')).toBe(false);
    expect(contained.classList.contains('contained')).toBe(true);
    expect(contained.style.getPropertyValue('--container')).toBe('#ff613d'); // Firefox red
    expect(contained.title).toBe('https://outlook.example.com/\nOpens in the SBB container');
    // Every row spells its full launch URL out on hover, contained or not.
    expect(plain.title).toBe('https://outlook.example.com/');
    // The subtitle stays the host — the colour carries the container.
    expect(contained.querySelector('.host').textContent).toBe('outlook.example.com');
  });

  it('still marks a row whose colour this build does not know', async () => {
    // "This one is pinned somewhere" is the part that matters; the hue is only
    // the shortcut, and Firefox keeps renaming its colours.
    globalThis.chrome = makeChrome({ local: { apps: CONTAINED }, sync: { settings: {} } });
    globalThis.browser = {
      contextualIdentities: {
        query: vi.fn(async () => [{ cookieStoreId: WORK, name: 'SBB', color: 'chartreuse' }]),
      },
      permissions: { contains: vi.fn(async () => true) },
    };
    loadPage('popup');
    vi.resetModules();
    await import('../src/popup/popup.js');
    await flush();
    expect(rows()[1].style.getPropertyValue('--container')).toBe('currentColor');
  });

  it('launches a contained app into its container', async () => {
    await mountFirefox();
    await flush();
    press(document.getElementById('search'), 'ArrowDown');
    press(document.getElementById('search'), 'Enter');
    await flush();
    expect(globalThis.chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://outlook.example.com/',
      cookieStoreId: WORK,
    });
  });

  it('opens it in the default container rather than not at all', async () => {
    // Firefox rejects tabs.create outright when a cookieStoreId is passed
    // without the `cookies` permission — the app would simply never open.
    await mountFirefox({ granted: false });
    await flush();
    press(document.getElementById('search'), 'ArrowDown');
    press(document.getElementById('search'), 'Enter');
    await flush();
    expect(globalThis.chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://outlook.example.com/',
    });
  });
});

describe('how strongly a container is marked', () => {
  const WORK = 'firefox-container-2';
  const CONTAINED = [
    {
      id: 'c2',
      name: 'Outlook',
      url: 'https://outlook.example.com/',
      source: 'myapps',
      container: WORK,
    },
  ];

  async function mountWith(containerStyle) {
    globalThis.chrome = makeChrome({
      local: { apps: CONTAINED },
      sync: { settings: containerStyle ? { containerStyle } : {} },
    });
    globalThis.browser = {
      contextualIdentities: {
        query: vi.fn(async () => [{ cookieStoreId: WORK, name: 'SBB', color: 'red' }]),
      },
      permissions: { contains: vi.fn(async () => true) },
    };
    loadPage('popup');
    vi.resetModules();
    await import('../src/popup/popup.js');
    await flush();
  }

  afterEach(() => {
    delete globalThis.browser;
  });

  it('shows just the badge by default', async () => {
    // It names the container exactly as precisely as a coloured row does, and
    // leaves a list of several hundred rows quiet enough to read.
    await mountWith();
    expect(document.getElementById('results').dataset.container).toBe('chip');
    expect(rows()[0].querySelector('.cchip').textContent).toBe('SBB');
  });

  it.each(['fill', 'outline', 'edge'])('honours the %s setting', async (style) => {
    await mountWith(style);
    expect(document.getElementById('results').dataset.container).toBe(style);
    expect(rows()[0].classList.contains('contained')).toBe(true); // still marked
  });
});

describe('the My Apps fallback with containers', () => {
  const WORK = 'firefox-container-2';
  const MIXED = [
    { id: 'f1', name: 'Alpha', url: 'https://alpha.example.com/', source: 'myapps' },
    {
      id: 'f2',
      name: 'Beta',
      url: 'https://beta.example.com/',
      source: 'myapps',
      container: WORK,
    },
  ];

  async function mountMixed(apps) {
    globalThis.chrome = makeChrome({ local: { apps }, sync: { settings: {} } });
    globalThis.browser = {
      contextualIdentities: {
        query: vi.fn(async () => [{ cookieStoreId: WORK, name: 'SBB', color: 'red' }]),
      },
      permissions: { contains: vi.fn(async () => true) },
    };
    loadPage('popup');
    vi.resetModules();
    await import('../src/popup/popup.js');
    await flush();
    const search = document.getElementById('search');
    search.value = 'nothing matches this';
    search.dispatchEvent(new Event('input'));
  }

  afterEach(() => {
    delete globalThis.browser;
  });

  it('offers one row per container the user keeps apps in', async () => {
    // My Apps in the work container lists a different tenant than the same page
    // in the default context, so a single row would send you to whichever
    // account happened to be signed in — usually not the one you searched for.
    await mountMixed(MIXED);
    expect(rows().map((li) => li.querySelector('.name').textContent)).toEqual([
      'Search My Apps for “nothing matches this”',
      'Search My Apps for “nothing matches this” (SBB)',
    ]);
  });

  it('opens the portal in the container that row stands for', async () => {
    await mountMixed(MIXED);
    press(document.getElementById('search'), 'ArrowDown');
    press(document.getElementById('search'), 'Enter');
    await flush();
    expect(globalThis.chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://myapplications.microsoft.com/',
      cookieStoreId: WORK,
    });
  });

  it('stays a single row when no container is in play', async () => {
    await mountMixed([MIXED[0]]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].querySelector('.name').textContent).toBe(
      'Search My Apps for “nothing matches this”',
    );
  });
});

describe('the launcher container pre-filter', () => {
  const WORK = 'firefox-container-2';
  const HOME = 'firefox-container-3';
  const APPS = [
    { id: 'p1', name: 'Plain', url: 'https://plain.example.com/', source: 'myapps' },
    {
      id: 'p2',
      name: 'Worky',
      url: 'https://worky.example.com/',
      source: 'myapps',
      container: WORK,
    },
    {
      id: 'p3',
      name: 'Homey',
      url: 'https://homey.example.com/',
      source: 'myapps',
      container: HOME,
    },
  ];

  async function mountHiding(hiddenContainers) {
    globalThis.chrome = makeChrome({
      local: { apps: APPS },
      sync: { settings: hiddenContainers ? { hiddenContainers } : {} },
    });
    globalThis.browser = {
      contextualIdentities: {
        query: vi.fn(async () => [
          { cookieStoreId: WORK, name: 'SBB', color: 'red' },
          { cookieStoreId: HOME, name: 'Personal', color: 'green' },
        ]),
      },
      permissions: { contains: vi.fn(async () => true) },
    };
    loadPage('popup');
    vi.resetModules();
    await import('../src/popup/popup.js');
    await flush();
  }

  afterEach(() => {
    delete globalThis.browser;
  });

  const names = () => rows().map((li) => li.querySelector('.name').textContent);

  it('shows everything when nothing is unticked', async () => {
    // The stored value is the HIDDEN set, so empty means show all — which is
    // also what every browser without containers has.
    await mountHiding();
    expect(names().sort()).toEqual(['Homey', 'Plain', 'Worky']);
  });

  it('mixes: two of three', async () => {
    await mountHiding([HOME]);
    expect(names().sort()).toEqual(['Plain', 'Worky']);
  });

  it('can hide the container-less apps too', async () => {
    await mountHiding(['']);
    expect(names().sort()).toEqual(['Homey', 'Worky']);
  });

  it('narrows the fallback rows to the same scopes', async () => {
    // Offering "Search My Apps (Personal)" while Personal is hidden would send
    // the user to an account they have chosen not to see.
    await mountHiding([HOME]);
    const search = document.getElementById('search');
    search.value = 'nothing matches this';
    search.dispatchEvent(new Event('input'));
    expect(names()).toEqual([
      'Search My Apps for “nothing matches this”',
      'Search My Apps for “nothing matches this” (SBB)',
    ]);
  });

  it('says WHY the list is empty when the filter hides everything', async () => {
    // "No apps yet — add or import" is a lie when the apps exist and the filter
    // is hiding them, and it offers the one way out that cannot help.
    await mountHiding(['', WORK, HOME]);
    expect(rows()).toHaveLength(0);
    const empty = document.getElementById('empty');
    expect(empty.hidden).toBe(false);
    expect(empty.querySelector('p').textContent).toBe(
      'All 3 of your apps are hidden by the container filter.',
    );
    expect(document.getElementById('manage').textContent).toBe('Change that in settings');
  });

  it('still offers a search when the filter emptied the pool', async () => {
    await mountHiding(['', WORK, HOME]);
    const search = document.getElementById('search');
    search.value = 'jira';
    search.dispatchEvent(new Event('input'));
    expect(rows().length).toBeGreaterThan(0);
  });
});
