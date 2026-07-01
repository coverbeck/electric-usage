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

  // The opower widget loads asynchronously inside an iframe.
  // Search all frames for the green button and remember which frame it's in.
  console.log('Waiting for Green Button (may take a moment for widget to load)...');
  const { button: greenButton, frame: opowerFrame } = await waitForGreenButton(page, 60000);

  console.log('Opening export form...');
  await greenButton.click();

  console.log('Waiting for export form...');
  const exportButton = opowerFrame.locator('button.button.primary:has-text("Export")');
  await exportButton.waitFor({ timeout: 15000 });

  console.log('Clicking Export...');
  const downloadPromise = context.waitForEvent('download');
  await exportButton.click();

  console.log('Waiting for download...');
  const download = await downloadPromise;
  const savePath = path.join(DOWNLOAD_DIR, download.suggestedFilename() || 'pge-usage.csv');
  await download.saveAs(savePath);
  console.log('Saved to:', savePath);

  await browser.close();
}

// Search main frame and all child iframes for button.green-button.
async function waitForGreenButton(page, timeout) {
  const deadline = Date.now() + timeout;
  let lastFrameCount = 0;

  while (Date.now() < deadline) {
    const frames = page.frames();

    if (frames.length !== lastFrameCount) {
      lastFrameCount = frames.length;
      console.log('Frames present:');
      for (const frame of frames) {
        console.log(' ', frame.url());
      }
    }

    // Check main frame
    const btn = page.locator('button.green-button');
    if (await btn.count() > 0) return { button: btn, frame: page.mainFrame() };

    // Check iframes
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameBtn = frame.locator('button.green-button');
        if (await frameBtn.count() > 0) return { button: frameBtn, frame };
      } catch (_) {}
    }

    await page.waitForTimeout(500);
  }

  console.log('Final frames at timeout:');
  for (const frame of page.frames()) {
    console.log(' ', frame.url());
  }

  throw new Error('Timed out waiting for button.green-button across all frames');
}

async function login(page) {
  await page.locator('input[name="username"]').waitFor({ timeout: 15000 });

  await page.locator('input[name="username"]').fill(USERNAME);
  await page.locator('input[name="password"]').fill(PASSWORD);

  await page.locator('button.PrimarySignInButton').click();

  // Wait for post-login navigation (may include MFA step — handle manually in the browser).
  await page.waitForURL(url => !url.href.includes('login') && !url.href.includes('signin') && !url.href.includes('idp'), { timeout: 120000 });
  console.log('Logged in, now at:', page.url());
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
