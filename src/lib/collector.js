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
 *   bottom, 0 when nothing could scroll further), or `null`/non-number on failure.
 * @param {(ms:number)=>Promise<void>} [io.sleep]
 * @param {number} [io.maxRounds]
 * @param {number} [io.stableLimit]
 *   Consecutive at-the-bottom rounds with nothing new before we call it complete.
 * @param {number} [io.stepDelay] - ms to wait after each scroll for a re-render.
 * @param {number} [io.noGrowthCap]
 *   Stop after this many consecutive rounds with no new tiles even if the bottom
 *   was never detected — a safety valve so a flaky bottom-signal can't spin to
 *   the deadline. Such a stop reports `complete:false` (merge-only, never removes).
 * @param {number|null} [io.deadline] - `Date.now()` cutoff; `null` = no deadline.
 * @param {number} [io.signInGraceMs]
 *   How long to keep waiting BEFORE the first tile is seen, without spending the
 *   deadline or a round. This is the sign-in wait: the portal has bounced us to
 *   Microsoft and nothing can be read until a human types a password. Counting
 *   that against the reading budget made every import from a not-yet-signed-in
 *   container fail and need starting again.
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
  stepDelay = 400,
  noGrowthCap = 12,
  deadline = null,
  signInGraceMs = 0,
}) {
  const seen = new Map();
  let stable = 0;
  let noGrowth = 0;
  let rounds = 0;
  let reachedBottom = false;
  // A round that reports "not ready" is almost always the sign-in page: the
  // portal bounced us to Microsoft and there is nothing to read until a HUMAN
  // types a password. That wait used to be spent out of the READING budget, so
  // an import started before signing in — the normal case in a fresh container
  // — burnt its two minutes on the login screen and then failed with "no apps
  // found", and the user had to start it again. Waiting is not failing: the
  // deadline is held off until the first tiles actually appear, for up to
  // `signInGraceMs`, and the round is not counted either.
  const graceUntil = signInGraceMs > 0 ? Date.now() + signInGraceMs : 0;
  let sawTiles = false;

  for (; rounds < maxRounds && stable < stableLimit; rounds++) {
    const waitingToSignIn = !sawTiles && Date.now() < graceUntil;
    if (deadline !== null && !waitingToSignIn && Date.now() > deadline) break;

    const found = await scrapeRound(seen.size);
    if (found === null) {
      await sleep(1200); // not ready yet — wait and retry without counting it
      rounds--; // …and without spending a round, or the grace runs out in 150
      continue;
    }
    if (found.length > 0) sawTiles = true;

    const grew = addNew(seen, found);
    const remaining = await scrollRound();
    await sleep(stepDelay);

    noGrowth = grew ? 0 : noGrowth + 1;
    if (typeof remaining === 'number') {
      reachedBottom = remaining <= 4;
      // Converge only at the bottom AND with nothing new; growth or remaining
      // scroll room resets the counter so we never stop early mid-grid.
      stable = !grew && reachedBottom ? stable + 1 : 0;
    } else if (grew) {
      stable = 0; // a transient scroll failure that still revealed new tiles
    }

    // Safety valve: nothing new for a long stretch (even without a detected
    // bottom) → stop. Reports complete:false, so this can only ever add apps.
    if (noGrowth >= noGrowthCap) break;
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
