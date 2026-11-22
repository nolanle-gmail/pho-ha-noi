// Self-check watchdog: periodically inspects the two things that silently take the
// whole app down — the SQLite volume filling up (writes start failing → every staff
// request errors) and the VM running out of memory — and alerts the owner/admin group
// BEFORE staff notice, reusing the existing in-app message + SMS channels. All checks
// are best-effort and never throw. Thresholds are env-tunable.
//
//   DISK_WARN_PCT (15)  free disk ≤ this %  → in-app message
//   DISK_CRIT_PCT (8)   free disk ≤ this %  → in-app message + SMS (imminent failure)
//   MEM_WARN_PCT  (10)  available RAM ≤ this % → in-app message
//   HEALTHWATCH_MIN (15) check interval, minutes
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db/database');
const { notify } = require('../routes/messages');
const { sendSms, smsEnabled } = require('./sms');

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const DISK_WARN_PCT = num(process.env.DISK_WARN_PCT, 15);
const DISK_CRIT_PCT = num(process.env.DISK_CRIT_PCT, 8);
const MEM_WARN_PCT = num(process.env.MEM_WARN_PCT, 10);
const INTERVAL_MS = num(process.env.HEALTHWATCH_MIN, 15) * 60000;

// Fraction of free space on the volume that holds the DB (0..1), or null if unknown.
function diskFreePct() {
  try {
    const dir = path.dirname(process.env.DB_PATH || '/data/x');
    const s = fs.statfsSync(dir);               // Node 18+
    if (!s || !s.blocks) return null;
    return { freePct: (s.bavail / s.blocks) * 100, freeGB: (s.bavail * s.bsize) / 1073741824, totGB: (s.blocks * s.bsize) / 1073741824 };
  } catch { return null; }
}

// Available-RAM fraction (0..1). Prefers /proc/meminfo MemAvailable (accounts for
// reclaimable cache/mmap); falls back to os.freemem on non-Linux.
function memAvailPct() {
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const tot = +(mi.match(/MemTotal:\s+(\d+)/) || [])[1];
    const avail = +(mi.match(/MemAvailable:\s+(\d+)/) || [])[1];
    if (tot && avail) return { availPct: (avail / tot) * 100, availMB: avail / 1024, totMB: tot / 1024 };
  } catch { /* fall through */ }
  const tot = os.totalmem(), free = os.freemem();
  return tot ? { availPct: (free / tot) * 100, availMB: free / 1048576, totMB: tot / 1048576 } : null;
}

function admins() {
  try { return db.prepare(`SELECT id, name, phone FROM users WHERE role IN ('owner','admin','ceo','president','hr') AND is_active=1 ORDER BY id`).all(); }
  catch { return []; }
}

// One alert per (key, severity) per local day, so a persistent condition doesn't spam.
const _sent = new Map();
function alert(key, severity, subject, body, sms) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const tag = `${key}:${severity}`;
  if (_sent.get(tag) === day) return;            // already alerted today at this severity
  _sent.set(tag, day);
  const who = admins();
  const sender = who[0] && who[0].id;
  if (!sender) { console.warn(`[healthwatch] ${subject} — ${body} (no admin to notify)`); return; }
  for (const a of who) { try { notify(sender, a.id, subject, body); } catch { /* best-effort */ } }
  if (sms && smsEnabled()) for (const a of who) { if (a.phone) { try { sendSms(a.phone, `${subject}: ${body}`).catch(() => {}); } catch { /* */ } } }
  console.warn(`[healthwatch] ALERT ${severity} ${subject} — ${body}`);
}

function check() {
  try {
    const d = diskFreePct();
    if (d) {
      if (d.freePct <= DISK_CRIT_PCT) alert('disk', 'crit', '🚨 Server disk almost full', `Only ${d.freeGB.toFixed(1)} GB free of ${d.totGB.toFixed(1)} GB (${d.freePct.toFixed(0)}%). The database volume is nearly full — writes may start failing. Extend the Fly volume now.`, true);
      else if (d.freePct <= DISK_WARN_PCT) alert('disk', 'warn', '⚠️ Server disk low', `${d.freeGB.toFixed(1)} GB free of ${d.totGB.toFixed(1)} GB (${d.freePct.toFixed(0)}%). Plan to extend the Fly volume soon.`, false);
      else { _sent.delete('disk:crit'); _sent.delete('disk:warn'); }   // recovered → re-arm
    }
    const m = memAvailPct();
    if (m) {
      if (m.availPct <= MEM_WARN_PCT) alert('mem', 'warn', '⚠️ Server memory low', `Only ${m.availMB.toFixed(0)} MB available of ${m.totMB.toFixed(0)} MB (${m.availPct.toFixed(0)}%). The app may slow or restart — consider a larger VM.`, false);
      else _sent.delete('mem:warn');
    }
  } catch (e) { console.error('[healthwatch]', e.message); }
}

function startHealthWatch() {
  setTimeout(check, 30000);                 // first check ~30s after boot
  const t = setInterval(check, INTERVAL_MS);
  if (t.unref) t.unref();
  console.log(`[healthwatch] disk/memory watch every ${INTERVAL_MS / 60000} min (disk warn ${DISK_WARN_PCT}% / crit ${DISK_CRIT_PCT}%, mem warn ${MEM_WARN_PCT}%).`);
}

module.exports = { startHealthWatch, diskFreePct, memAvailPct, check };
