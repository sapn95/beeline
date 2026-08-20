// Uploads the two parts of an AMO listing that `web-ext sign` cannot: the
// listing icon and the screenshots.
//
// Neither comes out of the XPI. The icon has a multipart PATCH of its own, and
// with none uploaded a signed, reviewed add-on sits in the store behind
// Mozilla's grey placeholder. Screenshots have a separate collection endpoint
// again — which is why beeline's listing was public through six releases with
// no screenshots at all.
//
// Declarative rather than incremental: the desired set is whatever numbered
// PNGs are in docs/store/amo/, and every run replaces the previews that are
// there with that set. Replacing means posting and then deleting, because this
// API has no image replace at all — PATCH on a preview accepts a new image,
// answers 200, and keeps the old one.
//
// Post first, delete second, and never the other way round. Deleting first
// reads better and is the version that got written, but it puts a window in the
// middle of the run where the live listing has no screenshots at all, and every
// way the run can end in that window ends with the store page bare: a 503, a
// 429 that outlasts its retries, a cancelled job, a runner that dies. The other
// order fails into duplicates on a public page, which are ugly, visible, and
// repaired by running it again. That is the direction to be wrong in.
//
// Safe to run on every release, including the runs where it can do nothing:
// absent credentials, an add-on that does not exist yet, and an AMO in
// read-only mode all warn and exit 0 — but ONLY before the first request that
// changes something. After that there is no benign exit left, because a green
// run is the one thing that guarantees nobody looks.
//
// Pure Node — platform fetch, node:crypto for the JWT — so the publish path
// takes no dependency that could ship a new version between a tag and its
// release.

import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// docs/store/amo/, not docs/store/. One source tree builds both stores, so
// docs/store/ holds art for both — screenshot-1280x800.png is the Chrome Web
// Store's required size and has no business on a Mozilla listing. A glob over
// the shared directory cannot tell those apart; a directory can, and the next
// picture added lands in the store it was drawn for or in neither.
const STORE = join(ROOT, 'docs', 'store', 'amo');

// dist-firefox/, not dist/. scripts/build.mjs writes the Chrome build to dist/
// and the Firefox one to dist-firefox/, and only the Firefox manifest carries
// browser_specific_settings — reading dist/ here would take the icon from a
// build that is not the one AMO signed, and then throw on the guid lookup
// because the Chrome manifest has no gecko id to read. This is the line the
// next port of this script will get wrong.
const DIST = join(ROOT, 'dist-firefox');

const API = 'https://addons.mozilla.org/api/v5';

// The screenshots, in the order the listing shows them. The two-digit prefix is
// what makes a plain lexical sort the right one; `1-`, `2-`, `10-` would put the
// tenth in second place.
const NUMBERED = /^\d{2}-.+\.png$/;

// AMO's ceiling on a token's lifetime. A token thrown away after one request
// gains nothing from being shorter, and the full five minutes is slack against a
// runner whose clock disagrees with Mozilla's.
const JWT_TTL_S = 300;

// Preview create and delete are counted against the add-on SUBMISSION throttle —
// 3/minute, 10/hour, unsafe methods only — which the version upload from
// `web-ext sign` has already been spending minutes earlier in the same job. One
// unsafe request every 23 s stays under 3-per-60-s however that window happens
// to be aligned. A naive loop 429s on its fourth call. 21 s is the arithmetic
// minimum (3 × 21 = 63 > 60) and leaves three seconds for a sliding window to
// disagree with a runner's clock, which is not enough to be worth the two
// seconds it saves.
//
// Overridable only so the regression tests can run the whole sync in under a
// second. Left alone anywhere else it is the real spacing: this is read from the
// environment rather than passed in because the tests drive the script as a
// subprocess, which is the only way to assert on its exit code.
const UNSAFE_SPACING_MS = Number(process.env.AMO_ART_PACE_MS ?? 23_000);

// The hourly bucket of the same throttle. A run costs one icon PATCH plus a
// post and a delete per screenshot, so this is where it would stop finishing and
// start sitting in 429s.
const UNSAFE_PER_HOUR = 10;

