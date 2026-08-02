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

/** Canonical form used for IDENTITY only: drops the fragment, keeps the rest
 * verbatim so two tiles pointing at the same launch URL collapse to one. The
 * stored URL keeps its fragment — hash-routed apps (Azure Portal blades, Power
 * BI pages) live entirely in it, and dropping it opens the wrong page. */
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return String(url ?? '').trim();
  }
}

/** Tidy an accepted URL for storage, fragment and all. */
export function normalizeUrl(url) {
  try {
    return new URL(url).toString();
  } catch {
    return String(url ?? '').trim();
  }
}

/** FNV-1a 32-bit over a string — the shared basis for every stable id here.
 * What gets hashed is the caller's choice: an app hashes its canonical URL,
 * a bookmark its full one (see lib/bookmarks.js). */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.codePointAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Stable, dependency-free id derived from the canonical URL.
 * Same URL always yields the same id, so launch stats survive re-imports. */
export function appId(url) {
  return fnv1a(canonicalUrl(url));
}

/** Coerce raw input (manual entry or scraped tile) into a clean app record, or
 * null if it is unusable. */
export function normalizeApp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    // Heal stray spaces around a hyphen joining a token (My Apps stores some apps
    // as e.g. "S-SBB -SAP-DEV2"); leave real " - " separators alone.
    .replace(/ -(\S)/g, '-$1')
    .replace(/(\S)- /g, '$1-');
  const url = String(raw.url ?? '').trim();
  if (!name || !isValidHttpsUrl(url)) return null;

  // Identity ignores the fragment; the launch URL keeps it.
  const app = { id: appId(url), name, url: normalizeUrl(url) };
  const icon = String(raw.iconUrl ?? '').trim();
  if (icon && isValidHttpsUrl(icon)) app.iconUrl = icon;
  // Provenance: 'manual' (user added/edited) or 'myapps' (scraped). Drives
  // reconcileApps — only 'myapps' entries are pruned on a re-sync.
  if (raw.source === 'manual' || raw.source === 'myapps') app.source = raw.source;
  // Strikes from the automatic sync: how many usable reads in a row failed to
  // find this app. Absent means "seen last time". See applySyncRead. Capped so
  // a corrupted value can't grow without bound; this whitelist is the only way
  // the field survives a round trip through storage at all.
  const missing = Number(raw.missing);
  if (Number.isInteger(missing) && missing > 0) app.missing = Math.min(missing, 9);
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
    const prev = map.get(app.id);
    if (!prev) {
      map.set(app.id, app);
    } else if (!prev.source && app.source) {
      // Heal a legacy untagged record: keep its (possibly user-edited) fields but
      // adopt the provenance tag from the fresh import so future syncs manage it.
      map.set(app.id, { ...prev, source: app.source });
    }
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
  const normExisting = normalizeAppList(existing);
  const incoming = normalizeAppList(scraped).map((a) => ({ ...a, source: 'myapps' }));
  const incomingIds = new Set(incoming.map((a) => a.id));
  // Legacy untagged records (no source), keyed by id, so that when we re-tag one
  // as 'myapps' below we keep ITS (possibly user-customised) name/icon rather
  // than overwriting with the scrape.
  const legacyById = new Map(normExisting.filter((a) => !a.source).map((a) => [a.id, a]));
  // Always keep explicit manual apps. Keep other non-'myapps' records (including
  // legacy untagged ones) ONLY while they're absent from the fresh scrape: an
  // untagged app that still appears in My Apps is dropped here so the re-tagged
  // record below replaces it (making it prunable on later syncs).
  const kept = normExisting.filter(
    (a) => a.source === 'manual' || (a.source !== 'myapps' && !incomingIds.has(a.id)),
  );
  const map = new Map(kept.map((a) => [a.id, a]));
  for (const app of incoming) {
    if (map.has(app.id)) continue;
    const legacy = legacyById.get(app.id);
    map.set(app.id, legacy ? { ...legacy, source: 'myapps' } : app);
  }
  // A manual import is the user watching a complete walk of the grid: it settles
  // the question for every app, so nothing is left carrying a strike.
  return [...map.values()].map(unmarked);
}

