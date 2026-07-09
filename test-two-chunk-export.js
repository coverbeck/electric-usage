const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const USERNAME = process.env.PGE_USERNAME;
const PASSWORD = process.env.PGE_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('PGE_USERNAME and PGE_PASSWORD env vars are required');
  process.exit(1);
}

const USAGE_URL = 'https://myaccount.pge.com/myaccount/s/usageandconsumption-homepage';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const SESSION_FILE = path.join(__dirname, 'session.json');

const CHUNKS = [
  { from: '01/01/2026', to: '07/07/2026', label: 'chunk2-2026' },
];

async function run() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const sessionExists = fs.existsSync(SESSION_FILE);
  const browser = await chromium.launch({ headless: false });
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

  console.log('On usage page:', page.url());

  for (const chunk of CHUNKS) {
    console.log(`\n=== Exporting ${chunk.label}: ${chunk.from} - ${chunk.to} ===`);
    console.log('Re-navigating to usage page for a fresh widget...');
    await page.goto(USAGE_URL, { waitUntil: 'load', timeout: 60000 });
    await exportChunk(page, chunk);
  }

  console.log('\nAll chunks done. Closing browser.');
  await browser.close();
}

async function exportChunk(page, { from, to, label }) {
  console.log('Waiting for Green Button (may take a moment for widget to load)...');
  const { button: greenButton, frame: opowerFrame } = await waitForGreenButton(page, 60000);

  console.log('Opening export form...');
  await greenButton.click();

  console.log('Waiting for export form...');
  const exportButton = opowerFrame.locator('button.button.primary:has-text("Export")');
  await exportButton.waitFor({ timeout: 15000 });

  console.log('Selecting "range of days" option...');
  await opowerFrame.locator('label[for="period-date"]').click();

  console.log(`Setting date range ${from} - ${to}...`);
  const fromInput = opowerFrame.locator('#date-selector--select-date-from');
  const toInput = opowerFrame.locator('#date-selector--select-date-to');
  await fromInput.fill(from);
  await fromInput.press('Tab');
  await toInput.fill(to);
  await toInput.press('Tab');

  console.log('Values after fill:', await fromInput.inputValue(), await toInput.inputValue());

  await page.waitForTimeout(1000);
  const errorLocator = opowerFrame.locator('[class*="error" i], [role="alert"]');
  const errorCount = await errorLocator.count();
  for (let i = 0; i < errorCount; i++) {
    const text = (await errorLocator.nth(i).textContent() || '').trim();
    if (text) console.log('POSSIBLE VALIDATION MESSAGE:', text);
  }

  console.log('Clicking Export...');
  const downloadPromise = page.context().waitForEvent('download', { timeout: 30000 }).catch(err => ({ __error: err }));
  await exportButton.click();

  console.log('Waiting for download (or error)...');
  const download = await downloadPromise;

  if (download && download.__error) {
    console.log('No download fired within timeout. Dumping dialog HTML for diagnosis:');
    console.log(await opowerFrame.locator('body').innerHTML());
    throw new Error(`Export failed for ${label}`);
  }

  const savePath = path.join(DOWNLOAD_DIR, `${label}-` + (download.suggestedFilename() || 'pge-usage.zip'));
  await download.saveAs(savePath);
  console.log('Saved to:', savePath);
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

async function login(page) {
  await page.locator('input[name="username"]').waitFor({ timeout: 15000 });

  await page.locator('input[name="username"]').fill(USERNAME);
  await page.locator('input[name="password"]').fill(PASSWORD);

  await page.locator('button.PrimarySignInButton').click();

  await page.waitForURL(url => !url.href.includes('login') && !url.href.includes('signin') && !url.href.includes('idp'), { timeout: 120000 });
  console.log('Logged in, now at:', page.url());
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
