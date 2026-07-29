// Optional second search source: this browser's own bookmarks.
//
// Bookmarks are NEVER copied into the stored app list. They are read live from
// the bookmarks API each time the popup opens, so there is nothing to sync,
// nothing to prune, and switching the option off — or revoking the optional
// `bookmarks` permission in the browser's extension settings — makes them
// disappear immediately. `loadBookmarkItems` is the only part that touches the
// browser; everything else here is pure and unit-tested.

import { fnv1a, normalizeUrl } from './apps.js';

/** Ids are namespaced so a bookmark's launch stats can never collide with an
 * app's, while staying stable per URL — moving a bookmark to another folder or
 * renaming it keeps the ranking it earned. */
export const BOOKMARK_ID_PREFIX = 'bm:';

/** A bookmark's identity KEEPS its fragment, unlike an app's (which drops it to
 * collapse two tiles into one app). A hash-routed page — an Azure Portal blade,
 * a Power BI report page — lives entirely in the fragment, so two of them are
 * two different destinations and have to stay two rows. */
export function bookmarkKey(url) {
  return fnv1a(normalizeUrl(url));
}

/** Only http(s) targets are launchable. A bookmarklet (`javascript:`), a local
 * `file:` or a `data:` bookmark has no business in a launcher, and the browser
 * refuses to open most of them from an extension tab anyway. */
export function isLaunchableBookmarkUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Flatten a bookmarks tree into its launchable leaves, remembering the folder
 * path each one lives in (shown as the row subtitle). The unnamed root nodes
 * are skipped in the path; the browser's own top-level folders ("Bookmarks
 * bar", "Other bookmarks") are kept, because that IS how you think of them.
 */
export function flattenBookmarks(nodes, folder = '', out = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node) continue;
    if (node.children) {
      const title = String(node.title ?? '').trim();
      const path = title ? (folder ? `${folder} › ${title}` : title) : folder;
      flattenBookmarks(node.children, path, out);
    } else if (node.url) {
      out.push({ title: String(node.title ?? '').trim(), url: node.url, folder });
    }
  }
  return out;
}

/**
 * Turn a bookmarks tree into launcher items: unusable entries are dropped, the
 * same URL bookmarked twice collapses to one, and anything you already have as
 * an app is left out — the app wins, since it carries the icon, the My Apps
 * provenance and the launch stats you have already built up.
 */
export function buildBookmarkItems(tree, apps = []) {
  const taken = new Set(apps.map((a) => bookmarkKey(a?.url ?? '')));
  const items = new Map();
  for (const bm of flattenBookmarks(tree)) {
    if (!isLaunchableBookmarkUrl(bm.url)) continue;
    const key = bookmarkKey(bm.url);
    if (taken.has(key) || items.has(key)) continue;
    items.set(key, {
      id: BOOKMARK_ID_PREFIX + key,
      // An untitled bookmark still has to be findable — fall back to its host.
      name: bm.title || new URL(bm.url).host,
      url: bm.url,
      folder: bm.folder,
      source: 'bookmark',
    });
  }
  return [...items.values()];
}

function bookmarksApi() {
  // Firefox exposes promise-style APIs on `browser`; Chrome MV3 on `chrome`.
  // Either namespace is absent entirely while the optional permission is not
  // granted, which is exactly the "feature is off" case.
  return globalThis.browser?.bookmarks ?? globalThis.chrome?.bookmarks ?? null;
}

function getTree(api) {
  // Promise form on Chrome MV3 and on Firefox's `browser`; the callback form is
  // the fallback for a callback-only implementation.
  try {
    const res = api.getTree();
    if (res && typeof res.then === 'function') return res;
  } catch {
    /* callback-only implementation — fall through */
  }
  return new Promise((resolve, reject) => {
    try {
      api.getTree(resolve);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Read this browser's bookmarks as launcher items, minus the ones already in
 * `apps`. Resolves to [] when the API is missing (permission never granted or
 * since revoked) or the read fails — a failed bookmark read must never keep the
 * launcher from showing your apps.
 */
export async function loadBookmarkItems(apps = []) {
  const api = bookmarksApi();
  if (!api?.getTree) return [];
  try {
    return buildBookmarkItems(await getTree(api), apps);
  } catch {
    return [];
  }
}
