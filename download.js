const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const USERNAME = process.env.PGE_USERNAME;
const PASSWORD = process.env.PGE_PASSWORD;
const API_BASE_URL = process.env.API_BASE_URL;
const API_AUTH_USER = process.env.API_AUTH_USER;
const API_AUTH_PASS = process.env.API_AUTH_PASS;

if (!USERNAME || !PASSWORD) {
  console.error('PGE_USERNAME and PGE_PASSWORD env vars are required');
  process.exit(1);
}
if (!API_BASE_URL || !API_AUTH_USER || !API_AUTH_PASS) {
  console.error('API_BASE_URL, API_AUTH_USER, and API_AUTH_PASS env vars are required');
  process.exit(1);
}

const USAGE_URL = 'https://myaccount.pge.com/myaccount/s/usageandconsumption-homepage';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const SESSION_FILE = path.join(__dirname, 'session.json');
const EXTRACT_DIR = path.join(DOWNLOAD_DIR, '.download-extract');

function todayPacific() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function addDaysIso(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isoToMMDDYYYY(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${m}/${d}/${y}`;
}

function parseCost(str) {
  if (str === undefined || str === '') return 0;
  return parseFloat(str.trim().replace(/\$/g, ''));
}

function findHeaderIndex(lines, prefix) {
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  if (idx === -1) throw new Error(`Could not find header row starting with "${prefix}"`);
  return idx;
}

// PG&E sometimes omits the COST column entirely for very recent/unfinalized
// days, so columns are located by header name rather than fixed position.
function parseElectricCsv(content) {
  const lines = content.split(/\r?\n/);
  const headerIdx = findHeaderIndex(lines, 'TYPE,DATE,START TIME');
  const header = lines[headerIdx].split(',');
  const col = (name) => header.indexOf(name);
  const dateIdx = col('DATE');
  const startIdx = col('START TIME');
  const endIdx = col('END TIME');
  const importIdx = col('IMPORT (kWh)');
  const exportIdx = col('EXPORT (kWh)');
  const costIdx = col('COST');

  const readings = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = line.split(',');
    readings.push({
      usageDate: fields[dateIdx],
      startTime: fields[startIdx],
      endTime: fields[endIdx],
      importKwh: parseFloat(fields[importIdx]),
      exportKwh: parseFloat(fields[exportIdx]),
      cost: costIdx === -1 ? 0 : parseCost(fields[costIdx]),
    });
  }
  return readings;
}

function parseGasCsv(content) {
  const lines = content.split(/\r?\n/);
  const headerIdx = findHeaderIndex(lines, 'TYPE,DATE,START TIME');
  const header = lines[headerIdx].split(',');
  const col = (name) => header.indexOf(name);
  const dateIdx = col('DATE');
  const thermsIdx = col('USAGE (therms)');
  const costIdx = col('COST');

  const readings = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = line.split(',');
    readings.push({
      usageDate: fields[dateIdx],
      therms: parseFloat(fields[thermsIdx]),
      cost: costIdx === -1 ? 0 : parseCost(fields[costIdx]),
    });
  }
  return readings;
}

async function fetchLatest() {
  const auth = Buffer.from(`${API_AUTH_USER}:${API_AUTH_PASS}`).toString('base64');
  const res = await fetch(`${API_BASE_URL}/api/electric-usage/latest`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error(`GET /api/electric-usage/latest failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function postReadings(electric, gas) {
  const auth = Buffer.from(`${API_AUTH_USER}:${API_AUTH_PASS}`).toString('base64');
  const res = await fetch(`${API_BASE_URL}/api/electric-usage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ electric, gas }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`POST /api/electric-usage failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function login(page) {
  await page.locator('input[name="username"]').waitFor({ timeout: 15000 });
  await page.locator('input[name="username"]').fill(USERNAME);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button.PrimarySignInButton').click();

  // May include an MFA step — if the saved session has expired, this run will need
  // a human at the Mac Mini's screen to clear it (see CLAUDE.md's login-frequency notes).
  await page.waitForURL(url => !url.href.includes('login') && !url.href.includes('signin') && !url.href.includes('idp'), { timeout: 120000 });
  console.log('Logged in, now at:', page.url());
}

async function waitForGreenButton(page, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frames = page.frames();

    const btn = page.locator('button.green-button');
    if (await btn.count() > 0) return { button: btn, frame: page.mainFrame() };

    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameBtn = frame.locator('button.green-button');
        if (await frameBtn.count() > 0) return { button: frameBtn, frame };
      } catch (_) {}
    }

    await page.waitForTimeout(500);
  }

  throw new Error('Timed out waiting for button.green-button across all frames');
}

async function downloadExport(fromIso, toIso) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const sessionExists = fs.existsSync(SESSION_FILE);
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      ...(sessionExists ? { storageState: SESSION_FILE } : {}),
    });
    const page = await context.newPage();

    console.log('Navigating to usage page...');
    await page.goto(USAGE_URL, { waitUntil: 'load', timeout: 60000 });

    if (page.url().includes('login') || page.url().includes('signin') || page.url().includes('idp')) {
      console.log('Login required, authenticating...');
      await login(page);
      console.log('Saving session...');
      await context.storageState({ path: SESSION_FILE });
      await page.goto(USAGE_URL, { waitUntil: 'load', timeout: 60000 });
    } else {
      console.log('Reusing saved session.');
    }

    console.log('Waiting for Green Button (may take a moment for widget to load)...');
    const { button: greenButton, frame: opowerFrame } = await waitForGreenButton(page, 60000);

    console.log('Opening export form...');
    await greenButton.click();

    console.log('Waiting for export form...');
    const exportButton = opowerFrame.locator('button.button.primary:has-text("Export")');
    await exportButton.waitFor({ timeout: 15000 });

    console.log('Selecting "range of days" option...');
    await opowerFrame.locator('label[for="period-date"]').click();

    const fromDate = isoToMMDDYYYY(fromIso);
    const toDate = isoToMMDDYYYY(toIso);
    console.log(`Setting date range ${fromDate} - ${toDate}...`);
    const fromInput = opowerFrame.locator('#date-selector--select-date-from');
    const toInput = opowerFrame.locator('#date-selector--select-date-to');
    await fromInput.fill(fromDate);
    await fromInput.press('Tab');
    await toInput.fill(toDate);
    await toInput.press('Tab');

    console.log('Clicking Export...');
    const downloadPromise = context.waitForEvent('download', { timeout: 30000 }).catch((err) => ({ __error: err }));
    await exportButton.click();

    console.log('Waiting for download...');
    const download = await downloadPromise;

    if (download && download.__error) {
      console.log('No download fired within timeout. Dumping dialog HTML for diagnosis:');
      console.log(await opowerFrame.locator('body').innerHTML());
      throw download.__error;
    }

    const savePath = path.join(DOWNLOAD_DIR, download.suggestedFilename() || 'DailyUsageData.zip');
    await download.saveAs(savePath);
    console.log('Saved to:', savePath);
    return savePath;
  } finally {
    await browser.close();
  }
}

