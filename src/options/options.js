import { getApps, mutateApps, getSettings, saveSettings, SYNC_INTERVALS } from '../lib/storage.js';
import { normalizeApp, normalizeAppList, mergeApps, reconcileApps } from '../lib/apps.js';
import {
  scrapeAppsFromDocument,
  accountHintFromApps,
  scrollMyAppsStepInPage,
} from '../lib/importer.js';
import { accumulateApps } from '../lib/collector.js';
import {
  listContainers,
  withContainer,
  requestCookiesPermission,
  isContained,
} from '../lib/containers.js';

const MYAPPS_ORIGIN = 'https://myapplications.microsoft.com/';
const MYAPPS_PATTERN = 'https://myapplications.microsoft.com/*';
// Optional permission behind the "also search my bookmarks" setting.
const BOOKMARKS_PERMISSION = { permissions: ['bookmarks'] };
// Set (to a timestamp) while a manual import runs so the background auto-sync
// stands down and doesn't scroll the same grid — see background.js IMPORT_FLAG.
const IMPORT_FLAG = 'beelineImporting';

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');

let apps = [];
let editingId = null;
let editDraft = null; // {name, url} in-progress edit, preserved across re-renders
let appFilter = '';
let pendingAppsRefresh = false; // a storage change arrived while editing — apply it on exit
let containerNames = new Map(); // cookieStoreId -> name, for the row chips
let settingsLoaded = false; // until the form holds the SAVED settings, never write it back

async function init() {
  // Wire the controls FIRST. If a storage read then fails, the page is still a
  // working page with an error message — not a dead one where every button is
  // silently unbound and it looks like the apps are gone.
  wireControls();
  populateRegions();
  populateSyncIntervals();
  populateContainers();
  showShortcut();

  // Load + heal: re-normalise stored apps once so legacy names saved before the
  // hyphen-spacing fix (e.g. "S-SBB -SAP") get cleaned up in place. Writes only
  // when something actually changed.
  try {
    apps = await mutateApps((current) => {
      const cleaned = normalizeAppList(current);
      return JSON.stringify(cleaned) === JSON.stringify(current) ? undefined : cleaned;
    });
  } catch (e) {
    apps = await getApps().catch(() => []);
    setStatus(`Could not read your apps: ${e?.message || e}`, 'error');
  }
  renderList();
  try {
    await loadSettings();
  } catch {
    setStatus('Could not read your settings — using defaults.', 'error');
  }

  // Show the running version (read from the manifest, so it always matches).
  const footer = document.createElement('footer');
  footer.className = 'appver';
  footer.textContent = `Beeline v${chrome.runtime.getManifest().version}`;
  document.querySelector('main').appendChild(footer);
}

function wireControls() {
  document.getElementById('add-form').addEventListener('submit', onAdd);
  document.getElementById('import-myapps').addEventListener('click', onImportMyApps);
  document.getElementById('export').addEventListener('click', onExport);
  document.getElementById('import-file').addEventListener('change', onImportFile);
  document.getElementById('clear').addEventListener('click', onClear);
  document.getElementById('app-filter').addEventListener('input', (e) => {
    appFilter = e.target.value;
    renderList();
  });
  document.getElementById('open-in-new-tab').addEventListener('change', onSettingChange);
  document.getElementById('close-after-launch').addEventListener('change', onSettingChange);
  // Own handler: this one has a permission prompt to run inside the click.
  document.getElementById('include-bookmarks').addEventListener('change', onBookmarksToggle);
  document.getElementById('fallback-search').addEventListener('change', onSettingChange);
  document.getElementById('aws-region').addEventListener('change', onSettingChange);
  document.getElementById('theme').addEventListener('change', onSettingChange);
  document.getElementById('sync-interval').addEventListener('change', onSettingChange);
  document.getElementById('sync-on-visit').addEventListener('change', onSettingChange);
  document.getElementById('change-shortcut').addEventListener('click', onChangeShortcut);
  statusEl.addEventListener('click', () => setStatus(''));
  // Esc dismisses it as well. <output> is a live region rather than a control,
  // so keeping it out of the tab order costs a keyboard user their way out —
  // this gives it back without turning every message into a focus stop.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setStatus('');
  });
  // Re-read the binding when you come back from the browser's shortcut page,
  // so a key you just changed is reflected without a reload.
  window.addEventListener('focus', showShortcut);

  // Keep the list in sync with storage: re-render when an import or the
  // background auto-sync changes the app list (so you never need to reload).
  // Skipped while editing a row so an incoming change can't discard your edit.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.apps) return;
    if (editingId !== null) {
      pendingAppsRefresh = true; // don't clobber the open edit row — apply on exit
      return;
    }
    apps = await getApps();
    renderList();
  });
}

