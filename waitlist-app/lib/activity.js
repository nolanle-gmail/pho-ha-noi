// Access / activity trail. Records who did what and when: every login attempt,
// every state-changing request (POST/PUT/PATCH/DELETE — including customer self
// check-ins), and every denied request (401/403). Successful GET reads (board
// refresh, kiosk polling) are skipped; flip LOG_READS=1 to capture those too.
const db = require('../db/database');

const LOG_READS = process.env.LOG_READS === '1';

// Real client IP: Fly sets Fly-Client-IP; fall back to X-Forwarded-For / req.ip.
function clientIp(req) {
  return req.headers['fly-client-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.ip || null;
}

function record({ userId, userName, userRole, method, path, status, ip, detail, locationId }) {
  try {
    db.prepare(`INSERT INTO activity_log (user_id, user_name, user_role, method, path, status, ip, detail, location_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      userId || null, userName || null, userRole || null,
      method || null, path || null, status || null, ip || null,
      detail ? JSON.stringify(detail) : null,
      Number.isFinite(locationId) ? locationId : null);
  } catch (e) {
    console.error('activityLog failed:', e.message);
  }
}
// Best-effort location for an entry: explicit location in the request, else the
// staff member's home location.
function locationOf(req) {
  const raw = (req.body && req.body.location_id) || (req.query && req.query.location_id) || (req.user && req.user.location_id);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function logLogin(req, { user, email, success }) {
  record({
    // Only local user ids reference this app's users table; Management-sourced
    // ids belong to the Management directory, so store null and rely on the
    // denormalized name/role below.
    userId: user && user.src !== 'mgmt' ? user.id : null,
    userName: user ? user.name : (email || null),
    userRole: user ? user.role : null,
    method: 'POST', path: '/api/auth/login', status: success ? 200 : 401,
    ip: clientIp(req), detail: { event: success ? 'login' : 'login_failed', email: email || null },
    locationId: user ? user.location_id : null,
  });
}

function activityLogger(req, res, next) {
  res.on('finish', () => {
    // Use originalUrl — mounting rewrites req.path/req.url inside sub-routers.
    const p = (req.originalUrl || req.url || '').split('?')[0];
    if (p === '/health' || p === '/api/auth/login') return;
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const denied = res.statusCode === 401 || res.statusCode === 403;
    if (!mutating && !denied && !LOG_READS) return;
    record({
      userId: req.user && req.user.src !== 'mgmt' ? req.user.id : null,
      userName: req.user ? req.user.name : null,
      userRole: req.user ? req.user.role : null,
      method: req.method,
      path: p,
      status: res.statusCode,
      ip: clientIp(req),
      locationId: locationOf(req),
    });
  });
  next();
}

module.exports = { activityLogger, logLogin, record };
