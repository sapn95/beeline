import { describe, it, expect } from 'vitest';
import {
  isValidHttpsUrl,
  canonicalUrl,
  appId,
  normalizeApp,
  normalizeAppList,
  mergeApps,
  reconcileApps,
  applySyncRead,
  isSuspectRead,
  legacyAppId,
  migrateStats,
  withAwsRegion,
} from '../src/lib/apps.js';

describe('isValidHttpsUrl', () => {
  it('accepts https', () => expect(isValidHttpsUrl('https://a.com')).toBe(true));
  it('rejects http', () => expect(isValidHttpsUrl('http://a.com')).toBe(false));
  it('rejects junk', () => expect(isValidHttpsUrl('not a url')).toBe(false));
});

describe('canonicalUrl', () => {
  it('drops the fragment and normalises bare hosts', () => {
    expect(canonicalUrl('https://a.com')).toBe('https://a.com/');
    expect(canonicalUrl('https://a.com/x#frag')).toBe('https://a.com/x');
  });
});

describe('appId', () => {
  it('is stable across fragment differences', () => {
    expect(appId('https://a.com/x')).toBe(appId('https://a.com/x#frag'));
  });
  it('differs for different urls', () => {
    expect(appId('https://a.com')).not.toBe(appId('https://b.com'));
  });
});

describe('normalizeApp', () => {
  it('collapses whitespace and derives an id that ignores the fragment', () => {
    const app = normalizeApp({ name: '  Sales   Force ', url: 'https://a.com/x#y' });
    expect(app.name).toBe('Sales Force');
    // The fragment is KEPT: hash-routed apps (Azure Portal blades, Power BI
    // pages) live entirely in it, so dropping it would open the wrong page.
    expect(app.url).toBe('https://a.com/x#y');
    expect(app.id).toBe(appId('https://a.com/x')); // ...but identity ignores it
  });

  it('treats two deep links into the same app as one entry', () => {
    const list = [
      { name: 'Portal blade A', url: 'https://portal.example.com/#/a' },
      { name: 'Portal blade B', url: 'https://portal.example.com/#/b' },
    ];
    expect(normalizeApp(list[0]).url).toBe('https://portal.example.com/#/a');
    expect(normalizeApp(list[0]).id).toBe(normalizeApp(list[1]).id);
  });

  it('heals stray spaces around joining hyphens but keeps real separators', () => {
    expect(normalizeApp({ name: 'S-SBB -SAP-DEV2-NWGW', url: 'https://a.com' }).name).toBe(
      'S-SBB-SAP-DEV2-NWGW',
    );
    expect(normalizeApp({ name: 'S4- SAML2', url: 'https://a.com' }).name).toBe('S4-SAML2');
    // A spaced " - " separator (both sides) is intentional — leave it.
    expect(normalizeApp({ name: 'Power BI - Dev', url: 'https://a.com' }).name).toBe(
      'Power BI - Dev',
    );
  });

  it('keeps an https icon but drops an http icon', () => {
    expect(
      normalizeApp({ name: 'A', url: 'https://a.com', iconUrl: 'https://i/a.png' }).iconUrl,
    ).toBe('https://i/a.png');
    expect(
      normalizeApp({ name: 'A', url: 'https://a.com', iconUrl: 'http://i/a.png' }).iconUrl,
    ).toBeUndefined();
  });

  it('rejects a missing name, non-https url, or non-object', () => {
    expect(normalizeApp({ name: '', url: 'https://a.com' })).toBeNull();
    expect(normalizeApp({ name: 'A', url: 'http://a.com' })).toBeNull();
    expect(normalizeApp(null)).toBeNull();
  });
});

