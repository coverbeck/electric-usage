const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ENPHASE_API_KEY;
const SYSTEM_ID = process.env.ENPHASE_SYSTEM_ID;

if (!API_KEY || !SYSTEM_ID) {
  console.error('ENPHASE_API_KEY and ENPHASE_SYSTEM_ID env vars are required');
  process.exit(1);
}

const TOKENS_FILE = path.join(__dirname, 'enphase-tokens.json');

async function main() {
  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));

  const url = `https://api.enphaseenergy.com/api/v4/systems/${encodeURIComponent(SYSTEM_ID)}?key=${encodeURIComponent(API_KEY)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  const body = await res.text();

  if (!res.ok) {
    console.error(`Lookup failed: ${res.status} ${res.statusText}`);
    console.error(body);
    process.exit(1);
  }

  const data = JSON.parse(body);
  console.log('System found:');
  console.log(`  name: ${data.name}`);
  console.log(`  system_id: ${data.system_id}`);
  console.log(`  status: ${data.status}`);
  console.log(`  timezone: ${data.timezone}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
