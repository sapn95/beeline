// @vitest-environment jsdom
// TEMPORARY adversarial probe — deleted after the review run.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeChrome, loadPage, stubDomExtras, flush, click } from './helpers/extension.js';
import { appId } from '../src/lib/apps.js';

const $ = (id) => document.getElementById(id);
const app = (n, u) => ({ id: appId(u), name: n, url: u, source: 'manual' });

beforeEach(() => stubDomExtras());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete globalThis.chrome;
});

const raf = () => new Promise((r) => (globalThis.requestAnimationFrame ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

describe('PROBE X: the (uncommitted) chunked options list', () => {
  it('a filter that matches nothing leaves the previous tail running', async () => {
    const APPS = Array.from({ length: 300 }, (_, i) =>
      app(`App ${String(i).padStart(3, '0')}`, `https://a${i}.example.com/`),
    );
    globalThis.chrome = makeChrome({ local: { apps: APPS }, sync: { settings: {} } });
    globalThis.chrome.contextualIdentities = { query: vi.fn(async () => []) };
    loadPage('options');
    vi.resetModules();
    await import('../src/options/options.js');
    await flush(10);
    console.log('X rows after first paint:', $('list').children.length);
    // type a filter that matches many, then one that matches nothing
    $('app-filter').value = 'App';
    $('app-filter').dispatchEvent(new Event('input', { bubbles: true }));
    console.log('X rows right after a wide filter:', $('list').children.length);
    $('app-filter').value = 'zzzzz-no-match';
    $('app-filter').dispatchEvent(new Event('input', { bubbles: true }));
    console.log('X rows right after the no-match filter:', $('list').children.length,
      JSON.stringify($('list').children[0]?.textContent));
    await raf();
    await raf();
    await raf();
    const kids = [...$('list').children];
    console.log('X rows one frame later:', kids.length);
    console.log('X first row:', JSON.stringify(kids[0]?.textContent?.slice(0, 40)));
    console.log('X second row:', JSON.stringify(kids[1]?.textContent?.slice(0, 40)));
    console.log('X count label says:', $('count').textContent);
  });
});
