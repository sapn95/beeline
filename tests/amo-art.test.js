// The things about the AMO uploader that running it does not check, and that a
// live store is a bad place to find out about. This listing is public and has
// been through six releases, so a bad run is visible to everyone who looks up
// the add-on — these tests are what stands between that and a bare page.
//
// A wrong HS256 signature has exactly one symptom — 401 — and at that point it
// is indistinguishable from a stale secret. The no-credentials path has to be a
// clean exit 0, because release.yml runs this step on every release, including
// the ones where the secrets were never set.
//
// And then the ones this file was extended for. The first version of the
// uploader deleted every screenshot before posting the replacements, and
// treated "AMO has switched uploads off" as a benign exit 0 at BOTH ends of
// that window — so a 503 arriving in the middle left the public listing with no
// screenshots at all and reported a successful release. A review caught it.
// Nothing in a suite would have. Hence:

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { signHs256 } from '../scripts/amo-art.mjs';

const SCRIPT = 'scripts/amo-art.mjs';
const FAKE = 'tests/helpers/fake-amo.mjs';
const SCREENSHOTS = ['01-launcher.png', '02-manage.png'];

// A real PNG, 1×1 and transparent. It is inline rather than copied out of
// src/icons/ because those are generated and gitignored: `npm run ci` and the
// release workflow both run the tests BEFORE `npm run icons`, so on a clean
// clone every one of these would fail on a missing fixture — green here, red
// the moment CI saw it. The bytes matter only because the fake asserts on the
// Content-Type each part DECLARES, and the point of that assertion is the Blob
// wrapper rather than the file.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// The uploader reads dist-firefox/ and docs/store/amo/, so it is run from a
// fixture tree rather than from this checkout: neither directory exists on a
// clean clone until something builds it, and `npm run package` rebuilds
// dist-firefox/ in the same `npm run ci` these tests run inside.
let ROOT;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'amo-art-root-'));
  mkdirSync(join(ROOT, 'scripts'), { recursive: true });
  mkdirSync(join(ROOT, 'tests', 'helpers'), { recursive: true });
  mkdirSync(join(ROOT, 'dist-firefox', 'icons'), { recursive: true });
  mkdirSync(join(ROOT, 'docs', 'store', 'amo'), { recursive: true });

  cpSync(SCRIPT, join(ROOT, SCRIPT));
  cpSync(FAKE, join(ROOT, FAKE));
  // Only the Firefox build carries browser_specific_settings, which is why the
  // uploader reads dist-firefox/ and not dist/ — see the fixture below.
  writeFileSync(
    join(ROOT, 'dist-firefox', 'manifest.json'),
    JSON.stringify({ browser_specific_settings: { gecko: { id: 'fixture@example.com' } } }),
  );
  writeFileSync(join(ROOT, 'dist-firefox', 'icons', 'icon-128.png'), PNG);
  for (const name of SCREENSHOTS) writeFileSync(join(ROOT, 'docs', 'store', 'amo', name), PNG);
  // A sibling inside the AMO directory that is NOT two-digit-prefixed, to prove
  // the pattern is a filter and not just a sort.
  writeFileSync(join(ROOT, 'docs', 'store', 'amo', 'screenshot-1x.png'), PNG);
  // And the Chrome side of the same docs/store/, numbered exactly the way the
  // AMO set is. This is the reason the AMO art has a directory of its own: one
  // source tree builds both stores, and a glob over the shared directory would
  // post this to Mozilla, at a position that collides with 01-launcher.png.
  writeFileSync(join(ROOT, 'docs', 'store', '01-chrome-store.png'), PNG);
  writeFileSync(join(ROOT, 'docs', 'store', 'screenshot-1280x800.png'), PNG);
  // A Chrome build in the tree, with a manifest that has no gecko id — the
  // shape the uploader would read if DIST ever went back to dist/. It should
  // never be opened; the guid lookup would throw on it.
  mkdirSync(join(ROOT, 'dist', 'icons'), { recursive: true });
  writeFileSync(join(ROOT, 'dist', 'manifest.json'), JSON.stringify({ name: 'beeline' }));
  writeFileSync(join(ROOT, 'dist', 'icons', 'icon-128.png'), PNG);
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const withoutCredentials = () => {
  const env = { ...process.env };
  delete env.AMO_JWT_ISSUER;
  delete env.AMO_JWT_SECRET;
  return env;
};

