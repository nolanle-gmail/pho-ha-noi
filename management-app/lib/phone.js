// Phone numbers are the login credential. Staff may type them in any common
// format — (408) 555-0101, 408-555-0101, 4085550101, (408)-555-0101 — but we
// store and match on the 10 digits only. normalizePhone strips every non-digit;
// isValidPhone accepts the result only when it is exactly 10 digits.
function normalizePhone(v) {
  return String(v == null ? '' : v).replace(/\D+/g, '');
}
function isValidPhone(v) {
  return /^\d{10}$/.test(normalizePhone(v));
}
module.exports = { normalizePhone, isValidPhone };
