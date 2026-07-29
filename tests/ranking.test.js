import { describe, it, expect } from 'vitest';
import { rankApps, scoreApp, hostOf } from '../src/lib/ranking.js';
import { normalizeAppList } from '../src/lib/apps.js';

const apps = normalizeAppList([
  { name: 'Azure Portal', url: 'https://portal.azure.com' },
  { name: 'Salesforce', url: 'https://salesforce.com' },
  { name: 'GitHub', url: 'https://github.com' },
]);

const byId = (name) => apps.find((a) => a.name === name).id;

describe('hostOf', () => {
  it('returns the host', () => expect(hostOf('https://a.com/x')).toBe('a.com'));
  it('returns empty for junk', () => expect(hostOf('nope')).toBe(''));
});

describe('rankApps', () => {
  it('returns all apps alphabetically for an empty query with no stats', () => {
    const r = rankApps(apps, '', 0, {});
    expect(r.map((x) => x.app.name)).toEqual(['Azure Portal', 'GitHub', 'Salesforce']);
  });

  it('filters by fuzzy name match', () => {
    const r = rankApps(apps, 'git', 0, {});
    expect(r.map((x) => x.app.name)).toEqual(['GitHub']);
    expect(r[0].field).toBe('name');
  });

  it('falls back to a host match when the name does not match', () => {
    const r = rankApps(apps, 'com', 0, {});
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.field === 'url')).toBe(true);
  });

  it('floats frequently launched apps to the top', () => {
    const stats = { [byId('GitHub')]: { count: 10, lastLaunched: 0 } };
    expect(rankApps(apps, '', 0, stats)[0].app.name).toBe('GitHub');
  });

  it('floats recently launched apps to the top', () => {
    const now = 24 * 60 * 60 * 1000 * 100;
    const stats = { [byId('Salesforce')]: { count: 0, lastLaunched: now } };
    expect(rankApps(apps, '', now, stats)[0].app.name).toBe('Salesforce');
  });
});

describe('scoreApp', () => {
  it('returns null when neither name nor host match', () => {
    expect(scoreApp(apps[0], 'zzzzz', 0, {})).toBeNull();
  });

  it('ranks a bookmark below an app of identical relevance', () => {
    const app = { id: 'x', name: 'Grafana', url: 'https://g.example.com/' };
    const bookmark = { ...app, id: 'bm:x', source: 'bookmark' };
    expect(scoreApp(bookmark, 'graf', 0, {}).score).toBeLessThan(
      scoreApp(app, 'graf', 0, {}).score,
    );
    // …but a handful of launches (6 × 1.5 > the 8-point handicap) climbs back
    // past an app you never open.
    const stats = { 'bm:x': { count: 6, lastLaunched: 0 } };
    expect(scoreApp(bookmark, 'graf', 0, stats).score).toBeGreaterThan(
      scoreApp(app, 'graf', 0, {}).score,
    );
  });
});
