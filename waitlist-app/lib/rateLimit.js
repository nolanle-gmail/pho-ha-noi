// Tiny in-memory fixed-window rate limiter — no external dependencies. Good for a
// single-instance deploy (which the SQLite storage already implies). Keys off the
// client IP, so set `trust proxy` when running behind a reverse proxy (Caddy/nginx)
// or every request will look like it comes from the proxy.
const buckets = new Map(); // key -> { count, resetAt }

function rateLimit({ windowMs = 60000, max = 60, key, message = 'Too many requests — please slow down and try again shortly.' } = {}) {
  const keyOf = key || ((req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
  return (req, res, next) => {
    const now = Date.now();
    const k = keyOf(req);
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(k, b); }
    b.count++;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// Drop expired buckets periodically so memory doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 5 * 60000).unref();

module.exports = { rateLimit };