// The launcher's own keyboard shortcut, as the BROWSER has it bound. Chrome
// silently drops a suggested key another extension already claimed, so the
// manifest's value is a wish, not a fact — always show what getAll() reports.
let shortcutRead = 0;

async function showShortcut() {
  const el = document.getElementById('shortcut');
  const read = ++shortcutRead;
  let shortcut = '';
  try {
    const commands = await chrome.commands.getAll();
    shortcut = commands.find((c) => c.name === '_execute_action')?.shortcut || '';
  } catch {
    /* commands API unavailable — fall through to the "not set" wording */
  }
  // The page-load read and the on-focus one can be in flight together; whichever
  // answers last must not be able to paint over a fresher binding.
  if (read !== shortcutRead) return;
  el.classList.toggle('unset', !shortcut);
  if (!shortcut) {
    el.textContent = 'no shortcut set yet';
    return;
  }
  // Chrome reports "Ctrl+Shift+Space" but "⌘⇧Space" on macOS — one chip per
  // key where there is a separator, one chip for the whole glyph run otherwise.
  const keys = shortcut.split('+').filter(Boolean);
  el.replaceChildren(
    ...keys.flatMap((key, i) => {
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      return i === 0 ? [kbd] : [document.createTextNode(' + '), kbd];
    }),
  );
}

/** The Firefox build, told apart by its own extension origin — no permission. */
function isFirefox() {
  try {
    return chrome.runtime.getURL('/').startsWith('moz-extension://');
  } catch {
    return false; // no runtime API at all: treat it as the Chrome build
  }
}

async function onChangeShortcut() {
  // The two browsers each solve this their own way and neither implements the
  // other's: Firefox has an API and flatly refuses to navigate to a privileged
  // page, Chrome has the page but not the API. Reaching for the URL on Firefox
  // is what made this button do nothing there but raise a toast.
  const firefox = isFirefox();
  const commands = globalThis.browser?.commands ?? globalThis.chrome?.commands;
  try {
    if (commands?.openShortcutSettings) {
      await commands.openShortcutSettings(); // Firefox: about:addons, right section
      return;
    }
    if (!firefox) {
      // Extensions may open this page, but cannot pre-select their own row.
      await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      return;
    }
  } catch {
    /* fall through and say where to click instead */
  }
  // Older Firefox has no openShortcutSettings(), so naming the clicks is all
  // that is left. Vague wording would send them hunting through the settings.
  setStatus(
    firefox
      ? 'Change it in about:addons → the gear icon → Manage Extension Shortcuts.'
      : 'Change it in your browser’s extension-shortcut settings.',
    'info',
  );
}

// How long a message stays before it clears itself, per tone. A plain
// confirmation only needs a glance; a result you may have to act on needs
// reading time, but not the rest of the session — it used to sit there until
// something replaced it. 0 means it never expires on its own.
const STATUS_FADE_MS = { ok: 4000, info: 15000, error: 15000, busy: 0 };
let statusTimer = null;

/**
 * Report something to the user. The page is as long as their app list, so a
 * line parked under the list is a line nobody reads — this floats above it.
 * Every message clears itself eventually, except 'busy': an import runs far
 * longer than any of these timeouts, and a progress line that vanished
 * mid-import would read as "it died". Clicking or Esc dismisses any of them.
 * @param {string} msg
 * @param {'info'|'ok'|'error'|'busy'} [tone]
 */
function setStatus(msg, tone = 'info') {
  clearTimeout(statusTimer);
  statusTimer = null;
  statusEl.textContent = msg;
  statusEl.dataset.tone = msg ? tone : '';
  const fade = STATUS_FADE_MS[tone] ?? 0;
  if (!msg || !fade) return;
  statusTimer = setTimeout(() => {
    // Only clear what we put there: a newer message must not be swallowed.
    if (statusEl.textContent === msg) setStatus('');
  }, fade);
}

