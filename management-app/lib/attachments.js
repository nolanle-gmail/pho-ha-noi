// Shared rules for message & chat attachments: images, videos, and now general files
// (documents, spreadsheets, PDFs, archives…). Executables/scripts are never allowed.
const MAX_IMG = parseInt(process.env.MESSAGE_IMG_MAX || '', 10) || 25 * 1024 * 1024;    // 25 MB
const MAX_VID = parseInt(process.env.MESSAGE_VID_MAX || '', 10) || 100 * 1024 * 1024;   // 100 MB
const MAX_FILE = parseInt(process.env.MESSAGE_FILE_MAX || '', 10) || 100 * 1024 * 1024; // 100 MB
const MAX_ATTACH = parseInt(process.env.MESSAGE_ATTACH_MAX || '', 10) || 10;           // per message
const MAX_ANY = Math.max(MAX_IMG, MAX_VID, MAX_FILE);

const OK_IMG = /^image\/(jpeg|png|webp|heic|heif|gif)$/i;
const OK_VID = /^video\/(mp4|quicktime|webm|ogg|3gpp|x-m4v|x-matroska)$/i;
// Documents & other safe file types by MIME…
const OK_FILE_MIME = /^(application\/(pdf|rtf|json|xml|zip|x-zip-compressed|gzip|x-7z-compressed|x-rar-compressed|x-tar|octet-stream|msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.oasis\.opendocument\.[a-z]+|vnd\.apple\.(pages|numbers|keynote))|text\/(plain|csv|tab-separated-values|calendar|markdown|x-log))$/i;
// …or, when the browser sends a generic type, by a safe filename extension.
const SAFE_EXT = /\.(pdf|docx?|xlsx?|xlsm|csv|tsv|pptx?|txt|rtf|md|json|xml|zip|7z|rar|gz|tar|odt|ods|odp|pages|numbers|key|ics|log)$/i;
// Never accept these, whatever the MIME claims.
const BAD_EXT = /\.(exe|msi|bat|cmd|com|scr|pif|ps1|vbs|wsf|jar|sh|bash|app|apk|dll|so|deb|rpm|dmg|htm|html|xhtml|svg|svgz)$/i;

// Decide the kind + size cap for an upload, or null if it isn't an allowed type.
function classify(mime, filename) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  const fn = String(filename || '');
  if (BAD_EXT.test(fn)) return null;                       // executables/scripts/inline-web
  if (OK_IMG.test(m)) return { kind: 'image', cap: MAX_IMG };
  if (OK_VID.test(m)) return { kind: 'video', cap: MAX_VID };
  if (SAFE_EXT.test(fn) || OK_FILE_MIME.test(m)) return { kind: 'file', cap: MAX_FILE };
  return null;
}

const REJECT_MSG = 'Unsupported file type. Attach an image, a video, or a document (PDF, Word, Excel, PowerPoint, CSV, TXT, ZIP…). Programs and scripts aren’t allowed.';

// ── Serving attachment bytes ────────────────────────────────────────────────
// Shared by message & chat attachment routes. Attachment bytes are immutable
// (an attachment is inserted once, never edited — only deleted), so we cache
// them hard and support conditional + range requests:
//   • Cache-Control: immutable, 1 year  → the browser reopens from its own cache
//     instead of re-downloading every time (was a 5-min window).
//   • ETag + If-None-Match                → a cheap 304 when the cache revalidates.
//   • Accept-Ranges + 206                 → video streams/seeks (and resumes)
//     instead of the whole file downloading before it can play.
// `a` is a row with { id, kind, mime, bytes, filename }.
function serveBytes(req, res, a) {
  const buf = Buffer.isBuffer(a.bytes) ? a.bytes : Buffer.from(a.bytes);
  const total = buf.length;
  const etag = `"att-${a.id}-${total}"`;
  const isHead = req.method === 'HEAD';

  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('ETag', etag);
  res.setHeader('Accept-Ranges', 'bytes');
  const dispo = a.kind === 'file' ? 'attachment' : 'inline';
  const fn = a.filename ? `; filename="${String(a.filename).replace(/[\r\n"]/g, '')}"` : '';
  res.setHeader('Content-Disposition', dispo + fn);

  // Conditional GET — bytes never change, so a matching ETag is always still fresh.
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) {
    return res.status(304).end();
  }

  // Range request (video seek / resumable download) → 206 partial content.
  const range = req.headers.range;
  if (range) {
    const mm = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (mm && (mm[1] !== '' || mm[2] !== '')) {
      let start = mm[1] === '' ? NaN : parseInt(mm[1], 10);
      let end = mm[2] === '' ? NaN : parseInt(mm[2], 10);
      if (Number.isNaN(start)) { start = Math.max(0, total - (Number.isNaN(end) ? 0 : end)); end = total - 1; }
      else if (Number.isNaN(end)) { end = total - 1; }
      if (start > end || start >= total) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      end = Math.min(end, total - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', end - start + 1);
      return res.end(isHead ? undefined : buf.subarray(start, end + 1));
    }
  }

  res.setHeader('Content-Length', total);
  return res.end(isHead ? undefined : buf);
}

// ── Inline-media tickets ────────────────────────────────────────────────────
// A plain <img>/<video> src can't carry an Authorization header, so to let the
// browser stream an attachment directly (and range-request it) we mint a short-
// lived, single-attachment capability token. It carries NO user identity — just
// the scope + attachment id + an expiry — and is only ever handed out after an
// authenticated access check, so it's a scoped signed-URL, not a session leak.
const jwt = require('jsonwebtoken');
const { SECRET } = require('./auth');
const TICKET_TTL = parseInt(process.env.MESSAGE_MEDIA_TICKET_TTL || '', 10) || 900; // 15 min

function signMediaTicket(scope, aid) {
  return jwt.sign({ t: 'att', s: scope, aid: Number(aid) }, SECRET, { expiresIn: TICKET_TTL });
}
function verifyMediaTicket(tk, scope, aid) {
  try {
    const p = jwt.verify(String(tk || ''), SECRET);
    return !!p && p.t === 'att' && p.s === scope && Number(p.aid) === Number(aid);
  } catch { return false; }
}

module.exports = {
  MAX_IMG, MAX_VID, MAX_FILE, MAX_ATTACH, MAX_ANY, classify, REJECT_MSG,
  serveBytes, signMediaTicket, verifyMediaTicket,
};
