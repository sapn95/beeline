import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'));

describe('manifest', () => {
  it('is Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('requests only least-privilege permissions', () => {
    expect(manifest.permissions).toEqual(['storage', 'scripting']);
    // No broad, always-on host access — My Apps access is requested on demand.
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toContain('https://myapplications.microsoft.com/*');
  });

  it('wires up the popup, options page and icons', () => {
    expect(manifest.action.default_popup).toBe('popup/popup.html');
    expect(manifest.options_page).toBe('options/options.html');
    expect(manifest.icons['128']).toBe('icons/icon-128.png');
  });
});
