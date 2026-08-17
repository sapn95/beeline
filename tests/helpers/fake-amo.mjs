// A stand-in for addons.mozilla.org, installed over global fetch with
// `node --import`, so scripts/amo-art.mjs can be run end to end without a
// network, a credential or a live listing to damage.
//
// It records every request in order and writes the transcript to the path in
// FAKE_AMO_OUT on exit, because the assertions that matter are about ORDER and
// about what a run leaves behind when it stops early — neither of which is
// visible in the script's own output.
//
// Scenarios are chosen with FAKE_AMO_SCENARIO. Each one reproduces a failure
// that has a real counterpart in AMO's behaviour, not an invented one.

import { writeFileSync } from 'node:fs';

const scenario = process.env.FAKE_AMO_SCENARIO ?? 'happy';
const previews = Number(process.env.FAKE_AMO_PREVIEWS ?? 2);
const out = process.env.FAKE_AMO_OUT;

const calls = [];
const existing = Array.from({ length: previews }, (_, i) => ({ id: 900 + i, position: i }));

// The parts of a multipart body, flattened to what the assertions care about:
// which field, what Content-Type it DECLARED, and which file it came from.
//
// The declared type is the one AMO reads — it never sniffs the bytes — so a
// Buffer appended without a Blob wrapper is rejected as "Images must be either
// PNG or JPG." despite being a valid PNG. The filename is here because this
// repo builds two stores out of one docs/store/, and "it posted two images" is
// not the same claim as "it posted the two in docs/store/amo/".
async function parts(body) {
  if (!(body instanceof FormData)) return null;
  const seen = {};
  const files = {};
  for (const [name, value] of body.entries()) {
    seen[name] = value instanceof Blob ? (value.type ?? '') : String(value);
    if (typeof value?.name === 'string') files[name] = value.name;
  }
  return { seen, files };
}

const json = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  const path = String(url).replace('https://addons.mozilla.org/api/v5', '');
  const body = await parts(init.body);
  calls.push({ method, path, at: calls.length, parts: body?.seen ?? null, files: body?.files });

  if (path === '/site/') {
    if (scenario === 'siteDown') return new Response('<html>502</html>', { status: 502 });
    return json(200, { read_only: scenario === 'readOnly', notice: null });
  }

  if (method === 'GET') {
    if (scenario === 'noAddon') return json(404, { detail: 'Not found.' });
    return json(200, { slug: 'beeline-fast-app-launcher', previews: existing });
  }

  // A revoked or mistyped key. It reaches fail() with nothing yet changed, which
  // is the only combination that exercises the "nothing was changed" message —
  // and a revoked AMO key is not hypothetical here.
  if (scenario === 'unauthorized') return json(401, { detail: 'Invalid credentials.' });

  if (method === 'PATCH') {
    if (scenario === 'iconDown')
      return json(503, { error: 'Add-on uploads are temporarily unavailable.' });
    return json(200, { slug: 'beeline-fast-app-launcher' });
  }

  if (method === 'POST') {
    // The blocker this fake exists for: uploads switched off partway through a
    // sync, after the icon has already gone up.
    if (scenario === 'postDown')
      return json(503, { error: 'Add-on uploads are temporarily unavailable.' });
    if (scenario === 'badType') return json(400, { image: ['Images must be either PNG or JPG.'] });
    return json(201, { id: 990 + calls.length, position: 0 });
  }

  if (method === 'DELETE') return new Response(null, { status: 204 });
  return json(500, { detail: 'unreachable' });
};

process.on('exit', () => {
  if (out) writeFileSync(out, JSON.stringify(calls, null, 2));
});
