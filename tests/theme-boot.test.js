// @vitest-environment jsdom
//
// theme-boot.js runs synchronously in <head> so the popup/options page never
// flashes the wrong theme. It must apply a mirrored theme, ignore anything else,
// and never throw — a throw here would block the page from rendering.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubLocalStorage } from './helpers/extension.js';

// Start from a value the script can never produce, so "unchanged" is
// distinguishable from "applied" — including for the 'auto' case.
async function boot(initial = 'untouched') {
  document.documentElement.dataset.theme = initial;
  vi.resetModules();
  await import('../src/theme-boot.js');
  return document.documentElement.dataset.theme;
}

beforeEach(() => {
  stubLocalStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('theme boot', () => {
  it.each(['light', 'dark', 'auto'])('applies the mirrored %s theme', async (theme) => {
    localStorage.setItem('beeline-theme', theme);
    expect(await boot()).toBe(theme);
  });

  it('ignores an unknown value', async () => {
    localStorage.setItem('beeline-theme', 'neon');
    expect(await boot()).toBe('untouched');
  });

  it('keeps the default when nothing was mirrored', async () => {
    expect(await boot()).toBe('untouched');
  });

  it('does not throw when storage is unavailable', async () => {
    stubLocalStorage({
      getItem: () => {
        throw new Error('denied');
      },
    });
    expect(await boot()).toBe('untouched');
  });
});
