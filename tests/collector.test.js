import { describe, it, expect, vi } from 'vitest';
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

  it('stops via the no-growth cap (incomplete) if the bottom is never detected', async () => {
    // Scrolling always claims there is more to go (never <= 4) and no new tiles
    // ever appear after the first round: must bail at noGrowthCap, not spin.
    const all = Array.from({ length: 3 }, (_, i) => ({ name: `a${i}`, url: `https://a${i}` }));
    let rounds = 0;
    const res = await accumulateApps({
      scrapeRound: () => Promise.resolve(all),
      scrollRound: () => {
        rounds += 1;
        return Promise.resolve(999); // forever "lots left", never the bottom
      },
      sleep: NOOP,
      stableLimit: 5,
      noGrowthCap: 4,
      maxRounds: 100,
    });
    expect(res.apps).toHaveLength(3);
    expect(res.complete).toBe(false); // never confirmed the bottom → merge-only
    expect(rounds).toBeLessThan(10); // stopped at the cap, nowhere near maxRounds (100)
  });

  it('never calls a grid complete while it still has room to scroll', async () => {
    // The single line between a partial read and reconcileApps pruning the list:
    // "at the bottom" must mean <= 4px left, not "the scroll returned a number".
    // noGrowthCap is set well above stableLimit so the cap cannot mask it.
    const all = [{ name: 'a', url: 'https://a.example' }];
    const res = await accumulateApps({
      scrapeRound: () => Promise.resolve(all),
      scrollRound: () => Promise.resolve(900), // always more to go
      sleep: NOOP,
      stableLimit: 3,
      noGrowthCap: 25,
      maxRounds: 60,
    });
    expect(res.reachedBottom).toBe(false);
    expect(res.complete).toBe(false); // merge-only: nothing may be pruned
  });

  it('needs several stable at-the-bottom rounds before declaring completeness', async () => {
    let rounds = 0;
    const res = await accumulateApps({
      scrapeRound: () => {
        rounds += 1;
        return Promise.resolve([{ name: 'a', url: 'https://a.example' }]);
      },
      scrollRound: () => Promise.resolve(0), // at the bottom from round one
      sleep: NOOP,
      // No stableLimit here on purpose: this pins the DEFAULT, which is what the
      // options page relies on when it does not pass one.
    });
    expect(res.complete).toBe(true);
    expect(rounds).toBeGreaterThanOrEqual(5); // one lucky round is not enough
  });

  it('does not treat "a little left to scroll" as the bottom', async () => {
    // 100px still to go is NOT the bottom; only <= 4 is. Widening that threshold
    // would let a partial read count as complete and prune the list.
    const res = await accumulateApps({
      scrapeRound: () => Promise.resolve([{ name: 'a', url: 'https://a.example' }]),
      scrollRound: () => Promise.resolve(100),
      sleep: NOOP,
      stableLimit: 3,
      noGrowthCap: 25,
      maxRounds: 60,
    });
    expect(res.reachedBottom).toBe(false);
    expect(res.complete).toBe(false);
  });

  it('does not call a round-capped run complete just because it ended at the bottom', async () => {
    // Tiles keep appearing, so `stable` never accrues, but every scroll reports
    // the bottom. Ending on maxRounds must still be an incomplete (merge-only)
    // read — completeness comes from convergence, not from the last data point.
    let n = 0;
    const res = await accumulateApps({
      scrapeRound: () => Promise.resolve([{ name: `a${n}`, url: `https://a${n++}.example` }]),
      scrollRound: () => Promise.resolve(0), // "at the bottom" every time
      sleep: NOOP,
      maxRounds: 6,
      stableLimit: 5,
    });
    expect(res.reachedBottom).toBe(true);
    expect(res.complete).toBe(false);
  });

  it('gives up at the deadline and reports an incomplete read', async () => {
    let scraped = 0;
    const res = await accumulateApps({
      scrapeRound: () => {
        scraped += 1;
        return Promise.resolve([{ name: 'a', url: 'https://a.example' }]);
      },
      scrollRound: () => Promise.resolve(900),
      sleep: NOOP,
      deadline: Date.now() - 1, // already past
    });
    expect(scraped).toBe(0);
    expect(res.complete).toBe(false);
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

describe('waiting for a sign-in is not failing', () => {
  it('holds off the deadline until the first tiles appear', async () => {
    // The portal bounces a not-yet-signed-in container to Microsoft, and there
    // is nothing to read until a human types a password. Spending the READING
    // budget on that made the import fail and need starting again.
    let now = 0;
    const clock = () => now;
    const spy = vi.spyOn(Date, 'now').mockImplementation(clock);
    try {
      let round = 0;
      const out = await accumulateApps({
        // Not ready for the first ten rounds — i.e. the login screen.
        scrapeRound: async () => {
          round += 1;
          return round <= 10 ? null : [{ url: `https://app${round}.example.com/` }];
        },
        scrollRound: async () => 0,
        sleep: async (ms) => {
          now += ms;
        },
        deadline: 5000, // long gone by the time sign-in finishes
        signInGraceMs: 600000,
      });
      expect(out.apps.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('still gives up when the grace itself runs out', async () => {
    let now = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const out = await accumulateApps({
        scrapeRound: async () => null, // never signs in
        scrollRound: async () => 0,
        sleep: async (ms) => {
          now += ms;
        },
        deadline: 1000,
        signInGraceMs: 5000,
      });
      expect(out.apps).toEqual([]);
      expect(out.complete).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves the unattended background read with no grace at all', async () => {
    let now = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const out = await accumulateApps({
        scrapeRound: async () => null,
        scrollRound: async () => 0,
        sleep: async (ms) => {
          now += ms;
        },
        deadline: 1000,
      });
      expect(out.rounds).toBe(0); // gave up on the first check
    } finally {
      spy.mockRestore();
    }
  });
});
