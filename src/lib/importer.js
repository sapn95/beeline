// Scrapes app tiles from the Microsoft My Apps portal DOM.
//
// NOTE: scrapeAppsFromDocument is injected verbatim into the My Apps page via
// chrome.scripting.executeScript, so it MUST stay fully self-contained — no
// imports, no references to module-scope helpers, no optional chaining on the
// injected globals beyond what older page contexts support. It is also exported
// so it can be unit-tested against a jsdom fixture.
//
// FIXME: The My Apps DOM is not a stable contract. If Microsoft changes the
// markup and imports come back empty, update the two selector strategies below
// (and tests/importer.test.js fixture) to match the new structure.

/**
 * Extract { name, url, iconUrl } records for every launchable app tile.
 * @param {Document} doc - defaults to the page `document` when injected.
 * @returns {Array<{name: string, url: string, iconUrl?: string}>}
 */
export function scrapeAppsFromDocument(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return [];

  const base = (doc.baseURI || 'https://myapplications.microsoft.com/').toString();
  const CHROME_LABELS =
    /^(home|sign out|settings|help|my account|add apps|give feedback|skip to content)$/i;

  const out = [];
  const seen = new Set();

  const add = (name, href, img) => {
    const label = String(name || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!label || CHROME_LABELS.test(label)) return;

    let abs;
    try {
      abs = new URL(href, base).toString();
    } catch {
      return;
    }
    if (abs.indexOf('https:') !== 0) return;
    if (seen.has(abs)) return;
    seen.add(abs);

    const record = { name: label, url: abs };
    const iconSrc = img && img.src ? String(img.src) : '';
    if (iconSrc.indexOf('https:') === 0) record.iconUrl = iconSrc;
    out.push(record);
  };

  // Strategy 1: explicit launcher links — the most reliable signal.
  const launchers = doc.querySelectorAll(
    'a[href*="launcher.myapps.microsoft.com"], a[href*="/launch"]',
  );
  for (const a of launchers) {
    add(
      a.getAttribute('aria-label') || a.textContent,
      a.getAttribute('href'),
      a.querySelector('img'),
    );
  }

  // Strategy 2: tile links inside the main content region that carry an icon.
  const main = doc.querySelector('main, [role="main"]') || doc;
  for (const a of main.querySelectorAll('a[href]')) {
    const img = a.querySelector('img');
    if (!img) continue;
    add(a.getAttribute('aria-label') || a.textContent, a.getAttribute('href'), img);
  }

  return out;
}
