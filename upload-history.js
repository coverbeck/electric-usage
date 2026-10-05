// Uploads the long-history files saved in downloads/ (gitignored) to overbeck-backend-node:
//   - PG&E electric bills (bill-history-*.json, from downloads/fetch-bill-history.js)
//     -> POST /api/electric-bills
//   - Enphase daily production (enphase-lifetime-*.json, from downloads/fetch-enphase-lifetime.js)
//     -> POST /api/solar-daily
// Uses the newest file of each kind. Both endpoints upsert, so rerunning is safe.
//
// Run from the electric-usage directory:
//   node --env-file-if-exists=.env upload-history.js [--dry-run]
const fs = require('fs');
const path = require('path');

const API_BASE_URL = process.env.API_BASE_URL;
const API_AUTH_USER = process.env.API_AUTH_USER;
const API_AUTH_PASS = process.env.API_AUTH_PASS;

const DRY_RUN = process.argv.includes('--dry-run');

if (!DRY_RUN && (!API_BASE_URL || !API_AUTH_USER || !API_AUTH_PASS)) {
  console.error('API_BASE_URL, API_AUTH_USER, and API_AUTH_PASS env vars are required (unless using --dry-run)');
  process.exit(1);
}

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

function newestFile(pattern) {
  const matches = fs.readdirSync(DOWNLOADS_DIR).filter((f) => pattern.test(f)).sort();
  if (matches.length === 0) throw new Error(`No file matching ${pattern} in ${DOWNLOADS_DIR}`);
  return path.join(DOWNLOADS_DIR, matches[matches.length - 1]);
}

function toPacificDate(isoString) {
  return new Date(isoString).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function amount(field) {
  return field?.value ?? null;
}

function quantity(segment, identifier) {
  const q = segment.serviceQuantities.find((sq) => sq.serviceQuantityIdentifier === identifier);
  return q?.serviceQuantity?.value ?? null;
}

// One row per electric segment, dated by the segment's own usage interval (the bill's
// overall interval also spans the gas segment, which runs a day later). The interval
// ends at midnight, so endDate is exclusive.
function parseBills(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bills = json.data?.billingAccountByAuthContext?.bills ?? [];
  const rows = [];
  for (const bill of bills) {
    for (const segment of bill.segments) {
      if (segment.serviceAgreement?.serviceType !== 'ELECTRICITY') continue;
      const [startIso, endIso] = segment.usageInterval.split('/');
      rows.push({
        startDate: toPacificDate(startIso),
        endDate: toPacificDate(endIso),
        netKwh: quantity(segment, 'NET_USAGE'),
        importKwh: quantity(segment, 'IMPORTED'),
        exportKwh: quantity(segment, 'EXPORTED'),
        usageCharges: amount(segment.usageCharges),
        currentAmount: amount(segment.currentAmount),
        totalNemCharges: amount(segment.totalNEMCharges),
        deferredNemCharges: amount(segment.deferredNEMCharges),
        energyPurchased: amount(segment.energyPurchased),
        totalEnergyCosts: amount(segment.totalEnergyCosts),
        estimated: segment.estimated === true,
      });
    }
  }
  return rows;
}

function addDaysIso(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// energy_lifetime returns one Wh value per day starting at start_date.
function parseSolarDaily(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!json.start_date || !Array.isArray(json.production)) {
    throw new Error(`${file} has no start_date/production array`);
  }
  return json.production.map((wh, i) => ({
    generationDate: addDaysIso(json.start_date, i),
    generationKwh: wh / 1000,
  }));
}

async function post(endpoint, body) {
  const auth = Buffer.from(`${API_AUTH_USER}:${API_AUTH_PASS}`).toString('base64');
  const res = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`${endpoint} upload failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function run() {
  const billsFile = newestFile(/^bill-history-\d{4}-\d{2}-\d{2}\.json$/);
  const solarFile = newestFile(/^enphase-lifetime-\d{4}-\d{2}-\d{2}\.json$/);

  const bills = parseBills(billsFile);
  const solar = parseSolarDaily(solarFile);
  console.log(`${path.basename(billsFile)}: ${bills.length} electric bills, ${bills[0]?.startDate} to ${bills[bills.length - 1]?.endDate}`);
  console.log(`${path.basename(solarFile)}: ${solar.length} days, ${solar[0]?.generationDate} to ${solar[solar.length - 1]?.generationDate}`);

  if (DRY_RUN) {
    console.log('Dry run, not uploading. First and last bill:');
    console.log(JSON.stringify([bills[0], bills[bills.length - 1]], null, 2));
    return;
  }

  console.log('Electric bills:', await post('/api/electric-bills', { bills }));
  console.log('Solar daily:', await post('/api/solar-daily', { readings: solar }));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