// If the row being edited no longer exists in the current list (removed by a
// sync/import/clear), drop the edit state so storage refreshes don't stay
// deferred forever. Call after every fresh `apps` assignment.
function dropStaleEdit() {
  if (editingId !== null && !apps.some((a) => a.id === editingId)) {
    editingId = null;
    editDraft = null;
  }
}

// Apply a storage refresh that was deferred because a row was being edited, so
// destructive/export actions and the post-edit view never run on a stale list.
async function ensureFresh() {
  if (pendingAppsRefresh) {
    pendingAppsRefresh = false;
    apps = await getApps();
    dropStaleEdit();
  }
}

// Live progress shown in the list area during a (possibly long) import.
function showImportProgress(count) {
  countEl.textContent = 'importing…';
  const li = document.createElement('li');
  li.className = 'empty-row import-progress';
  const text = document.createElement('div');
  text.textContent =
    count === null
      ? 'Waiting for you to sign in to My Apps…'
      : `Importing from My Apps… ${count} app(s) found`;
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.append(document.createElement('span'));
  li.append(text, bar);
  listEl.replaceChildren(li);
}

function renderList() {
  const q = appFilter.trim().toLowerCase();
  const filtered = q
    ? apps.filter((a) => a.name.toLowerCase().includes(q) || a.url.toLowerCase().includes(q))
    : apps;
  countEl.textContent = q ? `${filtered.length} found · ${apps.length} total` : String(apps.length);

  if (filtered.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-row';
    li.textContent = q
      ? `No apps match “${appFilter.trim()}”.`
      : 'No apps yet — import from My Apps or add one above.';
    listEl.replaceChildren(li);
    return;
  }

  const rows = filtered
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((app) => (app.id === editingId ? renderEditRow(app) : renderRow(app)));
  listEl.replaceChildren(...rows);
}

function renderRow(app) {
  const li = document.createElement('li');

  const grow = document.createElement('div');
  grow.className = 'grow';
  const name = document.createElement('div');
  name.className = 'app-name';
  name.textContent = app.name;
  const url = document.createElement('div');
  url.className = 'app-url';
  url.textContent = app.url;
  grow.append(name, url);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => {
    editingId = app.id;
    editDraft = null; // a fresh edit seeds from the stored app
    renderList();
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'danger';
  del.textContent = 'Remove';
  del.addEventListener('click', () => onDelete(app.id));

  li.append(grow);
  // Which container, if any. Two rows can otherwise be identical down to the
  // URL and differ only in which identity they sign in as.
  if (app.container) {
    const chip = document.createElement('span');
    chip.className = 'badge';
    chip.textContent = containerNames.get(app.container) || app.container;
    chip.title = 'Opens in this Firefox container';
    li.append(chip);
  }
  if (app.source === 'myapps') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'My Apps';
    badge.title = 'Imported from My Apps — kept in sync';
    li.append(badge);
  }
  li.append(edit, del);
  return li;
}

function renderEditRow(app) {
  const li = document.createElement('li');
  li.className = 'editing';

  const grow = document.createElement('div');
  grow.className = 'grow edit';
  // Seed from an in-progress draft (preserved across re-renders triggered by
  // filtering, adding/removing other rows, or a deferred sync) so typing here is
  // never silently discarded; fall back to the stored app for a fresh edit.
  const seed = editDraft || app;
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = seed.name;
  nameInput.setAttribute('aria-label', 'App name');
  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.value = seed.url;
  urlInput.setAttribute('aria-label', 'App URL');
  // keepBox is declared up here so saveDraft (below) can capture its checked
  // state too — otherwise a re-render mid-edit would reset the checkbox to true.
  let keepBox = null;
  const saveDraft = () => {
    editDraft = {
      name: nameInput.value,
      url: urlInput.value,
      keep: keepBox ? keepBox.checked : true,
    };
  };
  nameInput.addEventListener('input', saveDraft);
  urlInput.addEventListener('input', saveDraft);
  grow.append(nameInput, urlInput);
  li.append(grow);

  // Apps imported from My Apps get overwritten/removed on the next sync. Let the
  // user decide whether to pin their edit (keep) or stay linked to My Apps.
  if (app.source === 'myapps') {
    const note = document.createElement('label');
    note.className = 'check edit-note';
    keepBox = document.createElement('input');
    keepBox.type = 'checkbox';
    keepBox.checked = editDraft ? editDraft.keep !== false : true; // restore from draft
    keepBox.addEventListener('change', saveDraft);
    note.append(
      keepBox,
      document.createTextNode(
        ' This app was imported from My Apps. Keep my changes — otherwise the next' +
          ' sync overwrites or removes it.',
      ),
    );
    li.append(note);
  }

  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save';
  save.addEventListener('click', () =>
    onEditSave(
      app.id,
      nameInput.value,
      urlInput.value,
      keepBox ? keepBox.checked : true,
      app.iconUrl,
    ),
  );

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', async () => {
    editingId = null;
    editDraft = null;
    await ensureFresh(); // pull in any sync that landed while this row was open
    renderList();
  });

  const actions = document.createElement('div');
  actions.className = 'edit-actions';
  actions.append(save, cancel);
  li.append(actions);

  return li;
}

