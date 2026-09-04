// Location URL slugs for the per-location clock kiosk (/clock/<slug>).
// slugify makes a readable slug from a location name; normSlug reduces any
// slug/path segment to a comparison key so /SanJose, /san-jose and /sanjose
// all resolve to the same location.
function slugify(name) {
  return String(name || '')
    .replace(/^Ph[oở]\s*H[aà]\s*N[oộ]i\s*[—–-]\s*/i, '') // drop the "Pho Ha Noi — " prefix
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const normSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

module.exports = { slugify, normSlug };