// What `web-ext sign` has already spent from the same bucket, in the same job,
// minutes earlier: POST /addons/upload/ and PUT /addons/addon/{id}/. It makes a
// third call only with --upload-source-code, which the workflow does not pass.
// Leaving these out of the budget is how a run talks itself into starting.
const UNSAFE_SPENT_BY_SIGN = 2;

// A 429 from the minute bucket is worth sitting out. The hourly one answers with
// a Retry-After in the thousands of seconds, and sleeping through that converts
// a legible error into a job timeout with nothing in the log to explain it.
const MAX_RETRY_AFTER_S = 120;
const THROTTLE_ATTEMPTS = 3;

// A single request's patience. The slowest call here is a 300 KB image POST, so
// anything past this is a stall and not a slow upload. It matters because the
// release step budgets eight minutes for the whole sync: a request allowed to
// hang forever spends all of it on one call and then gets killed mid-sync, which
// is the one way this script can still leave a listing half finished.
const REQUEST_TIMEOUT_MS = 60_000;

const b64url = (value) => Buffer.from(value).toString('base64url');

/**
 * The HS256 half of a JWS, over the already-encoded `header.payload`.
 *
 * Exported because a wrong signature has exactly one symptom — 401 — and at that
 * point it is indistinguishable from a stale secret or a revoked key.
 * tests/amo-art.test.js pins it to the RFC 7515 A.1 vector, which is the only
 * thing that separates those two before a release day does.
 */
export function signHs256(signingInput, secret) {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

/** One token per request: addons-server remembers `jti` and refuses a replay. */
function mintJwt(issuer, secret) {
  const iat = Math.floor(Date.now() / 1000);
  // No `orig_iat`. It is a leftover from the v3 documentation, and addons-server
  // rejects the whole token for carrying it — which then reads as bad credentials.
  const claims = { iss: issuer, jti: randomUUID(), iat, exp: iat + JWT_TTL_S };
  const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify(claims),
  )}`;
  return `${signingInput}.${signHs256(signingInput, secret)}`;
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    // A proxy in front of AMO answers HTML when AMO itself is the thing that is
    // down. Keep the body for the error message and carry on.
    return null;
  }
}

/** Mozilla switching submissions off is not this repository's build failing. */
const unavailable = (res) => res.status === 503;

/**
 * One image, as a multipart part AMO will accept.
 *
 * The Blob wrapper is the whole trick, and it is the reason this is a function
 * rather than two inline appends. AMO validates the DECLARED part type and not
 * the bytes; a bare Buffer appended to a FormData goes out as
 * application/octet-stream, and a perfectly good PNG then comes back as "Images
 * must be either PNG or JPG."
 */
const imagePart = (file) => new Blob([readFileSync(file)], { type: 'image/png' });

function fail(what, res) {
  console.error(`::error::${what}: HTTP ${res.status}`);
  console.error(res.text);
  // Which state the listing is in matters more than the status code, and this is
  // the path almost every mid-sync failure takes — skip() says it and fail() did
  // not, so the one message that tells you whether to go and look was missing
  // from the common case.
  console.error(
    mutated
      ? 'The listing has already been changed and this sync did not finish. ' +
          'Re-run the release workflow, or `npm run amo:art`, to complete it.'
      : 'Nothing on the listing was changed.',
  );
  process.exit(1);
}

// Flipped by the first request that changes anything on the listing. Past that
// point the run has no clean state to walk away from, so there is no such thing
// as a benign reason to stop.
let mutated = false;

function skip(why) {
  if (mutated) {
    console.error(
      `::error::${why} — but the listing has already been changed. It is now in a ` +
        'partial state; re-run the release workflow to finish the sync.',
    );
    process.exit(1);
  }
  console.log(`::warning::${why}`);
  process.exit(0);
}

/**
 * Whether a 429 is worth sitting out, and for how long.
 *
 * The minute bucket answers with seconds and is worth waiting for. The hourly
 * one answers with thousands of seconds, and sleeping through that converts a
 * legible error into a job timeout with nothing in the log to explain it.
 */
function retryDelayS(res, attempt) {
  if (res.status !== 429 || attempt >= THROTTLE_ATTEMPTS) return null;
  const after = Number(res.headers.get('retry-after'));
  if (after > MAX_RETRY_AFTER_S) return null;
  // The pacer still applies on top of this, so a Retry-After shorter than the
  // spacing does not buy a faster retry — which is the direction to be wrong in.
  return Number.isFinite(after) && after > 0 ? after : UNSAFE_SPACING_MS / 1000;
}

function client({ issuer, secret }) {
  let lastUnsafeAt = 0;

  const send = async (path, method, body) => {
    const unsafe = method !== 'GET';
    if (unsafe) {
      const wait = lastUnsafeAt + UNSAFE_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
    // Deliberately no Content-Type header, even on the multipart calls: fetch
    // derives it from the FormData, and a hand-written one loses the boundary.
    //
    // A timeout, and a catch around it. Without either, a stalled connection
    // sits until the job's own timeout kills the step mid-sync, and a refused
    // one leaves main() as an unhandled rejection — a stack trace instead of the
    // one thing worth printing here, which is whether the listing was left half
    // finished.
    let res;
    let text;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        body,
        headers: { Authorization: `JWT ${mintJwt(issuer, secret)}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      const why =
        err?.name === 'TimeoutError' ? `no answer in ${REQUEST_TIMEOUT_MS}ms` : err?.message;
      console.error(`::error::${method} ${path} failed: ${why}`);
      console.error(
        mutated
          ? 'The listing has already been changed and this sync did not finish. ' +
              'Re-run the release workflow, or `npm run amo:art`, to complete it.'
          : 'Nothing on the listing was changed.',
      );
      process.exit(1);
    }
    // Stamped on COMPLETION, not on send. The throttle counts arrivals, so
    // pacing from the moment a request left leaks the whole margin as soon as
    // one call is slower than the next — and the image POSTs are the slow ones.
    if (unsafe) lastUnsafeAt = Date.now();
    // Mutated on success, not on attempt. A 503 or a 429 is AMO declining to
    // act, and treating a declined request as a change made turns the one safe
    // exit this script has — "nothing happened, come back next release" — into
    // a red build for a listing nobody touched.
    if (unsafe && res.ok) mutated = true;
    return { res, text };
  };

  return async function amo(path, { method = 'GET', body } = {}) {
    for (let attempt = 1; ; attempt++) {
      const { res, text } = await send(path, method, body);
      const pause = retryDelayS(res, attempt);
      if (pause === null) {
        return { status: res.status, ok: res.ok, text, json: parseBody(text) };
      }
      console.log(`throttled by AMO — retrying, Retry-After ${pause}s`);
      await sleep(pause * 1000);
    }
  };
}

