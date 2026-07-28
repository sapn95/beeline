// Test harness for the parts that talk to the browser: a fake `chrome.*` API
// plus the REAL popup/options markup loaded into jsdom, so the page scripts can
// be imported and driven exactly the way the browser runs them (each module
// wires itself up on import).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

// Plain path joins, not `new URL(..., import.meta.url)`: Vite rewrites that
// pattern into a served asset URL, which readFileSync cannot open.
const HERE = dirname(fileURLToPath(import.meta.url));

/** In-memory stand-in for one chrome.storage area (local or sync). */
export function makeArea(seed = {}) {
  const store = structuredClone(seed);
  return {
    store,
    get: vi.fn(async (key) => {
      if (key == null) return structuredClone(store);
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (k in store) out[k] = structuredClone(store[k]);
      return out;
    }),
    set: vi.fn(async (obj) => {
      Object.assign(store, structuredClone(obj));
    }),
    remove: vi.fn(async (key) => {
      for (const k of Array.isArray(key) ? key : [key]) delete store[k];
    }),
  };
}

/** chrome.* event stand-in: collects listeners so tests can fire them. */
export function makeEvent() {
  const listeners = [];
  return {
    addListener: vi.fn((fn) => listeners.push(fn)),
    removeListener: vi.fn((fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    }),
    hasListener: (fn) => listeners.includes(fn),
    listeners,
    /** Fire every registered listener and await the (possibly async) handlers. */
    emit: async (...args) => {
      const results = listeners.map((fn) => fn(...args));
      return Promise.all(results);
    },
  };
}

/**
 * Build a fake `chrome` with just enough surface for the extension.
 * `executeScript` runs the injected function against the CURRENT jsdom document
 * by default — the same contract the browser gives it — so functions that are
 * injected into the My Apps page get exercised for real.
 */
export function makeChrome({ local = {}, sync = {}, version = '9.9.9', granted = true } = {}) {
  const localArea = makeArea(local);
  const syncArea = makeArea(sync);
  return {
    runtime: {
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      openOptionsPage: vi.fn(async () => {}),
      getURL: vi.fn((p) => `chrome-extension://beeline/${p}`),
      getManifest: vi.fn(() => ({ version })),
    },
    storage: {
      local: localArea,
      sync: syncArea,
      onChanged: makeEvent(),
    },
    tabs: {
      create: vi.fn(async () => ({ id: 1 })),
      update: vi.fn(async () => ({ id: 1 })),
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ status: 'complete' })),
      onUpdated: makeEvent(),
    },
    windows: {
      create: vi.fn(async () => ({ id: 7, tabs: [{ id: 42 }] })),
      remove: vi.fn(async () => {}),
    },
    scripting: {
      // Runs the injected function against the current jsdom document. Note the
      // real API serialises it with Function.prototype.toString and evaluates it
      // in the page, so an injected function must be entirely self-contained —
      // that contract is enforced by `rebuildInjected` below, used in its own
      // test, rather than here (calling a rebuilt copy would run the
      // side-effecting scroll steps twice).
      executeScript: vi.fn(async ({ func }) => [{ result: func() }]),
    },
    permissions: {
      request: vi.fn(async () => granted),
      contains: vi.fn(async () => granted),
    },
    alarms: {
      get: vi.fn(async () => undefined),
      create: vi.fn(),
      onAlarm: makeEvent(),
    },
    search: { query: vi.fn() },
  };
}

const PAGES = {
  popup: join(HERE, '../../src/popup/popup.html'),
  options: join(HERE, '../../src/options/options.html'),
};

// A page script binds listeners to `document` / `window`, not only to elements —
// and jsdom keeps ONE document per test file, so re-mounting a page would stack
// them up. A stale popup listener (capture phase + stopPropagation) then eats
// clicks meant for the next mount. Record what each mount binds so the next one
// can unbind it; the browser gets a fresh document per popup, so this is a
// test-harness concern only.
const globalListeners = [];
let listenersPatched = false;

function patchGlobalListeners() {
  if (listenersPatched) return;
  listenersPatched = true;
  for (const target of [document, window]) {
    const add = target.addEventListener.bind(target);
    target.addEventListener = (type, fn, options) => {
      globalListeners.push({ target, type, fn, options });
      add(type, fn, options);
    };
  }
}

/** Unbind everything previous mounts attached to `document` / `window`. */
export function clearGlobalListeners() {
  for (const { target, type, fn, options } of globalListeners.splice(0)) {
    target.removeEventListener(type, fn, options);
  }
}

/**
 * Load the real page markup into jsdom (scripts stripped — the test imports the
 * module itself). Loading the shipped HTML means a renamed/removed element id
 * fails these tests instead of only failing in the browser.
 */
export function loadPage(name) {
  clearGlobalListeners();
  patchGlobalListeners();
  const html = readFileSync(PAGES[name], 'utf8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1];
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  document.documentElement.dataset.theme = 'auto';
}

/**
 * Node's own experimental `localStorage` global shadows jsdom's, so the pages'
 * theme mirror has nothing to write to. Install a minimal in-memory Storage.
 * Pass a failing implementation to exercise the "storage unavailable" path.
 */
export function stubLocalStorage(impl) {
  const map = new Map();
  const storage = impl ?? {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => {
      map.set(String(k), String(v));
    },
    removeItem: (k) => {
      map.delete(String(k));
    },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  return storage;
}

/**
 * jsdom no-ops window.scrollBy and never moves scrollY, so a page that scrolls
 * the WINDOW (rather than an inner panel) would look immovable. Give the window
 * a working scroll position bounded by `height`.
 */
export function stubWindowScroll({ height = 0, viewport = 768 } = {}) {
  let y = 0;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => viewport });
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    get: () => Math.max(height, viewport),
  });
  window.scrollBy = vi.fn((_x, dy) => {
    y = Math.max(0, Math.min(y + dy, Math.max(0, height - viewport)));
  });
}

/** jsdom implements neither of these; the UI calls both. */
export function stubDomExtras() {
  stubLocalStorage();
  window.scrollBy = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(window, 'close').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:beeline/1');
  globalThis.URL.revokeObjectURL = vi.fn();
}

/**
 * Rebuild an injected function from its SOURCE, exactly the way
 * chrome.scripting.executeScript does (Function.prototype.toString, evaluated in
 * the page). Anything the function closes over is gone, so a reference to
 * module scope throws a ReferenceError here — the failure it would otherwise
 * only produce in a real browser.
 */
export function rebuildInjected(func) {
  // No closure scope is exactly the point: this mirrors how the browser
  // evaluates an injected function.
  return new Function(`return (${func.toString()})`)();
}

/** Give an element the scroll geometry jsdom refuses to compute. */
export function fakeScroller(el, { scrollHeight, clientHeight, scrollTop = 0 }) {
  let top = scrollTop;
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (v) => {
        top = Math.max(0, Math.min(v, scrollHeight - clientHeight));
      },
    },
  });
  return el;
}

/** Flush pending microtasks (for handlers we dispatch but cannot await). */
export function flush(times = 3) {
  return times <= 0 ? Promise.resolve() : Promise.resolve().then(() => flush(times - 1));
}

/** Dispatch a keydown on an element the way a user would. */
export function press(el, key, init = {}) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
}

/** Click an element and let its async handler settle. */
export async function click(el, init = {}) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  await flush();
}
