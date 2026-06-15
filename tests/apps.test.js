import { describe, it, expect } from 'vitest';
import {
  isValidHttpsUrl,
  canonicalUrl,
  appId,
  normalizeApp,
  normalizeAppList,
  mergeApps,
  reconcileApps,
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
  it('collapses whitespace, drops the fragment, derives an id', () => {
    const app = normalizeApp({ name: '  Sales   Force ', url: 'https://a.com/x#y' });
    expect(app.name).toBe('Sales Force');
    expect(app.url).toBe('https://a.com/x');
    expect(app.id).toBe(appId('https://a.com/x'));
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
});