async function onEditSave(oldId, name, url, keep, iconUrl) {
  // keep=true pins the edit as a manual app (sync leaves it alone); keep=false
  // leaves it tagged 'myapps', so a future sync may overwrite or remove it.
  // The icon travels with the edit: the old record is about to be dropped, and
  // for a pinned ('manual') app no later sync would ever restore it.
  const updated = normalizeApp({ name, url, iconUrl, source: keep ? 'manual' : 'myapps' });
  if (!updated) {
    setStatus('Enter a name and a valid https:// URL.', 'error');
    return;
  }
  // mutateApps re-reads the freshest list under a lock, so a background sync that
  // landed while this row was open (refresh is paused during an edit) isn't
  // dropped. If the edit's new URL already belongs to a DIFFERENT app, reject
  // instead of silently overwriting/deleting that other app.
  let collision = false;
  apps = await mutateApps((current) => {
    if (updated.id !== oldId && current.some((a) => a.id === updated.id)) {
      collision = true;
      return undefined; // leave the list unchanged
    }
    return mergeApps(
      current.filter((a) => a.id !== oldId),
      [updated],
    );
  });
  if (collision) {
    setStatus(
      'Another app already uses that URL — edit cancelled. Change the URL or Cancel.',
      'error',
    );
    return; // keep the row in edit mode so it can be fixed
  }
  editingId = null;
  editDraft = null;
  pendingAppsRefresh = false; // mutateApps already merged against the freshest list
  renderList();
  setStatus(
    keep
      ? `Saved “${updated.name}”.`
      : `Saved “${updated.name}” — still linked to My Apps, so a future sync may overwrite it.`,
    'ok',
  );
}

async function onAdd(e) {
  e.preventDefault();
  const name = document.getElementById('name').value;
  const url = document.getElementById('url').value;
  const app = normalizeApp({ name, url, source: 'manual' });
  if (!app) {
    setStatus('Enter a name and a valid https:// URL.', 'error');
    return;
  }
  apps = await mutateApps((current) => mergeApps(current, [app]));
  e.target.reset();
  renderList();
  setStatus(`Added “${app.name}”.`, 'ok');
}

async function onDelete(id) {
  apps = await mutateApps((current) => current.filter((a) => a.id !== id));
  renderList();
  setStatus('Removed.', 'ok');
}

async function onClear() {
  await ensureFresh(); // confirm against the real current list, not a stale one
  if (apps.length === 0) return;
  if (!confirm(`Remove all ${apps.length} apps? This cannot be undone.`)) return;
  editingId = null; // any open edit row is moot once the list is emptied
  editDraft = null;
  apps = await mutateApps(() => []);
  renderList();
  setStatus('Removed all apps.', 'ok');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Guard against executeScript hanging on a still-loading / navigating tab.
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);

// Scroll + scrape one round. Returns the app array, or null when the page is
// not accessible yet (still on the Microsoft sign-in origin, or still loading).
async function scrapeTab(tabId) {
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId }, func: scrapeAppsFromDocument }),
      8000,
    );
    return results?.[0]?.result ?? [];
  } catch {
    return null; // timeout, no host permission yet (sign-in origin), or not ready
  }
}

