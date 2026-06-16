import { getApps, getStats, getSettings, recordLaunch } from '../lib/storage.js';
import { rankApps, hostOf } from '../lib/ranking.js';
import { withAwsRegion } from '../lib/apps.js';

const searchEl = document.getElementById('search');
const resultsEl = document.getElementById('results');
const emptyEl = document.getElementById('empty');
const ctxEl = document.getElementById('ctx');
const toastEl = document.getElementById('toast');

let ctxApp = null; // the app the right-click menu is acting on
let toastTimer = null;

let apps = [];
let stats = {};
let settings = {
  openInNewTab: true,
  closeAfterLaunch: true,
  fallbackSearch: 'myapps',
  awsRegion: '',
};
let current = [];
let selected = 0;

async function init() {
  [apps, stats, settings] = await Promise.all([getApps(), getStats(), getSettings()]);
  const theme = settings.theme || 'auto'; // 'auto' | 'light' | 'dark'
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('beeline-theme', theme); // mirror for theme-boot.js (no-flash)
  } catch {
    /* localStorage unavailable */
  }
  emptyEl.hidden = apps.length > 0;
  render();

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

  searchEl.focus();
}

function render() {
  const q = searchEl.value.trim();
  current = rankApps(apps, searchEl.value, Date.now(), stats);
  // When you have apps but none match, offer a fallback search action.
  if (current.length === 0 && q && apps.length > 0) {
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

function renderItem(r, i) {
  if (r.fallback) return renderFallbackItem(r, i);

  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.index = String(i);

  const icon = document.createElement('span');
  icon.className = 'icon';
  if (r.app.iconUrl) {
    const img = document.createElement('img');
    img.src = r.app.iconUrl;
    img.alt = '';
    img.loading = 'lazy';
    icon.appendChild(img);
  } else {
    icon.classList.add('letter');
    icon.textContent = r.app.name.charAt(0).toUpperCase();
  }

  const meta = document.createElement('span');
  meta.className = 'meta';
  const name = document.createElement('span');
  name.className = 'name';
  name.append(...highlight(r.app.name, r.field === 'name' ? r.positions : []));
  const host = document.createElement('span');
  host.className = 'host';
  host.textContent = hostOf(r.app.url) || r.app.url;
  meta.append(name, host);

  li.append(icon, meta);
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
  } else if (e.altKey && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    launch(Number(e.key) - 1); // Alt+1–9 → quick-launch that result
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
  await recordLaunch(r.app.id, Date.now());
  const target = withAwsRegion(r.app.url, r.app.name, settings.awsRegion);
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
