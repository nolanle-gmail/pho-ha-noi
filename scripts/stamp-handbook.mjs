#!/usr/bin/env node
// Stamp the "last updated" date into the Platform Handbook copies.
//
//   node scripts/stamp-handbook.mjs [file ...]
//
// Defaults to docs/HANDBOOK.md. Also accepts the artifact HTML source so the
// same command stamps both before republishing. Handles the Markdown line
//   _Last updated: <date>_
// and the HTML masthead
//   Last updated · <b><date></b>
// Rewrites only when the date actually changed, so it's a no-op most days.
import { readFileSync, writeFileSync } from 'node:fs';

const today = new Date().toLocaleDateString('en-US', {
  year: 'numeric', month: 'long', day: 'numeric',
});

const files = process.argv.slice(2);
if (files.length === 0) files.push('docs/HANDBOOK.md');

let failed = false;
for (const file of files) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    console.error(`stamp-handbook: cannot read ${file}`);
    failed = true;
    continue;
  }
  const out = src
    .replace(/(_Last updated: ).*?(_)/, `$1${today}$2`)               // Markdown
    .replace(/(Last updated · <b>).*?(<\/b>)/, `$1${today}$2`);        // artifact HTML
  if (out === src) {
    console.log(`stamp-handbook: ${file} already ${today}`);
    continue;
  }
  writeFileSync(file, out);
  console.log(`stamp-handbook: ${file} → ${today}`);
}

process.exit(failed ? 1 : 0);
