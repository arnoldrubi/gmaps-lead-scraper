const path = require('path');
const axios = require('axios');
const { scrapeMaps } = require('./server');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (_) {}

const APPS_SCRIPT_URL = (process.env.APPS_SCRIPT_URL || '').trim();
const MAX_RESULTS = Number(process.env.MAX_RESULTS) || 40;
const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 2;
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS) || 5000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sends a POST request to the deployed Google Apps Script Web App.
 * Note: Google Apps Script returns a 302 redirect on POST; axios follows redirects
 * automatically when maxRedirects > 0.
 */
async function callSheetBridge(payload) {
  const res = await axios.post(APPS_SCRIPT_URL, JSON.stringify(payload), {
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    maxRedirects: 5,
    timeout: 60000
  });

  if (res.data && res.data.error) {
    throw new Error(`Google Sheet Bridge Error: ${res.data.error}`);
  }
  return res.data;
}

/**
 * Runs scrapeMaps with n8n-equivalent retry behavior (default: 2 tries, 5s wait).
 */
async function scrapeWithRetries(params) {
  let lastErr = null;
  for (let tryNum = 1; tryNum <= MAX_RETRIES; tryNum++) {
    try {
      return await scrapeMaps(params);
    } catch (err) {
      lastErr = err;
      console.warn(`  [Retry ${tryNum}/${MAX_RETRIES}] Scrape error for ${params.city}, ${params.state}: ${err.message}`);
      if (tryNum < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr || new Error('All scrape attempts failed');
}

async function runQueue() {
  const args = process.argv.slice(2);

  // Optional standalone CLI test mode: node run-queue.js --test "Austin" "TX" "gym" 5
  if (args[0] === '--test') {
    const city = args[1] || 'Austin';
    const state = args[2] || 'TX';
    const keyword = args[3] || 'gym';
    const maxResults = Number(args[4]) || 5;
    console.log(`[Test Mode] Scraping "${keyword}" in ${city}, ${state} (maxResults: ${maxResults})...`);
    const result = await scrapeMaps({ city, state, keyword, maxResults });
    console.log(`Found ${result.count} cleaned leads:`);
    console.log(JSON.stringify(result.leads, null, 2));
    return;
  }

  if (!APPS_SCRIPT_URL) {
    console.error('\n[!] Missing APPS_SCRIPT_URL in .env');
    console.error('To connect your Google Sheet without n8n:');
    console.error('  1. Open google-apps-script.js and follow the 1-minute setup steps at the top.');
    console.error('  2. Paste the Web App URL into .env as APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec');
    console.error('  3. Run: npm run scrape\n');
    console.error('Tip: To test the scraper locally without Google Sheets right now, run:');
    console.error('  node run-queue.js --test "Austin" "TX" "gym" 5\n');
    process.exit(1);
  }

  console.log('Fetching Pending rows from Google Sheets (Search_Queue)...');
  const { rows = [] } = await callSheetBridge({ action: 'getPending' });

  if (rows.length === 0) {
    console.log('No rows with Status = "Pending" found in Search_Queue. All caught up!');
    return;
  }

  console.log(`Found ${rows.length} pending row(s) to process (maxResults=${MAX_RESULTS}).\n`);

  let completedCount = 0;
  let failedCount = 0;
  let totalLeadsFound = 0;

  for (let i = 0; i < rows.length; i++) {
    const item = rows[i];
    const city = item.City;
    const state = item.State;
    const keyword = item.Keyword || 'gym';
    const rowNumber = item.row_number;

    console.log(`[${i + 1}/${rows.length}] Row #${rowNumber}: Scraping "${keyword}" in ${city}, ${state}...`);

    if (!city || !state) {
      console.warn(`  -> Skipping Row #${rowNumber} (missing City or State), marking Failed.`);
      await callSheetBridge({
        action: 'updateRowStatus',
        row_number: rowNumber,
        Status: 'Failed',
        Leads_Found: 0,
        Last_run: new Date().toISOString()
      });
      failedCount++;
      continue;
    }

    try {
      const result = await scrapeWithRetries({
        city,
        state,
        keyword,
        maxResults: MAX_RESULTS
      });

      const leads = result.leads || [];
      console.log(`  -> Scraped ${leads.length} lead(s). Appending to Leads_Master...`);

      if (leads.length > 0) {
        const appendRes = await callSheetBridge({
          action: 'appendLeads',
          leads,
          skipDuplicates: true
        });
        console.log(`  -> Appended ${appendRes.appended} lead(s) (${appendRes.skipped} duplicate(s) skipped).`);
      }

      await callSheetBridge({
        action: 'updateRowStatus',
        row_number: rowNumber,
        Status: 'Completed',
        Leads_Found: result.count,
        Last_run: new Date().toISOString()
      });

      console.log(`  -> Row #${rowNumber} marked Completed.\n`);
      completedCount++;
      totalLeadsFound += result.count;
    } catch (err) {
      console.error(`  -> Failed Row #${rowNumber}: ${err.message}`);
      try {
        await callSheetBridge({
          action: 'updateRowStatus',
          row_number: rowNumber,
          Status: 'Failed',
          Leads_Found: 0,
          Last_run: new Date().toISOString()
        });
      } catch (updateErr) {
        console.error(`  -> Could not mark Row #${rowNumber} Failed in sheet: ${updateErr.message}`);
      }
      failedCount++;
    }
  }

  console.log('============================================================');
  console.log(`Queue Run Finished!`);
  console.log(`  Completed Rows : ${completedCount}`);
  console.log(`  Failed Rows    : ${failedCount}`);
  console.log(`  Total Leads    : ${totalLeadsFound}`);
  console.log('============================================================');
}

runQueue().catch(err => {
  console.error('Fatal error in queue runner:', err.message);
  process.exit(1);
});
