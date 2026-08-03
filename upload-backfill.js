const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const EXTRACT_DIR = path.join(DOWNLOAD_DIR, '.upload-extract');

const API_BASE_URL = process.env.API_BASE_URL;
const API_AUTH_USER = process.env.API_AUTH_USER;
const API_AUTH_PASS = process.env.API_AUTH_PASS;

const DRY_RUN = process.argv.includes('--dry-run');

if (!DRY_RUN && (!API_BASE_URL || !API_AUTH_USER || !API_AUTH_PASS)) {
  console.error('API_BASE_URL, API_AUTH_USER, and API_AUTH_PASS env vars are required (unless using --dry-run)');
  process.exit(1);
}

function parseCost(str) {
  return parseFloat(str.trim().replace(/\$/g, ''));
}

function findHeaderIndex(lines, prefix) {
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  if (idx === -1) throw new Error(`Could not find header row starting with "${prefix}"`);
  return idx;
}

function parseElectricCsv(content) {
  const lines = content.split(/\r?\n/);
  const headerIdx = findHeaderIndex(lines, 'TYPE,DATE,START TIME');
  const readings = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [, date, startTime, endTime, importKwh, exportKwh, cost] = line.split(',');
    readings.push({
      usageDate: date,
      startTime,
      endTime,
      importKwh: parseFloat(importKwh),
      exportKwh: parseFloat(exportKwh),
      cost: parseCost(cost),
    });
  }
  return readings;
}

function parseGasCsv(content) {
  const lines = content.split(/\r?\n/);
  const headerIdx = findHeaderIndex(lines, 'TYPE,DATE,START TIME');
  const readings = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [, date, , , therms, cost] = line.split(',');
    readings.push({
      usageDate: date,
      therms: parseFloat(therms),
      cost: parseCost(cost),
    });
  }
  return readings;
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
    throw new Error(`Upload failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function run() {
  fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });

  const zipFiles = fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.endsWith('DailyUsageData.zip'));
  if (zipFiles.length === 0) {
    console.log('No *DailyUsageData.zip files found in downloads/. Nothing to do.');
    return;
  }

  console.log('Found zip files:', zipFiles);

  const uploadedZips = [];

  for (const zipFile of zipFiles) {
    const zipPath = path.join(DOWNLOAD_DIR, zipFile);
    const extractSubdir = path.join(EXTRACT_DIR, zipFile.replace('.zip', ''));
    fs.mkdirSync(extractSubdir, { recursive: true });

    console.log(`\nExtracting ${zipFile}...`);
    execSync(`unzip -o "${zipPath}" -d "${extractSubdir}"`, { stdio: 'inherit' });

    const files = fs.readdirSync(extractSubdir);
    const electricFile = files.find((f) => f.includes('electric_usage_interval_data'));
    const gasFile = files.find((f) => f.includes('natural_gas_usage_interval_data'));

    if (!electricFile && !gasFile) {
      console.log(`No recognized interval CSVs in ${zipFile} (probably an old billing export) — skipping.`);
      continue;
    }

    const electric = electricFile
      ? parseElectricCsv(fs.readFileSync(path.join(extractSubdir, electricFile), 'utf8'))
      : [];
    const gas = gasFile
      ? parseGasCsv(fs.readFileSync(path.join(extractSubdir, gasFile), 'utf8'))
      : [];

    console.log(`Parsed ${electric.length} electric rows, ${gas.length} gas rows from ${zipFile}`);
    if (electric.length) console.log('  sample electric row:', electric[0]);
    if (gas.length) console.log('  sample gas row:', gas[0]);

    if (DRY_RUN) continue;

    console.log(`Uploading ${zipFile} to ${API_BASE_URL}...`);
    const result = await postReadings(electric, gas);
    console.log('  result:', result);

    const electricOk = result.electric.received === electric.length;
    const gasOk = result.gas.received === gas.length;
    if (!electricOk || !gasOk) {
      throw new Error(`Row count mismatch for ${zipFile} — refusing to delete. Got: ${JSON.stringify(result)}`);
    }

    uploadedZips.push(zipPath);
  }

  fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });

  if (DRY_RUN) {
    console.log('\nDry run complete. Nothing uploaded, nothing deleted.');
    return;
  }

  console.log('\nAll uploads succeeded. Deleting uploaded zip files.');
  for (const zipPath of uploadedZips) {
    fs.unlinkSync(zipPath);
    console.log('Deleted', zipPath);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