// Returns the pixels still left to the bottom (so collectAllApps knows when the
// grid has been fully walked), or null when the step could not run. Wrapped in a
// timeout like scrapeTab: a frozen/discarded tab can make executeScript hang,
// and an un-timed-out scroll would stall the whole accumulation loop.
async function scrollMyAppsStep(tabId) {
  try {
    const res = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId }, func: scrollMyAppsStepInPage }),
      8000,
    );
    // null (not 0) for a missing/non-number result so a failed scroll is never
    // mistaken for "reached the bottom".
    return typeof res?.[0]?.result === 'number' ? res[0].result : null;
  } catch {
    return null; // executeScript hung or the page is not ready
  }
}

// Injected (MAIN world) belt-and-suspenders: make the tab report itself visible
// so the My Apps SPA never pauses rendering. The helper window already keeps the
// tab genuinely visible, but this guards against any visibilitychange handlers.
function spoofVisibleInPage() {
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  } catch {
    /* page disallows redefining — ignore */
  }
}

// Resolve once the given tab has finished loading (or after a safety timeout).
function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(done);
      if (timer) clearTimeout(timer);
      resolve();
    };
    const done = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(done); // listen before checking, so a fast load can't be missed
    timer = setTimeout(finish, timeoutMs); // safety net if 'complete' never fires
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') finish();
      })
      .catch(finish);
  });
}

// Open My Apps in its OWN unfocused window and run fn(tabId) against it. Because
// the tab is the active tab of that window, document.visibilityState is
// 'visible' — so the virtualised grid actually renders and scrolls — yet the
// window stays in the background, so you are never pulled off this settings page.
// A fresh window also means a clean URL (no leftover ?search= filter). The
// window is always closed when we're done.
async function withMyAppsWindow(fn, container = '') {
  // My Apps inside a container is signed in as THAT identity and lists that
  // tenant's tiles. Reading the work container therefore means opening the
  // helper window in it — the same page in the default context would just
  // re-read whatever account happens to be signed in there.
  const win = await chrome.windows.create(
    await withContainer(
      {
        url: MYAPPS_ORIGIN,
        type: 'popup',
        focused: false,
        width: 920,
        height: 820,
      },
      container,
    ),
  );
  const tabId = win.tabs?.[0]?.id ?? null;
  try {
    if (tabId == null) throw new Error('could not open a My Apps window');
    await waitForTabComplete(tabId);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: spoofVisibleInPage,
        world: 'MAIN',
      });
    } catch {
      /* MAIN world unsupported / blocked — still fine, the tab is really visible */
    }
    await sleep(3500); // let the SPA fetch + render its first grid slice
    return await fn(tabId);
  } finally {
    if (win.id != null) {
      await chrome.windows.remove(win.id).catch(() => {});
    }
  }
}

// Scroll through the (virtualised) My Apps grid, accumulating the UNION of tiles
// until the grid bottoms out with nothing new. The loop logic lives in the pure,
// unit-tested accumulateApps(); here we just wire it to the live tab.
async function collectAllApps(tabId, onProgress) {
  const {
    apps: collected,
    complete,
    reachedBottom,
  } = await accumulateApps({
    scrapeRound: async (seenCount) => {
      onProgress(seenCount); // refresh the progress UI before the (slow) scrape
      const found = await scrapeTab(tabId);
      // null = page not ready (sign-in redirect / still loading): surface the
      // "waiting to sign in" state instead of leaving "0 app(s) found" up.
      if (found === null) onProgress(null);
      return found;
    },
    // Return the live scroll result (number, or null on failure) directly — never
    // reuse a stale value, or a single failed scroll after one at-bottom step
    // would keep looking like "bottom" and end the loop early.
    scrollRound: () => scrollMyAppsStep(tabId),
    sleep,
    maxRounds: 150,
    stableLimit: 5,
    deadline: Date.now() + 120000,
  });
  return { apps: collected, complete, reachedBottom };
}