/**
 * Run the uploader against the fake store, and hand back the transcript of what
 * it actually sent alongside its exit code.
 *
 * AMO_ART_PACE_MS collapses the throttle pacer — without it every one of these
 * would take a minute and a half of real time, and a test nobody runs is not a
 * regression test.
 */
function run(scenario, { previews = 2 } = {}) {
  const transcript = join(ROOT, `calls-${scenario}-${previews}.json`);
  let status = 0;
  let stdout;
  try {
    stdout = execFileSync('node', ['--import', `./${FAKE}`, SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        AMO_JWT_ISSUER: 'user:12345:67',
        AMO_JWT_SECRET: 'not-a-real-secret',
        FAKE_AMO_SCENARIO: scenario,
        FAKE_AMO_PREVIEWS: String(previews),
        FAKE_AMO_OUT: transcript,
        AMO_ART_PACE_MS: '0',
      },
    });
  } catch (e) {
    status = e.status;
    stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const calls = JSON.parse(readFileSync(transcript, 'utf8'));
  rmSync(transcript, { force: true });
  return { status, stdout, calls };
}

const methods = (calls) => calls.map((c) => c.method);

describe('the JWS signature', () => {
  it('reproduces the published HS256 test vector', () => {
    // RFC 7515 A.1, verbatim. Header and payload are taken pre-encoded because
    // the example's JSON carries CRLFs that no serialiser here would reproduce,
    // and the key is its JWK octet sequence decoded back to bytes.
    const signingInput =
      'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.' +
      'eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ';
    const key = Buffer.from(
      'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow',
      'base64url',
    );

    expect(signHs256(signingInput, key)).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  });
});

describe('running it without credentials', () => {
  // execFileSync throws on a non-zero exit, so getting output back at all IS
  // the exit-0 assertion in both of these.

  it('warns instead of reddening a release that has already published', () => {
    const out = execFileSync('node', [SCRIPT], {
      cwd: process.cwd(),
      env: withoutCredentials(),
      encoding: 'utf8',
    });

    expect(out).toContain('::warning::');
    expect(out).toContain('docs/publishing.md');
  });

  it('gets no further than the credential check, so an unbuilt tree is fine too', () => {
    // Run a copy from a directory that has no dist-firefox/ and no
    // docs/store/amo/. If the order of the checks ever slips, this throws with
    // ENOENT — which on a release day would read as a broken build rather than
    // an unconfigured one.
    const root = mkdtempSync(join(tmpdir(), 'amo-art-'));
    mkdirSync(join(root, 'scripts'));
    cpSync(join(process.cwd(), SCRIPT), join(root, SCRIPT));

    const out = execFileSync('node', [SCRIPT], {
      cwd: root,
      env: withoutCredentials(),
      encoding: 'utf8',
    });

    expect(out).toContain('::warning::');
  });
});

