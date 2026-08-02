import { getApps, getStats, getSettings, recordLaunch } from '../lib/storage.js';
import { rankApps, hostOf } from '../lib/ranking.js';
import { withAwsRegion } from '../lib/apps.js';
import { loadBookmarkItems } from '../lib/bookmarks.js';

const searchEl = document.getElementById('search');
const resultsEl = document.getElementById('results');
const emptyEl = document.getElementById('empty');
const ctxEl = document.getElementById('ctx');
const toastEl = document.getElementById('toast');

let ctxApp = null; // the app the right-click menu is acting on
let toastTimer = null;

let apps = [];
let bookmarks = []; // read live from the browser, never stored — see lib/bookmarks.js
let stats = {};
let settings = {
  openInNewTab: true,
  closeAfterLaunch: true,
  fallbackSearch: 'myapps',
  awsRegion: '',
  includeBookmarks: false,
};
let current = [];
let selected = 0;

async function init() {
  wireEvents();
  try {
    [apps, stats, settings] = await Promise.all([getApps(), getStats(), getSettings()]);
  } catch {
    /* storage unavailable — fall back to the defaults above rather than a blank popup */
  }
  const theme = settings.theme || 'auto'; // 'auto' | 'light' | 'dark'
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('beeline-theme', theme); // mirror for theme-boot.js (no-flash)
  } catch {
    /* localStorage unavailable */
  }
  emptyEl.hidden = apps.length > 0;
  render();
  searchEl.focus();
  await loadBookmarks();
}

// Bookmarks are optional and read live. Loading them AFTER the first paint
// keeps the popup instant — they only matter once you start typing.
async function loadBookmarks() {
  if (!settings.includeBookmarks) return;
  bookmarks = await loadBookmarkItems(apps).catch(() => []);
  if (bookmarks.length === 0) return;
  searchEl.placeholder = 'Search apps and bookmarks…';
  searchEl.setAttribute('aria-label', 'Search apps and bookmarks');
  // The "No apps yet" panel deliberately stays: bookmarks are a search source,
  // not an app list, so with an empty list there is still nothing to launch
  // until you type — and hiding it would leave a blank popup instead of the
  // "add or import apps" way out.
  //
  // Re-select whatever the user had picked: this is a keyboard launcher, so by
  // the time a big bookmark tree comes back they may already have typed and
  // arrowed down, and silently snapping back to row 1 would open the wrong
  // thing on the next Enter.
  const picked = current[selected];
  render();
  const i = picked ? current.findIndex((r) => isSameResult(r, picked)) : -1;
  if (i > 0) {
    selected = i;
    updateSelection();
  }
}

/** Two rendered rows are the same row when they launch the same thing. */
function isSameResult(a, b) {
  return a.fallback ? a.fallback === b.fallback && a.query === b.query : a.app?.id === b.app?.id;
}

function wireEvents() {
  searchEl.addEventListener('input', render);
  searchEl.addEventListener('keydown', onKeyDown);
  document.getElementById('open-options').addEventListener('click', openOptions);
  const manage = document.getElementById('manage');
  if (manage) manage.addEventListener('click', openOptions);

  // Right-click copy menu: act on its buttons, and dismiss on outside click/scroll/blur.
  ctxEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) onCtxAction(btn.dataset.act);
  });
  // Capture phase + stop, so the click that dismisses the menu doesn't also fall
  // through to a row and launch that app.
  document.addEventListener(
    'click',
    (e) => {
      if (ctxEl.hidden || ctxEl.contains(e.target)) return; // let menu-button clicks through
      e.preventDefault();
      e.stopPropagation();
      closeCtxMenu();
    },
    true,
  );
  resultsEl.addEventListener('scroll', closeCtxMenu);
  window.addEventListener('blur', closeCtxMenu);
}

function render() {
  closeCtxMenu(); // the rows are about to be replaced under it
  const q = searchEl.value.trim();
  // Bookmarks join the pool only once you type: they are a search source, not a
  // list. Showing hundreds of them on open would bury the apps.
  const pool = q && bookmarks.length > 0 ? apps.concat(bookmarks) : apps;
  current = rankApps(pool, searchEl.value, Date.now(), stats);
  // When you have something to search but none of it matches, offer a fallback.
  if (current.length === 0 && q && pool.length > 0) {
    current = buildFallbacks(q);
  }
  selected = 0;
  resultsEl.replaceChildren(...current.map((r, i) => renderItem(r, i)));
  updateSelection();
}