function extractAndParse(zipPath) {
  fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });

  execSync(`unzip -o "${zipPath}" -d "${EXTRACT_DIR}"`, { stdio: 'inherit' });

  const files = fs.readdirSync(EXTRACT_DIR);
  const electricFile = files.find((f) => f.includes('electric_usage_interval_data'));
  const gasFile = files.find((f) => f.includes('natural_gas_usage_interval_data'));

  const electric = electricFile
    ? parseElectricCsv(fs.readFileSync(path.join(EXTRACT_DIR, electricFile), 'utf8'))
    : [];
  const gas = gasFile
    ? parseGasCsv(fs.readFileSync(path.join(EXTRACT_DIR, gasFile), 'utf8'))
    : [];

  fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });
  return { electric, gas };
}

async function run() {
  console.log('Checking latest stored readings...');
  const latest = await fetchLatest();
  console.log('Latest stored:', latest);

  const electricNext = latest.electric ? addDaysIso(latest.electric.usageDate, 1) : null;
  const gasNext = latest.gas ? addDaysIso(latest.gas.usageDate, 1) : null;

  if (!electricNext && !gasNext) {
    throw new Error('Server has no existing electric or gas data — run a backfill before using the daily scraper.');
  }

  const fromIso = [electricNext, gasNext].filter(Boolean).sort()[0];
  const toIso = todayPacific();

  if (fromIso > toIso) {
    console.log(`Nothing new to fetch (next needed date ${fromIso} is after today ${toIso}).`);
    return;
  }

  console.log(`Fetching PG&E usage from ${fromIso} to ${toIso}...`);
  const zipPath = await downloadExport(fromIso, toIso);

  const { electric, gas } = extractAndParse(zipPath);
  console.log(`Parsed ${electric.length} electric rows, ${gas.length} gas rows.`);

  if (electric.length === 0 && gas.length === 0) {
    console.log('No rows in export — nothing to upload.');
  } else {
    console.log('Uploading to', API_BASE_URL, '...');
    const result = await postReadings(electric, gas);
    console.log('Upload result:', result);
  }

  fs.unlinkSync(zipPath);
  console.log('Done.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