async function main() {
  const issuer = process.env.AMO_JWT_ISSUER;
  const secret = process.env.AMO_JWT_SECRET;
  if (!issuer || !secret) {
    skip('AMO secrets incomplete — skipping the listing art. See docs/publishing.md.');
  }

  const icon = join(DIST, 'icons', 'icon-128.png');
  const manifest = join(DIST, 'manifest.json');
  if (!existsSync(icon) || !existsSync(manifest)) {
    console.error('::error::dist-firefox/ is not built — run `npm run build:firefox` before this.');
    process.exit(1);
  }

  // The guid, not the slug. A slug is editable in the dashboard by whoever is
  // looking at it, and this has to name the same add-on the XPI was signed
  // under. The endpoint takes either. Only the Firefox build has one, which is
  // the other half of why DIST is dist-firefox/ — read from dist/ this line is
  // a TypeError on undefined.
  const guid = JSON.parse(readFileSync(manifest, 'utf8')).browser_specific_settings.gecko.id;
  const addon = `/addons/addon/${encodeURIComponent(guid)}`;
  const amo = client({ issuer, secret });

  // Mozilla puts the whole API into read-only for deploys and incidents. The
  // version is published by then; the art can follow it on the next release.
  const site = await amo('/site/');
  // A probe that cannot answer is not an all-clear. This is the one call that
  // goes out before anything has been touched, so the cheap move when it comes
  // back as a 502 or as a proxy's HTML error page is to stop while stopping is
  // still free.
  if (!site.ok)
    skip(`AMO did not answer its status probe (HTTP ${site.status}) — art not uploaded.`);
  if (site.json?.read_only) skip('AMO is read-only right now — listing art not uploaded.');

  const detail = await amo(`${addon}/`);
  if (detail.status === 404) {
    skip('No add-on on AMO under this id yet — the art goes up on the next release.');
  }
  if (!detail.ok) fail('reading the add-on', detail);

  // GET on the previews collection is a 405: the current set is only ever
  // readable from the add-on detail.
  const previews = detail.json?.previews ?? [];
  // Tolerated rather than assumed, because unlike docs/store/ this directory is
  // one a checkout can plausibly be missing — and readdir on an absent path
  // throws a stack trace where the empty case one screen down prints a sentence.
  const screenshots = existsSync(STORE)
    ? readdirSync(STORE)
        .filter((f) => NUMBERED.test(f))
        .sort()
    : [];

  // Refuse rather than warn, and refuse HERE — before the first request that
  // changes anything. A run that knows it will be throttled off the end is a run
  // that would post half a set and then stop, and the only moment at which that
  // costs nothing is this one.
  const unsafeCalls = UNSAFE_SPENT_BY_SIGN + 1 + screenshots.length + previews.length;
  if (unsafeCalls > UNSAFE_PER_HOUR) {
    console.error(
      `::error::this sync needs ${unsafeCalls} throttled requests (including the ` +
        `${UNSAFE_SPENT_BY_SIGN} the signing step already spent) and AMO allows ` +
        `${UNSAFE_PER_HOUR} an hour. Refusing to start a sync that cannot finish — ` +
        'ship fewer screenshots, or run `npm run amo:art` by hand an hour later.',
    );
    process.exit(1);
  }

  await uploadIcon(amo, addon, icon);
  await syncScreenshots(amo, addon, previews, screenshots);
}