async function onImportMyApps() {
  const btn = document.getElementById('import-myapps');
  if (btn.disabled) return; // already importing
  // Which container to read. '' is the ordinary browsing context, which is all
  // Chrome and a containers-off Firefox ever have.
  const picker = document.getElementById('import-container');
  const container = isContained(picker?.value) ? picker.value : '';
  // Disable BEFORE the permission prompt: the page stays interactive while that
  // bubble is open, so a second click would start a second import — and the
  // first one to finish would release the grid lock under the other.
  btn.disabled = true;
  const label = btn.textContent;
  setStatus('Requesting access to My Apps…', 'busy');
  const granted = await chrome.permissions
    .request({ origins: [MYAPPS_PATTERN] })
    .catch(() => false);
  if (!granted) {
    btn.disabled = false;
    setStatus('Permission denied — cannot read My Apps.', 'error');
    return;
  }
  // `cookies` is what makes a cookieStoreId mean anything. Firefox grants it
  // without a prompt, but asking must still happen inside this click. Refusing
  // to continue is deliberate: silently reading the DEFAULT container instead
  // would then reconcile the chosen container's apps against the wrong tenant's
  // tiles and delete every one of them.
  if (container && !(await requestCookiesPermission())) {
    btn.disabled = false;
    setStatus('Container access denied — nothing was read, so nothing changed.', 'error');
    return;
  }

  btn.textContent = 'Importing…';
  // 'busy': this one has to survive the whole read, which can take minutes.
  setStatus('Reading your apps in a background window (you can keep working here)…', 'busy');
  // Claim the grid so the background auto-sync stands down for the duration.
  // If the claim FAILS we can't be sure sync stays off, and a second scroll loop
  // makes this read skip tiles — so the run is downgraded to merge-only below
  // and can never prune. Losing apps is worse than a stale entry.
  const claimed = await chrome.storage.local
    .set({ [IMPORT_FLAG]: Date.now() })
    .then(() => true)
    .catch(() => false);

  let best;
  let complete;
  let reachedBottom;
  try {
    // Run in a dedicated unfocused window so the virtualised grid renders without
    // pulling focus away from this page. See withMyAppsWindow().
    ({
      apps: best,
      complete,
      reachedBottom,
    } = await withMyAppsWindow((tabId) => collectAllApps(tabId, showImportProgress), container));
  } catch (e) {
    renderList(); // drop the progress placeholder — the list must stay visible
    setStatus(
      `Import failed: ${e?.message || e}. Open My Apps once to sign in, then try again.`,
      'error',
    );
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    await chrome.storage.local.set({ [IMPORT_FLAG]: 0 }).catch(() => {}); // release the grid
  }

  if (best.length === 0) {
    renderList();
    setStatus(
      'No apps found. Make sure you are signed in to My Apps (open it once in this browser), then click Import again.',
      'error',
    );
    return;
  }

  // Tag every scraped tile as 'myapps' BEFORE storing — otherwise a partial
  // (merge-only) import saves them untagged, so they read as manual apps that a
  // later complete reconcile can never prune (and they'd miss the My Apps badge).
  const scraped = best.map((a) => ({
    ...a,
    source: 'myapps',
    ...(container ? { container } : {}),
  }));

  // Only reconcile (which removes apps no longer in My Apps) when we scrolled all
  // the way through AND owned the grid while doing it; any other read only adds,
  // so it can never wrongly delete. mutateApps does this atomically against the
  // freshest stored list.
  const canPrune = complete && claimed;
  const before = apps.length;
  try {
    apps = await mutateApps((current) =>
      canPrune ? reconcileApps(current, scraped, { container }) : mergeApps(current, scraped),
    );
  } catch (err) {
    renderList(); // ditto: never leave the user staring at "importing…"
    setStatus(`Found ${best.length} app(s) but saving failed: ${err.message}`, 'error');
    return;
  }
  dropStaleEdit(); // a complete reconcile may have removed the app being edited
  renderList();
  const delta = apps.length - before;
  // Surface WHICH account this came from, so a multi-account / multi-profile
  // mismatch is obvious instead of silent.
  const account = accountHintFromApps(scraped);
  const who = account ? ` (account: ${account})` : '';
  if (canPrune) {
    setStatus(`Synced ${best.length} app(s) from My Apps${who}. Your manual apps are kept.`);
  } else if (complete) {
    setStatus(
      `Imported ${best.length} app(s) (+${delta})${who} — the background sync could not be paused, so nothing was removed.`,
    );
  } else {
    // Name the reason: "never reported the end" is a scroll-signal problem (a
    // container we cannot drive), "still growing" is a grid that kept producing
    // new tiles right up to the cap — very different things to chase.
    const why = reachedBottom
      ? 'the list was still growing at the end'
      : 'the page never reported the end of the list';
    setStatus(
      `Imported ${best.length} app(s) (+${delta})${who} — ${why}, so nothing was removed. Run Import again to finish.`,
    );
  }
}

