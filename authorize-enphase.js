const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const CLIENT_ID = process.env.ENPHASE_CLIENT_ID;
const CLIENT_SECRET = process.env.ENPHASE_CLIENT_SECRET;
const REDIRECT_URI = process.env.ENPHASE_REDIRECT_URI || 'https://api.enphaseenergy.com/oauth/redirect_uri';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ENPHASE_CLIENT_ID and ENPHASE_CLIENT_SECRET env vars are required');
  process.exit(1);
}

const TOKENS_FILE = path.join(__dirname, 'enphase-tokens.json');

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

async function main() {
  const authorizeUrl = `https://api.enphaseenergy.com/oauth/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  console.log('Opening the Enphase authorization page in your browser...');
  console.log(authorizeUrl);
  try {
    execSync(`open "${authorizeUrl}"`);
  } catch {
    console.log('(Could not auto-open browser — copy the URL above manually.)');
  }
  console.log('Log in, approve access, then copy the "code" value shown on the redirect page.');

  const code = await prompt('Paste the authorization code here: ');
  if (!code) {
    console.error('No code entered, aborting.');
    process.exit(1);
  }

  const tokenUrl = `https://api.enphaseenergy.com/oauth/token?grant_type=authorization_code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code=${encodeURIComponent(code)}`;
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${basicAuth}` },
  });

  if (!res.ok) {
    console.error(`Token exchange failed: ${res.status} ${res.statusText}`);
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

  console.log(`Tokens written to ${TOKENS_FILE}`);
  console.log(`Access token expires at ${expiresAt}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
