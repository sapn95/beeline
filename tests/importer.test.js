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

// Regression fixture mirroring the REAL My Apps DOM captured by the Beeline Debug
// button: gridLink anchors with role="button" and launcher /api/signin hrefs, an
// icon-less tile, a direct-link tile, plus the header "View account" mectrl link
// that must NOT be treated as an app.
describe('scrapeAppsFromDocument — real My Apps markup', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="mectrl_main">
        <a class="mectrl_link" href="https://myaccount.microsoft.com/?ref=MeControl" aria-label="View account">View account</a>
        <button class="mectrl_trigger" aria-label="Account manager">SW</button>
      </div>
      <main>
        <a class="gridLink-118" role="button" aria-label="AWS SBB HAFAS - NonProd"
           href="https://launcher.myapps.microsoft.com/api/signin/4f3ac166-42c1-4175-9cb4-01ee208a08c4?tenantId=2cda5d11">
          <img src="https://cdn.example.com/aws.png" />
        </a>
        <a class="gridLink-118" role="button" aria-label="CFcf-sigma-sso"
           href="https://launcher.myapps.microsoft.com/api/signin/2e5da77f-c931-4c9f-ade8-ab8ad33b1e27?tenantId=2cda5d11">
        </a>
        <a class="gridLink-118" role="button" aria-label="Learning Activities"
           href="https://learningactivities.edu.cloud.microsoft?sourceApp=m365">
          <img src="https://cdn.example.com/la.png" />
        </a>
      </main>
    `;
  });

  it('captures launcher tiles (even icon-less) and main-region icon tiles', () => {
    const apps = scrapeAppsFromDocument(document);
    const names = apps.map((a) => a.name);
    expect(names).toContain('AWS SBB HAFAS - NonProd'); // launcher + icon
    expect(names).toContain('CFcf-sigma-sso'); // launcher, no icon — still captured
    expect(names).toContain('Learning Activities'); // not a launcher link, but main + icon
    const aws = apps.find((a) => a.name === 'AWS SBB HAFAS - NonProd');
    expect(aws.url).toContain('launcher.myapps.microsoft.com/api/signin/');
    expect(aws.iconUrl).toBe('https://cdn.example.com/aws.png');
  });

  it('does not treat the header "View account" link as an app', () => {
    const names = scrapeAppsFromDocument(document).map((a) => a.name);
    expect(names).not.toContain('View account');
    expect(names.some((n) => /myaccount/i.test(n))).toBe(false);
  });
});
