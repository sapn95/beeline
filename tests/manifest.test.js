import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

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
