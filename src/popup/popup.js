import { getApps, getStats, getSettings, recordLaunch } from '../lib/storage.js';
import { rankApps, hostOf } from '../lib/ranking.js';
import { withAwsRegion } from '../lib/apps.js';
import { loadBookmarkItems } from '../lib/bookmarks.js';
import { withContainer, listContainers, containerColor } from '../lib/containers.js';

const MYAPPS_URL = 'https://myapplications.microsoft.com/';

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
  containerStyle: 'chip',
  hiddenContainers: [],
};
let containers = new Map(); // cookieStoreId -> {name, color} (Firefox only)
let current = [];
let selected = 0;
let selectedEl = null; // the highlighted row, kept so selection never walks the whole list

// Rows are painted in chunks: the first slice lands right away, the rest streams
// in over the following frames. Building several hundred rows (each with an
// icon) in one go is what made the popup feel slow to open and slow per
// keystroke — the list below the fold can arrive late, nobody is looking at it.
const FIRST_CHUNK = 20; // more than fills the popup viewport
const TAIL_CHUNK = 50;
let painted = 0; // how many of `current` are actually in the DOM
let tailHandle = null;
// Fall back to a timeout only if BOTH halves of the rAF pair are missing, so the
// handle we keep is always cancellable by the matching canceller.
const hasRaf =
  typeof globalThis.requestAnimationFrame === 'function' &&
  typeof globalThis.cancelAnimationFrame === 'function';
const schedule = hasRaf ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(fn, 0);
const unschedule = hasRaf ? (h) => cancelAnimationFrame(h) : (h) => clearTimeout(h);

async function init() {
  wireEvents();
  // Focus before the storage read, not after: opening the popup and typing
  // immediately is the whole point, and a keystroke that lands before the list
  // is ready is then still in the box when the first render runs.
  //
  // Asked for more than once on purpose. Firefox opens the panel and moves
  // focus into it on its OWN schedule, and a focus() that lands before the
  // panel has it is simply discarded — the popup then sits there swallowing
  // every keystroke with nothing selected. Chrome takes the first one and the
  // rest are no-ops.
  focusSearch();
  try {
    // listContainers() is a local read that answers [] instantly on Chrome, so
    // it costs the first paint nothing and the rows can name their container
    // straight away rather than filling in a beat later.
    const [a, st, se, cs] = await Promise.all([
      getApps(),
      getStats(),
      getSettings(),
      listContainers(),
    ]);
    [apps, stats, settings] = [a, st, se];
    containers = new Map(cs.map((c) => [c.cookieStoreId, c]));
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
  // Drives which of the three container markings the rows get — see popup.css.
  resultsEl.dataset.container = settings.containerStyle || 'chip';
  showEmptyState();
  render();
  focusSearch(); // …and again once there is a list to type against
  await loadBookmarks();
}

/**
 * Put the caret in the search box, now and on the next frame. See init(): on
 * Firefox the panel takes focus asynchronously, and whoever gets there last
 * wins — so this is deliberately not a one-shot.
 */
function focusSearch() {
  searchEl.focus();
  schedule(() => searchEl.focus());
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
    ensureRendered(selected);
    updateSelection();
  }
}

/** Two rendered rows are the same row when they launch the same thing. */
function isSameResult(a, b) {
  return a.fallback
    ? a.fallback === b.fallback && a.query === b.query && a.container === b.container
    : a.app?.id === b.app?.id;
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
  // Bound on the document, not on the search box: once a keyboard user has
  // tabbed onto "Copy name" the box no longer sees the key, and Escape was the
  // only way out of a menu that traps nothing and manages no focus.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ctxEl.hidden) {
      e.preventDefault();
      closeCtxMenu();
      searchEl.focus();
    }
  });
  resultsEl.addEventListener('scroll', closeCtxMenu);
  window.addEventListener('blur', closeCtxMenu);
  // Rename a container and the rows should say so at once, not after a reload.
  const ids = globalThis.browser?.contextualIdentities ?? globalThis.chrome?.contextualIdentities;
  for (const event of ['onUpdated', 'onCreated', 'onRemoved']) {
    ids?.[event]?.addListener?.(reloadContainers);
  }
  // The panel can hand focus over after everything above has run. Take it back
  // the moment that happens, or the first thing typed is lost.
  window.addEventListener('focus', () => searchEl.focus());
  // Clicking a row must not park focus on the row: this is a keyboard launcher
  // and the next thing typed belongs in the box.
  resultsEl.addEventListener('mouseup', () => searchEl.focus());
}

