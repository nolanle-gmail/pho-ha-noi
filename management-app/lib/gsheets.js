// Create a live Google Sheet from report data via a Google service account.
// No googleapis dependency — we sign the service-account JWT with jsonwebtoken and call the
// Sheets + Drive REST APIs with Node's built-in fetch.
//
// Configure with the service-account JSON key, preferably base64-encoded (avoids private-key
// newline issues in a Fly secret):
//   GOOGLE_SA_KEY_B64  = base64 of the whole service-account JSON key   (preferred)
//   GOOGLE_SA_KEY      = the raw service-account JSON                   (alternative)
// Sharing (optional):
//   GSHEET_LINK_ACCESS = view (default) | edit | none   — the "anyone with the link" permission
//   GSHEET_SHARE_EMAILS= comma-separated emails to also share as editors (e.g. the billing team)
//   GSHEET_NOTIFY      = true to email those people the link (default false)
const jwt = require('jsonwebtoken');

const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function saConfig() {
  let raw = process.env.GOOGLE_SA_KEY || '';
  if (!raw && process.env.GOOGLE_SA_KEY_B64) {
    try { raw = Buffer.from(process.env.GOOGLE_SA_KEY_B64, 'base64').toString('utf8'); } catch { /* bad base64 */ }
  }
  if (!raw) return null;
  let j; try { j = JSON.parse(raw); } catch { return null; }
  if (!j.client_email || !j.private_key) return null;
  return { client_email: j.client_email, private_key: j.private_key };
}
function isConfigured() { return !!saConfig(); }

let _tok = null; // { token, exp(ms) }
async function getAccessToken() {
  const sa = saConfig();
  if (!sa) throw new Error('Google Sheets isn’t configured on the server yet.');
  if (_tok && _tok.exp > Date.now() + 60000) return _tok.token;
  const assertion = jwt.sign({ scope: SCOPES }, sa.private_key,
    { algorithm: 'RS256', issuer: sa.client_email, audience: TOKEN_URL, expiresIn: 3600 });
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Google sign-in failed: ' + (d.error_description || d.error || ('HTTP ' + r.status)));
  _tok = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return _tok.token;
}

async function gapi(token, url, method, body) {
  const r = await fetch(url, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google API error: ' + ((d.error && d.error.message) || ('HTTP ' + r.status)));
  return d;
}

// Create a spreadsheet, write `values` (array of row arrays) to the first sheet, apply light
// formatting, share it per the env config, and return { id, url }.
async function createSheet({ title, sheetTitle = 'Sheet1', values = [], boldRows = [] }) {
  const token = await getAccessToken();
  const ss = await gapi(token, 'https://sheets.googleapis.com/v4/spreadsheets', 'POST', {
    properties: { title }, sheets: [{ properties: { title: sheetTitle } }],
  });
  const id = ss.spreadsheetId, url = ss.spreadsheetUrl;
  const sheetId = ss.sheets && ss.sheets[0] && ss.sheets[0].properties.sheetId;
  await gapi(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(sheetTitle)}!A1?valueInputOption=USER_ENTERED`, 'PUT', { values });
  if (sheetId != null) {
    const reqs = boldRows.map(ri => ({
      repeatCell: { range: { sheetId, startRowIndex: ri, endRowIndex: ri + 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' },
    }));
    reqs.push({ autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 11 } } });
    try { await gapi(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, 'POST', { requests: reqs }); } catch { /* formatting is best-effort */ }
  }
  await shareFile(token, id);
  return { id, url };
}

async function shareFile(token, id) {
  const base = `https://www.googleapis.com/drive/v3/files/${id}/permissions?supportsAllDrives=true&sendNotificationEmail=`;
  const emails = (process.env.GSHEET_SHARE_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  const notify = String(process.env.GSHEET_NOTIFY || '').toLowerCase() === 'true';
  for (const email of emails) {
    try { await gapi(token, base + (notify ? 'true' : 'false'), 'POST', { role: 'writer', type: 'user', emailAddress: email }); } catch { /* one bad email shouldn't block the rest */ }
  }
  const linkAccess = (process.env.GSHEET_LINK_ACCESS || 'view').toLowerCase();
  if (linkAccess === 'view' || linkAccess === 'edit') {
    try { await gapi(token, base + 'false', 'POST', { role: linkAccess === 'edit' ? 'writer' : 'reader', type: 'anyone' }); } catch { /* best-effort */ }
  }
}

module.exports = { isConfigured, createSheet };
