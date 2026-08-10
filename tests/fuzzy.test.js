import { describe, it, expect } from 'vitest';
import { fuzzyMatch } from '../src/lib/fuzzy.js';

describe('fuzzyMatch', () => {
  it('matches an empty query against anything with a neutral score', () => {
    const r = fuzzyMatch('', 'Anything');
    expect(r.matched).toBe(true);
    expect(r.score).toBe(0);
    expect(r.positions).toEqual([]);
  });

  it('matches a subsequence case-insensitively and reports positions', () => {
    const r = fuzzyMatch('sf', 'Salesforce');
    expect(r.matched).toBe(true);
    expect(r.positions).toEqual([0, 5]);
  });

  it('does not match missing characters or wrong order', () => {
    expect(fuzzyMatch('xyz', 'Salesforce').matched).toBe(false);
    expect(fuzzyMatch('fs', 'Salesforce').matched).toBe(false);
  });

  it('prefers a contiguous prefix over a scattered match', () => {
    const prefix = fuzzyMatch('sal', 'Salesforce');
    const scattered = fuzzyMatch('sal', 'Social Analytics Lab');
    expect(prefix.matched && scattered.matched).toBe(true);
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });

  it('rewards matches at a word start over mid-word matches', () => {
    const wordStart = fuzzyMatch('p', 'Azure Portal');
    const midWord = fuzzyMatch('z', 'Azure Portal');
    expect(wordStart.score).toBeGreaterThan(midWord.score);
  });

  it('rewards camelCase humps', () => {
    const hump = fuzzyMatch('p', 'azurePortal');
    const plain = fuzzyMatch('z', 'azurePortal');
    expect(hump.score).toBeGreaterThan(plain.score);
  });
});

describe('a query with more than one word', () => {
  // Reported: `nova-test` found the app and `nova test` found nothing. Same
  // app, same letters, one key different. The query was one subsequence, so a
  // separator had to appear LITERALLY in the name — which also hid `nova_test`
  // and `NovaTest` from `nova-test`, and meant the words could never be swapped.
  const NAMES = ['NOVA-TEST', 'AWS NOVA-TEST Account', 'nova_test', 'nova.test', 'NovaTest'];
  const QUERIES = ['nova-test', 'nova test', 'test nova', 'novatest', 'NOVA TEST', 'nova/test'];

  for (const name of NAMES) {
    for (const query of QUERIES) {
      it(`finds ${name} by "${query}"`, () => {
        expect(fuzzyMatch(query, name).matched).toBe(true);
      });
    }
  }

  it('treats every separator as the same thing', () => {
    // The point of the fix: which key you happened to press between two words
    // must not decide whether the app exists.
    const found = new Set(QUERIES.map((q) => fuzzyMatch(q, 'NOVA-TEST').matched));
    expect([...found]).toEqual([true]);
  });

  it('still needs every word to be there', () => {
    // Splitting the query makes it more forgiving about separators, not about
    // what was typed. An extra word still narrows.
    expect(fuzzyMatch('nova test', 'NOVA-PROD').matched).toBe(false);
    expect(fuzzyMatch('nova prod test', 'NOVA-PROD').matched).toBe(false);
  });

  it('keeps the order of characters WITHIN a word significant', () => {
    // Only the words are order-free. `fs` must still miss Salesforce, or the
    // matcher stops narrowing anything at all.
    expect(fuzzyMatch('fs nova', 'Salesforce NOVA').matched).toBe(false);
    expect(fuzzyMatch('sf nova', 'Salesforce NOVA').matched).toBe(true);
  });

  it('ignores stray and trailing separators rather than failing on them', () => {
    // A trailing space is what a half-typed second word looks like. Turning
    // that into "no results" empties the list under the cursor mid-type.
    for (const query of ['nova ', ' nova', 'nova  test', ' nova - test ']) {
      expect(fuzzyMatch(query, 'NOVA-TEST').matched).toBe(true);
    }
  });

  it('matches everything for a query that is only separators', () => {
    const r = fuzzyMatch(' - ', 'Anything');
    expect(r).toEqual({ matched: true, score: 0, positions: [] });
  });

  it('reports every matched position once, in order, for the highlighter', () => {
    const r = fuzzyMatch('nova test', 'NOVA-TEST');
    expect(r.positions).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
  });

  it('does not report a position twice when two words overlap', () => {
    // `nova` and `ova` both land on the same characters. The highlighter takes
    // a Set, but a duplicated position is still a lie about what matched.
    const r = fuzzyMatch('nova ova', 'Nova');
    expect(r.positions).toEqual([...new Set(r.positions)].sort((a, b) => a - b));
  });

  it('does not let a word repeated by accident score twice', () => {
    // Two identical words are matched independently and would both land on the
    // same characters, doubling the score of one word and outranking a better
    // app on a typo.
    expect(fuzzyMatch('nova nova', 'Nova').score).toBe(fuzzyMatch('nova', 'Nova').score);
  });

  it('ranks the app that has both words above one that scatters them', () => {
    const exact = fuzzyMatch('nova test', 'NOVA-TEST');
    const scattered = fuzzyMatch('nova test', 'Nova Application Latest Settings');
    expect(exact.matched && scattered.matched).toBe(true);
    expect(exact.score).toBeGreaterThan(scattered.score);
  });

  it('hands back a miss nobody can corrupt for the next app', () => {
    // One shared object is returned to every app that misses on a keystroke.
    const first = fuzzyMatch('zzz', 'Salesforce');
    expect(() => first.positions.push(99)).toThrow();
    expect(fuzzyMatch('zzz', 'Anything').positions).toEqual([]);
  });
});
