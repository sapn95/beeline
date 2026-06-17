import { getApps, mutateApps, getSettings, saveSettings } from '../lib/storage.js';
import { normalizeApp, normalizeAppList, mergeApps, reconcileApps } from '../lib/apps.js';
import { scrapeAppsFromDocument, accountHintFromApps } from '../lib/importer.js';
import { accumulateApps } from '../lib/collector.js';

const MYAPPS_ORIGIN = 'https://myapplications.microsoft.com/';
const MYAPPS_PATTERN = 'https://myapplications.microsoft.com/*';
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

async function init() {
  // Load + heal: re-normalise stored apps once so legacy names saved before the
  // hyphen-spacing fix (e.g. "S-SBB -SAP") get cleaned up in place. Writes only
  // when something actually changed.
  apps = await mutateApps((current) => {
    const cleaned = normalizeAppList(current);
    return JSON.stringify(cleaned) === JSON.stringify(current) ? undefined : cleaned;
  });
  renderList();
  populateRegions();
  await loadSettings();

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
  document.getElementById('fallback-search').addEventListener('change', onSettingChange);
  document.getElementById('aws-region').addEventListener('change', onSettingChange);
  document.getElementById('theme').addEventListener('change', onSettingChange);

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

  // Show the running version (read from the manifest, so it always matches).
  const footer = document.createElement('footer');
  footer.className = 'appver';
  footer.textContent = `Beeline v${chrome.runtime.getManifest().version}`;
  document.querySelector('main').appendChild(footer);
}

