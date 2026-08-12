const express = require('express');
const cors = require('cors');
const path = require('path');
const { migrate } = require('./db/schema');

migrate();

const app = express();
// Behind a reverse proxy (Fly/Caddy/nginx), set TRUST_PROXY so req.ip is the real
// client IP recorded in the activity log. e.g. TRUST_PROXY=1
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Enterprise Restaurant Management System' }));
// Front-Desk time-clock kiosk (staff check-in / check-out tablet).
app.get('/clock', (req, res) => res.sendFile(path.join(__dirname, 'public', 'clock.html')));

// Activity trail — records logins, writes, and denied attempts across the API.
app.use(require('./lib/activity').activityLogger);

app.use('/api/auth', require('./routes/auth'));
// Mounted before the '/api' core router: floor-plan accepts a Waitlist service
// key (no JWT), which core's verifyToken would otherwise reject.
app.use('/api/floorplan', require('./routes/floorplan'));
app.use('/api', require('./routes/core'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/central', require('./routes/central'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/timeclock', require('./routes/timeclock'));

const PORT = process.env.PORT || 4001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Enterprise Restaurant Management System running on http://localhost:${PORT}`));
}

module.exports = app;
