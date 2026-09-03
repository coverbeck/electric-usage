const fs = require('fs');
const path = require('path');

function timestamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' });
}
const origLog = console.log;
const origError = console.error;
console.log = (...args) => origLog(`[${timestamp()}]`, ...args);
console.error = (...args) => origError(`[${timestamp()}]`, ...args);

const ENPHASE_API_KEY = process.env.ENPHASE_API_KEY;
const ENPHASE_CLIENT_ID = process.env.ENPHASE_CLIENT_ID;
const ENPHASE_CLIENT_SECRET = process.env.ENPHASE_CLIENT_SECRET;
const ENPHASE_SYSTEM_ID = process.env.ENPHASE_SYSTEM_ID;
const API_BASE_URL = process.env.API_BASE_URL;
const API_AUTH_USER = process.env.API_AUTH_USER;
const API_AUTH_PASS = process.env.API_AUTH_PASS;

if (!ENPHASE_API_KEY || !ENPHASE_CLIENT_ID || !ENPHASE_CLIENT_SECRET || !ENPHASE_SYSTEM_ID) {
  console.error('ENPHASE_API_KEY, ENPHASE_CLIENT_ID, ENPHASE_CLIENT_SECRET, and ENPHASE_SYSTEM_ID env vars are required');
  process.exit(1);
}
if (!API_BASE_URL || !API_AUTH_USER || !API_AUTH_PASS) {
  console.error('API_BASE_URL, API_AUTH_USER, and API_AUTH_PASS env vars are required');
  process.exit(1);
}

const TOKENS_FILE = path.join(__dirname, 'enphase-tokens.json');

// Per-run call budget, split across three groups (see CLAUDE.md for the rationale):
// today (always refreshed) + oldest-edge backfill (outrunning Enphase's rolling 2-year
// window) + recent-history backfill (walking backward from yesterday). Once the 2-year
// window is fully backfilled, groups 2 and 3 naturally find nothing to do and each run
// reduces to just the "today" call. Kept proportional to the original 1/2/7 split
// (reduced 2026-09-01 from 30/4min to 27/4min — with manual runs stopped and only the
// daily launchd job left, 27/day * 30 days/month ~= 810, landing close to a target of
// ~800 calls for the rest of this month on top of the ~200 already made, staying safely
// under Enphase's 1,000/month cap).
const TODAY_CALLS = 1;
const OLDEST_EDGE_CALLS = 5;
const RECENT_BACKWARD_CALLS = 21;
const TOTAL_CALLS = TODAY_CALLS + OLDEST_EDGE_CALLS + RECENT_BACKWARD_CALLS;

// Spread all calls evenly across this window so a burst never approaches Enphase's
// free-tier 10-requests/minute cap — 15 calls in one tight burst is exactly what
// tripped a rate-limit violation on 2026-08-31.
const SPREAD_WINDOW_MS = 4 * 60 * 1000;
const CALL_DELAY_MS = Math.floor(SPREAD_WINDOW_MS / (TOTAL_CALLS - 1));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Enphase enforces "requested start date must be within 2 years from current date" —
// stay a few days inside that boundary to avoid an off-by-one rejection at the exact edge.
const TWO_YEAR_WINDOW_DAYS = 365 * 2 - 5;
// Safety stop for the backward walk so a bug can't spin it into an unbounded loop.
const BACKWARD_WALK_SAFETY_DAYS = 365 * 2 + 30;

function todayPacific() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function addDaysIso(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Unix epoch seconds for Pacific-local midnight on the given YYYY-MM-DD date, DST-aware.
// Iteratively converges: format a guess in the target timezone, measure the drift from
// the desired local wall-clock time, and correct — handles both PST and PDT correctly
// without a date library, and converges in 1-2 iterations.
function pacificMidnightEpochSeconds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const targetLocalMs = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guessMs = Date.UTC(y, m - 1, d, 8, 0, 0); // rough PST guess

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guessMs)).map((p) => [p.type, p.value]));
    const hour = parts.hour === '24' ? 0 : Number(parts.hour);
    const formattedLocalMs = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      hour, Number(parts.minute), Number(parts.second)
    );
    const driftMs = targetLocalMs - formattedLocalMs;
    if (driftMs === 0) break;
    guessMs += driftMs;
  }

  return Math.floor(guessMs / 1000);
}

async function ensureFreshToken() {
  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  const bufferMs = 5 * 60 * 1000;
  if (Date.now() + bufferMs < new Date(tokens.expires_at).getTime()) {
    return tokens.access_token;
  }

  console.log('Access token expired or expiring soon, refreshing...');
  const tokenUrl = `https://api.enphaseenergy.com/oauth/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(tokens.refresh_token)}`;
  const basicAuth = Buffer.from(`${ENPHASE_CLIENT_ID}:${ENPHASE_CLIENT_SECRET}`).toString('base64');

  const res = await fetch(tokenUrl, { method: 'POST', headers: { Authorization: `Basic ${basicAuth}` } });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
  }, null, 2));
  console.log(`Refreshed. New access token expires at ${expiresAt}`);
  return data.access_token;
}

// A full day of 5-minute solar intervals is 288; a legitimate DST spring-forward day is
// 276 (23 hours). Anything below this is treated as an incomplete fetch (typically a date
// that was only ever captured while it was still "today") and stays eligible for
// oldest-edge/recent-backward to fill in, rather than being skipped forever just because
// *some* rows exist for it.
const COMPLETE_INTERVALS_THRESHOLD = 250;

