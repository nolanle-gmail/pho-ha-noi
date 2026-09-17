// Toast POS REST API client (read-only). Safe by default: with no credentials
// configured it is "disabled" and every call reports that instead of throwing —
// the app runs exactly as before until Toast keys are set.
//
// Credentials (set as env / Fly secrets, NEVER committed):
//   TOAST_CLIENT_ID       — API client id  (created in Toast Web → Standard API access)
//   TOAST_CLIENT_SECRET   — API client secret
//   TOAST_HOST            — API host; default production. Sandbox:
//                           https://ws-sandbox-api.toasttab.com
//
// Access model: Standard API access is READ-ONLY. Each request carries a Bearer
// token (from the auth endpoint) plus a `Toast-Restaurant-External-ID` header that
// selects which restaurant (GUID) the call is for. Tokens last a few hours; we
// cache one and refresh shortly before it expires. Uses the global fetch (Node 18+).
const HOST = (process.env.TOAST_HOST || 'https://ws-api.toasttab.com').replace(/\/+$/, '');
const CLIENT_ID = process.env.TOAST_CLIENT_ID || '';
const CLIENT_SECRET = process.env.TOAST_CLIENT_SECRET || '';

const toastEnabled = () => !!(CLIENT_ID && CLIENT_SECRET);
const toastHost = () => HOST;

// ── Auth token cache ──────────────────────────────────────────────────────────
let _token = null;         // { accessToken, expiresAt (ms epoch) }
let _pending = null;       // in-flight login promise (de-dupes concurrent callers)

async function login() {
  const r = await fetch(`${HOST}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, userAccessType: 'TOAST_MACHINE_CLIENT' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`toast_auth_http_${r.status}: ${(j && (j.message || j.error)) || 'login failed'}`);
  // The token lives under `token` in the response envelope.
  const t = (j && j.token) || j;
  if (!t || !t.accessToken) throw new Error('toast_auth_no_token');
  const ttlMs = (Number(t.expiresIn) || 3600) * 1000;
  _token = { accessToken: t.accessToken, expiresAt: Date.now() + ttlMs - 60000 }; // refresh 60s early
  return _token.accessToken;
}

async function getToken() {
  if (!toastEnabled()) throw new Error('toast_not_configured');
  if (_token && Date.now() < _token.expiresAt) return _token.accessToken;
  if (!_pending) _pending = login().finally(() => { _pending = null; });
  return _pending;
}

// ── Core request (read-only GET) ──────────────────────────────────────────────
// path: absolute API path (e.g. '/orders/v2/ordersBulk'). guid: restaurant GUID
// for the Toast-Restaurant-External-ID header. query: object of query params.
// Handles token refresh on 401 (once) and simple backoff on 429 / 5xx.
async function toastGet(path, { guid, query } = {}, _retry = 0) {
  if (!toastEnabled()) throw new Error('toast_not_configured');
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (guid) headers['Toast-Restaurant-External-ID'] = guid;
  const r = await fetch(`${HOST}${path}${qs}`, { headers });
  if (r.status === 401 && _retry === 0) { _token = null; return toastGet(path, { guid, query }, 1); }
  if ((r.status === 429 || r.status >= 500) && _retry < 3) {
    const wait = Number(r.headers.get('Retry-After')) * 1000 || (500 * Math.pow(2, _retry));
    await new Promise((res) => setTimeout(res, Math.min(wait, 8000)));
    return toastGet(path, { guid, query }, _retry + 1);
  }
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) {
    const msg = (body && (body.message || body.error)) || `http_${r.status}`;
    const err = new Error(`toast_${r.status}: ${msg}`); err.status = r.status; err.body = body; throw err;
  }
  // Toast returns a next-page cursor in a response header for paged endpoints.
  const next = r.headers.get('Toast-Next-Page-Token') || r.headers.get('toast-next-page-token');
  return { body, nextPageToken: next || null };
}

// Fetch every page of a paged endpoint into a single array. Toast paging uses a
// pageToken cursor (returned via the Toast-Next-Page-Token header) with pageSize.
async function toastGetAll(path, { guid, query, pageSize = 100, max = 10000 } = {}) {
  const out = [];
  let pageToken = null;
  do {
    const q = Object.assign({ pageSize }, query || {}, pageToken ? { pageToken } : {});
    const { body, nextPageToken } = await toastGet(path, { guid, query: q });
    if (Array.isArray(body)) out.push(...body);
    else if (body != null) out.push(body);
    pageToken = nextPageToken;
  } while (pageToken && out.length < max);
  return out;
}

// Basic connectivity check: fetch a restaurant's general info. Proves the token +
// the restaurant GUID work, without importing any operational data.
async function getRestaurantInfo(guid) {
  const { body } = await toastGet(`/restaurants/v1/restaurants/${encodeURIComponent(guid)}`, { guid });
  return body;
}

module.exports = { toastEnabled, toastHost, getToken, toastGet, toastGetAll, getRestaurantInfo };
