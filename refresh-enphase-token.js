const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.ENPHASE_CLIENT_ID;
const CLIENT_SECRET = process.env.ENPHASE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ENPHASE_CLIENT_ID and ENPHASE_CLIENT_SECRET env vars are required');
  process.exit(1);
}

const TOKENS_FILE = path.join(__dirname, 'enphase-tokens.json');

async function main() {
  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));

  const tokenUrl = `https://api.enphaseenergy.com/oauth/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(tokens.refresh_token)}`;
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${basicAuth}` },
  });

  if (!res.ok) {
    console.error(`Refresh failed: ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  fs.writeFileSync(TOKENS_FILE, JSON.stringify({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
  }, null, 2));

  console.log('Refresh succeeded.');
  console.log(`New access token expires at ${expiresAt}`);
  console.log(`Refresh token rotated: ${data.refresh_token !== tokens.refresh_token}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
