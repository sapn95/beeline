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

// URL query params that carry the signed-in account's email across Microsoft apps.
const ACCOUNT_PARAMS = new Set(['login_hint', 'auth_upn', 'user_email', 'upn', 'username']);

/**
 * Best-guess the Microsoft account these scraped apps belong to, by reading the
 * email embedded in their deep-link URLs (e.g. `?login_hint=a@b.ch`). Returns the
 * most common email, or null. Used to surface WHICH account an import came from
 * so a multi-account / multi-profile mismatch is visible rather than silent.
 * @param {Array<{url?: string}>} apps
 * @returns {string|null}
 */
export function accountHintFromApps(apps) {
  const counts = new Map();
  for (const app of apps || []) {
    let parsed;
    try {
      parsed = new URL(app?.url);
    } catch {
      continue;
    }
    for (const [key, value] of parsed.searchParams) {
      if (value.includes('@') && ACCOUNT_PARAMS.has(key.toLowerCase())) {
        const email = value.trim().toLowerCase();
        counts.set(email, (counts.get(email) || 0) + 1);
      }
    }
  }
  let best = null;
  let max = 0;
  for (const [email, n] of counts) {
    if (n > max) {
      max = n;
      best = email;
    }
  }
  return best;
}

// Injected into the My Apps page: scroll one viewport down. The grid is
// virtualised inside an inner scroll panel, so we scroll the scrollable
// ancestors OF THE TILES THEMSELVES (plus the window) — scoping to tile-bearing
// scrollers stops an unrelated panel from holding the loop open forever.
// Three distinct answers, and a caller MUST keep them apart:
//   0    — nothing anywhere can advance any further. The reliable "at the
//          bottom" signal, independent of trailing padding.
//   >0   — the largest distance any scroller still has left to the bottom.
//   null — UNKNOWN: nothing advanced, yet a scroller we can see still claims
//          room. Never treat this as 0; a single virtualised slice would then
//          pass as a complete read and a reconcile would delete the rest.
export function scrollMyAppsStepInPage() {
  const step = Math.round(window.innerHeight * 0.8) || 600;
  const overflows = (el, min) =>
    !!el && el.scrollHeight - el.clientHeight > min && el.clientHeight > 150;
  const gap = (el) => el.scrollHeight - (el.scrollTop + el.clientHeight);
  const nearestScroller = (node) => {
    // Walk past <body> too — on some layouts the grid's scroll container IS the
    // body. Stop at <html>, which window.scrollBy already drives.
    for (
      let el = node.parentElement;
      el && el !== document.documentElement;
      el = el.parentElement
    ) {
      if (overflows(el, 4)) return el;
    }
    return null;
  };

  // The tile selector mirrors the scraper (importer.js) so direct-link icon tiles
  // count as tiles here too; we scroll each tile's nearest scrollable ancestor.
  const tiles = document.querySelectorAll(
    'a[href*="launcher.myapps.microsoft.com"], a[href*="/api/signin/"], a[href*="/launch"], ' +
      '[role="gridcell"], main a[href]:has(img), [role="main"] a[href]:has(img)',
  );
  const scrollers = new Set();
  for (const tile of tiles) {
    const s = nearestScroller(tile);
    if (s) scrollers.add(s);
  }
  // Fallback (empty grid / unknown markup): all sizeably-scrollable blocks.
  if (scrollers.size === 0) {
    for (const el of document.querySelectorAll('div, main, section, ul')) {
      if (overflows(el, 200)) scrollers.add(el);
    }
  }

  // Scroll window + each tile scroller, tracking whether ANYTHING advanced and
  // how far the deepest scroller still has to go.
  const winBefore = window.scrollY;
  window.scrollBy(0, step);
  const winMoved = window.scrollY !== winBefore;
  let moved = winMoved;
  // The document-level distance only counts when the WINDOW is really what
  // scrolls. An app shell (fixed-height <html>, grid inside its own scroller)
  // can report a document far taller than the viewport that no scrollBy will
  // ever move: a phantom gap that never falls to 0, so the bottom is never
  // detected and EVERY import ends merge-only ("Run Import again to finish")
  // even after it walked the whole grid. Ignore it — but only while a
  // tile-bearing inner scroller exists to be the real one. With no inner
  // scroller the window is all we have, and its claim must still be believed.
  const windowScrolls = winMoved || window.scrollY > 0 || scrollers.size === 0;
  let maxRemaining = windowScrolls
    ? document.documentElement.scrollHeight - (window.scrollY + window.innerHeight)
    : 0;
  for (const el of scrollers) {
    const before = el.scrollTop;
    el.scrollTop += step;
    if (el.scrollTop !== before) moved = true;
    maxRemaining = Math.max(maxRemaining, gap(el));
  }

  if (moved) return Math.max(0, maxRemaining);
  // Nothing advanced. If a scroller we CAN see still reports distance to go, the
  // answer is "unknown" (null), never "bottom" — calling that bottom would let a
  // single virtualised slice pass as a complete read, and the reconcile would
  // then delete every app that wasn't in it. If nothing anywhere has room left,
  // the page really is fully shown (a short list that needs no scrolling), so
  // report 0. NOTE: a scroller we cannot see at all (shadow root, iframe) is
  // indistinguishable from that case here — the growth cap in accumulateApps is
  // the remaining backstop.
  return maxRemaining <= 4 ? 0 : null;
}
