// Timezone helpers — render a UTC instant in a location's local (IANA) timezone.
// Uses the built-in Intl/ICU (Node 24 ships full ICU), so no extra dependency.
const DEFAULT_TZ = process.env.DEFAULT_TZ || 'America/Los_Angeles';

// Local calendar date (YYYY-MM-DD) for an instant in the given timezone.
function localDate(tz, d = new Date()) {
  const zone = tz || DEFAULT_TZ;
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch { return new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
}

// Local wall-clock time (HH:MM, 24h) for an instant in the given timezone.
function localTime(tz, d = new Date()) {
  const zone = tz || DEFAULT_TZ;
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d); }
  catch { return new Intl.DateTimeFormat('en-GB', { timeZone: DEFAULT_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d); }
}

module.exports = { DEFAULT_TZ, localDate, localTime };
