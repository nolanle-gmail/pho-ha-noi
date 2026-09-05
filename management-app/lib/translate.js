// Message / chat translator between English, Spanish and Vietnamese.
// Uses MyMemory (free, no API key) by default. Set MYMEMORY_EMAIL to raise the
// daily limit (~5k → ~50k words/day). Results are cached in memory to cut repeat
// calls. Never throws quota text back as a translation. Uses global fetch (Node 18+).
const OK = ['en', 'es', 'vi'];
const CACHE = new Map();
const CACHE_MAX = 800;
const EMAIL = process.env.MYMEMORY_EMAIL || '';

async function translate(q, from, to) {
  q = String(q == null ? '' : q).trim();
  from = String(from || '').toLowerCase();
  to = String(to || '').toLowerCase();
  if (!OK.includes(to)) throw new Error('Unsupported target language.');
  if (!OK.includes(from)) from = 'en';
  if (!q) return { text: '' };
  if (from === to) return { text: q };
  q = q.slice(0, 500); // MyMemory per-request cap
  const key = `${from}|${to}|${q}`;
  if (CACHE.has(key)) return { text: CACHE.get(key), from, to, cached: true };
  let url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(from + '|' + to)}`;
  if (EMAIL) url += `&de=${encodeURIComponent(EMAIL)}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  const text = j && j.responseData && j.responseData.translatedText;
  if (!text || /MYMEMORY WARNING|QUERY LENGTH LIMIT|IS AN INVALID|NO QUERY SPECIFIED/i.test(text)) {
    throw new Error('translation_unavailable');
  }
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, text);
  return { text, from, to };
}

module.exports = { translate };
