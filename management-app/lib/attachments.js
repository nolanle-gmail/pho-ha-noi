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

module.exports = { MAX_IMG, MAX_VID, MAX_FILE, MAX_ATTACH, MAX_ANY, classify, REJECT_MSG };