function buildFallbacks(query) {
  const mode = settings.fallbackSearch;
  const items = [];
  if (mode === 'myapps' || mode === 'both') items.push({ fallback: 'myapps', query });
  if (mode === 'web' || mode === 'both') items.push({ fallback: 'web', query });
  return items;
}

// My Apps launcher links all share one host, so their favicon is the same
// Microsoft glyph for every app — an initial tells them apart, that would not.
const SAME_FAVICON_HOSTS = new Set([
  'launcher.myapps.microsoft.com',
  'myapplications.microsoft.com',
]);

/**
 * Bookmarks (chrome.bookmarks carries no icon) and hand-added apps have no logo
 * to scrape, so borrow the one the browser has already cached for that page.
 * The `favicon` permission serves it from Chrome's LOCAL store: no network
 * request, nothing leaves the machine. Returns '' when there is nothing sensible
 * to ask for — the caller then draws the initial.
 */
function faviconUrl(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return '';
  }
  if (SAME_FAVICON_HOSTS.has(host)) return '';
  try {
    const endpoint = new URL(chrome.runtime.getURL('/_favicon/'));
    endpoint.searchParams.set('pageUrl', url);
    endpoint.searchParams.set('size', '32');
    return endpoint.toString();
  } catch {
    return ''; // no runtime API / no favicon permission (Firefox build)
  }
}

/** Replace whatever is in the icon slot with the app's initial. */
function letterTile(icon, name) {
  icon.textContent = ''; // drops a failed <img> along with it
  icon.classList.add('letter');
  icon.textContent = String(name || '?')
    .charAt(0)
    .toUpperCase();
}

function renderItem(r, i) {
  if (r.fallback) return renderFallbackItem(r, i);

  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.index = String(i);

  const icon = document.createElement('span');
  icon.className = 'icon';
  const src = r.app.iconUrl || faviconUrl(r.app.url);
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    // No favicon cached (or a browser without the endpoint, e.g. Firefox): drop
    // back to the initial rather than leaving a broken image behind.
    img.addEventListener('error', () => letterTile(icon, r.app.name), { once: true });
    icon.appendChild(img);
  } else {
    letterTile(icon, r.app.name);
  }

  const meta = document.createElement('span');
  meta.className = 'meta';
  const name = document.createElement('span');
  name.className = 'name';
  name.append(...highlight(r.app.name, r.field === 'name' ? r.positions : []));
  const host = document.createElement('span');
  host.className = 'host';
  const where = hostOf(r.app.url) || r.app.url;
  // A bookmark says where it lives, so two similarly-named ones stay tellable
  // apart ("Work › Tickets · jira.example.com").
  host.textContent = r.app.folder ? `${r.app.folder} · ${where}` : where;
  meta.append(name, host);

  li.append(icon, meta);
  if (r.app.source === 'bookmark') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Bookmark';
    li.append(badge);
  }
  li.addEventListener('click', () => launch(i));
  li.addEventListener('contextmenu', (e) => openCtxMenu(e, r.app, i)); // right-click → copy menu
  li.addEventListener('mousemove', () => {
    if (selected !== i) {
      selected = i;
      updateSelection();
    }
  });
  return li;
}

function renderFallbackItem(r, i) {
  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.index = String(i);

  const icon = document.createElement('span');
  icon.className = 'icon letter';
  icon.textContent = '🔍';

  const meta = document.createElement('span');
  meta.className = 'meta';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent =
    r.fallback === 'myapps' ? `Search My Apps for “${r.query}”` : `Search the web for “${r.query}”`;
  const host = document.createElement('span');
  host.className = 'host';
  host.textContent =
    r.fallback === 'myapps' ? 'myapplications.microsoft.com' : 'your default search engine';
  meta.append(name, host);

  li.append(icon, meta);
  li.addEventListener('click', () => launch(i));
  li.addEventListener('mousemove', () => {
    if (selected !== i) {
      selected = i;
      updateSelection();
    }
  });
  return li;
}

