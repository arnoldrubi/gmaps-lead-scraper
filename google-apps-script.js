/**
 * ============================================================================
 * GOOGLE APPS SCRIPT BRIDGE FOR GMAPS LEAD SCRAPER
 * ============================================================================
 *
 * SETUP INSTRUCTIONS (One-Time, takes ~1 minute):
 * 1. Open your Google Sheet ("Gyms Assist - Lead Engine"):
 *    https://docs.google.com/spreadsheets/d/1ZqCdSGbobE3AUzzNQOb-zzm0DyJL-kFpKHPKRhUuWlE/edit
 * 2. Click "Extensions" -> "Apps Script" in the top menu.
 * 3. Delete any existing code in Code.gs and paste this entire file.
 * 4. Click the "Save" icon (or Ctrl+S).
 * 5. Click "Deploy" (top right) -> "New deployment".
 * 6. Click the gear icon next to "Select type" -> choose "Web app".
 * 7. Set:
 *    - Description: "Lead Scraper Bridge"
 *    - Execute as: "Me"
 *    - Who has access: "Anyone"
 * 8. Click "Deploy" (authorize access if prompted: Advanced -> Go to project).
 * 9. Copy the "Web app URL" (ends with /exec) and paste it into your .env file:
 *    APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
 * ============================================================================
 */

const QUEUE_SHEET_NAME = 'Search_Queue';
const LEADS_SHEET_NAME = 'Leads_Master';

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'status';
  if (action === 'getPending') {
    return jsonResponse(getPendingRows());
  }
  return jsonResponse({ status: 'ok', message: 'GMaps Lead Scraper Bridge is active.' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action;

    if (action === 'getPending') {
      return jsonResponse(getPendingRows());
    }

    if (action === 'appendLeads') {
      return jsonResponse(appendLeads(body.leads || [], body.skipDuplicates !== false));
    }

    if (action === 'updateRowStatus') {
      return jsonResponse(updateRowStatus(body));
    }

    return jsonResponse({ error: 'Unknown action: ' + action }, 400);
  } catch (err) {
    return jsonResponse({ error: err.message || String(err) }, 500);
  }
}

/**
 * Finds a column's 0-based index by matching header name (case-insensitive, trimmed).
 */
function findColIndex(headers, name) {
  const target = String(name).trim().toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim().toLowerCase() === target) {
      return i;
    }
  }
  return -1;
}

/**
 * Returns all rows from Search_Queue where Status == "Pending".
 */
function getPendingRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QUEUE_SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + QUEUE_SHEET_NAME + '" not found.');
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    return { rows: [] };
  }

  const headers = data[0];
  const cityIdx = findColIndex(headers, 'City');
  const stateIdx = findColIndex(headers, 'State');
  const keywordIdx = findColIndex(headers, 'Keyword');
  const statusIdx = findColIndex(headers, 'Status');

  const pendingRows = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const status = statusIdx !== -1 ? String(row[statusIdx] || '').trim() : '';
    if (status.toLowerCase() === 'pending') {
      pendingRows.push({
        row_number: r + 1, // 1-based sheet row number
        City: cityIdx !== -1 ? String(row[cityIdx] || '').trim() : '',
        State: stateIdx !== -1 ? String(row[stateIdx] || '').trim() : '',
        Keyword: keywordIdx !== -1 ? String(row[keywordIdx] || '').trim() : '',
        Status: status
      });
    }
  }

  return { rows: pendingRows };
}

/**
 * Appends cleaned leads to Leads_Master in a single bulk operation.
 */
function appendLeads(leads, skipDuplicates) {
  if (!leads || leads.length === 0) {
    return { appended: 0, skipped: 0 };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(LEADS_SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + LEADS_SHEET_NAME + '" not found.');
  }

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // Collect existing Place_IDs to prevent duplicate rows if enabled
  const existingPlaceIds = new Set();
  const placeIdColIdx = findColIndex(headers, 'Place_ID');
  const lastRow = sheet.getLastRow();
  if (skipDuplicates && placeIdColIdx !== -1 && lastRow > 1) {
    const existingValues = sheet.getRange(2, placeIdColIdx + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < existingValues.length; i++) {
      const id = String(existingValues[i][0] || '').trim();
      if (id) existingPlaceIds.add(id);
    }
  }

  const rowsToInsert = [];
  let skipped = 0;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const placeId = String(lead.Place_ID || '').trim();
    if (skipDuplicates && placeId && existingPlaceIds.has(placeId)) {
      skipped++;
      continue;
    }
    if (placeId) existingPlaceIds.add(placeId);

    // Map each header column dynamically (handles trailing spaces in sheet headers)
    const rowValues = headers.map(function (header) {
      const key = String(header).trim();
      if (key === 'Phone') {
        const phone = String(lead.Phone || '').trim();
        return phone ? "'" + phone : '';
      }
      return lead[key] !== undefined && lead[key] !== null ? lead[key] : '';
    });

    rowsToInsert.push(rowValues);
  }

  if (rowsToInsert.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rowsToInsert.length, headers.length).setValues(rowsToInsert);
  }

  return { appended: rowsToInsert.length, skipped: skipped };
}

/**
 * Updates Status, Leads_Found, and Last_run for a row in Search_Queue.
 */
function updateRowStatus(payload) {
  const rowNumber = Number(payload.row_number);
  if (!rowNumber || rowNumber < 2) {
    throw new Error('Invalid row_number: ' + payload.row_number);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(QUEUE_SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + QUEUE_SHEET_NAME + '" not found.');
  }

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  const statusIdx = findColIndex(headers, 'Status');
  const leadsFoundIdx = findColIndex(headers, 'Leads_Found');
  const lastRunIdx = findColIndex(headers, 'Last_run');

  if (statusIdx !== -1 && payload.Status !== undefined) {
    sheet.getRange(rowNumber, statusIdx + 1).setValue(payload.Status);
  }
  if (leadsFoundIdx !== -1 && payload.Leads_Found !== undefined) {
    sheet.getRange(rowNumber, leadsFoundIdx + 1).setValue(payload.Leads_Found);
  }
  if (lastRunIdx !== -1 && payload.Last_run !== undefined) {
    sheet.getRange(rowNumber, lastRunIdx + 1).setValue(payload.Last_run);
  }

  return { updated: true, row_number: rowNumber, Status: payload.Status };
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

