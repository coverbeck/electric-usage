const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ENPHASE_API_KEY;
const SYSTEM_ID = process.env.ENPHASE_SYSTEM_ID;

if (!API_KEY || !SYSTEM_ID) {
  console.error('ENPHASE_API_KEY and ENPHASE_SYSTEM_ID env vars are required');
  process.exit(1);
}

const TOKENS_FILE = path.join(__dirname, 'enphase-tokens.json');

// Candidate endpoints worth checking for interval production data.
// start_at values are Unix timestamps; picking a recent full day.
function candidates() {
  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - 24 * 60 * 60;
  return [
    { name: 'summary', path: `/api/v4/systems/${SYSTEM_ID}/summary` },
    { name: 'energy_lifetime', path: `/api/v4/systems/${SYSTEM_ID}/energy_lifetime` },
    { name: 'telemetry/production_micro', path: `/api/v4/systems/${SYSTEM_ID}/telemetry/production_micro?start_at=${oneDayAgo}&granularity=day` },
    { name: 'rgm_stats', path: `/api/v4/systems/${SYSTEM_ID}/rgm_stats?start_at=${oneDayAgo}&end_at=${now}` },
  ];
}

async function main() {
  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));

  for (const c of candidates()) {
    const sep = c.path.includes('?') ? '&' : '?';
    const url = `https://api.enphaseenergy.com${c.path}${sep}key=${encodeURIComponent(API_KEY)}`;
    console.log(`\n=== ${c.name} ===`);
    console.log(url.replace(API_KEY, '<key>'));
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const text = await res.text();
      console.log(`status: ${res.status}`);
      console.log(text.length > 2000 ? text.slice(0, 2000) + '\n...[truncated]' : text);
    } catch (err) {
      console.error(`error: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
