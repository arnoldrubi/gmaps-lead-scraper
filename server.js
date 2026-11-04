const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const dns = require('dns').promises;

// Load environment variables from .env (built-in in Node 20.12+)
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (_) {}

const app = express();
app.use(express.json());

// Configure residential / primary proxy from .env (takes priority over proxy-list.text)
const ENV_PROXY_SERVER = (process.env.PROXY_SERVER || '').trim();
const ENV_PROXY_USERNAME = (process.env.PROXY_USERNAME || '').trim();
const ENV_PROXY_PASSWORD = (process.env.PROXY_PASSWORD || '').trim();

// Load proxy from .env first; fall back to proxy-list.text if .env PROXY_SERVER is empty
function loadProxyPool() {
  const pool = [];

  if (ENV_PROXY_SERVER) {
    const server = ENV_PROXY_SERVER.startsWith('http')
      ? ENV_PROXY_SERVER
      : `http://${ENV_PROXY_SERVER}`;
    pool.push({
      server,
      username: ENV_PROXY_USERNAME,
      password: ENV_PROXY_PASSWORD
    });
    return pool;
  }

  const listPath = path.join(__dirname, 'proxy-list.text');
  if (fs.existsSync(listPath)) {
    const lines = fs.readFileSync(listPath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      // Match user:pass@host:port
      const atIdx = line.lastIndexOf('@');
      if (atIdx !== -1) {
        const authPart = line.slice(0, atIdx);
        const hostPart = line.slice(atIdx + 1);
        const colonIdx = authPart.indexOf(':');
        const username = colonIdx !== -1 ? authPart.slice(0, colonIdx) : authPart;
        const password = colonIdx !== -1 ? authPart.slice(colonIdx + 1) : '';
        const server = hostPart.startsWith('http') ? hostPart : `http://${hostPart}`;
        pool.push({ server, username, password });
      } else {
        const server = line.startsWith('http') ? line : `http://${line}`;
        pool.push({
          server,
          username: ENV_PROXY_USERNAME,
          password: ENV_PROXY_PASSWORD
        });
      }
    }
  }

  return pool;
}

const PROXY_ENABLED = process.env.USE_PROXY === 'true';
const PROXY_POOL = PROXY_ENABLED ? loadProxyPool() : [];
let proxyIndex = 0;

function getNextProxy() {
  if (PROXY_POOL.length === 0) return null;
  const proxy = PROXY_POOL[proxyIndex % PROXY_POOL.length];
  proxyIndex = (proxyIndex + 1) % PROXY_POOL.length;
  return proxy;
}

// Junk email domains/patterns to ignore
const JUNK_EMAIL_PATTERNS = [
  /sentry/i, /wixpress/i, /example\.com/i, /domain\.com/i, /email\.com/i,
  /yourname/i, /username/i, /\.png$/i, /\.jpg$/i, /\.jpeg$/i, /\.gif$/i,
  /\.webp$/i, /\.svg$/i, /\.css$/i, /\.js$/i, /2x\./i, /@godaddy/i,
  /wordpress/i, /woocommerce/i, /squarespace/i, /shopify/i
];

// Helper: Extract emails and social links from HTML string
function extractContactsFromHtml(html) {
  const $ = cheerio.load(html);
  const emails = new Set();
  let facebook = '';
  let instagram = '';
  let contactPath = '';

  // 1. Check mailto: links and social links
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (href.startsWith('mailto:')) {
      const email = href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
      if (email) emails.add(email);
    } else if (!facebook && href.includes('facebook.com/') && !href.includes('sharer')) {
      facebook = href;
    } else if (!instagram && href.includes('instagram.com/')) {
      instagram = href;
    } else if (!contactPath && /(contact|about|connect)/i.test(href)) {
      contactPath = href;
    }
  });

  // 2. Regex scan over raw HTML text
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,10}/g;
  const rawMatches = html.match(emailRegex) || [];
  rawMatches.forEach(e => emails.add(e.toLowerCase().trim()));

  // 3. Filter out false positives
  const cleanEmails = [...emails].filter(email => {
    if (email.length > 60) return false;
    return !JUNK_EMAIL_PATTERNS.some(pattern => pattern.test(email));
  });

  // Prioritize role/owner emails for primary slot
  cleanEmails.sort((a, b) => {
    const priority = /^(owner|info|contact|sales|service|hello|shop|bikes|support)@/i;
    return (priority.test(b) ? 1 : 0) - (priority.test(a) ? 1 : 0);
  });

  return { cleanEmails, facebook, instagram, contactPath };
}