async function onExport() {
  await ensureFresh(); // export the real current list, including any unseen sync
  const blob = new Blob([JSON.stringify(apps, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'beeline-apps.json';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('Exported.', 'ok');
}

async function onImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    setStatus('That file is not valid JSON.', 'error');
    e.target.value = '';
    return;
  }
  try {
    const before = apps.length;
    apps = await mutateApps((current) => mergeApps(current, Array.isArray(parsed) ? parsed : []));
    renderList();
    setStatus(`Imported ${apps.length - before} new app(s) from file.`, 'ok');
  } catch (err) {
    // A storage failure is NOT a malformed file — say which one it was.
    setStatus(`Could not save the imported apps: ${err.message}`, 'error');
  } finally {
    e.target.value = '';
  }
}

// AWS commercial regions, eu-central first (Frankfurt + Zurich) per request.
const AWS_REGIONS = [
  [
    'Recommended',
    [
      ['eu-central-1', 'Europe (Frankfurt)'],
      ['eu-central-2', 'Europe (Zurich)'],
    ],
  ],
  [
    'Europe',
    [
      ['eu-west-1', 'Ireland'],
      ['eu-west-2', 'London'],
      ['eu-west-3', 'Paris'],
      ['eu-north-1', 'Stockholm'],
      ['eu-south-1', 'Milan'],
      ['eu-south-2', 'Spain'],
    ],
  ],
  [
    'Americas',
    [
      ['us-east-1', 'N. Virginia'],
      ['us-east-2', 'Ohio'],
      ['us-west-1', 'N. California'],
      ['us-west-2', 'Oregon'],
      ['ca-central-1', 'Canada Central'],
      ['ca-west-1', 'Calgary'],
      ['sa-east-1', 'São Paulo'],
      ['mx-central-1', 'Mexico'],
    ],
  ],
  [
    'Asia Pacific',
    [
      ['ap-south-1', 'Mumbai'],
      ['ap-south-2', 'Hyderabad'],
      ['ap-southeast-1', 'Singapore'],
      ['ap-southeast-2', 'Sydney'],
      ['ap-southeast-3', 'Jakarta'],
      ['ap-southeast-4', 'Melbourne'],
      ['ap-northeast-1', 'Tokyo'],
      ['ap-northeast-2', 'Seoul'],
      ['ap-northeast-3', 'Osaka'],
      ['ap-east-1', 'Hong Kong'],
    ],
  ],
  [
    'Middle East & Africa',
    [
      ['me-central-1', 'UAE'],
      ['me-south-1', 'Bahrain'],
      ['il-central-1', 'Tel Aviv'],
      ['af-south-1', 'Cape Town'],
    ],
  ],
];

function populateRegions() {
  const sel = document.getElementById('aws-region');
  const off = document.createElement('option');
  off.value = '';
  off.textContent = "Off — don't change region";
  sel.append(off);
  for (const [groupLabel, regions] of AWS_REGIONS) {
    const og = document.createElement('optgroup');
    og.label = groupLabel;
    for (const [code, city] of regions) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = `${code} — ${city}`;
      og.append(o);
    }
    sel.append(og);
  }
}

/**
 * Fill the "read which container" picker, and show it only if this browser has
 * containers at all. Chrome never does; a Firefox with privacy.userContext
 * switched off reports none either, and a picker with one entry would be a
 * control that cannot do anything.
 */
async function populateContainers() {
  const sel = document.getElementById('import-container');
  const row = document.getElementById('import-container-row');
  const found = await listContainers();
  containerNames = new Map(found.map((c) => [c.cookieStoreId, c.name]));
  if (found.length === 0) return; // row stays hidden
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'No container';
  sel.append(none);
  for (const c of found) {
    const o = document.createElement('option');
    o.value = c.cookieStoreId;
    o.textContent = c.name;
    sel.append(o);
  }
  row.hidden = false;
}

