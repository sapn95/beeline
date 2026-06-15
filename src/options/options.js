import { getApps, saveApps, getSettings, saveSettings } from '../lib/storage.js';
import { normalizeApp, mergeApps, reconcileApps } from '../lib/apps.js';
import { scrapeAppsFromDocument } from '../lib/importer.js';

const MYAPPS_ORIGIN = 'https://myapplications.microsoft.com/';
const MYAPPS_PATTERN = 'https://myapplications.microsoft.com/*';

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');

let apps = [];
let editingId = null;
let appFilter = '';

async function init() {
  apps = await getApps();
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

  // Show the running version (read from the manifest, so it always matches).
  const footer = document.createElement('footer');
  footer.className = 'appver';
  footer.textContent = `Beeline v${chrome.runtime.getManifest().version}`;
  document.querySelector('main').appendChild(footer);
}

function setStatus(msg) {
  statusEl.textContent = msg;
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
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = app.name;
  nameInput.setAttribute('aria-label', 'App name');
  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.value = app.url;
  urlInput.setAttribute('aria-label', 'App URL');
  grow.append(nameInput, urlInput);
  li.append(grow);

  // Apps imported from My Apps get overwritten/removed on the next sync. Let the
  // user decide whether to pin their edit (keep) or stay linked to My Apps.
  let keepBox = null;
  if (app.source === 'myapps') {
    const note = document.createElement('label');
    note.className = 'check edit-note';
    keepBox = document.createElement('input');
    keepBox.type = 'checkbox';
    keepBox.checked = true;
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
  cancel.addEventListener('click', () => {
    editingId = null;
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
  apps = mergeApps(
    apps.filter((a) => a.id !== oldId),
    [updated],
  );
  await saveApps(apps);
  editingId = null;
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
  apps = mergeApps(apps, [app]);
  await saveApps(apps);
  e.target.reset();
  renderList();
  setStatus(`Added “${app.name}”.`);
}

async function onDelete(id) {
  apps = apps.filter((a) => a.id !== id);
  await saveApps(apps);
  renderList();
  setStatus('Removed.');
}

async function onClear() {
  if (apps.length === 0) return;
  if (!confirm(`Remove all ${apps.length} apps? This cannot be undone.`)) return;
  apps = [];
  await saveApps(apps);
  renderList();
  setStatus('Removed all apps.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Injected into the My Apps page to trigger lazy-loading of all app tiles.
function scrollMyAppsToBottom() {
  window.scrollTo(0, document.body.scrollHeight);
  return document.body.scrollHeight;
}

// Bring the Beeline settings page back to the foreground after an import.
async function focusSelf() {
  const self = await chrome.tabs.getCurrent();
  if (self) {
    await chrome.tabs.update(self.id, { active: true });
    if (self.windowId != null) await chrome.windows.update(self.windowId, { focused: true });
  } else if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
}

// Scroll + scrape one round. Returns the app array, or null when the page is
// not accessible yet (still on the Microsoft sign-in origin, or still loading).
async function scrapeTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: scrollMyAppsToBottom });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapeAppsFromDocument,
    });
    return results?.[0]?.result ?? [];
  } catch {
    return null; // no host permission yet (sign-in origin) or page not ready
  }
}

async function onImportMyApps() {
  setStatus('Requesting access to My Apps…');
  const granted = await chrome.permissions.request({ origins: [MYAPPS_PATTERN] });
  if (!granted) {
    setStatus('Permission denied — cannot read My Apps.');
    return;
  }

  // Reuse an open My Apps tab (scraped in the background so you stay on this
  // page); only open + focus a new one if none exists, so you can sign in.
  let [tab] = await chrome.tabs.query({ url: MYAPPS_PATTERN });
  if (tab) {
    setStatus('Importing from My Apps…');
  } else {
    tab = await chrome.tabs.create({ url: MYAPPS_ORIGIN, active: true });
    setStatus('Opened My Apps — sign in if asked. Importing…');
  }

  // Poll for up to ~60s so a single click covers signing in AND the SPA
  // lazy-loading its tiles. Keep the largest stable result we have seen, and
  // scroll each round so virtualised/long app grids are fully loaded.
  const deadline = Date.now() + 60000;
  let best = [];
  let stableRounds = 0;
  while (Date.now() < deadline && stableRounds < 3) {
    await sleep(1200);
    const found = await scrapeTab(tab.id);
    if (found === null) {
      setStatus('Waiting for you to sign in to My Apps…');
      continue;
    }
    if (found.length > best.length) {
      best = found;
      stableRounds = 0;
      setStatus(`Found ${best.length} app(s)…`);
    } else if (found.length > 0 && found.length === best.length) {
      stableRounds += 1;
    }
  }

  await focusSelf(); // always end on the Beeline settings page

  if (best.length === 0) {
    setStatus(
      'No apps found. Make sure you are signed in and your apps are visible on My Apps, then click Import again.',
    );
    return;
  }

  const before = apps.length;
  const reconciled = reconcileApps(apps, best);
  try {
    await saveApps(reconciled);
  } catch (err) {
    setStatus(`Found ${best.length} app(s) but saving failed: ${err.message}`);
    return;
  }
  apps = reconciled;
  renderList();
  const delta = apps.length - before;
  let change = 'no change';
  if (delta > 0) change = `+${delta}`;
  else if (delta < 0) change = String(delta);
  setStatus(`Synced ${best.length} app(s) from My Apps (${change}). Your manual apps are kept.`);
}

function onExport() {
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
    apps = mergeApps(apps, Array.isArray(parsed) ? parsed : []);
    await saveApps(apps);
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

async function loadSettings() {
  const settings = await getSettings();
  document.getElementById('open-in-new-tab').checked = settings.openInNewTab;
  document.getElementById('close-after-launch').checked = settings.closeAfterLaunch;
  document.getElementById('fallback-search').value = settings.fallbackSearch;
  document.getElementById('aws-region').value = settings.awsRegion;
}

async function onSettingChange() {
  await saveSettings({
    openInNewTab: document.getElementById('open-in-new-tab').checked,
    closeAfterLaunch: document.getElementById('close-after-launch').checked,
    fallbackSearch: document.getElementById('fallback-search').value,
    awsRegion: document.getElementById('aws-region').value.trim(),
  });
  setStatus('Settings saved.');
}

await init();
