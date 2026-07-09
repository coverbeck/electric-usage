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
const SESSION_FILE = path.join(__dirname, 'session.json');

async function run() {
  const sessionExists = fs.existsSync(SESSION_FILE);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
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

  console.log('Waiting for Green Button (may take a moment for widget to load)...');
  const { button: greenButton, frame: opowerFrame } = await waitForGreenButton(page, 60000);

  console.log('Opening export form...');
  await greenButton.click();

  console.log('Waiting for export form...');
  const exportButton = opowerFrame.locator('button.button.primary:has-text("Export")');
  await exportButton.waitFor({ timeout: 15000 });

  console.log('Dumping export dialog form controls...\n');
  await dumpFormControls(opowerFrame);

  console.log('\nDone inspecting. Not clicking Export. Leaving browser open for 30s in case you want to look manually.');
  await page.waitForTimeout(30000);

  await browser.close();
}

async function dumpFormControls(frame) {
  const selects = await frame.locator('select').all();
  for (const select of selects) {
    const name = await select.getAttribute('name');
    const id = await select.getAttribute('id');
    const options = await select.locator('option').all();
    const optionInfo = [];
    for (const opt of options) {
      optionInfo.push({
        value: await opt.getAttribute('value'),
        text: (await opt.textContent() || '').trim(),
        selected: await opt.evaluate(el => el.selected),
      });
    }
    console.log(`SELECT name="${name}" id="${id}"`);
    console.log(JSON.stringify(optionInfo, null, 2));
  }

  const radios = await frame.locator('input[type="radio"]').all();
  for (const radio of radios) {
    const name = await radio.getAttribute('name');
    const value = await radio.getAttribute('value');
    const id = await radio.getAttribute('id');
    const checked = await radio.isChecked();
    let labelText = '';
    if (id) {
      const label = frame.locator(`label[for="${id}"]`);
      if (await label.count() > 0) labelText = (await label.first().textContent() || '').trim();
    }
    console.log(`RADIO name="${name}" value="${value}" id="${id}" checked=${checked} label="${labelText}"`);
  }

  const checkboxes = await frame.locator('input[type="checkbox"]').all();
  for (const cb of checkboxes) {
    const name = await cb.getAttribute('name');
    const value = await cb.getAttribute('value');
    const id = await cb.getAttribute('id');
    const checked = await cb.isChecked();
    let labelText = '';
    if (id) {
      const label = frame.locator(`label[for="${id}"]`);
      if (await label.count() > 0) labelText = (await label.first().textContent() || '').trim();
    }
    console.log(`CHECKBOX name="${name}" value="${value}" id="${id}" checked=${checked} label="${labelText}"`);
  }

  const dateInputs = await frame.locator('input[type="date"], input[type="text"][name*="date" i], input[id*="date" i]').all();
  for (const input of dateInputs) {
    const name = await input.getAttribute('name');
    const id = await input.getAttribute('id');
    const value = await input.inputValue().catch(() => '');
    console.log(`DATE-ISH INPUT name="${name}" id="${id}" value="${value}"`);
  }

  console.log('\nFull dialog HTML (for anything the above missed):');
  const dialogHtml = await frame.locator('body').innerHTML();
  console.log(dialogHtml);
}

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

  await page.waitForURL(url => !url.href.includes('login') && !url.href.includes('signin') && !url.href.includes('idp'), { timeout: 120000 });
  console.log('Logged in, now at:', page.url());
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
