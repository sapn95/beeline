// One-time helper to mint a Chrome Web Store API refresh token for the release
// pipeline. Run AFTER creating an OAuth "Desktop app" client in Google Cloud
// (see docs/publishing.md):
//
//   node scripts/get-cws-token.mjs <CLIENT_ID> <CLIENT_SECRET>
//
// It opens Google's consent screen, captures the loopback redirect, exchanges
// the code, and prints the refresh token plus the gh command to store it.
// Nothing is sent anywhere except to Google's OAuth endpoint.

import http from 'node:http';
import { exec } from 'node:child_process';

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error('Usage: node scripts/get-cws-token.mjs <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

const PORT = 8818;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const authUrl =
  'https://accounts.google.com/o/oauth2/auth?' +
  new URLSearchParams({
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPE,
    client_id: clientId,
    redirect_uri: REDIRECT,
  }).toString();

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('No authorization code in request.');
    return;
  }
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const data = await resp.json();
    if (!data.refresh_token) {
      res.writeHead(500).end(`No refresh_token returned: ${JSON.stringify(data)}`);
      console.error('\nFailed — Google returned:', data);
      server.close();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Done — refresh token captured. You can close this tab.');
    console.log(`\n=== CHROME_REFRESH_TOKEN ===\n${data.refresh_token}\n`);
    console.log('Store it with:');
    console.log(
      `  gh secret set CHROME_REFRESH_TOKEN --repo sapn95/myapps-launcher --body "${data.refresh_token}"`,
    );
    server.close();
  } catch (err) {
    res.writeHead(500).end(`Token exchange failed: ${err.message}`);
    console.error(err);
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('Opening the Google consent screen…');
  console.log(`If it does not open automatically, visit:\n${authUrl}\n`);
  // macOS opener; on Linux use `xdg-open`.
  exec(`open "${authUrl}"`);
});
