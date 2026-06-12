import { getApps, saveApps, getSettings, saveSettings } from '../lib/storage.js';
import { normalizeApp, mergeApps } from '../lib/apps.js';
import { scrapeAppsFromDocument } from '../lib/importer.js';

const MYAPPS_ORIGIN = 'https://myapplications.microsoft.com/';
const MYAPPS_PATTERN = 'https://myapplications.microsoft.com/*';

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');

let apps = [];

async function init() {
  apps = await getApps();
  renderList();
  await loadSettings();

  document.getElementById('add-form').addEventListener('submit', onAdd);
  document.getElementById('import-myapps').addEventListener('click', onImportMyApps);
  document.getElementById('export').addEventListener('click', onExport);
  document.getElementById('import-file').addEventListener('change', onImportFile);
  document.getElementById('clear').addEventListener('click', onClear);
  document.getElementById('open-in-new-tab').addEventListener('change', onSettingChange);
  document.getElementById('close-after-launch').addEventListener('change', onSettingChange);
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function renderList() {
  countEl.textContent = String(apps.length);
  listEl.replaceChildren(
    ...apps
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((app) => {
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

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Remove';
        del.addEventListener('click', () => onDelete(app.id));

        li.append(grow, del);
        return li;
      }),
  );
}

async function onAdd(e) {
  e.preventDefault();
  const name = document.getElementById('name').value;
  const url = document.getElementById('url').value;
  const app = normalizeApp({ name, url });
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

async function onImportMyApps() {
  setStatus('Requesting access to My Apps…');
  const granted = await chrome.permissions.request({ origins: [MYAPPS_PATTERN] });
  if (!granted) {
    setStatus('Permission denied — cannot read My Apps.');
    return;
  }

  const [tab] = await chrome.tabs.query({ url: MYAPPS_PATTERN });
  if (!tab) {
    chrome.tabs.create({ url: MYAPPS_ORIGIN });
    setStatus('Opened My Apps. Sign in, then click “Import from My Apps” again.');
    return;
  }

  setStatus('Reading apps from the open My Apps tab…');
  let scraped = [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeAppsFromDocument,
    });
    scraped = (results && results[0] && results[0].result) || [];
  } catch (err) {
    setStatus(`Could not read the page: ${err.message}`);
    return;
  }

  const before = apps.length;
  apps = mergeApps(apps, scraped);
  await saveApps(apps);
  renderList();
  setStatus(`Found ${scraped.length} app(s); added ${apps.length - before} new one(s).`);
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
  const file = e.target.files && e.target.files[0];
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

async function loadSettings() {
  const settings = await getSettings();
  document.getElementById('open-in-new-tab').checked = settings.openInNewTab;
  document.getElementById('close-after-launch').checked = settings.closeAfterLaunch;
}

async function onSettingChange() {
  await saveSettings({
    openInNewTab: document.getElementById('open-in-new-tab').checked,
    closeAfterLaunch: document.getElementById('close-after-launch').checked,
  });
  setStatus('Settings saved.');
}

init();
