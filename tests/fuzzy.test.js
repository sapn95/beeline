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
