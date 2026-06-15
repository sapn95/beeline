// Normalisation, validation, dedup and merge for the app list.
// Pure functions only — no chrome / DOM dependencies — so they are fully
// unit-testable and safe to import from both the popup and the options page.

/** Only https URLs are accepted — SSO apps are always https, and this keeps
 * the launcher from storing or opening plain-http targets (security default). */
export function isValidHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Canonical form used for identity and storage: drops the fragment, keeps the
 * rest verbatim so two tiles pointing at the same launch URL collapse to one. */
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return String(url ?? '').trim();
  }
}

/** Stable, dependency-free id derived from the canonical URL (FNV-1a 32-bit).
 * Same URL always yields the same id, so launch stats survive re-imports. */
export function appId(url) {
  const s = canonicalUrl(url);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.codePointAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Coerce raw input (manual entry or scraped tile) into a clean app record, or
 * null if it is unusable. */
export function normalizeApp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  const url = String(raw.url ?? '').trim();
  if (!name || !isValidHttpsUrl(url)) return null;

  const app = { id: appId(url), name, url: canonicalUrl(url) };
  const icon = String(raw.iconUrl ?? '').trim();
  if (icon && isValidHttpsUrl(icon)) app.iconUrl = icon;
  // Provenance: 'manual' (user added/edited) or 'myapps' (scraped). Drives
  // reconcileApps — only 'myapps' entries are pruned on a re-sync.
  if (raw.source === 'manual' || raw.source === 'myapps') app.source = raw.source;
  return app;
}

export function dedupeApps(apps) {
  const seen = new Map();
  for (const app of apps) {
    if (app?.id && !seen.has(app.id)) seen.set(app.id, app);
  }
  return [...seen.values()];
}

export function normalizeAppList(rawList) {
  if (!Array.isArray(rawList)) return [];
  return dedupeApps(rawList.map(normalizeApp).filter(Boolean));
}

/** Merge freshly imported apps into the existing list without dropping
 * manually-added entries. Existing records win on conflict so user edits to a
 * name are never overwritten by a later re-import. */
export function mergeApps(existing, incoming) {
  const map = new Map(normalizeAppList(existing).map((a) => [a.id, a]));
  for (const app of normalizeAppList(incoming)) {
    if (!map.has(app.id)) map.set(app.id, app);
  }
  return [...map.values()];
}

/** Reconcile the list against a fresh My Apps scrape (add + remove):
 * - manually added/edited apps (source !== 'myapps') are always kept;
 * - previously-scraped apps that are no longer present are dropped;
 * - newly-seen apps are added, tagged 'myapps'.
 * Callers MUST skip this on an empty/failed scrape, or it would wipe the
 * scraped set. Existing (manual) records win on id conflict. */
export function reconcileApps(existing, scraped) {
  const kept = normalizeAppList(existing).filter((a) => a.source !== 'myapps');
  const incoming = normalizeAppList(scraped).map((a) => ({ ...a, source: 'myapps' }));
  const map = new Map(kept.map((a) => [a.id, a]));
  for (const app of incoming) {
    if (!map.has(app.id)) map.set(app.id, app);
  }
  return [...map.values()];
}

/** For apps with "aws" in the name, steer the launch to a given AWS region:
 * - a direct AWS console URL gets a `region` query param;
 * - an IdP-initiated SSO launcher URL gets a SAML `RelayState` pointing at the
 *   regional console (whether Entra honours this is tenant-dependent — test it).
 * No-ops when region is empty, the name has no "aws", a RelayState already
 * exists, or the URL can't be parsed. Pure + unit-tested. */
export function withAwsRegion(url, name, region) {
  if (!region || !/aws/i.test(String(name ?? ''))) return url;
  try {
    const u = new URL(url);
    if (/(^|\.)(console\.)?aws\.amazon\.com$/i.test(u.host)) {
      if (!u.searchParams.has('region')) u.searchParams.set('region', region);
      return u.toString();
    }
    if (!u.searchParams.has('RelayState')) {
      u.searchParams.set(
        'RelayState',
        `https://console.aws.amazon.com/console/home?region=${region}`,
      );
    }
    return u.toString();
  } catch {
    return url;
  }
}
