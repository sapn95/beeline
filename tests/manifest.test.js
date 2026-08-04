import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'));

describe('manifest', () => {
  it('is Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('requests only least-privilege permissions', () => {
    // "favicon" reads Chrome's LOCAL icon cache to fill in apps and bookmarks
    // that carry no logo. It grants no page or network access.
    expect(manifest.permissions).toEqual(['storage', 'scripting', 'alarms', 'search', 'favicon']);
    // No broad, always-on host access — My Apps access is requested on demand.
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toContain('https://myapplications.microsoft.com/*');
    // Bookmarks are opt-in: asked for only when the setting is switched on, so
    // installing Beeline never grants read access to them.
    expect(manifest.optional_permissions).toEqual(['bookmarks']);
    expect(manifest.permissions).not.toContain('bookmarks');
  });

  it('wires up the popup, options page and icons', () => {
    expect(manifest.action.default_popup).toBe('popup/popup.html');
    expect(manifest.options_page).toBe('options/options.html');
    expect(manifest.icons['128']).toBe('icons/icon-128.png');
  });
});

describe('the Firefox build', () => {
  // scripts/build.mjs rewrites the manifest for Firefox. Nothing asserted what
  // it produced, so a container permission could have leaked into the Chrome
  // bundle — where it is an unknown string that earns a store warning — or gone
  // missing from the Firefox one, where the feature then silently does nothing.
  // Built here rather than trusting a stale dist/: the point is what the script
  // produces today.
  execFileSync(process.execPath, [join(ROOT, 'scripts/build.mjs'), '--firefox'], { cwd: ROOT });
  const built = JSON.parse(readFileSync(join(ROOT, 'dist-firefox/manifest.json'), 'utf8'));

  it('requires contextualIdentities, which Firefox has no optional form of', () => {
    expect(built.permissions).toContain('contextualIdentities');
  });

  it('asks for cookies only when a container is actually chosen', () => {
    // Optional, and on Firefox's silently-granted list.
    expect(built.optional_permissions).toContain('cookies');
    expect(built.permissions).not.toContain('cookies');
  });

  it('drops the Chrome-only favicon permission', () => {
    expect(built.permissions).not.toContain('favicon');
  });

  it('keeps both container permissions out of the Chrome manifest', () => {
    const chrome = manifest;
    expect(chrome.permissions).not.toContain('contextualIdentities');
    expect(chrome.optional_permissions ?? []).not.toContain('cookies');
  });
});
