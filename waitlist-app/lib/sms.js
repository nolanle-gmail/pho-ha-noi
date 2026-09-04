// Provider-agnostic SMS sender. Safe by default: with no provider configured it
// logs only (sends nothing, costs nothing) — the historical stub. Set
// SMS_PROVIDER=twilio|textbelt plus the matching credentials (as env / Fly
// secrets) to send for real. sendSms never throws; it returns a normalized
// result the caller can record. Uses the global fetch (Node 18+).
//
//   Twilio   → TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (an SMS number)
//   TextBelt → TEXTBELT_KEY (default 'textbelt' = 1 free msg/day, testing only)
const PROVIDER = (process.env.SMS_PROVIDER || 'none').toLowerCase();

// Normalize to E.164. US default: 10 digits -> +1XXXXXXXXXX. An already
// international number that starts with '+' is kept. Returns null if it cannot
// be made into a plausible E.164 number.
function toE164(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s.startsWith('+')) { const d = s.slice(1).replace(/\D+/g, ''); return d.length >= 8 && d.length <= 15 ? '+' + d : null; }
  const d = s.replace(/\D+/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}

async function viaTwilio(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return { sent: false, error: 'twilio_not_configured' };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { sent: false, error: j.message || `twilio_http_${r.status}` };
  return { sent: true, id: j.sid };
}

async function viaTextbelt(to, body) {
  const key = process.env.TEXTBELT_KEY || 'textbelt';
  const params = new URLSearchParams({ phone: to, message: body, key });
  const r = await fetch('https://textbelt.com/text', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  const j = await r.json().catch(() => ({}));
  if (!j.success) return { sent: false, error: j.error || 'textbelt_failed' };
  return { sent: true, id: j.textId };
}

// Send one SMS. Never throws — returns { sent, provider, to, id?, error?, logged? }.
async function sendSms(rawTo, body) {
  const to = toE164(rawTo);
  const text = String(body || '').slice(0, 1200);
  if (!to) return { sent: false, provider: PROVIDER, to: null, error: 'invalid_phone' };
  if (PROVIDER === 'none') { console.log(`[sms:log-only] -> ${to}: ${text}`); return { sent: false, provider: 'none', to, logged: true }; }
  try {
    const res = PROVIDER === 'twilio' ? await viaTwilio(to, text)
      : PROVIDER === 'textbelt' ? await viaTextbelt(to, text)
        : { sent: false, error: `unknown_provider:${PROVIDER}` };
    if (!res.sent) console.error(`[sms:${PROVIDER}] failed -> ${to}: ${res.error}`);
    return { provider: PROVIDER, to, ...res };
  } catch (e) { console.error(`[sms:${PROVIDER}] threw:`, e.message); return { sent: false, provider: PROVIDER, to, error: e.message }; }
}

const smsEnabled = () => PROVIDER !== 'none';

module.exports = { sendSms, toE164, smsEnabled, SMS_PROVIDER: PROVIDER };
