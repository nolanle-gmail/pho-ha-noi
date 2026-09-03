const express = require('express');
const cors = require('cors');
const path = require('path');
const { migrate } = require('./db/schema');

migrate();
// Front-desk host accounts are created by the seed only, not auto-provisioned on
// boot — so a production directory reflects exactly the staff that were added.
// (SEED_DIRECTORY=1 opts back into auto-creating the host1..10 demo accounts.)
if (process.env.SEED_DIRECTORY === '1') require('./db/ensure-directory').ensureDirectory();

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
app.use('/api/roles', require('./routes/roles'));
// Mounted before the '/api' core router: these accept a Waitlist service key
// (no JWT), which core's verifyToken would otherwise reject. Messages does too
// (the Staff app proxies here with ?as=<email>).
app.use('/api/floorplan', require('./routes/floorplan'));
app.use('/api/visits', require('./routes/visits'));
app.use('/api/stafftasks', require('./routes/stafftasks'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/timeclock', require('./routes/timeclock'));
app.use('/api', require('./routes/core'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/central', require('./routes/central'));
app.use('/api/distribution', require('./routes/distribution'));
app.use('/api/schedule', require('./routes/schedule'));

const PORT = process.env.PORT || 4001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Enterprise Restaurant Management System running on http://localhost:${PORT}`));
}

module.exports = app;
