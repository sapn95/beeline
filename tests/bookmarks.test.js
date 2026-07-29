// The optional bookmarks source. These are the functions that decide what a
// bookmark turns into in the launcher — and, just as importantly, what it never
// turns into: a stored app, a duplicate of an app you already have, or a
// javascript: URL the popup would happily open.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  BOOKMARK_ID_PREFIX,
  bookmarkKey,
  isLaunchableBookmarkUrl,
  flattenBookmarks,
  buildBookmarkItems,
  loadBookmarkItems,
} from '../src/lib/bookmarks.js';
import { appId } from '../src/lib/apps.js';

// A tree shaped the way chrome.bookmarks.getTree returns one: an unnamed root,
// then the browser's own top-level folders, then user folders.
const TREE = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: 'Bookmarks bar',
        children: [
          { id: '11', title: 'Jira', url: 'https://jira.example.com/' },
          {
            id: '12',
            title: 'Work',
            children: [
              { id: '121', title: 'Grafana', url: 'https://grafana.example.com/d/1' },
              { id: '122', title: 'Bookmarklet', url: 'javascript:void(0)' },
            ],
          },
        ],
      },
      {
        id: '2',
        title: 'Other bookmarks',
        children: [{ id: '21', title: '', url: 'https://untitled.example.com/page' }],
      },
    ],
  },
];

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.browser;
});

describe('isLaunchableBookmarkUrl', () => {
  it('accepts http(s) and nothing else', () => {
    expect(isLaunchableBookmarkUrl('https://example.com/')).toBe(true);
    expect(isLaunchableBookmarkUrl('http://intranet.example/')).toBe(true);
    expect(isLaunchableBookmarkUrl('javascript:alert(1)')).toBe(false);
    expect(isLaunchableBookmarkUrl('data:text/html,<h1>x</h1>')).toBe(false);
    expect(isLaunchableBookmarkUrl('file:///etc/hosts')).toBe(false);
    expect(isLaunchableBookmarkUrl('chrome://bookmarks/')).toBe(false);
    expect(isLaunchableBookmarkUrl('not a url')).toBe(false);
    expect(isLaunchableBookmarkUrl(undefined)).toBe(false);
  });
});

describe('flattenBookmarks', () => {
  it('returns the leaves with their folder path, skipping unnamed roots', () => {
    expect(flattenBookmarks(TREE)).toEqual([
      { title: 'Jira', url: 'https://jira.example.com/', folder: 'Bookmarks bar' },
      {
        title: 'Grafana',
        url: 'https://grafana.example.com/d/1',
        folder: 'Bookmarks bar › Work',
      },
      { title: 'Bookmarklet', url: 'javascript:void(0)', folder: 'Bookmarks bar › Work' },
      { title: '', url: 'https://untitled.example.com/page', folder: 'Other bookmarks' },
    ]);
  });

  it('survives junk input', () => {
    expect(flattenBookmarks(null)).toEqual([]);
    expect(flattenBookmarks([null, undefined, {}])).toEqual([]);
    expect(flattenBookmarks([{ children: [{ title: 'x' }] }])).toEqual([]); // no url, not a leaf
  });
});