async function uploadIcon(amo, addon, icon) {
  const form = new FormData();
  form.append('icon', imagePart(icon), 'icon-128.png');
  const res = await amo(`${addon}/`, { method: 'PATCH', body: form });
  if (unavailable(res)) skip('AMO uploads are switched off — listing art not uploaded.');
  if (!res.ok) fail('uploading the listing icon', res);
  console.log('icon: uploaded icon-128.png');
}

async function syncScreenshots(amo, addon, previews, screenshots) {
  if (!screenshots.length) {
    // Deliberately NOT read as "this listing wants no screenshots". An empty
    // match is far more often a wrong working directory than a decision, and the
    // difference only becomes visible once the store page has already gone bare.
    console.log('::warning::No numbered PNGs in docs/store/amo/ — leaving the screenshots alone.');
    return;
  }

  // The new set goes up while the old set is still there. For the length of this
  // loop the listing carries both, which looks wrong to anyone reading the page
  // and is corrected within the minute — and if the run dies here, it dies with
  // the old screenshots untouched and the page still working.
  for (const [position, file] of screenshots.entries()) {
    const form = new FormData();
    form.append('image', imagePart(join(STORE, file)), file);
    // Explicit, ascending, and set at creation: position is the only ordering
    // AMO honours, and left out it falls back to upload order — which a retry of
    // a half-finished run would then get wrong. Colliding with the outgoing set's
    // positions is fine; `created` breaks the tie and the losers are about to go.
    form.append('position', String(position));
    const res = await amo(`${addon}/previews/`, { method: 'POST', body: form });
    if (!res.ok) fail(`uploading ${file}`, res);
    console.log(`screenshots: uploaded ${file} at position ${position}`);
  }

  for (const preview of previews) {
    const res = await amo(`${addon}/previews/${preview.id}/`, { method: 'DELETE' });
    // 404: something else already removed it. Same end state, nothing to say.
    if (!res.ok && res.status !== 404) fail(`deleting preview ${preview.id}`, res);
    console.log(`screenshots: removed #${preview.id}`);
  }
}

// Only when run as a command. Imported, this file is just the signer, so
// tests/amo-art.test.js can hold it against the published vector.
//
// Through realpath on both sides: argv[1] is absolute but keeps its symlinks
// while import.meta.url has resolved them, so comparing the two raw makes a
// checkout reached through a symlink look like an import — and the script then
// exits 0 having done precisely nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
