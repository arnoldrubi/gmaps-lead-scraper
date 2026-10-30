# Google Maps Lead Scraper & Contact Enrichment API

A lightweight Node.js API built with **Express**, **Puppeteer**, **Axios**, and **Cheerio** designed to be called by **n8n** (or any HTTP client). It scrapes business listings from Google Maps by city/state/keyword, visits each business's website to extract email addresses and social media links, and verifies email deliverability via DNS `MX` record lookups.

---

## Features

- **Google Maps Scraping (Puppeteer):** Searches Google Maps (`<keyword> in <city>, <state>, USA`), scrolls the results feed, and visits each listing to extract the business name, category, phone number, physical address, website URL, star rating, review count, and Place ID.
- **Website Contact Enrichment:** Crawls each business's homepage (and falls back to `/contact`, `/about`, or `/connect` pages) to find email addresses, **Facebook** links, and **Instagram** links.
- **Smart Email Filtering & Prioritization:** Strips out junk/system emails (`@sentry`, `@wixpress`, image filenames, etc.) and prioritizes role/owner addresses (`owner@`, `info@`, `contact@`, `sales@`, `bikes@`, etc.) as the `Primary_Email`.
- **Zero-Cost Email Validation:** Checks email syntax and performs a live DNS `MX` lookup (`Valid_MX`, `No_MX_Record`, `Invalid_Domain`, or `Invalid_Syntax`).
- **Proxy Pool Rotation & Retries:** Automatically rotates through proxies in `proxy-list.text` (or falls back to `.env`) and retries failed requests across up to 3 proxies.
- **Bandwidth Optimization:** Blocks heavy visual assets (photos, Street View thumbnails, fonts, and media) in Puppeteer to reduce proxy data consumption by ~75–80% while keeping Google Maps DOM/XHR behavior intact.

---

## Prerequisites

- **Node.js** `v20.12.0+` (tested on `v24.x`; uses built-in `process.loadEnvFile()`)
- **npm**

---

## Installation

```bash
npm install
```

---

## Configuration (Proxies & Environment Variables)

The server supports two ways to configure proxies:

### 1. Proxy Pool (`proxy-list.text`) — *Recommended*
Place a `proxy-list.text` file in the project root with one proxy per line in the format:
```text
username:password@host:port
```
If `proxy-list.text` is present, the server automatically loads all proxies into a round-robin pool and rotates through them on every scrape request (retrying up to 3 different proxies if a connection fails).

### 2. Single Fallback Proxy (`.env`)
Create a `.env` file in the project root:
```env
PROXY_SERVER=http://209.50.174.184:3129
PROXY_USERNAME=your_proxy_username
PROXY_PASSWORD=your_proxy_password
PORT=3005
```
If `proxy-list.text` is empty or missing, the server falls back to `PROXY_SERVER` from `.env`.

---

## Running the Server

```bash
node server.js
```

By default, the server listens on port `3005`:
```text
Lead Scraper API running on port 3005 (100 proxies loaded)
```

---

## API Reference

### `POST /scrape-maps`

Scrapes Google Maps listings and enriches them with website contact data.

#### Request Headers
```http
Content-Type: application/json
```

#### Request Body
| Field | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `city` | `string` | **Yes** | — | Target city (e.g., `"Austin"`) |
| `state` | `string` | **Yes** | — | Target state (e.g., `"TX"` or `"Texas"`) |
| `keyword` | `string` | No | `"bicycle shop"` | Search keyword or business category |
| `maxResults` | `number` | No | `60` | Maximum number of listings to collect |

#### Example Request (`curl`)
```bash
curl -X POST http://localhost:3005/scrape-maps \
  -H "Content-Type: application/json" \
  -d '{
    "city": "Austin",
    "state": "TX",
    "keyword": "bicycle shop",
    "maxResults": 20
  }'
```

#### Example Response
```json
{
  "count": 1,
  "leads": [
    {
      "Place_ID": "0x8644b508b173c0f9:0x7e40717a4d621712",
      "Business_Name": "Example Bike Shop",
      "Category": "Bicycle store",
      "Phone": "(512) 555-0199",
      "Address": "123 Congress Ave, Austin, TX 78701",
      "City": "Austin",
      "State": "TX",
      "Website": "https://examplebikeshop.com/",
      "Primary_Email": "info@examplebikeshop.com",
      "Email_Status": "Valid_MX",
      "All_Emails": "info@examplebikeshop.com, sales@examplebikeshop.com",
      "Facebook": "https://www.facebook.com/examplebikeshop",
      "Instagram": "https://www.instagram.com/examplebikeshop",
      "Rating": "4.8",
      "Reviews": "245",
      "Scraped_At": "2026-10-30T16:00:00.000Z"
    }
  ]
}
```

---

## Using with n8n

1. Add an **HTTP Request** node in n8n.
2. Set **Method** to `POST` and **URL** to `http://localhost:3005/scrape-maps` (or your tunnel/host URL).
3. Enable **Send Body** (`JSON`) and pass `city`, `state`, `keyword`, and `maxResults`.
4. Increase the HTTP Request node **Timeout** (under *Options -> Timeout*) to `300000` (5 minutes), since scraping and enriching 20–60 listings sequentially takes roughly 1–3 minutes.

---

## Project Structure

- `server.js` — Main Express server, Puppeteer Google Maps scraper, website crawler, and DNS MX email validator.
- `.env` — Environment configuration for port and fallback proxy credentials.
- `proxy-list.text` — List of HTTP proxies (`user:pass@ip:port`) used for automatic proxy rotation.
- `package.json` — Node.js dependencies (`express`, `puppeteer`, `axios`, `cheerio`).