describe('buildBookmarkItems', () => {
  it('maps launchable leaves to launcher items', () => {
    const items = buildBookmarkItems(TREE);
    expect(items.map((i) => i.name)).toEqual(['Jira', 'Grafana', 'untitled.example.com']);
    expect(items[0]).toEqual({
      id: BOOKMARK_ID_PREFIX + bookmarkKey('https://jira.example.com/'),
      name: 'Jira',
      url: 'https://jira.example.com/',
      folder: 'Bookmarks bar',
      source: 'bookmark',
    });
  });

  it('drops bookmarks you already have as an app — the app wins', () => {
    const apps = [{ id: appId('https://jira.example.com/'), url: 'https://jira.example.com/' }];
    expect(buildBookmarkItems(TREE, apps).map((i) => i.name)).toEqual([
      'Grafana',
      'untitled.example.com',
    ]);
  });

  it('tolerates an app record without a URL', () => {
    expect(buildBookmarkItems(TREE, [{ id: 'x' }]).length).toBe(3);
  });

  it('collapses the same URL bookmarked in two folders', () => {
    const dup = [
      {
        title: '',
        children: [
          { title: 'A', url: 'https://same.example.com/' },
          { title: 'B', children: [{ title: 'B copy', url: 'https://same.example.com/' }] },
        ],
      },
    ];
    expect(buildBookmarkItems(dup).map((i) => i.name)).toEqual(['A']);
  });

  it('keeps two hash-routed destinations apart, unlike the app list', () => {
    const blades = [
      {
        title: '',
        children: [
          { title: 'Blade A', url: 'https://portal.example.com/#/resource/a' },
          { title: 'Blade B', url: 'https://portal.example.com/#/resource/b' },
        ],
      },
    ];
    // An app id drops the fragment on purpose (two tiles, one app); a bookmark
    // must not, or the second blade would silently vanish from the launcher.
    expect(appId('https://portal.example.com/#/resource/a')).toBe(
      appId('https://portal.example.com/#/resource/b'),
    );
    expect(buildBookmarkItems(blades).map((i) => i.name)).toEqual(['Blade A', 'Blade B']);
  });

  it('does not treat a bookmark into a hash route as a duplicate of the plain app', () => {
    const tree = [
      { title: '', children: [{ title: 'Blade', url: 'https://portal.example.com/#/a' }] },
    ];
    const apps = [{ id: appId('https://portal.example.com/'), url: 'https://portal.example.com/' }];
    expect(buildBookmarkItems(tree, apps).map((i) => i.name)).toEqual(['Blade']);
  });
});

describe('loadBookmarkItems', () => {
  it('returns nothing when the API is absent (permission not granted)', async () => {
    expect(await loadBookmarkItems()).toEqual([]);
    globalThis.chrome = { storage: {} };
    expect(await loadBookmarkItems()).toEqual([]);
  });

  it('reads the promise-style API', async () => {
    globalThis.chrome = { bookmarks: { getTree: vi.fn(async () => TREE) } };
    const items = await loadBookmarkItems([
      { id: appId('https://jira.example.com/'), url: 'https://jira.example.com/' },
    ]);
    expect(items.map((i) => i.name)).toEqual(['Grafana', 'untitled.example.com']);
  });

  it('prefers the browser namespace when both exist (Firefox)', async () => {
    globalThis.chrome = { bookmarks: { getTree: vi.fn(async () => []) } };
    globalThis.browser = { bookmarks: { getTree: vi.fn(async () => TREE) } };
    expect((await loadBookmarkItems()).length).toBe(3);
    expect(globalThis.chrome.bookmarks.getTree).not.toHaveBeenCalled();
  });

  it('falls back to the callback form', async () => {
    globalThis.chrome = {
      bookmarks: {
        getTree: vi.fn((cb) => {
          if (!cb) throw new TypeError('callback required');
          cb(TREE);
        }),
      },
    };
    expect((await loadBookmarkItems()).map((i) => i.name)).toEqual([
      'Jira',
      'Grafana',
      'untitled.example.com',
    ]);
  });

  it('falls back when the promise form returns nothing at all', async () => {
    let calls = 0;
    globalThis.chrome = {
      bookmarks: {
        getTree: vi.fn((cb) => {
          calls++;
          if (cb) cb(TREE);
          return undefined;
        }),
      },
    };
    expect((await loadBookmarkItems()).length).toBe(3);
    expect(calls).toBe(2);
  });

  it('never throws when the read fails — the apps must still show', async () => {
    globalThis.chrome = {
      bookmarks: {
        getTree: vi.fn(() => {
          throw new Error('nope');
        }),
      },
    };
    expect(await loadBookmarkItems()).toEqual([]);

    globalThis.chrome = { bookmarks: { getTree: vi.fn(() => Promise.reject(new Error('nope'))) } };
    expect(await loadBookmarkItems()).toEqual([]);
  });
});
