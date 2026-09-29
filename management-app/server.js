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
app.use(express.json({ limit: '1mb' }));   // 1mb headroom for kiosk punch photos (small JPEGs)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Enterprise Restaurant Management System' }));
// Per-location time-clock kiosk (staff clock in / out tablet, no login).
// Each location has its own URL: /clock/<slug> (e.g. /clock/milpitas). The bare
// /clock shows a location picker. The page reads the slug from its own path.
// Notification setup guide (public, no login) — a shareable how-to for staff.
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/clock', (req, res) => res.sendFile(path.join(__dirname, 'public', 'clock.html')));
app.get('/clock/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'clock.html')));
// Per-location barcode-scanner kiosk (staff identify with their employee code, no login).
// /scanner shows a location picker; /scanner/<slug> pins the store (e.g. /scanner/san-jose).
app.get('/scanner', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scanner.html')));
app.get('/scanner/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scanner.html')));
// Public Service Flow kiosk (no login). Bare /sflow lets a staffer pick among their own stores;
// /sflow/<slug> pins a store (e.g. /sflow/fountain-valley or /sflow/fountainvalley).
app.get('/sflow', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sflow.html')));
app.get('/sflow/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sflow.html')));
// Busser Cleanup board (no login) — always-on kitchen tablet: /cleanup/<slug> shows one store's
// ready-to-bus tables; bare /cleanup lets you pick a store.
app.get('/cleanup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cleanup.html')));
app.get('/cleanup/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cleanup.html')));

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
app.use('/api/push', require('./routes/push'));
app.use('/api/alerts', require('./routes/alerts'));
// Staff-facing Service Flow (service key + ?as=). Mounted BEFORE the '/api' core router
// so its service-key requests aren't caught by core's verifyToken.
app.use('/api/sf', require('./routes/sfstaff'));
app.use('/api/sfkiosk', require('./routes/sfkiosk'));   // public Service Flow kiosk (employee code, no JWT)
app.use('/api/cleanup', require('./routes/cleanup'));   // public busser Cleanup board (no login)
app.use('/api/invscan', require('./routes/invscan'));
app.use('/api/scannerkiosk', require('./routes/scannerkiosk'));
app.use('/api/sms', require('./routes/sms'));
app.use('/api/translate', require('./routes/translate'));
app.use('/api/timeclock', require('./routes/timeclock'));
// Mounted before the '/api' core router: schedule's /mine accepts the Waitlist
// service key (core's verifyToken would otherwise reject the keyless request).
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api', require('./routes/core'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/glossary', require('./routes/glossary'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/central', require('./routes/central'));
app.use('/api/distribution', require('./routes/distribution'));
app.use('/api/toast', require('./routes/toast'));
app.use('/api/waitlistfeed', require('./routes/waitlistfeed'));

const PORT = process.env.PORT || 4001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Enterprise Restaurant Management System running on http://localhost:${PORT}`));
  // Background sweeps (real server only): missed clock-outs + break reminders.
  try { require('./routes/timeclock').startClockSweep(); } catch { /* optional */ }
  try { require('./routes/timeclock').startBreakSweep(); } catch { /* optional */ }
  // Auto-purge clock-kiosk punch photos older than the retention window (default 90 days).
  try { require('./routes/timeclock').startPunchPhotoPurge(); } catch { /* optional */ }
  // Weekly schedule auto-roll for locations that opted in.
  try { require('./routes/schedule').startScheduleRoll(); } catch { /* optional */ }
  // Automatic Toast sales sync during each mapped location's operating hours.
  try { require('./lib/toastSync').startToastSweep(); } catch { /* optional */ }
  // Resume the history backfill if it was interrupted (survives restarts/deploys).
  try { require('./lib/toastSync').startToastBackfillResume(); } catch { /* optional */ }
  // Live 3-min service-flow sweep (dry-run: logs "check on table", pings no one yet).
  try { require('./lib/toastSync').startToastLiveSweep(); } catch { /* optional */ }
  // One-time background backfill of pay_minutes (open→paid duration) for old orders.
  try { require('./lib/toastSync').startPayMinutesBackfill(); } catch { /* optional */ }
}

module.exports = app;
