// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { scrapeAppsFromDocument } from '../src/lib/importer.js';

beforeEach(() => {
  document.body.innerHTML = `
    <header>
      <a href="https://myapplications.microsoft.com/">Home</a>
      <a href="https://myaccount.microsoft.com/">My account</a>
    </header>
    <main>
      <a href="https://launcher.myapps.microsoft.com/api/signin/123" aria-label="Salesforce">
        <img src="https://cdn.example.com/sf.png" />
      </a>
      <a href="https://portal.azure.com/" aria-label="Azure Portal">
        <img src="https://cdn.example.com/az.png" />
      </a>
      <a href="https://help.example.com/">Help</a>
      <a href="https://config.example.com/" aria-label="Settings"><img src="https://cdn.example.com/s.png" /></a>
      <a href="http://insecure.example.com/" aria-label="Insecure"><img src="https://cdn.example.com/x.png" /></a>
    </main>
  `;
});

describe('scrapeAppsFromDocument', () => {
  it('returns [] for a null document', () => {
    expect(scrapeAppsFromDocument(null)).toEqual([]);
  });

  it('extracts launchable tiles and their icons', () => {
    const apps = scrapeAppsFromDocument(document);
    expect(apps.map((a) => a.name)).toEqual(['Salesforce', 'Azure Portal']);
    expect(apps[0].url).toContain('launcher.myapps.microsoft.com');
    expect(apps[1].iconUrl).toBe('https://cdn.example.com/az.png');
  });

  it('excludes navigation chrome, icon-less links, and http targets', () => {
    const names = scrapeAppsFromDocument(document).map((a) => a.name);
    expect(names).not.toContain('Home'); // nav, no icon
    expect(names).not.toContain('Help'); // no icon
    expect(names).not.toContain('Settings'); // chrome label
    expect(names).not.toContain('Insecure'); // http target
  });
});