function render() {
  closeCtxMenu(); // the rows are about to be replaced under it
  const q = searchEl.value.trim();
  // Bookmarks join the pool only once you type: they are a search source, not a
  // list. Showing hundreds of them on open would bury the apps.
  // The pre-filter from the settings. It narrows what the LAUNCHER lists and
  // nothing else: the apps are still stored, still synced, still there when the
  // box is ticked again. Stored as the hidden set, so an empty list — and every
  // browser without containers — shows everything.
  const shown = visibleApps();
  const pool = q && bookmarks.length > 0 ? shown.concat(bookmarks) : shown;
  current = rankApps(pool, searchEl.value, Date.now(), stats);
  // When you have something to search but none of it matches, offer a fallback.
  // Gated on what the user HAS, not on what survived the filter: with every
  // container unticked the pool is empty, and gating on that left them with no
  // rows and no way to search either.
  if (current.length === 0 && q && (apps.length > 0 || bookmarks.length > 0)) {
    current = buildFallbacks(q);
  }
  selected = 0;
  repaint();
}

/** Drop every row and start the chunked paint over from the top. */
function repaint() {
  cancelTail();
  resultsEl.replaceChildren();
  selectedEl = null;
  painted = 0;
  paintMore(FIRST_CHUNK);
  // Told the truth about whether there is a list at all: hard-coding "expanded"
  // announced a listbox to a screen reader even when the popup was showing the
  // empty panel instead.
  searchEl.setAttribute('aria-expanded', current.length > 0 ? 'true' : 'false');
  updateSelection();
  scheduleTail();
}

function paintMore(n) {
  const end = Math.min(current.length, painted + n);
  if (end === painted) return;
  const frag = document.createDocumentFragment();
  for (let i = painted; i < end; i++) frag.append(renderItem(current[i], i));
  resultsEl.append(frag);
  painted = end;
}

function scheduleTail() {
  if (tailHandle !== null || painted >= current.length) return;
  tailHandle = schedule(() => {
    tailHandle = null;
    paintMore(TAIL_CHUNK);
    scheduleTail();
  });
}

function cancelTail() {
  if (tailHandle === null) return;
  unschedule(tailHandle);
  tailHandle = null;
}

/** The keyboard can outrun the tail — pull in the rows it skipped past. */
function ensureRendered(i) {
  if (i < painted) return;
  paintMore(i - painted + 1);
}

/**
 * The "nothing here" panel, and WHICH nothing it is. "No apps yet — add or
 * import" is a lie when the apps exist and the container pre-filter is simply
 * hiding all of them: it offers the one way out that cannot help, and nothing
 * on screen points at the filter that is actually responsible.
 */
function showEmptyState() {
  const shown = visibleApps().length;
  emptyEl.hidden = shown > 0;
  if (shown > 0) return;
  const filteredOut = apps.length > 0;
  emptyEl.querySelector('p').textContent = filteredOut
    ? `All ${apps.length} of your apps are hidden by the container filter.`
    : 'No apps yet.';
  const btn = document.getElementById('manage');
  if (btn) btn.textContent = filteredOut ? 'Change that in settings' : 'Add or import apps';
}

async function reloadContainers() {
  containers = new Map((await listContainers()).map((c) => [c.cookieStoreId, c]));
  // Keep whatever the user had arrowed onto. render() resets the selection to
  // row 0, and a container renamed in another window would otherwise move the
  // target out from under the next Enter — the same problem loadBookmarks()
  // already solves, and for the same reason.
  const picked = current[selected];
  render();
  const i = picked ? current.findIndex((r) => isSameResult(r, picked)) : -1;
  if (i > 0) {
    selected = i;
    ensureRendered(selected);
    updateSelection();
  }
}

/** The apps the launcher may list, after the settings' container pre-filter. */
function visibleApps() {
  const hidden = new Set(settings.hiddenContainers ?? []);
  if (hidden.size === 0) return apps;
  return apps.filter((a) => !hidden.has(a.container ?? ''));
}