/** Drop the automatic sync's strike counter from a record. */
function unmarked(app) {
  if (app.missing === undefined) return app;
  const copy = { ...app };
  delete copy.missing;
  return copy;
}

/**
 * Apply one automatic background read to the stored list: add what is new, and
 * move what is gone one step closer to being removed.
 *
 * Where reconcileApps is the user watching a full import, this runs unattended
 * against a virtualised grid that can stall anywhere, so a SINGLE read is never
 * allowed to delete. An app the read did not find collects a strike; it goes
 * only once `strikes` reads in a row have missed it, and being found again
 * clears the count. One bad read therefore costs nothing but a cycle's delay.
 *
 * Manual apps and untagged legacy records are never struck or removed.
 *
 * @param {number} [strikes] consecutive misses before an app is dropped.
 * @returns {{apps: Array, removed: Array}} the new list, and what fell out of it.
 */
export function applySyncRead(existing, scraped, { strikes = 2 } = {}) {
  // The count has to be reachable: normalizeApp caps a stored `missing` at 9, so
  // a threshold above that would never be met and the app would simply never be
  // removed — a silent no-op rather than a loud mistake. Clamp instead.
  const limit = Math.min(Math.max(Math.trunc(strikes) || 1, 1), 9);
  const incoming = normalizeAppList(scraped).map((a) => ({ ...a, source: 'myapps' }));
  const seen = new Set(incoming.map((a) => a.id));
  const apps = [];
  const removed = [];
  for (const app of mergeApps(existing, incoming)) {
    if (app.source !== 'myapps' || seen.has(app.id)) {
      apps.push(unmarked(app)); // still there, or not ours to prune
      continue;
    }
    const strike = (app.missing ?? 0) + 1;
    if (strike >= limit) removed.push(app);
    else apps.push({ ...app, missing: strike });
  }
  return { apps, removed };
}

/**
 * Does this read look like it only saw PART of the grid?
 *
 * The strike counter above defends against a read that stalls somewhere random.
 * It cannot defend against one that stalls in the same place every time — those
 * misses line up, and the apps behind the stall would be struck out. So a read
 * that suddenly cannot find a large slice of what we already know is thrown away
 * whole: it neither adds nor strikes, and the next one gets to decide.
 *
 * The threshold is deliberately generous downward. Losing a handful of apps is
 * everyday churn and should just happen; losing a tenth of them at once is
 * either a broken read or news big enough to be worth a manual Import.
 *
 * @param {number} [maxMissingRatio] fraction of the known 'myapps' apps that may
 *   be absent before the read is called suspect.
 * @param {number} [floor] never suspect while at most this many are absent, so a
 *   short list is not held hostage by a percentage.
 */
export function isSuspectRead(existing, scraped, { maxMissingRatio = 0.1, floor = 5 } = {}) {
  const known = normalizeAppList(existing).filter((a) => a.source === 'myapps');
  if (known.length === 0) return false; // nothing to lose yet
  const seen = new Set(normalizeAppList(scraped).map((a) => a.id));
  const absent = known.reduce((n, a) => (seen.has(a.id) ? n : n + 1), 0);
  return absent > Math.max(floor, known.length * maxMissingRatio);
}

/** For apps with "aws" in the name, steer the launch to a given AWS region:
 * - a direct AWS console URL gets a `region` query param;
 * - an IdP-initiated SSO launcher URL gets a SAML `RelayState` pointing at the
 *   regional console (whether Entra honours this is tenant-dependent — test it).
 * No-ops when region is empty, the name has no "aws", a RelayState already
 * exists, or the URL can't be parsed. Pure + unit-tested.
 * `samlRelayState: false` keeps only the console `region` rewrite — for targets
 * that are not an SSO launch URL (a bookmark), where a stray RelayState
 * parameter would just be noise on someone else's URL. */
export function withAwsRegion(url, name, region, { samlRelayState = true } = {}) {
  if (!region || !/aws/i.test(String(name ?? ''))) return url;
  try {
    const u = new URL(url);
    if (/(^|\.)(console\.)?aws\.amazon\.com$/i.test(u.host)) {
      if (!u.searchParams.has('region')) u.searchParams.set('region', region);
      return u.toString();
    }
    if (!samlRelayState) return url;
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
