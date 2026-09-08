// Web Push (VAPID) — the Management app is the sender: it stores each user's push
// subscriptions and delivers a real OS notification (works when the app is closed
// or the phone is on silent, unlike the in-page Web Audio chime). Subscriptions are
// registered from the Staff PWA (proxied here with the service key) and from the
// Management PWA directly. Best-effort throughout: a missing dependency, unset VAPID
// keys, or a dead endpoint never breaks the request that triggered the push.
const db = require('../db/database');

let webpush = null;
try { webpush = require('web-push'); } catch { /* dependency absent — push disabled, log-only */ }

const PUBLIC = process.env.VAPID_PUBLIC || '';
const PRIVATE = process.env.VAPID_PRIVATE || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:harry@phohanoi.com';

let ready = false;
if (webpush && PUBLIC && PRIVATE) {
  try { webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE); ready = true; }
  catch (e) { console.error('push: bad VAPID config —', e.message); }
}

const enabled = () => ready;
const publicKey = () => (ready ? PUBLIC : '');

// Upsert a subscription for a user, keyed by its unique endpoint. If the same
// endpoint was previously registered to another user (shared device), it moves.
function saveSubscription(userId, sub, ua) {
  if (!userId || !sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return false;
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua)
    VALUES (?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, ua=excluded.ua
  `).run(Number(userId), sub.endpoint, sub.keys.p256dh, sub.keys.auth, (ua || '').slice(0, 200));
  return true;
}

function removeSubscription(endpoint) {
  if (endpoint) db.prepare(`DELETE FROM push_subscriptions WHERE endpoint=?`).run(endpoint);
}

// Send a notification to every device of the given users. `payload` is a small
// object: { title, body, tag, url }. Fire-and-forget; prunes dead endpoints.
function pushToUsers(userIds, payload) {
  if (!ready) return;
  const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return;
  const subs = db.prepare(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  if (!subs.length) return;
  const data = JSON.stringify(payload || {});
  subs.forEach((s) => {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    webpush.sendNotification(sub, data, { TTL: 600 }).catch((err) => {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {   // gone — the browser dropped it
        try { db.prepare(`DELETE FROM push_subscriptions WHERE id=?`).run(s.id); } catch { /* ignore */ }
      } // other errors (network, 429) are transient — leave the subscription
    });
  });
}

module.exports = { enabled, publicKey, saveSubscription, removeSubscription, pushToUsers };