async function fetchExistingDates() {
  const auth = Buffer.from(`${API_AUTH_USER}:${API_AUTH_PASS}`).toString('base64');
  const res = await fetch(`${API_BASE_URL}/api/solar-generation/dates`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch existing dates: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const complete = new Set(
    Object.entries(data.counts ?? {})
      .filter(([, count]) => count >= COMPLETE_INTERVALS_THRESHOLD)
      .map(([date]) => date)
  );
  return complete;
}

function planTargetDates(completeDates) {
  const today = todayPacific();
  const claimed = new Set();
  const targets = [];

  targets.push({ date: today, group: 'today' });
  claimed.add(today);

  let cursor = addDaysIso(today, -TWO_YEAR_WINDOW_DAYS);
  let found = 0;
  while (found < OLDEST_EDGE_CALLS && cursor < today) {
    if (!completeDates.has(cursor) && !claimed.has(cursor)) {
      targets.push({ date: cursor, group: 'oldest-edge' });
      claimed.add(cursor);
      found++;
    }
    cursor = addDaysIso(cursor, 1);
  }

  cursor = addDaysIso(today, -1);
  found = 0;
  const backwardStop = addDaysIso(today, -BACKWARD_WALK_SAFETY_DAYS);
  while (found < RECENT_BACKWARD_CALLS && cursor > backwardStop) {
    if (!completeDates.has(cursor) && !claimed.has(cursor)) {
      targets.push({ date: cursor, group: 'recent-backward' });
      claimed.add(cursor);
      found++;
    }
    cursor = addDaysIso(cursor, -1);
  }

  return targets;
}

// Enphase doesn't document any X-RateLimit-* / Retry-After style headers as of
// 2026-08-31 (checked developer-v4.enphase.com), but log anything rate-limit-shaped
// that shows up on real responses so we find out empirically rather than guessing.
function logRateLimitHeaders(res) {
  const relevant = [...res.headers.entries()].filter(([name]) =>
    /rate.?limit|retry-after|quota/i.test(name)
  );
  if (relevant.length > 0) {
    console.log(`  rate-limit headers: ${relevant.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
}

async function fetchDayIntervals(accessToken, dateStr) {
  const startAt = pacificMidnightEpochSeconds(dateStr);
  const url = `https://api.enphaseenergy.com/api/v4/systems/${ENPHASE_SYSTEM_ID}/telemetry/production_micro?start_at=${startAt}&granularity=day&key=${encodeURIComponent(ENPHASE_API_KEY)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  logRateLimitHeaders(res);
  if (!res.ok) {
    throw new Error(`Enphase telemetry request failed for ${dateStr}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.intervals ?? [];
}

// Enphase's production_micro intervals are 5 minutes wide, identified only by their
// end_at. The bucket a given interval belongs to (and thus its generationDate) is
// derived from the interval's *start*, not its end — the day's last interval
// (23:55-00:00) has an end_at that falls exactly at the start of the next calendar
// day, so deriving generationDate from end_at would misattribute that one interval
// per day to the following date.
const INTERVAL_SECONDS = 5 * 60;

function intervalsToReadings(intervals) {
  return intervals.map((iv) => {
    const endDate = new Date(iv.end_at * 1000);
    const startDate = new Date((iv.end_at - INTERVAL_SECONDS) * 1000);
    const timeFormat = { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false };
    return {
      generationDate: startDate.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
      startTime: startDate.toLocaleTimeString('en-GB', timeFormat),
      endTime: endDate.toLocaleTimeString('en-GB', timeFormat),
      generationKwh: iv.enwh / 1000,
    };
  });
}

async function uploadReadings(readings) {
  if (readings.length === 0) {
    return { received: 0, inserted: 0, duplicates: 0 };
  }
  const auth = Buffer.from(`${API_AUTH_USER}:${API_AUTH_PASS}`).toString('base64');
  const res = await fetch(`${API_BASE_URL}/api/solar-generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ readings }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function run() {
  const accessToken = await ensureFreshToken();

  console.log('Fetching existing stored dates...');
  const completeDates = await fetchExistingDates();
  console.log(`${completeDates.size} day(s) already complete.`);

  const targets = planTargetDates(completeDates);
  console.log(`Plan (${targets.length} call(s)): ${targets.map((t) => `${t.date} [${t.group}]`).join(', ')}`);

  const totals = { received: 0, inserted: 0, duplicates: 0 };

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    console.log(`Fetching ${target.date} (${target.group})...`);
    const intervals = await fetchDayIntervals(accessToken, target.date);
    const readings = intervalsToReadings(intervals);
    const result = await uploadReadings(readings);
    console.log(`  ${target.date}: ${intervals.length} interval(s) -> received ${result.received}, inserted ${result.inserted}, duplicates ${result.duplicates}`);
    totals.received += result.received;
    totals.inserted += result.inserted;
    totals.duplicates += result.duplicates;

    if (i < targets.length - 1) {
      console.log(`  waiting ${(CALL_DELAY_MS / 1000).toFixed(1)}s before next call...`);
      await sleep(CALL_DELAY_MS);
    }
  }

  console.log(`Done. Total: received ${totals.received}, inserted ${totals.inserted}, duplicates ${totals.duplicates}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
