// Normalisation, validation, dedup and merge for the app list.
// Pure functions only — no chrome / DOM dependencies — so they are fully
// unit-testable and safe to import from both the popup and the options page.

import { isContained } from './containers.js';

/** Only https URLs are accepted — SSO apps are always https, and this keeps
 * the launcher from storing or opening plain-http targets (security default). */
export function isValidHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Query parameters that say WHERE YOU CAME FROM, WHAT LANGUAGE you asked for or
 * WHO YOU ARE — never WHICH APP this is. My Apps hands out the same tile with
 * different ones, and one portal listed **Planner twice**, byte-identical but
 * for `mkt=en-GB` against `mkt=en-US`. Keeping those in the identity made that
 * two apps in the launcher, forever, because nothing downstream can tell them
 * apart afterwards.
 *
 * Deliberately an allowlist rather than "strip the query": for plenty of hosts
 * the query IS the app, and a blanket rule would fuse unrelated tiles into one.
 * A single-letter parameter like `s=shell` is left in for the same reason — too
 * generic to strip safely on a hunch.
 */
const IDENTITY_NOISE = new Set([
  'mkt',
  'lang',
  'locale', // which language the portal felt like linking
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'trk', // referral tracking
  'referrer',
  'referrerscenario',
  'source',
  'sourceapp',
  'origin', // which launcher you came from
  'login_hint',
  'auth_upn',
  'auth_pvr',
  'upn',
  'user_email',
  'realm',
  'tenant',
  'tenantid', // who you signed in as
]);

/** Canonical form used for IDENTITY only: drops the fragment and the noise
 * parameters above, and sorts what is left so parameter ORDER cannot split one
 * app in two either. The stored URL keeps all of it — the fragment because
 * hash-routed apps (Azure Portal blades, Power BI pages) live entirely in it,
 * and the parameters because that is the URL the tile actually launches. */
// A canonical form is a pure function of the URL string, so it can be memoised
// for the life of the page. Worth it out of all proportion to its size: this
// runs from appId, which runs from normalizeApp, which runs over the WHOLE list
// several times per sync — and with the same tile stored once per container the
// same handful of URLs come round again and again. Measured over 1160 apps in
// four containers: 11.3 ms cold, 0.02 ms warm.
const canonical = new Map();

export function canonicalUrl(url) {
  const key = String(url ?? '');
  const hit = canonical.get(key);
  if (hit !== undefined) return hit;
  let out;
  try {
    const u = new URL(key);
    u.hash = '';
    // Collect what survives and write the query back ONCE. Deleting key by key
    // re-serialises the whole query string every time, which was most of the
    // cost of this function.
    const kept = [...u.searchParams.entries()].filter(
      ([k]) => !IDENTITY_NOISE.has(k.toLowerCase()),
    );
    const params = new URLSearchParams(kept);
    params.sort();
    u.search = params.toString();
    out = u.toString();
  } catch {
    out = key.trim();
  }
  canonical.set(key, out);
  return out;
}

/** The id an app WOULD have had before the noise parameters were stripped —
 * fragment dropped, query kept verbatim. Exists for exactly one reason: to
 * carry launch stats across that change instead of resetting everyone's
 * ranking to alphabetical. See migrateStats. */
