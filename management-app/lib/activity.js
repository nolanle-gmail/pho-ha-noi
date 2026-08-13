// Access / activity trail. Records who did what and when: every login attempt,
// every state-changing request (POST/PUT/PATCH/DELETE), and every denied request
// (401/403 — "tried to interact"). Successful GET reads (page loads, polling) are
// skipped to keep the trail meaningful; flip LOG_READS=1 to capture those too.
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
// Best-effort location for an entry: an explicit location in the request, else
// the actor's home location — so a location's Activity tab shows its own trail.
function locationOf(req) {
  const raw = (req.body && req.body.location_id) || (req.query && req.query.location_id) || (req.user && req.user.location_id);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// Explicit login logging (success or failure) with the attempted email.
function logLogin(req, { user, email, success }) {
  record({
    userId: user ? user.id : null,
    userName: user ? user.name : (email || null),
    userRole: user ? user.role : null,
    method: 'POST', path: '/api/auth/login', status: success ? 200 : 401,
    ip: clientIp(req), detail: { event: success ? 'login' : 'login_failed', email: email || null },
    locationId: user ? user.location_id : null,
  });
}

// Middleware — logs on response finish so it sees the final status and (for
// authenticated routes) req.user set by verifyToken.
function activityLogger(req, res, next) {
  res.on('finish', () => {
    // Use originalUrl — mounting rewrites req.path/req.url inside sub-routers.
    const p = (req.originalUrl || req.url || '').split('?')[0]; // strip query (may hold data)
    if (p === '/health' || p === '/api/auth/login') return; // health noise; login logged explicitly
    if (req.headers['x-service-key']) return; // proxied Staff-app calls are logged in that app
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const denied = res.statusCode === 401 || res.statusCode === 403;
    if (!mutating && !denied && !LOG_READS) return;
    record({
      userId: req.user ? req.user.id : null,
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
