const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PGE_USERNAME = process.env.PGE_USERNAME;
const PGE_PASSWORD = process.env.PGE_PASSWORD;
const API_BASE_URL = process.env.API_BASE_URL;
const API_AUTH_USER = process.env.API_AUTH_USER;
const API_AUTH_PASS = process.env.API_AUTH_PASS;

const DRY_RUN = process.argv.includes('--dry-run');

if (!PGE_USERNAME || !PGE_PASSWORD) {
  console.error('PGE_USERNAME and PGE_PASSWORD env vars are required');
  process.exit(1);
}
if (!DRY_RUN && (!API_BASE_URL || !API_AUTH_USER || !API_AUTH_PASS)) {
  console.error('API_BASE_URL, API_AUTH_USER, and API_AUTH_PASS env vars are required (unless using --dry-run)');
  process.exit(1);
}

const USAGE_URL = 'https://myaccount.pge.com/myaccount/s/usageandconsumption-homepage';
const SESSION_FILE = path.join(__dirname, 'session.json');
const BILLS_OPERATION_NAME = 'WDB_GetCostUsageReadsForBills';

async function run() {
  const sessionExists = fs.existsSync(SESSION_FILE);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    ...(sessionExists ? { storageState: SESSION_FILE } : {}),
  });
  const page = await context.newPage();

  let billsResponseBody = null;
  page.on('requestfinished', async (request) => {
    if (!/graphql/i.test(request.url())) return;
    try {
      const postData = request.postData();
      if (!postData || !postData.includes(BILLS_OPERATION_NAME)) return;
      const response = await request.response();
      if (!response) return;
      billsResponseBody = await response.text();
    } catch (_) {}
  });

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

  console.log('Waiting for BillInsights/OpowerDataBrowser frame to load...');
  const billFrame = await waitForBillFrame(page, 60000);

  console.log('Selecting "Bill view" to trigger the bill-history GraphQL query...');
  billsResponseBody = null;
  await billFrame.locator('select').first().selectOption('day');

  console.log('Waiting for bill-history response...');
  await waitForCondition(() => billsResponseBody !== null, 30000);

  const periods = extractBillingPeriods(billsResponseBody);
  console.log(`Extracted ${periods.length} billing period(s). Earliest: ${periods[0]?.startDate}, latest: ${periods[periods.length - 1]?.endDate}`);

  await browser.close();

  if (DRY_RUN) {
    console.log('\nDry run — not uploading. Sample periods:', periods.slice(0, 3), '...', periods.slice(-3));
    return;
  }

  console.log(`Uploading ${periods.length} periods to ${API_BASE_URL}...`);
  const result = await uploadPeriods(periods);
  console.log('Result:', result);
}

function extractBillingPeriods(responseBody) {
  const json = JSON.parse(responseBody);
  const bills = json.data?.billingAccountByAuthContext?.bills ?? [];

  const seen = new Set();
  const periods = [];
  for (const bill of bills) {
    const [startIso, endIso] = bill.timeInterval.split('/');
    const startDate = toPacificDate(startIso);
    const endDate = toPacificDate(endIso);
    const key = `${startDate}/${endDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    periods.push({ startDate, endDate });
  }
  return periods;
}

function toPacificDate(isoString) {
  return new Date(isoString).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

async function uploadPeriods(periods) {
  const auth = Buffer.from(`${API_AUTH_USER}:${API_AUTH_PASS}`).toString('base64');

  const res = await fetch(`${API_BASE_URL}/api/billing-periods`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ periods }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function waitForCondition(predicate, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Timed out waiting for condition');
}

// Find the iframe hosting the bill-insights widget (identified by button.green-button,
// same as the Green Button export widget lives alongside it in a sibling frame).
async function waitForBillFrame(page, timeout) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const match = page.frames().find((f) => /BillInsights|OpowerDataBrowser/i.test(f.url()));
    if (match) return match;
    await page.waitForTimeout(500);
  }

  throw new Error('Timed out waiting for BillInsights/OpowerDataBrowser frame');
}

async function login(page) {
  await page.locator('input[name="username"]').waitFor({ timeout: 15000 });

  await page.locator('input[name="username"]').fill(PGE_USERNAME);
  await page.locator('input[name="password"]').fill(PGE_PASSWORD);

  await page.locator('button.PrimarySignInButton').click();

  await page.waitForURL(url => !url.href.includes('login') && !url.href.includes('signin') && !url.href.includes('idp'), { timeout: 120000 });
  console.log('Logged in, now at:', page.url());
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