// Wrap matched character positions in <mark> for highlighting.
function highlight(text, positions) {
  if (!positions || positions.length === 0) return [document.createTextNode(text)];
  const set = new Set(positions);
  const nodes = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      if (buf) {
        nodes.push(document.createTextNode(buf));
        buf = '';
      }
      const mark = document.createElement('mark');
      mark.textContent = text[i];
      nodes.push(mark);
    } else {
      buf += text[i];
    }
  }
  if (buf) nodes.push(document.createTextNode(buf));
  return nodes;
}

function onKeyDown(e) {
  if (e.key === 'Escape' && !ctxEl.hidden) {
    e.preventDefault();
    closeCtxMenu(); // close the copy menu first, before clearing the search
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    launch(selected, e.ctrlKey || e.metaKey); // Ctrl/Cmd+Enter → background tab
  } else if (e.altKey && /^Digit[1-9]$/.test(e.code || '')) {
    // Match the PHYSICAL key: macOS turns Option+2 into '™', so e.key would never
    // be a digit there and the advertised ⌥1–9 shortcut would do nothing.
    e.preventDefault();
    launch(Number(e.code.slice(5)) - 1); // Alt+1–9 → quick-launch that result
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (searchEl.value) {
      searchEl.value = '';
      render();
    } else {
      window.close();
    }
  }
}

function move(delta) {
  if (current.length === 0) return;
  selected = (selected + delta + current.length) % current.length;
  updateSelection();
}

function updateSelection() {
  const items = resultsEl.children;
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('selected', i === selected);
  }
  const el = items[selected];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

async function launch(i, background = false) {
  const r = current[i];
  if (!r) return;
  if (r.fallback) {
    doFallback(r);
    return;
  }
  // Usage stats are best-effort: a failed write (quota, transient error) must
  // never stop the app from opening — launching IS the job.
  await recordLaunch(r.app.id, Date.now()).catch(() => {});
  const target = withAwsRegion(r.app.url, r.app.name, settings.awsRegion, {
    // The SAML RelayState rewrite only makes sense for an SSO launch URL. A
    // bookmark is just a URL the user saved — leave it alone unless it IS the
    // AWS console, which takes a plain ?region=.
    samlRelayState: r.app.source !== 'bookmark',
  });
  if (background) {
    chrome.tabs.create({ url: target, active: false });
    return; // keep the popup open so you can launch several in a row
  }
  if (settings.openInNewTab) {
    chrome.tabs.create({ url: target });
  } else {
    chrome.tabs.update({ url: target });
  }
  if (settings.closeAfterLaunch) window.close();
}

function doFallback(r) {
  if (r.fallback === 'web') {
    if (chrome.search?.query) {
      chrome.search.query({ text: r.query, disposition: 'NEW_TAB' });
    } else {
      chrome.tabs.create({ url: `https://duckduckgo.com/?q=${encodeURIComponent(r.query)}` });
    }
  } else {
    chrome.tabs.create({ url: 'https://myapplications.microsoft.com/' });
  }
  if (settings.closeAfterLaunch) window.close();
}

function openOptions() {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
  }
}

// Right-click menu: copy an app's name or URL.
function openCtxMenu(e, app, i) {
  e.preventDefault();
  selected = i;
  updateSelection();
  ctxApp = app;
  ctxEl.hidden = false;
  // Show first (so we can measure it), then clamp inside the popup viewport.
  const x = Math.max(4, Math.min(e.clientX, window.innerWidth - ctxEl.offsetWidth - 4));
  const y = Math.max(4, Math.min(e.clientY, window.innerHeight - ctxEl.offsetHeight - 4));
  ctxEl.style.left = `${x}px`;
  ctxEl.style.top = `${y}px`;
}

function closeCtxMenu() {
  if (!ctxEl.hidden) {
    ctxEl.hidden = true;
    ctxApp = null;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text); // works in Chrome + Firefox popups on a user gesture
    return true;
  } catch {
    return false;
  }
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 1400);
}

async function onCtxAction(act) {
  const app = ctxApp;
  closeCtxMenu();
  if (!app) return;
  const isUrl = act === 'url';
  const label = isUrl ? 'URL' : 'name';
  const ok = await copyText(isUrl ? app.url : app.name);
  toast(ok ? `Copied ${label}` : 'Copy failed');
}

await init();