describe('normalizeAppList / mergeApps', () => {
  it('dedupes by id', () => {
    const list = normalizeAppList([
      { name: 'A', url: 'https://a.com' },
      { name: 'A again', url: 'https://a.com' },
    ]);
    expect(list).toHaveLength(1);
  });

  it('returns [] for non-arrays', () => {
    expect(normalizeAppList(null)).toEqual([]);
  });

  it('keeps existing entries on conflict and adds new ones', () => {
    const existing = normalizeAppList([{ name: 'Keep', url: 'https://a.com' }]);
    const merged = mergeApps(existing, [
      { name: 'Changed', url: 'https://a.com' },
      { name: 'New', url: 'https://b.com' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((x) => x.url === 'https://a.com/').name).toBe('Keep');
    expect(merged.find((x) => x.url === 'https://b.com/').name).toBe('New');
  });
});

describe('normalizeApp source', () => {
  it('preserves manual / myapps source', () => {
    expect(normalizeApp({ name: 'A', url: 'https://a.com', source: 'manual' }).source).toBe(
      'manual',
    );
    expect(normalizeApp({ name: 'A', url: 'https://a.com', source: 'myapps' }).source).toBe(
      'myapps',
    );
  });

  it('ignores unknown or missing source', () => {
    expect(
      normalizeApp({ name: 'A', url: 'https://a.com', source: 'weird' }).source,
    ).toBeUndefined();
    expect(normalizeApp({ name: 'A', url: 'https://a.com' }).source).toBeUndefined();
  });
});

describe('reconcileApps', () => {
  it('adds new, drops removed myapps entries, and keeps manual ones', () => {
    const existing = normalizeAppList([
      { name: 'Manual', url: 'https://manual.com', source: 'manual' },
      { name: 'OldImport', url: 'https://old.com', source: 'myapps' },
    ]);
    const result = reconcileApps(existing, [{ name: 'Fresh', url: 'https://new.com' }]);

    expect(result.map((a) => a.url).sort((x, y) => x.localeCompare(y))).toEqual([
      'https://manual.com/',
      'https://new.com/',
    ]);
    expect(result.find((a) => a.url === 'https://manual.com/').source).toBe('manual');
    expect(result.find((a) => a.url === 'https://new.com/').source).toBe('myapps');
    expect(result.find((a) => a.url === 'https://old.com/')).toBeUndefined();
  });

  it('keeps a manual app that shares a url with a scraped one', () => {
    const existing = normalizeAppList([{ name: 'Mine', url: 'https://x.com', source: 'manual' }]);
    const result = reconcileApps(existing, [{ name: 'Scraped', url: 'https://x.com' }]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Mine');
    expect(result[0].source).toBe('manual');
  });

  it('re-tags a legacy untagged app still in My Apps, preserving its local fields', () => {
    const existing = normalizeAppList([
      { name: 'Legacy edit', url: 'https://legacy.com', iconUrl: 'https://i/edit.png' }, // no source
    ]);
    const result = reconcileApps(existing, [
      { name: 'Scraped', url: 'https://legacy.com', iconUrl: 'https://i/scraped.png' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('myapps'); // now prunable on future syncs
    expect(result[0].name).toBe('Legacy edit'); // local name kept, not overwritten
    expect(result[0].iconUrl).toBe('https://i/edit.png'); // local icon kept
  });

  it('keeps a legacy untagged app that is no longer in My Apps', () => {
    const existing = normalizeAppList([{ name: 'Legacy', url: 'https://legacy.com' }]); // no source
    const result = reconcileApps(existing, [{ name: 'Other', url: 'https://other.com' }]);
    expect(result.find((a) => a.url === 'https://legacy.com/')).toBeDefined();
  });
});

describe('mergeApps legacy healing', () => {
  it('promotes an untagged existing record when a tagged import covers it', () => {
    const existing = normalizeAppList([{ name: 'Legacy', url: 'https://legacy.com' }]); // untagged
    const result = mergeApps(existing, [
      { name: 'Legacy', url: 'https://legacy.com', source: 'myapps' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('myapps');
    expect(result[0].name).toBe('Legacy'); // existing (possibly edited) fields preserved
  });

  it('never downgrades an explicit manual record', () => {
    const existing = normalizeAppList([{ name: 'Mine', url: 'https://x.com', source: 'manual' }]);
    const result = mergeApps(existing, [
      { name: 'Scraped', url: 'https://x.com', source: 'myapps' },
    ]);
    expect(result[0].source).toBe('manual');
    expect(result[0].name).toBe('Mine');
  });
});

describe('withAwsRegion', () => {
  const launcher = 'https://launcher.myapps.microsoft.com/api/signin/x?tenantId=t';

  it('adds a RelayState region deep-link for aws-named launcher apps', () => {
    const out = withAwsRegion(launcher, 'SBB AWS int-nonprod', 'eu-central-1');
    expect(new URL(out).searchParams.get('RelayState')).toBe(
      'https://console.aws.amazon.com/console/home?region=eu-central-1',
    );
  });

  it('sets the region query param directly on a console URL', () => {
    const out = withAwsRegion('https://console.aws.amazon.com/console/home', 'AWS', 'eu-west-1');
    expect(new URL(out).searchParams.get('region')).toBe('eu-west-1');
  });

  it('leaves non-aws apps and empty regions untouched', () => {
    expect(withAwsRegion('https://x.com/', 'GitHub', 'eu-central-1')).toBe('https://x.com/');
    expect(withAwsRegion('https://x.com/', 'AWS', '')).toBe('https://x.com/');
  });

  it('does not overwrite an existing RelayState', () => {
    const url = `${launcher}&RelayState=https%3A%2F%2Fexisting`;
    expect(withAwsRegion(url, 'AWS', 'eu-central-1')).toBe(url);
  });

  it('leaves a non-SSO target alone when the RelayState rewrite is off', () => {
    // What a bookmark gets: a stray RelayState on someone else's URL is noise.
    expect(
      withAwsRegion('https://docs.aws.example/', 'AWS docs', 'eu-central-1', {
        samlRelayState: false,
      }),
    ).toBe('https://docs.aws.example/');
    // …but the console's own ?region= still applies.
    const out = withAwsRegion('https://console.aws.amazon.com/home', 'AWS', 'eu-central-2', {
      samlRelayState: false,
    });
    expect(new URL(out).searchParams.get('region')).toBe('eu-central-2');
  });
});

describe('applySyncRead', () => {
  const scraped = (n) => ({ name: `App ${n}`, url: `https://app${n}.example.com/` });
  const stored = (n, extra = {}) => ({ ...scraped(n), source: 'myapps', ...extra });

  it('adds what is new and leaves what is still there alone', () => {
    const { apps, removed } = applySyncRead([stored(1)], [scraped(1), scraped(2)]);
    expect(apps.map((a) => a.name)).toEqual(['App 1', 'App 2']);
    expect(apps.every((a) => a.missing === undefined)).toBe(true);
    expect(removed).toEqual([]);
  });

  it('marks a missing app on the first read and removes it on the second', () => {
    const first = applySyncRead([stored(1), stored(2)], [scraped(1)]);
    expect(first.apps.find((a) => a.name === 'App 2')).toMatchObject({ missing: 1 });
    expect(first.removed).toEqual([]);

    const second = applySyncRead(first.apps, [scraped(1)]);
    expect(second.apps.map((a) => a.name)).toEqual(['App 1']);
    expect(second.removed.map((a) => a.name)).toEqual(['App 2']);
  });

  it('clears the count as soon as the app is seen again', () => {
    // Otherwise two unlucky reads weeks apart would add up and delete an app
    // that was present every time in between.
    const marked = [stored(1), stored(2, { missing: 1 })];
    const { apps } = applySyncRead(marked, [scraped(1), scraped(2)]);
    expect(apps.find((a) => a.name === 'App 2').missing).toBeUndefined();
  });

  it('never touches a manual app, however often it is missing', () => {
    const manual = { name: 'Hand-made', url: 'https://manual.example.com/', source: 'manual' };
    let apps = [manual, stored(1)];
    for (let i = 0; i < 5; i++) apps = applySyncRead(apps, [scraped(1)]).apps;
    expect(apps.map((a) => a.name)).toEqual(['Hand-made', 'App 1']);
  });

  it('honours a stricter strike count', () => {
    const { removed } = applySyncRead([stored(1)], [], { strikes: 1 });
    expect(removed.map((a) => a.name)).toEqual(['App 1']);
  });

  it('clamps a threshold no stored counter could ever reach', () => {
    // normalizeApp caps `missing` at 9, so asking for 11 would mean the app is
    // never removed at all — a silent no-op instead of a loud mistake.
    let apps = [stored(1)];
    for (let i = 0; i < 12; i++) apps = applySyncRead(apps, [], { strikes: 11 }).apps;
    expect(apps).toEqual([]);
  });
});

describe('isSuspectRead', () => {
  const known = (n) =>
    Array.from({ length: n }, (_, i) => ({
      name: `App ${i}`,
      url: `https://app${i}.example.com/`,
      source: 'myapps',
    }));

  it('accepts a read that found everything', () => {
    expect(isSuspectRead(known(50), known(50))).toBe(false);
  });

  it('accepts everyday churn — a handful of apps really did go', () => {
    expect(isSuspectRead(known(50), known(50).slice(0, 46))).toBe(false);
  });

  it('rejects a read that lost a large slice of the list', () => {
    expect(isSuspectRead(known(50), known(50).slice(0, 20))).toBe(true);
  });

  it('lets a short list lose apps without tripping the percentage', () => {
    // 1 of 4 gone is 25%, but it is also just one app — a floor keeps a small
    // list from being frozen by a ratio.
    expect(isSuspectRead(known(4), known(4).slice(0, 3))).toBe(false);
  });

  it('has nothing to protect before the first sync', () => {
    expect(isSuspectRead([], [])).toBe(false);
    expect(
      isSuspectRead([{ name: 'M', url: 'https://m.example.com/', source: 'manual' }], []),
    ).toBe(false);
  });
});

describe('the strike counter as stored data', () => {
  it('survives a round trip through normalizeApp, capped', () => {
    const raw = { name: 'A', url: 'https://a.example.com/', source: 'myapps', missing: 2 };
    expect(normalizeApp(raw).missing).toBe(2);
    expect(normalizeApp({ ...raw, missing: 99 }).missing).toBe(9);
  });

  it('ignores a value that is not a count', () => {
    const raw = { name: 'A', url: 'https://a.example.com/', source: 'myapps' };
    for (const missing of [0, -1, 1.5, 'lots', null, undefined]) {
      expect(normalizeApp({ ...raw, missing }).missing).toBeUndefined();
    }
  });

  it('is wiped by a manual import, which settles the whole list', () => {
    const marked = [{ name: 'A', url: 'https://a.example.com/', source: 'myapps', missing: 1 }];
    const out = reconcileApps(marked, [{ name: 'A', url: 'https://a.example.com/' }]);
    expect(out[0].missing).toBeUndefined();
  });
});

describe('one app, two tiles', () => {
  // Straight from a real portal: Planner listed twice, identical but for the
  // locale the link was generated in. Before this, that was two apps forever.
  const enGB = 'https://planner.cloud.microsoft/?auth_pvr=OrgId&auth_upn=me@example.com&mkt=en-GB';
  const enUS = 'https://planner.cloud.microsoft/?auth_pvr=OrgId&auth_upn=me@example.com&mkt=en-US';

  it('gives both the same id', () => {
    expect(appId(enGB)).toBe(appId(enUS));
  });

  it('collapses them into one row', () => {
    const out = normalizeAppList([
      { name: 'Planner', url: enGB },
      { name: 'Planner', url: enUS },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe(enGB); // the first one seen keeps its launch URL
  });

  it('ignores the account, the entry point and the tracking tail', () => {
    const bare = 'https://sbb-my.example.com/personal/me/x.aspx';
    expect(appId(`${bare}?login_hint=me@example.com&source=waffle`)).toBe(appId(bare));
    expect(appId(`${bare}?utm_source=office&utm_medium=app_launcher`)).toBe(appId(bare));
    expect(appId(`${bare}?referrer=OfficeHome&referrerScenario=AppLauncher`)).toBe(appId(bare));
    expect(appId(`${bare}?UPN=me@example.com&realm=example.ch`)).toBe(appId(bare));
  });

  it('does not care what order the parameters came in', () => {
    expect(appId('https://x.example.com/?a=1&b=2')).toBe(appId('https://x.example.com/?b=2&a=1'));
  });

  it('still tells genuinely different apps apart', () => {
    // The query IS the app on plenty of hosts — this is why noise is an
    // allowlist and not "strip everything after the ?".
    expect(appId('https://x.example.com/?app=alpha')).not.toBe(
      appId('https://x.example.com/?app=beta'),
    );
    expect(appId('https://x.example.com/a')).not.toBe(appId('https://x.example.com/b'));
    // A single-letter parameter is too generic to strip on a hunch.
    expect(appId('https://x.example.com/?s=shell')).not.toBe(appId('https://x.example.com/'));
  });

  it('keeps the fragment out of identity but leaves the stored URL whole', () => {
    const withHash = 'https://portal.example.com/?mkt=en-GB#/blade/one';
    expect(appId(withHash)).toBe(appId('https://portal.example.com/#/blade/two'));
    expect(normalizeApp({ name: 'P', url: withHash }).url).toContain('#/blade/one');
  });
});

describe('migrateStats', () => {
  const enGB = 'https://planner.cloud.microsoft/?mkt=en-GB';
  const enUS = 'https://planner.cloud.microsoft/?mkt=en-US';
  const app = (url) => ({ name: 'Planner', url, source: 'myapps' });

  it('carries a launch history onto the new id', () => {
    // Without this, changing what identity means would silently reset a ranking
    // built up over months to plain alphabetical order.
    const stats = { [legacyAppId(enGB)]: { count: 7, lastLaunched: 1000 } };
    const out = migrateStats([app(enGB)], stats);
    expect(out[appId(enGB)]).toEqual({ count: 7, lastLaunched: 1000 });
    expect(out[legacyAppId(enGB)]).toBeUndefined();
  });

  it('adds up the two records that are now one app', () => {
    const stats = {
      [legacyAppId(enGB)]: { count: 4, lastLaunched: 1000 },
      [legacyAppId(enUS)]: { count: 3, lastLaunched: 5000 },
    };
    const out = migrateStats([app(enGB), app(enUS)], stats);
    expect(out[appId(enGB)]).toEqual({ count: 7, lastLaunched: 5000 });
  });

  it('reports nothing to do rather than rewriting storage for free', () => {
    const clean = 'https://plain.example.com/';
    expect(migrateStats([app(clean)], { [appId(clean)]: { count: 1 } })).toBeNull();
    expect(migrateStats([app(clean)], {})).toBeNull();
    expect(migrateStats([app(clean)], null)).toBeNull();
  });
});

describe('containers', () => {
  const WORK = 'firefox-container-2';
  const HOME = 'firefox-container-3';
  const tile = (n) => ({ name: `App ${n}`, url: `https://app${n}.example.com/` });
  const inC = (n, container) => ({ ...tile(n), source: 'myapps', container });

  it('makes the same tile in two containers two apps', () => {
    // They sign in as different identities and land somewhere else. Collapsing
    // them would make one of the two accounts disappear from the launcher.
    expect(appId(tile(1).url, WORK)).not.toBe(appId(tile(1).url, HOME));
    const both = normalizeAppList([inC(1, WORK), inC(1, HOME)]);
    expect(both).toHaveLength(2);
  });

  it('leaves an app with no container hashed exactly as before', () => {
    // Everything anyone already has must keep the id it has today, or every
    // launch statistic is orphaned by an update that changed nothing for them.
    const url = tile(1).url;
    expect(appId(url)).toBe(appId(url, ''));
    expect(appId(url)).toBe(appId(url, 'firefox-default'));
    expect(normalizeApp(tile(1)).container).toBeUndefined();
  });

  it('never pins an app to a private window', () => {
    // That store is gone when the window closes, so the app would be orphaned.
    expect(normalizeApp({ ...tile(1), container: 'firefox-private' }).container).toBeUndefined();
  });

  it('reconciles ONLY the container that was read', () => {
    // The one way this can destroy something: importing the work container must
    // not look like every personal-container app has vanished.
    const existing = [inC(1, WORK), inC(2, WORK), inC(3, HOME), { ...tile(4), source: 'myapps' }];
    const out = reconcileApps(existing, [tile(1)], { container: WORK });
    const names = out.map((a) => a.name).sort();
    expect(names).toEqual(['App 1', 'App 3', 'App 4']); // only App 2 (work) went
    expect(out.find((a) => a.name === 'App 3').container).toBe(HOME);
  });

  it('strikes ONLY the container that was read', () => {
    const existing = [inC(1, WORK), inC(2, WORK), inC(3, HOME)];
    const { apps } = applySyncRead(existing, [tile(1)], { container: WORK });
    expect(apps.find((a) => a.name === 'App 2').missing).toBe(1);
    expect(apps.find((a) => a.name === 'App 3').missing).toBeUndefined();
  });

  it('judges a read suspect against its own container only', () => {
    // 20 apps in HOME and 2 in WORK: reading WORK and finding both is a
    // complete read, not a read that lost 20 apps.
    const home = Array.from({ length: 20 }, (_, i) => inC(`h${i}`, HOME));
    const existing = [...home, inC(1, WORK), inC(2, WORK)];
    expect(isSuspectRead(existing, [tile(1), tile(2)], { container: WORK })).toBe(false);
  });

  it('tags a scrape with the container it was read from', () => {
    const out = reconcileApps([], [tile(1)], { container: WORK });
    expect(out[0].container).toBe(WORK);
    expect(out[0].id).toBe(appId(tile(1).url, WORK));
  });
});