function setStatus(msg) {
  statusEl.textContent = msg;
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
    onEditSave(app.id, nameInput.value, urlInput.value, keepBox ? keepBox.checked : true),
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

async function onEditSave(oldId, name, url, keep) {
  // keep=true pins the edit as a manual app (sync leaves it alone); keep=false
  // leaves it tagged 'myapps', so a future sync may overwrite or remove it.
  const updated = normalizeApp({ name, url, source: keep ? 'manual' : 'myapps' });
  if (!updated) {
    setStatus('Enter a name and a valid https:// URL.');
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
    setStatus('Another app already uses that URL — edit cancelled. Change the URL or Cancel.');
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
  );
}

async function onAdd(e) {
  e.preventDefault();
  const name = document.getElementById('name').value;
  const url = document.getElementById('url').value;
  const app = normalizeApp({ name, url, source: 'manual' });
  if (!app) {
    setStatus('Enter a name and a valid https:// URL.');
    return;
  }
  apps = await mutateApps((current) => mergeApps(current, [app]));
  e.target.reset();
  renderList();
  setStatus(`Added “${app.name}”.`);
}

async function onDelete(id) {
  apps = await mutateApps((current) => current.filter((a) => a.id !== id));
  renderList();
  setStatus('Removed.');
}

async function onClear() {
  await ensureFresh(); // confirm against the real current list, not a stale one
  if (apps.length === 0) return;
  if (!confirm(`Remove all ${apps.length} apps? This cannot be undone.`)) return;
  editingId = null; // any open edit row is moot once the list is emptied
  editDraft = null;
  apps = await mutateApps(() => []);
  renderList();
  setStatus('Removed all apps.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Guard against executeScript hanging on a still-loading / navigating tab.
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);

// Injected into the My Apps page: scroll one viewport down. The grid is
// virtualised inside an inner scroll panel, so we scroll the scrollable
// ancestors OF THE TILES THEMSELVES (plus the window) — scoping to tile-bearing
// scrollers stops an unrelated panel from holding the loop open forever.
// Returns 0 once NOTHING can advance any further (the reliable "at the bottom"
// signal, independent of trailing padding); otherwise the largest distance still
// left to the bottom.
function scrollMyAppsStepInPage() {
  const step = Math.round(window.innerHeight * 0.8) || 600;
  const overflows = (el, min) =>
    !!el && el.scrollHeight - el.clientHeight > min && el.clientHeight > 150;
  const gap = (el) => el.scrollHeight - (el.scrollTop + el.clientHeight);
  const nearestScroller = (node) => {
    for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
      if (overflows(el, 4)) return el;
    }
    return null;
  };

  // The tile selector mirrors the scraper (importer.js) so direct-link icon tiles
  // count as tiles here too; we scroll each tile's nearest scrollable ancestor.
  const tiles = document.querySelectorAll(
    'a[href*="launcher.myapps.microsoft.com"], a[href*="/api/signin/"], a[href*="/launch"], ' +
      '[role="gridcell"], main a[href]:has(img), [role="main"] a[href]:has(img)',
  );
  const scrollers = new Set();
  for (const tile of tiles) {
    const s = nearestScroller(tile);
    if (s) scrollers.add(s);
  }
  // Fallback (empty grid / unknown markup): all sizeably-scrollable blocks.
  if (scrollers.size === 0) {
    for (const el of document.querySelectorAll('div, main, section, ul')) {
      if (overflows(el, 200)) scrollers.add(el);
    }
  }

  // Scroll window + each tile scroller, tracking whether ANYTHING advanced and
  // how far the deepest scroller still has to go.
  const winBefore = window.scrollY;
  window.scrollBy(0, step);
  let moved = window.scrollY !== winBefore;
  let maxRemaining = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
  for (const el of scrollers) {
    const before = el.scrollTop;
    el.scrollTop += step;
    if (el.scrollTop !== before) moved = true;
    maxRemaining = Math.max(maxRemaining, gap(el));
  }

  // Nothing could advance → genuinely at the bottom, even if trailing padding
  // keeps maxRemaining above zero. Otherwise report the remaining gradient.
  return moved ? Math.max(0, maxRemaining) : 0;
}

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
async function withMyAppsWindow(fn) {
  const win = await chrome.windows.create({
    url: MYAPPS_ORIGIN,
    type: 'popup',
    focused: false,
    width: 920,
    height: 820,
  });
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
  const { apps: collected, complete } = await accumulateApps({
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
  return { apps: collected, complete };
}

async function onImportMyApps() {
  setStatus('Requesting access to My Apps…');
  const granted = await chrome.permissions.request({ origins: [MYAPPS_PATTERN] });
  if (!granted) {
    setStatus('Permission denied — cannot read My Apps.');
    return;
  }

  const btn = document.getElementById('import-myapps');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Importing…';
  setStatus('Reading your apps in a background window (you can keep working here)…');
  // Claim the grid so the background auto-sync stands down for the duration.
  await chrome.storage.local.set({ [IMPORT_FLAG]: Date.now() }).catch(() => {});

  let best;
  let complete;
  try {
    // Run in a dedicated unfocused window so the virtualised grid renders without
    // pulling focus away from this page. See withMyAppsWindow().
    ({ apps: best, complete } = await withMyAppsWindow((tabId) =>
      collectAllApps(tabId, showImportProgress),
    ));
  } catch (e) {
    setStatus(`Import failed: ${e?.message || e}. Open My Apps once to sign in, then try again.`);
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
    );
    return;
  }

  // Tag every scraped tile as 'myapps' BEFORE storing — otherwise a partial
  // (merge-only) import saves them untagged, so they read as manual apps that a
  // later complete reconcile can never prune (and they'd miss the My Apps badge).
  const scraped = best.map((a) => ({ ...a, source: 'myapps' }));

  // Only reconcile (which removes apps no longer in My Apps) when we scrolled all
  // the way through; a partial read only adds, so it can never wrongly delete.
  // mutateApps does this atomically against the freshest stored list.
  const before = apps.length;
  try {
    apps = await mutateApps((current) =>
      complete ? reconcileApps(current, scraped) : mergeApps(current, scraped),
    );
  } catch (err) {
    setStatus(`Found ${best.length} app(s) but saving failed: ${err.message}`);
    return;
  }
  dropStaleEdit(); // a complete reconcile may have removed the app being edited
  renderList();
  const delta = apps.length - before;
  // Surface WHICH account this came from, so a multi-account / multi-profile
  // mismatch is obvious instead of silent.
  const account = accountHintFromApps(scraped);
  const who = account ? ` (account: ${account})` : '';
  if (complete) {
    setStatus(`Synced ${best.length} app(s) from My Apps${who}. Your manual apps are kept.`);
  } else {
    setStatus(
      `Imported ${best.length} app(s) (+${delta})${who} — didn't reach the end, so nothing was removed. Run Import again to finish.`,
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
  setStatus('Exported.');
}

async function onImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const before = apps.length;
    apps = await mutateApps((current) => mergeApps(current, Array.isArray(parsed) ? parsed : []));
    renderList();
    setStatus(`Imported ${apps.length - before} new app(s) from file.`);
  } catch {
    setStatus('That file is not valid JSON.');
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

async function loadSettings() {
  const settings = await getSettings();
  document.getElementById('open-in-new-tab').checked = settings.openInNewTab;
  document.getElementById('close-after-launch').checked = settings.closeAfterLaunch;
  document.getElementById('fallback-search').value = settings.fallbackSearch;
  document.getElementById('aws-region').value = settings.awsRegion;
  document.getElementById('theme').value = settings.theme;
  applyTheme(settings.theme);
}

async function onSettingChange() {
  const theme = document.getElementById('theme').value;
  await saveSettings({
    openInNewTab: document.getElementById('open-in-new-tab').checked,
    closeAfterLaunch: document.getElementById('close-after-launch').checked,
    fallbackSearch: document.getElementById('fallback-search').value,
    awsRegion: document.getElementById('aws-region').value.trim(),
    theme,
  });
  applyTheme(theme); // reflect the new theme on this page immediately
  setStatus('Settings saved.');
}

await init();
