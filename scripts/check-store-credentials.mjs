// Are the store credentials still usable? Run by the daily credentials check
// (.github/workflows/credentials-check.yml) so an expired token is found days
// before a release needs it — not while the release is half-done.
//
//   CHROME_CLIENT_ID=… CHROME_CLIENT_SECRET=… CHROME_REFRESH_TOKEN=… \
//   AMO_JWT_ISSUER=… AMO_JWT_SECRET=… node scripts/check-store-credentials.mjs
//
// Exits non-zero if any configured credential is rejected. Prints only the
// store name and the provider's error code — never a secret. A store whose
// secrets are absent is reported as "not configured" and does not fail the run.

import { createHmac, randomUUID } from 'node:crypto';

const b64url = (input) => Buffer.from(input).toString('base64url');

/** Exchange the refresh token for an access token — the exact call the
 * publisher makes. `invalid_grant` here is what breaks a release. */
async function checkChrome() {
  const { CHROME_CLIENT_ID, CHROME_CLIENT_SECRET, CHROME_REFRESH_TOKEN } = process.env;
  if (!CHROME_CLIENT_ID || !CHROME_CLIENT_SECRET || !CHROME_REFRESH_TOKEN) {
    return { store: 'Chrome Web Store', state: 'not configured' };
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CHROME_CLIENT_ID,
      client_secret: CHROME_CLIENT_SECRET,
      refresh_token: CHROME_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (res.ok) return { store: 'Chrome Web Store', state: 'ok' };
  const body = await res.json().catch(() => ({}));
  return {
    store: 'Chrome Web Store',
    state: 'broken',
    // `invalid_grant` = the refresh token was revoked or expired. Google expires
    // it after ~7 days while the OAuth consent screen is still in "Testing".
    reason: `${res.status} ${body.error ?? 'unknown_error'}`,
  };
}

/** AMO signs each request with a short-lived JWT built from the API key pair. */
async function checkAmo() {
  const { AMO_JWT_ISSUER, AMO_JWT_SECRET } = process.env;
  if (!AMO_JWT_ISSUER || !AMO_JWT_SECRET) {
    return { store: 'Firefox AMO', state: 'not configured' };
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: AMO_JWT_ISSUER, jti: randomUUID(), iat: now, exp: now + 60 };
  const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify(payload),
  )}`;
  const signature = createHmac('sha256', AMO_JWT_SECRET).update(signingInput).digest('base64url');

  const res = await fetch('https://addons.mozilla.org/api/v5/accounts/profile/', {
    headers: { Authorization: `JWT ${signingInput}.${signature}` },
  });
  if (res.ok) return { store: 'Firefox AMO', state: 'ok' };
  return { store: 'Firefox AMO', state: 'broken', reason: String(res.status) };
}

const results = await Promise.all([checkChrome(), checkAmo()]);
for (const { store, state, reason } of results) {
  console.log(`${store}: ${state}${reason ? ` (${reason})` : ''}`);
}

const broken = results.filter((r) => r.state === 'broken');
if (broken.length > 0) {
  console.log(`::error::Store credentials rejected: ${broken.map((b) => b.store).join(', ')}`);
  process.exit(1);
}