export function legacyAppId(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return fnv1a(u.toString());
  } catch {
    return fnv1a(String(url ?? '').trim());
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

/** Stable, dependency-free id derived from the canonical URL — and, on Firefox,
 * from the container it belongs to.
 *
 * The same URL always yields the same id, so launch stats survive re-imports.
 * A container is folded in because the SAME tile in two containers is two
 * different things: it signs in as a different identity and lands somewhere
 * else. Without it the second import would collapse onto the first and one of
 * the two accounts would silently disappear from the launcher.
 *
 * The default (container-less) store is deliberately hashed exactly as before,
 * so every app anyone already has keeps the id it has today. */
export function appId(url, container) {
  const canonical = canonicalUrl(url);
  return fnv1a(isContained(container) ? `${canonical}\n${container}` : canonical);
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

  // Which container this app belongs to (Firefox only). Kept before the id is
  // computed, because it is PART of the id — see appId.
  const container = isContained(raw.container) ? raw.container : '';
  // Identity ignores the fragment; the launch URL keeps it.
  const app = { id: appId(url, container), name, url: normalizeUrl(url) };
  if (container) app.container = container;
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

/**
 * Re-key launch stats from the pre-noise-stripping ids to the current ones.
 *
 * Every app's id is derived from its URL, so changing what counts as identity
 * renames every record at once — and stats keyed by the old names would simply
 * stop matching, resetting a ranking built up over months to plain alphabetical
 * order. Where two old ids now name the SAME app (the Planner pair), their
 * records are added together rather than one silently winning.
 *
 * @returns {object|null} the new stats, or null when nothing needed moving.
 */
export function migrateStats(apps, stats) {
  if (!stats || typeof stats !== 'object') return null;
  const next = { ...stats };
  let moved = false;
  // The RAW list, deliberately not the normalised one: normalising DEDUPES, and
  // the whole point here is that two stored records now share an id. Each of
  // them still has its own history to bring along.
  // Which ids the list itself already claims. A CONTAINED app's legacy id is,
  // by construction, the container-less app's CURRENT id — so migrating it would
  // hand one app's launch history to a different app and delete the original's.
  const claimed = new Set(
    (Array.isArray(apps) ? apps : [])
      .filter((a) => isValidHttpsUrl(String(a?.url ?? '').trim()))
      .map((a) => appId(String(a.url).trim(), a?.container)),
  );
  for (const raw of Array.isArray(apps) ? apps : []) {
    const url = String(raw?.url ?? '').trim();
    if (!isValidHttpsUrl(url)) continue;
    const old = legacyAppId(url);
    if (claimed.has(old)) continue; // that history belongs to a live app
    // With the app's own container, or the migration target is an id nothing
    // owns — and `delete next[old]` would then throw the history away.
    const id = appId(url, raw?.container);
    if (old === id || !next[old]) continue;
    const from = next[old];
    const to = next[id];
    next[id] = to
      ? {
          count: (to.count ?? 0) + (from.count ?? 0),
          lastLaunched: Math.max(to.lastLaunched ?? 0, from.lastLaunched ?? 0),
        }
      : from;
    delete next[old];
    moved = true;
  }
  return moved ? next : null;
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
 * scraped set. Existing (manual) records win on id conflict.
 *
 * `container` scopes the whole operation, and getting that wrong is the one way
 * this can destroy something: a scrape only ever sees ONE container's My Apps,
 * so apps belonging to any OTHER container are none of its business. Importing
 * the work container would otherwise wipe every app of the personal one. */
export function reconcileApps(existing, scraped, { container = '' } = {}) {
  const scope = isContained(container) ? container : '';
  const inScope = (a) => (a.container ?? '') === scope;
  const normExisting = normalizeAppList(existing);
  const incoming = normalizeAppList(scraped)
    .map((a) => ({
      ...a,
      source: 'myapps',
      ...(scope ? { container: scope } : {}),
    }))
    .map((a) => normalizeApp(a));
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
    (a) =>
      a.source === 'manual' ||
      // Another container's apps: this scrape never looked at them.
      !inScope(a) ||
      (a.source !== 'myapps' && !incomingIds.has(a.id)),
  );
  const map = new Map(kept.map((a) => [a.id, a]));
  for (const app of incoming) {
    if (map.has(app.id)) continue;
    const legacy = legacyById.get(app.id);
    map.set(app.id, legacy ? { ...legacy, source: 'myapps' } : app);
  }
  // A manual import is the user watching a complete walk of the grid, so it
  // settles the question — but only for the container it actually walked.
  // Another container's strikes are none of its business.
  return [...map.values()].map((a) => (inScope(a) ? unmarked(a) : a));
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
export function applySyncRead(existing, scraped, { strikes = 2, container = '' } = {}) {
  // Scoped exactly like reconcileApps: a My Apps tab lives in ONE container, so
  // a read of it says nothing whatsoever about any other container's apps.
  const scope = isContained(container) ? container : '';
  const inScope = (a) => (a.container ?? '') === scope;
  // The count has to be reachable: normalizeApp caps a stored `missing` at 9, so
  // a threshold above that would never be met and the app would simply never be
  // removed — a silent no-op rather than a loud mistake. Clamp instead.
  const limit = Math.min(Math.max(Math.trunc(strikes) || 1, 1), 9);
  const incoming = normalizeAppList(
    normalizeAppList(scraped).map((a) => ({
      ...a,
      source: 'myapps',
      ...(scope ? { container: scope } : {}),
    })),
  );
  const seen = new Set(incoming.map((a) => a.id));
  const apps = [];
  const removed = [];
  for (const app of mergeApps(existing, incoming)) {
    if (app.source !== 'myapps' || seen.has(app.id)) {
      apps.push(unmarked(app)); // still there, or not ours to prune
      continue;
    }
    if (!inScope(app)) {
      // Another container's. This read never looked at it, so it neither clears
      // nor adds a strike — clearing would mean a user who alternates between a
      // default and a container My Apps tab could never prune anything again.
      apps.push(app);
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
export function isSuspectRead(
  existing,
  scraped,
  { maxMissingRatio = 0.1, floor = 5, container = '' } = {},
) {
  const scope = isContained(container) ? container : '';
  // Only this container's apps are at stake, so only they count towards "how
  // much of the list did this read fail to find".
  const known = normalizeAppList(existing).filter(
    (a) => a.source === 'myapps' && (a.container ?? '') === scope,
  );
  if (known.length === 0) return false; // nothing to lose yet
  // Guarded before the map: this is the one rail whose whole job is to distrust
  // a bad read, so it must never be the thing that throws on one.
  const seen = new Set(
    normalizeAppList(
      (Array.isArray(scraped) ? scraped : []).map((a) => ({ ...a, container: scope })),
    ).map((a) => a.id),
  );
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