// Helper: Crawl Website Homepage + Contact Subpage
async function enrichFromWebsite(websiteUrl) {
  const result = {
    primaryEmail: '',
    allEmails: '',
    emailStatus: 'None',
    facebook: '',
    instagram: ''
  };

  if (!websiteUrl) return result;

  const axiosConfig = {
    timeout: 8000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    },
    maxRedirects: 4
  };

  try {
    const res = await axios.get(websiteUrl, axiosConfig);
    const html = typeof res.data === 'string' ? res.data : '';
    let { cleanEmails, facebook, instagram, contactPath } = extractContactsFromHtml(html);

    // Fallback: If no email on homepage, check the contact page
    if (cleanEmails.length === 0 && contactPath) {
      try {
        const contactUrl = new URL(contactPath, websiteUrl).href;
        const contactRes = await axios.get(contactUrl, axiosConfig);
        const subData = extractContactsFromHtml(typeof contactRes.data === 'string' ? contactRes.data : '');
        cleanEmails = subData.cleanEmails;
        if (!facebook) facebook = subData.facebook;
        if (!instagram) instagram = subData.instagram;
      } catch (_) {
        // Ignore subpage timeout/errors
      }
    }

    result.facebook = facebook;
    result.instagram = instagram;

    if (cleanEmails.length > 0) {
      result.primaryEmail = cleanEmails[0];
      result.allEmails = cleanEmails.join(', ');
      result.emailStatus = await validateEmailDomain(result.primaryEmail);
    }
  } catch (_) {
    // Website offline or blocking automated requests
  }

  return result;
}

// Helper: Zero-Cost Syntax + DNS MX Validation
async function validateEmailDomain(email) {
  const syntaxRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!syntaxRegex.test(email)) return 'Invalid_Syntax';

  const domain = email.split('@')[1];
  try {
    const mxRecords = await dns.resolveMx(domain);
    if (mxRecords && mxRecords.length > 0) {
      return 'Valid_MX';
    }
    return 'No_MX_Record';
  } catch (_) {
    return 'Invalid_Domain';
  }
}

// Helper: Safely decode URI component without throwing on malformed %
function safeDecodeURI(str) {
  try {
    return decodeURIComponent(str || '');
  } catch (_) {
    return String(str || '').replace(/%20/g, ' ');
  }
}

