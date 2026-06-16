import { describe, it, expect } from 'vitest';
import { accumulateApps } from '../src/lib/collector.js';

// Simulate the exact field failure: a *virtualised* grid that holds `total`
// tiles but only ever renders a `windowSize` slice in the DOM, sliding the slice
// down as you scroll. This is what made the live import stall at ~140.
function virtualGrid({ total, windowSize, stepFraction = 0.8 }) {
  const all = Array.from({ length: total }, (_, i) => ({
    name: `App ${i}`,
    url: `https://launcher.myapps.microsoft.com/api/signin/${i}`,
  }));
  const rowH = 10;
  const viewport = windowSize * rowH;
  const fullHeight = Math.max(total * rowH, viewport);
  let top = 0; // index of the first rendered tile
  return {
    scrapeRound: async () => all.slice(top, top + windowSize),
    scrollRound: async () => {
      const stepRows = Math.max(1, Math.floor(windowSize * stepFraction));
      top = Math.min(top + stepRows, Math.max(0, total - windowSize));
      return Math.max(0, fullHeight - (top * rowH + viewport)); // px left to bottom
    },
  };
}

const NOOP = () => Promise.resolve();

describe('accumulateApps', () => {
  it('gathers EVERY tile from a 300-item virtualised grid that renders ~140 at a time', async () => {
    const grid = virtualGrid({ total: 300, windowSize: 140 });
    const res = await accumulateApps({
      scrapeRound: grid.scrapeRound,
      scrollRound: grid.scrollRound,
      sleep: NOOP,
      stableLimit: 3,
    });
    expect(res.apps).toHaveLength(300);
    expect(new Set(res.apps.map((a) => a.url)).size).toBe(300); // no dupes
    expect(res.complete).toBe(true);
    expect(res.reachedBottom).toBe(true);
  });

  it('handles a grid that fits in one viewport', async () => {
    const grid = virtualGrid({ total: 5, windowSize: 140 });
    const res = await accumulateApps({
      scrapeRound: grid.scrapeRound,
      scrollRound: grid.scrollRound,
      sleep: NOOP,
      stableLimit: 3,
    });
    expect(res.apps).toHaveLength(5);
    expect(res.complete).toBe(true);
  });

  it('completes cleanly on an empty grid', async () => {
    const grid = virtualGrid({ total: 0, windowSize: 140 });
    const res = await accumulateApps({
      scrapeRound: grid.scrapeRound,
      scrollRound: grid.scrollRound,
      sleep: NOOP,
      stableLimit: 3,
    });
    expect(res.apps).toEqual([]);
    expect(res.complete).toBe(true);
  });

  it('retries while the page is not ready (null), then collects everything', async () => {
    const grid = virtualGrid({ total: 50, windowSize: 20 });
    let calls = 0;
    const res = await accumulateApps({
      scrapeRound: () => {
        calls += 1;
        return calls <= 3 ? Promise.resolve(null) : grid.scrapeRound(); // first 3 rounds: loading
      },
      scrollRound: grid.scrollRound,
      sleep: NOOP,
      stableLimit: 3,
    });
    expect(res.apps).toHaveLength(50);
    expect(res.complete).toBe(true);
  });

  it('stops at the deadline and reports incomplete (so nothing is ever removed)', async () => {
    const grid = virtualGrid({ total: 1000, windowSize: 140 });
    const res = await accumulateApps({
      scrapeRound: grid.scrapeRound,
      scrollRound: grid.scrollRound,
      sleep: NOOP,
      deadline: Date.now() - 1, // already past → bail before doing damage
    });
    expect(res.complete).toBe(false);
    expect(res.apps).toHaveLength(0);
  });

  it('respects maxRounds, returning a partial+incomplete result', async () => {
    const grid = virtualGrid({ total: 1000, windowSize: 50, stepFraction: 0.2 });
    const res = await accumulateApps({
      scrapeRound: grid.scrapeRound,
      scrollRound: grid.scrollRound,
      sleep: NOOP,
      maxRounds: 5,
      stableLimit: 3,
    });
    expect(res.rounds).toBe(5);
    expect(res.complete).toBe(false);
    expect(res.apps.length).toBeGreaterThan(0);
    expect(res.apps.length).toBeLessThan(1000);
  });

  it('stays incomplete when scrolling never reports the bottom, but still grabs what is visible', async () => {
    const grid = virtualGrid({ total: 30, windowSize: 30 });
    const res = await accumulateApps({
      scrapeRound: grid.scrapeRound,
      scrollRound: () => Promise.resolve(null), // scroll step failed every time
      sleep: NOOP,
      maxRounds: 8,
      stableLimit: 3,
    });
    expect(res.reachedBottom).toBe(false);
    expect(res.complete).toBe(false);
    expect(res.apps).toHaveLength(30);
  });

  it('ignores tiles with no url and works with the default sleep', async () => {
    let n = 0;
    const res = await accumulateApps({
      scrapeRound: () =>
        Promise.resolve(n++ === 0 ? [{ url: 'https://a.example' }, null, { name: 'no-url' }] : []),
      scrollRound: () => Promise.resolve(0),
      stableLimit: 2,
    });
    expect(res.apps).toHaveLength(1);
    expect(res.apps[0].url).toBe('https://a.example');
  });

  it('still converges when scrolling reports transient nulls at the bottom', async () => {
    // All tiles already visible; scrollRound alternates a real at-bottom (0) with
    // a transient failure (null). The null must NOT keep resetting stability, or
    // the loop would never reach complete.
    const all = Array.from({ length: 5 }, (_, i) => ({ name: `a${i}`, url: `https://a${i}` }));
    let i = 0;
    const res = await accumulateApps({
      scrapeRound: () => Promise.resolve(all),
      scrollRound: () => Promise.resolve(i++ % 2 === 0 ? 0 : null),
      sleep: NOOP,
      maxRounds: 40,
      stableLimit: 3,
    });
    expect(res.complete).toBe(true);
    expect(res.apps).toHaveLength(5);
  });

  it('feeds the running count back to the caller for progress UI', async () => {
    const grid = virtualGrid({ total: 60, windowSize: 20 });
    const progress = [];
    await accumulateApps({
      scrapeRound: (seenCount) => {
        progress.push(seenCount);
        return grid.scrapeRound();
      },
      scrollRound: grid.scrollRound,
      sleep: NOOP,
      stableLimit: 2,
    });
    expect(progress[0]).toBe(0); // first round starts from nothing
    expect(Math.max(...progress)).toBe(60); // later rounds see the full set
  });
});