function buildFallbacks(query) {
  const mode = settings.fallbackSearch;
  const items = [];
  if (mode === 'myapps' || mode === 'both') {
    // One row per container the user actually keeps apps in. My Apps in the
    // work container lists a different tenant than the same page in the default
    // context, so a single "search My Apps" row would send you to whichever
    // account happened to be signed in there — usually not the one whose app
    // you just failed to find. With no containers in play this is exactly one
    // row, as it has always been.
    // Every scope the user keeps apps in — including the case where that is ONE
    // container and no default context at all, which is exactly the user this
    // was written for. Falling back to [''] there sent them to the portal as
    // whichever account happened to be signed in outside their container.
    const scopes = [...new Set(visibleApps().map((a) => a.container ?? ''))].sort();
    if (scopes.length === 0) scopes.push('');
    for (const container of scopes) {
      items.push({ fallback: 'myapps', query, container });
    }
  }
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
  // Announced as a listbox option. Focus stays in the search box — this is a
  // keyboard launcher — so "which row is selected" can only reach a screen
  // reader through aria-selected plus aria-activedescendant on the input.
  li.id = `row-${i}`;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');

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
  // Wrapped in <bdi>: the row cuts names at the FRONT via direction:rtl (see
  // popup.css .name), and that alone moves any neutral character at either edge
  // to the other end — "[PROD] Vault" rendered as "Vault [PROD]", brackets
  // mirrored, and "Acme Corp." as ".Acme Corp". A bidi isolate keeps the text
  // in its own order while the ellipsis stays at the start where it belongs.
  const bdi = document.createElement('bdi');
  bdi.append(...highlight(r.app.name, r.field === 'name' ? r.positions : []));
  name.append(bdi);
  const host = document.createElement('span');
  host.className = 'host';
  const where = hostOf(r.app.url) || r.app.url;
  // A bookmark says where it lives, so two similarly-named ones stay tellable
  // apart ("Work › Tickets · jira.example.com"). A contained app says WHICH
  // container, for the same reason and more urgently: the same tile imported
  // from two containers is two rows that are otherwise identical, and picking
  // the wrong one signs in as the wrong person.
  // A container is shown as COLOUR, not as words: at a glance, in a list where
  // the two rows are otherwise identical, a red edge against a pink one reads
  // instantly where "SBB · outlook.office.com" has to be parsed. The same
  // colour Firefox paints that container's tabs with, so it is already learned.
  // The name still goes in the tooltip, for anyone who needs it spelled out and
  // for a colour nobody can tell apart.
  const known = r.app.container ? containers.get(r.app.container) : null;
  if (r.app.container) {
    const edge = containerColor(known?.color);
    li.classList.add('contained');
    // No known colour still gets an edge, in the text colour: "this one is
    // pinned somewhere" is the part that matters, the hue is the shortcut.
    li.style.setProperty('--container', edge || 'currentColor');
  }
  // Hover long enough and you get the WHOLE launch URL. The subtitle is only
  // the host, and these URLs carry the account, the tenant and the region — the
  // things you actually want to check before opening one of two near-identical
  // rows. The container is named here too, since its colour cannot spell itself.
  li.title = [
    wrapForTooltip(r.app.url),
    // A container can be deleted while its apps live on. Naming it by its raw
    // id is ugly, but it is the difference between two visually identical rows
    // and two tellable-apart ones — and this is the fallback a keyboard user
    // relies on precisely when the colour has stopped meaning anything.
    r.app.container ? `Opens in the ${known?.name || r.app.container} container` : '',
  ]
    .filter(Boolean)
    .join('\n');
  host.textContent = r.app.folder ? `${r.app.folder} · ${where}` : where;
  meta.append(name, host);

  li.append(icon, meta);
  // The colour alone cannot carry this. Firefox's palette runs red / pink /
  // orange, which blur into each other at a glance and are indistinguishable to
  // a colour-blind reader — and this is a KEYBOARD launcher, so the tooltip that
  // spells it out is never reached by the person most likely to need it. The
  // name rides along in the container's own colour: colour to find the row,
  // word to be sure of it.
  if (r.app.container) {
    const chip = document.createElement('span');
    chip.className = 'cchip';
    // A deleted container leaves apps behind that still name it. The raw id is
    // honest; a missing chip would read as "no container" on a row that has one.
    chip.textContent = known?.name || r.app.container;
    li.append(chip);
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

/**
 * Break a long URL into lines for a `title` tooltip.
 *
 * A native tooltip does not wrap: one unbroken 400-character launch URL — and
 * these carry the tenant, the account and a GUID — stretches the box to the far
 * edge of the screen, where most of it is off-screen and what is left looks
 * empty. Broken at 90 characters it stays a readable block. Split on the
 * separators the URL already has, so a line ends somewhere meaningful instead
 * of mid-GUID.
 */
function wrapForTooltip(url, width = 90) {
  const text = String(url ?? '');
  if (text.length <= width) return text;
  const lines = [];
  let line = '';
  for (const part of text.split(/(?=[?&/#])/)) {
    // A single part longer than the width is hard-cut: better a blunt break
    // than one line running off the screen on its own.
    for (let i = 0; i < part.length; i += width) {
      const piece = part.slice(i, i + width);
      if (line && line.length + piece.length > width) {
        lines.push(line);
        line = '';
      }
      line += piece;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function renderFallbackItem(r, i) {
  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.index = String(i);
  li.id = `row-${i}`;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');

  const icon = document.createElement('span');
  icon.className = 'icon letter';
  icon.textContent = '🔍';

  const meta = document.createElement('span');
  meta.className = 'meta';
  const name = document.createElement('span');
  name.className = 'name';
  const where = r.container ? containers.get(r.container)?.name || r.container : '';
  name.textContent =
    r.fallback === 'myapps'
      ? `Search My Apps for “${r.query}”${where ? ` (${where})` : ''}`
      : `Search the web for “${r.query}”`;
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
  ensureRendered(selected);
  updateSelection();
}

function updateSelection({ scroll = true } = {}) {
  const el = resultsEl.children[selected] || null;
  if (selectedEl && selectedEl !== el) {
    selectedEl.classList.remove('selected');
    selectedEl.setAttribute('aria-selected', 'false');
  }
  selectedEl = el;
  if (!el) {
    searchEl.removeAttribute('aria-activedescendant');
    return;
  }
  el.classList.add('selected');
  el.setAttribute('aria-selected', 'true');
  // What the screen reader reads out as the caret stays in the search box.
  searchEl.setAttribute('aria-activedescendant', el.id);
  if (scroll) el.scrollIntoView({ block: 'nearest' });
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
  // `container` is a Firefox cookie store id, and an app imported inside one
  // signs in as that container's identity — opening it anywhere else lands on
  // the wrong account, or a login screen. withContainer drops the option on
  // Chrome and whenever the `cookies` permission is missing, because Firefox
  // rejects the whole call then and "nothing happens" is worse than "opened in
  // the default container".
  const opened = await withContainer({ url: target }, r.app.container);
  if (background) {
    chrome.tabs.create({ ...opened, active: false });
    return; // keep the popup open so you can launch several in a row
  }
  if (settings.openInNewTab) {
    chrome.tabs.create(opened);
  } else if (r.app.container) {
    // tabs.update cannot move a tab between containers, so an app that belongs
    // to one always gets its own tab, whatever the setting says.
    chrome.tabs.create(opened);
  } else {
    chrome.tabs.update({ url: target });
  }
  if (settings.closeAfterLaunch) window.close();
}

async function doFallback(r) {
  if (r.fallback === 'web') {
    if (chrome.search?.query) {
      chrome.search.query({ text: r.query, disposition: 'NEW_TAB' });
    } else {
      chrome.tabs.create({ url: `https://duckduckgo.com/?q=${encodeURIComponent(r.query)}` });
    }
  } else {
    // Opened in the container the row stands for, so the portal comes up as the
    // account whose apps you were looking for.
    chrome.tabs.create(await withContainer({ url: MYAPPS_URL }, r.container));
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
  // Marked WITHOUT scrolling: scrollIntoView on a partly-visible row scrolls
  // #results, and the scroll listener that dismisses this menu then fires on the
  // next frame — the menu closed itself the moment you right-clicked a row near
  // the edge. The row is under the pointer already; it needs no scrolling to.
  updateSelection({ scroll: false });
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