// Helper: Clean raw lead fields (replaces the n8n "Code in JavaScript" node)
function cleanLead(lead) {
  const cleanPhone = (lead.Phone || '').replace(/^[^\d+(]+/, '').trim();
  const cleanAddress = (lead.Address || '').replace(/^[\uE000-\uF8FF\s\n]+/, '').trim();

  const decodedPrimary = safeDecodeURI(lead.Primary_Email || '').trim();
  const cleanAllEmailsList = safeDecodeURI(lead.All_Emails || '')
    .split(',')
    .map(e => e.trim())
    .filter(e => e && !/^first\.last@/i.test(e));

  const cleanPrimaryEmail = /^first\.last@/i.test(decodedPrimary)
    ? (cleanAllEmailsList[0] || '')
    : decodedPrimary;

  return {
    ...lead,
    Phone: cleanPhone,
    Address: cleanAddress,
    Primary_Email: cleanPrimaryEmail,
    Email_Status: cleanPrimaryEmail ? lead.Email_Status : 'None',
    All_Emails: cleanAllEmailsList.join(', ')
  };
}

// Core Scraper Function (usable directly from scripts or via Express endpoint)
async function scrapeMaps({ city, state, keyword = 'bicycle shop', maxResults = 60 }) {
  if (!city || !state) {
    throw new Error('Both city and state are required.');
  }

  const maxAttempts = PROXY_POOL.length > 1 ? 3 : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proxy = getNextProxy();
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,900'
    ];

    if (proxy && proxy.server) {
      launchArgs.push(`--proxy-server=${proxy.server}`);
    }

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args: launchArgs
      });

      const page = await browser.newPage();
      if (proxy && proxy.username) {
        await page.authenticate({
          username: proxy.username,
          password: proxy.password
        });
      }

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');

      // Block heavy visual assets (photos, street view, fonts, media) to save ~80% proxy bandwidth
      // while keeping all scripts, XHR/fetch calls, and stylesheets intact so Google Maps works normally
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = req.resourceType();
        const url = req.url();
        if (
          type === 'image' ||
          type === 'media' ||
          type === 'font' ||
          url.includes('lh3.googleusercontent.com') ||
          url.includes('streetviewpixels') ||
          url.includes('ggpht.com')
        ) {
          return req.abort();
        }
        req.continue();
      });

      // Bypass Google cookie consent screens
      await page.setCookie({
        name: 'SOCS',
        value: 'CAISHAgBEhJnd3NfMjAyMzA4MTUtMF9SQzIaAmVuIAEaBgiAo_CmBg',
        domain: '.google.com',
        path: '/'
      });

      const searchQuery = encodeURIComponent(`${keyword} in ${city}, ${state}, USA`);
      const mapsUrl = `https://www.google.com/maps/search/${searchQuery}?hl=en`;

      await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // If Google still presents a consent form, click Accept
      const consentBtn = await page.$('form[action*="consent.google.com"] button, button[aria-label*="Accept all"]');
      if (consentBtn) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
          consentBtn.click()
        ]);
      }

      // Wait for the results feed container
      try {
        await page.waitForSelector('div[role="feed"]', { timeout: 25000 });
      } catch (err) {
        try {
          const diagnostics = await page.evaluate(() => {
            const pageText = (document.body?.innerText || '').toLowerCase();
            return {
              title: document.title,
              url: window.location.href,
              hasFeed: Boolean(document.querySelector('div[role="feed"]')),
              hasConsentForm: Boolean(document.querySelector('form[action*="consent.google.com"]')),
              mentionsCaptcha: pageText.includes('captcha'),
              mentionsUnusualTraffic: pageText.includes('unusual traffic'),
              bodyTextLength: pageText.length
            };
          });
          const screenshotPath = path.join(os.tmpdir(), `gmaps-scraper-failure-${Date.now()}.png`);
          await page.screenshot({ path: screenshotPath });
          console.warn(`Maps results feed diagnostics: ${JSON.stringify(diagnostics)}; screenshot: ${screenshotPath}`);
        } catch (diagnosticError) {
          console.warn(`Could not capture Maps page diagnostics: ${diagnosticError.message}`);
        }
        throw err;
      }

      // Scroll the feed to load listings
      await page.evaluate(async (limit) => {
        const feed = document.querySelector('div[role="feed"]');
        if (!feed) return;
        let lastHeight = 0;
        let attempts = 0;

        while (attempts < 15) {
          feed.scrollBy(0, 1500);
          await new Promise(r => setTimeout(r, 1500));

          const items = feed.querySelectorAll('a[href*="/maps/place/"]');
          if (items.length >= limit) break;

          if (feed.scrollHeight === lastHeight) {
            attempts++;
          } else {
            attempts = 0;
            lastHeight = feed.scrollHeight;
          }
        }
      }, maxResults);

      // Collect all unique listing URLs from the feed
      const placeLinks = await page.evaluate((limit) => {
        const anchors = Array.from(document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]'));
        const uniqueUrls = [...new Set(anchors.map(a => a.href))];
        return uniqueUrls.slice(0, limit);
      }, maxResults);

      const leads = [];

      // Visit each place URL to get clean Phone, Website, and Address
      for (const url of placeLinks) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForSelector('h1', { timeout: 8000 });

          const details = await page.evaluate((currentUrl) => {
            const getText = (sel) => {
              const el = document.querySelector(sel);
              return el ? el.innerText.trim() : '';
            };

            const name = getText('h1');
            const category = getText('button[jsaction*="category"]');
            const addressBtn = document.querySelector('button[data-item-id="address"]');
            const phoneBtn = document.querySelector('button[data-item-id^="phone:tel:"]');
            const websiteAnchor = document.querySelector('a[data-item-id="authority"]');

            // Rating & Reviews
            const ratingText = getText('div.F7nice span[aria-hidden="true"]');
            const reviewsEl = document.querySelector('div.F7nice span[aria-label*="reviews"]');
            const reviewsText = reviewsEl ? reviewsEl.getAttribute('aria-label').replace(/\D/g, '') : '';

            // Extract unique Place ID or CID from URL
            const placeIdMatch = currentUrl.match(/!1s([^!]+)!/) || currentUrl.match(/place\/([^/]+)/);
            const placeId = placeIdMatch ? placeIdMatch[1] : currentUrl;

            return {
              placeId,
              businessName: name,
              category,
              address: addressBtn ? addressBtn.innerText.trim() : '',
              phone: phoneBtn ? phoneBtn.innerText.trim() : '',
              website: websiteAnchor ? websiteAnchor.href.trim() : '',
              rating: ratingText,
              reviews: reviewsText
            };
          }, url);

          if (!details.businessName) continue;

          // Enrich from business website (Emails + Socials + MX Validation)
          const webEnrichment = await enrichFromWebsite(details.website);

          leads.push(cleanLead({
            Place_ID: details.placeId,
            Business_Name: details.businessName,
            Category: details.category || keyword,
            Phone: details.phone,
            Address: details.address,
            City: city,
            State: state,
            Website: details.website,
            Primary_Email: webEnrichment.primaryEmail,
            Email_Status: webEnrichment.emailStatus,
            All_Emails: webEnrichment.allEmails,
            Facebook: webEnrichment.facebook,
            Instagram: webEnrichment.instagram,
            Rating: details.rating,
            Reviews: details.reviews,
            Scraped_At: new Date().toISOString()
          }));
        } catch (_) {
          // Skip broken individual listing and continue
        }
      }

      await browser.close();
      return { count: leads.length, leads };

    } catch (err) {
      lastError = err;
      if (browser) await browser.close();
      console.warn(`Attempt ${attempt}/${maxAttempts} failed (${proxy ? proxy.server : 'no-proxy'}): ${err.message}`);
    }
  }

  throw lastError || new Error('Scrape failed');
}

// Main Endpoint Called by n8n (kept for backwards compatibility)
app.post('/scrape-maps', async (req, res) => {
  const { city, state, keyword = 'bicycle shop', maxResults = 60 } = req.body;

  if (!city || !state) {
    return res.status(400).json({ error: 'Both city and state are required.' });
  }

  try {
    const result = await scrapeMaps({ city, state, keyword, maxResults });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Scrape failed' });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3005;
  app.listen(PORT, () => {
    const proxyStatus = PROXY_ENABLED
      ? `${PROXY_POOL.length} proxies loaded`
      : 'proxy disabled';
    console.log(`Lead Scraper API running on port ${PORT} (${proxyStatus})`);
  });
}

module.exports = { scrapeMaps, cleanLead, app };