function populateSyncIntervals() {
  const sel = document.getElementById('sync-interval');
  for (const { value, label } of SYNC_INTERVALS) {
    const o = document.createElement('option');
    o.value = String(value);
    o.textContent = label;
    sel.append(o);
  }
}

function applyTheme(theme) {
  const t = theme || 'auto'; // 'auto' | 'light' | 'dark'
  document.documentElement.dataset.theme = t;
  // Mirror to localStorage so theme-boot.js can apply it before first paint.
  try {
    localStorage.setItem('beeline-theme', t);
  } catch {
    /* localStorage unavailable — the async path still applies it */
  }
}

function hasBookmarksPermission() {
  return chrome.permissions.contains(BOOKMARKS_PERMISSION).catch(() => false);
}

// The permission prompt has to run inside the user gesture that ticked the box,
// so it goes FIRST — any await before it ends the gesture and Chrome refuses.
// The setting is only written once the permission state actually matches it.
async function onBookmarksToggle(e) {
  const box = e.target;
  if (!settingsLoaded) {
    box.checked = !box.checked; // put the box back: nothing was saved
    setStatus('Settings are not loaded yet — reload the page before changing them.', 'error');
    return;
  }
  // Disable for the duration: the page stays interactive while the permission
  // bubble is open, so a second click could ask and revoke at the same time and
  // leave the granted permission out of step with the saved setting.
  box.disabled = true;
  try {
    if (box.checked) {
      const granted = await chrome.permissions.request(BOOKMARKS_PERMISSION).catch(() => false);
      if (!granted) {
        box.checked = false;
        setStatus('Bookmark access denied — the launcher keeps searching your apps only.', 'error');
        return;
      }
    } else {
      // Hand the permission back: keeping read access to bookmarks Beeline no
      // longer looks at would be exactly the kind of leftover this repo avoids.
      await chrome.permissions.remove(BOOKMARKS_PERMISSION).catch(() => {});
    }
    await onSettingChange();
  } finally {
    box.disabled = false;
  }
}

async function loadSettings() {
  const settings = await getSettings();
  document.getElementById('open-in-new-tab').checked = settings.openInNewTab;
  document.getElementById('close-after-launch').checked = settings.closeAfterLaunch;
  document.getElementById('fallback-search').value = settings.fallbackSearch;
  document.getElementById('aws-region').value = settings.awsRegion;
  document.getElementById('theme').value = settings.theme;
  document.getElementById('sync-interval').value = String(settings.syncIntervalMin);
  document.getElementById('sync-on-visit').checked = Boolean(settings.syncOnVisit);
  applyTheme(settings.theme);
  // Last, because it needs a second async round-trip: show what is actually in
  // effect. The permission can be revoked in the browser's own extension
  // settings behind our back, which silently turns the feature off (the
  // bookmarks API simply disappears). Changing any setting writes the
  // corrected value back.
  document.getElementById('include-bookmarks').checked =
    Boolean(settings.includeBookmarks) && (await hasBookmarksPermission());
  settingsLoaded = true;
}

async function onSettingChange() {
  // The form still shows the markup defaults if the saved settings could not be
  // read (or have not arrived yet). Writing it back would silently reset every
  // other setting to a default the user never chose.
  if (!settingsLoaded) {
    setStatus('Settings are not loaded yet — reload the page before changing them.', 'error');
    return;
  }
  const theme = document.getElementById('theme').value;
  await saveSettings({
    openInNewTab: document.getElementById('open-in-new-tab').checked,
    closeAfterLaunch: document.getElementById('close-after-launch').checked,
    fallbackSearch: document.getElementById('fallback-search').value,
    awsRegion: document.getElementById('aws-region').value.trim(),
    theme,
    includeBookmarks: document.getElementById('include-bookmarks').checked,
    // The background worker watches for this write and re-arms its alarm, so a
    // new interval takes effect now rather than at the next browser restart.
    syncIntervalMin: Number(document.getElementById('sync-interval').value) || 0,
    syncOnVisit: document.getElementById('sync-on-visit').checked,
  });
  applyTheme(theme); // reflect the new theme on this page immediately
  setStatus('Settings saved.', 'ok');
}

try {
  await init();
} catch (e) {
  setStatus(`Beeline could not start: ${e?.message || e}. Reload the page.`, 'error');
}
