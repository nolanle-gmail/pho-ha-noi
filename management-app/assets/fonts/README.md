# Bundled fonts

**DejaVu Sans** (Regular + Bold), used by `lib/pdf.js` to render the signed
Worked-Hours Acknowledgment PDF so Spanish and Vietnamese display correctly
(the built-in PDF base fonts only cover basic Latin). The font is subset per
document at generation time, so output PDFs stay ~20–25 KB.

- Source: `dejavu-fonts-ttf` 2.37.3 (`ttf/DejaVuSans.ttf`, `ttf/DejaVuSans-Bold.ttf`)
- License: DejaVu Fonts License — a permissive, free license derived from the
  Bitstream Vera Fonts license. Redistribution (including bundling in this repo)
  and embedding in documents is permitted. Full text: https://dejavu-fonts.github.io/License.html
