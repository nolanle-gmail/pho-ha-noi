// Small helper over pdf-lib to render a one/two-page text document (headings,
// paragraphs, key/value rows, rules) with an embedded Unicode font, so the saved
// acknowledgment renders correctly in English, Spanish AND Vietnamese. The font
// is subset per document, so output PDFs stay small (~tens of KB) even though the
// bundled DejaVu Sans TTFs are ~750KB each.

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const FONT_REG = fs.readFileSync(path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf'));
const FONT_BOLD = fs.readFileSync(path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf'));

const PAGE_W = 612, PAGE_H = 792, MARGIN = 72;       // US Letter
const CONTENT_W = PAGE_W - MARGIN * 2;

// Strip control characters pdf-lib can't lay out; keep all real (incl. accented
// / Vietnamese) letters. Normalize whitespace runs that aren't newlines.
function clean(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\t/g, '  ');
}

// Greedy word-wrap using the font's real glyph metrics.
function wrapLines(font, text, size, width) {
  const out = [];
  for (const para of clean(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const w of words) {
      const cand = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(cand, size) <= width) { line = cand; }
      else { if (line) out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  return out;
}

// blocks: { h1 } { h2 } { p } { small } | { kv:[label,value] } | { rule:true } | { gap:n }
// Returns a Promise<Buffer>.
async function textPdf(blocks, meta = {}) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const reg = await doc.embedFont(FONT_REG, { subset: true });
  const bold = await doc.embedFont(FONT_BOLD, { subset: true });
  if (meta.title) doc.setTitle(clean(meta.title));
  doc.setProducer('Pho Ha Noi');
  doc.setCreator('Pho Ha Noi');

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const newPage = () => { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; };
  const need = (h) => { if (y - h < MARGIN) newPage(); };
  const grey = rgb(0.38, 0.38, 0.38), black = rgb(0.1, 0.1, 0.1);
  const draw = (text, x, size, font, color) => { page.drawText(clean(text), { x, y, size, font, color: color || black }); };

  for (const b of blocks) {
    if (b.gap != null) { y -= b.gap; continue; }
    if (b.rule) { need(10); y -= 4; page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.75, color: rgb(0.78, 0.78, 0.78) }); y -= 8; continue; }
    if (b.h1 != null) {
      const size = 17, lead = 22;
      for (const ln of wrapLines(bold, b.h1, size, CONTENT_W)) { need(lead); y -= size; draw(ln, MARGIN, size, bold); y -= (lead - size); }
      y -= 4; continue;
    }
    if (b.h2 != null) {
      const size = 12, lead = 17; y -= 4;
      for (const ln of wrapLines(bold, b.h2, size, CONTENT_W)) { need(lead); y -= size; draw(ln, MARGIN, size, bold); y -= (lead - size); }
      continue;
    }
    if (b.kv) {
      const size = 11, lead = 16, labelW = 160;
      const [label, value] = b.kv;
      const vlines = wrapLines(reg, value, size, CONTENT_W - labelW);
      need(lead); y -= size;
      draw(label, MARGIN, size, bold);
      draw(vlines[0] || '', MARGIN + labelW, size, reg);
      y -= (lead - size);
      for (let i = 1; i < vlines.length; i++) { need(lead); y -= size; draw(vlines[i], MARGIN + labelW, size, reg); y -= (lead - size); }
      continue;
    }
    const small = b.small != null;
    const txt = small ? b.small : b.p;
    const size = small ? 9 : 11, lead = small ? 13 : 16;
    for (const ln of wrapLines(reg, txt, size, CONTENT_W)) { need(lead); y -= size; draw(ln, MARGIN, size, reg, small ? grey : black); y -= (lead - size); }
    y -= small ? 4 : 6;
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

module.exports = { textPdf };
