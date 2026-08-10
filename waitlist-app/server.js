const express = require('express');
const cors = require('cors');
const path = require('path');
const { migrate } = require('./db/schema');

migrate();

const app = express();
// Behind a reverse proxy (Caddy/nginx/Lightsail LB), set TRUST_PROXY so req.ip is
// the real client IP (needed for rate limiting). e.g. TRUST_PROXY=1 or "loopback".
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use(cors());
app.use(express.json({ limit: '16kb' })); // small bodies only — this is a waitlist
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Pho Ha Noi — Waitlist' }));
// Customer self-check-in kiosk (public, no login). /checkin/<slug> pins a store.
app.get(['/checkin', '/checkin/*'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
// Activity trail — logins, writes (incl. self check-ins), and denied attempts.
app.use(require('./lib/activity').activityLogger);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/public', require('./routes/public'));
app.use('/api/waitlist', require('./routes/waitlist'));

const PORT = process.env.PORT || 4002;
if (require.main === module) app.listen(PORT, () => console.log(`Pho Ha Noi Waitlist running on http://localhost:${PORT}`));

module.exports = app;