describe('replacing the screenshots', () => {
  it('posts the new set before deleting the old one', () => {
    // The ordering IS the safety property. Deleting first opens a window in
    // which the live listing has no screenshots, and every way the run can stop
    // inside that window leaves the store page bare.
    const { status, calls } = run('happy');

    expect(status).toBe(0);
    const lastPost = methods(calls).lastIndexOf('POST');
    const firstDelete = methods(calls).indexOf('DELETE');
    expect(firstDelete).toBeGreaterThan(lastPost);
  });

  it('declares image/png on every part it uploads, icon included', () => {
    // AMO validates the DECLARED part type and never sniffs the bytes, so a
    // Buffer appended without a Blob wrapper goes up as application/octet-stream
    // and comes back rejected as not being a PNG.
    const { calls } = run('happy');
    const images = calls.filter((c) => c.parts?.image || c.parts?.icon);

    expect(images.length).toBeGreaterThan(0);
    for (const call of images) {
      expect(call.parts.image ?? call.parts.icon).toBe('image/png');
    }
  });

  it('numbers the positions from zero, ascending', () => {
    // Position is the only ordering AMO honours; left out it falls back to
    // insertion time, which a retry of a half-finished run gets wrong.
    const { calls } = run('happy');
    const posted = calls.filter((c) => c.method === 'POST');

    expect(posted.map((c) => c.parts.position)).toEqual(['0', '1']);
  });

  it('uploads the AMO directory only, and only the numbered PNGs in it', () => {
    // Both halves matter. docs/store/ also holds the Chrome art — including a
    // 01-*.png — and a glob over it would send Mozilla a picture drawn to
    // Chrome's required 1280×800, at a position that collides with the real
    // first screenshot. docs/store/amo/ also holds an unnumbered sibling, which
    // a filter that had decayed into a sort would sweep up.
    const { calls } = run('happy');
    const posted = calls.filter((c) => c.method === 'POST');

    expect(posted.map((c) => c.files.image)).toEqual(SCREENSHOTS);
  });

  it('takes the listing icon from the Firefox build', () => {
    // dist/ is in the fixture too, with a Chrome manifest that has no gecko id.
    // Reading it would take the icon off the wrong build and then throw on the
    // guid — the mistake is silent right up to the point where it is a crash.
    const { status, calls } = run('happy');
    const patched = calls.filter((c) => c.method === 'PATCH');

    expect(status).toBe(0);
    expect(patched).toHaveLength(1);
    expect(patched[0].files.icon).toBe('icon-128.png');
    // The guid off dist-firefox/manifest.json, url-encoded into the path.
    expect(patched[0].path).toBe('/addons/addon/fixture%40example.com/');
  });
});

describe('stopping early', () => {
  it('is silent and green when nothing has been touched yet', () => {
    // 503 on the icon PATCH: AMO declined, so the listing is exactly as it was.
    // This is the one case where walking away costs nothing.
    const { status, stdout, calls } = run('iconDown');

    expect(status).toBe(0);
    expect(stdout).toContain('::warning::');
    expect(methods(calls)).not.toContain('DELETE');
  });

  it('is loud and red once it has changed something', () => {
    // The regression. A 503 on a screenshot POST arrives after the icon has
    // already gone up, so the listing is half-synced. The old version called the
    // same benign exit here that it called above, and a green step is the one
    // thing that guarantees nobody looks.
    const { status, stdout, calls } = run('postDown');

    expect(status).not.toBe(0);
    expect(stdout).toContain('::error::');
    // and it says WHICH state the listing is in, which is the only part of this
    // a human can act on. fail() printed the status code and nothing else until a
    // review pointed out that skip() said it and the commoner path did not.
    expect(stdout).toMatch(/already been changed|did not finish/i);
    // and, crucially, it got nowhere near the deletions
    expect(methods(calls)).not.toContain('DELETE');
  });

  it('says plainly when a failure left the listing untouched', () => {
    // The other half. A run that failed before changing anything needs no
    // follow-up, and not saying so invites somebody to go and check by hand.
    const { status, stdout } = run('unauthorized');
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/Nothing on the listing was changed/i);
  });

  it('never deletes anything when an upload is refused outright', () => {
    const { status, calls } = run('badType');

    expect(status).not.toBe(0);
    expect(methods(calls)).not.toContain('DELETE');
  });

  it('leaves the listing alone when the add-on is not published yet', () => {
    const { status, calls } = run('noAddon');

    expect(status).toBe(0);
    expect(methods(calls)).toEqual(['GET', 'GET']);
  });

  it('treats a status probe it cannot read as a reason to stop, not an all-clear', () => {
    // Failing open here would send the full destructive sync at an AMO that has
    // just answered a trivial GET with a proxy error page.
    const { status, calls } = run('siteDown');

    expect(status).toBe(0);
    expect(methods(calls)).toEqual(['GET']);
  });

  it('refuses a sync too big for the hourly throttle before sending anything', () => {
    // Nine existing previews plus the icon and this repo's screenshots is past
    // the ten-an-hour bucket, and the signing step in the same job has already
    // spent two of them. Stopping here costs nothing; stopping halfway does not.
    const { status, stdout, calls } = run('happy', { previews: 9 });

    expect(status).not.toBe(0);
    expect(stdout).toContain('::error::');
    expect(methods(calls)).toEqual(['GET', 'GET']);
  });
});
