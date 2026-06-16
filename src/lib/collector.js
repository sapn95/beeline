// Pure orchestration for importing from a *virtualised* grid: repeatedly scrape
// the tiles currently in the DOM, scroll one step, and accumulate the UNION
// until the grid reaches the bottom with nothing new appearing.
//
// This is deliberately free of any browser / chrome.* API so it can be
// unit-tested against a simulated virtualised source (tests/collector.test.js).
// The "only ~140 tiles exist in the DOM at once" behaviour is exactly what broke
// in the field, so it is the part that carries the heaviest test coverage.

/**
 * @param {object} io
 * @param {(seenCount:number)=>Promise<Array|null>} io.scrapeRound
 *   Returns the tiles currently rendered, or `null` when the page is not ready
 *   yet (sign-in origin / still loading) — `null` is retried, never counted.
 * @param {()=>Promise<number|null>} io.scrollRound
 *   Scrolls one step; returns the pixels still left to the bottom (<= 4 ≈ at the
 *   bottom), or `null`/non-number when it could not scroll.
 * @param {(ms:number)=>Promise<void>} [io.sleep]
 * @param {number} [io.maxRounds]
 * @param {number} [io.stableLimit]
 *   Consecutive at-the-bottom rounds with nothing new before we call it complete.
 * @param {number|null} [io.deadline] - `Date.now()` cutoff; `null` = no deadline.
 * @returns {Promise<{apps:Array, rounds:number, complete:boolean, reachedBottom:boolean}>}
 *   `complete` is true only when we converged at the bottom — the caller may then
 *   safely remove apps that vanished. A timed-out / capped run returns
 *   `complete:false`, so a partial read can only ever ADD.
 */
export async function accumulateApps({
  scrapeRound,
  scrollRound,
  sleep = () => Promise.resolve(),
  maxRounds = 150,
  stableLimit = 5,
  deadline = null,
}) {
  const seen = new Map();
  let stable = 0;
  let rounds = 0;
  let reachedBottom = false;

  for (; rounds < maxRounds && stable < stableLimit; rounds++) {
    if (deadline !== null && Date.now() > deadline) break;

    const found = await scrapeRound(seen.size);
    if (found === null) {
      await sleep(1200); // not ready yet — wait and retry without counting it
      continue;
    }

    const grew = addNew(seen, found);
    const remaining = await scrollRound();
    await sleep(800);

    if (typeof remaining === 'number') {
      reachedBottom = remaining <= 4;
      // Converge only at the bottom AND with nothing new; growth or remaining
      // scroll room resets the counter so we never stop early mid-grid.
      stable = !grew && reachedBottom ? stable + 1 : 0;
    } else if (grew) {
      // Unknown remaining (transient scroll failure): keep accumulated stability
      // unless we just grew, which means there is clearly more still to read.
      stable = 0;
    }
  }

  return { apps: [...seen.values()], rounds, complete: stable >= stableLimit, reachedBottom };
}

// Add every url-bearing tile into the union map; returns true if anything new
// was added this round.
function addNew(seen, found) {
  const before = seen.size;
  for (const a of found) if (a?.url) seen.set(a.url, a);
  return seen.size > before;
}
