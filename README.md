# Google Maps Lead Scraper & Contact Enrichment (Script-Only + Google Sheets)

A standalone Node.js Google Maps lead scraper built with **Puppeteer**, **Axios**, and **Cheerio** that syncs directly with your **Google Sheet** (`Search_Queue` and `Leads_Master`) without needing **n8n** or a Cloudflare tunnel.

---

## Quick Start (Script-Only Mode — No n8n Required)

### 1. Connect Your Google Sheet (1-Minute Setup)
1. Open your Google Sheet ([Gyms Assist - Lead Engine](https://docs.google.com/spreadsheets/d/1ZqCdSGbobE3AUzzNQOb-zzm0DyJL-kFpKHPKRhUuWlE/edit)).
2. Click **Extensions → Apps Script** in the top menu.
3. Paste the entire contents of [`google-apps-script.js`](file:///c:/Users/USER/Documents/gmaps-lead-scraper/google-apps-script.js) into `Code.gs` and press **Save**.
4. Click **Deploy → New deployment**, select type **Web app**:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
5. Click **Deploy**, authorize access, and copy the **Web app URL** (`https://script.google.com/macros/s/.../exec`).
6. Paste that URL into [`.env`](file:///c:/Users/USER/Documents/gmaps-lead-scraper/.env):
   ```env
   APPS_SCRIPT_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
   MAX_RESULTS=40
   USE_PROXY=false
   ```

### 2. Run the Queue Scraper
Whenever you have rows marked `Pending` in the `Search_Queue` tab, run:
```bash
npm run scrape
```
What happens automatically:
1. Fetches all `Pending` rows (`City`, `State`, `Keyword`) from `Search_Queue`.
2. Scrapes Google Maps and crawls each business website for emails, Facebook, Instagram, and DNS MX validation (retrying up to 5 times on transient errors).
3. Cleans phone numbers, addresses, and URL-encoded/placeholder emails.
4. Appends all leads in bulk to `Leads_Master` (skipping duplicate `Place_ID` entries).
5. Marks the `Search_Queue` row `Completed` (or `Failed`) with `Leads_Found` and `Last_run`.

### 3. Test Locally Without Google Sheets
To run a quick test scrape directly in your terminal:
```bash
node run-queue.js --test "Austin" "TX" "gym" 5
```

---

## Project Structure

- [`run-queue.js`](file:///c:/Users/USER/Documents/gmaps-lead-scraper/run-queue.js) — Standalone CLI runner that replaces the n8n workflow.
- [`google-apps-script.js`](file:///c:/Users/USER/Documents/gmaps-lead-scraper/google-apps-script.js) — Google Apps Script Web App code to paste into your Google Sheet.
- [`server.js`](file:///c:/Users/USER/Documents/gmaps-lead-scraper/server.js) — Core Puppeteer scraper, contact enricher, lead cleaner (`cleanLead`), and optional Express server (`npm start`).
- [`.env`](file:///c:/Users/USER/Documents/gmaps-lead-scraper/.env) — Configuration for `APPS_SCRIPT_URL`, `MAX_RESULTS`, and proxy settings.
- [`proxy-list.text`](file:///c:/Users/USER/Documents/gmaps-lead-scraper/proxy-list.text) — Optional HTTP proxy pool (`user:pass@ip:port`) used when `USE_PROXY=true`.
