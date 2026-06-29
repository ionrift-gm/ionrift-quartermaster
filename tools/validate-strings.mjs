#!/usr/bin/env node
// validate-strings.mjs
// Scans scripts/ and templates/ for em dashes (—, U+2014) and en dashes (–, U+2013)
// in JS string literals and HBS template text.
// Exits 1 if any are found — intended to run in CI before release.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, extname } from 'path';

// ── Config ──────────────────────────────────────────────────────────────────

const SCAN_DIRS   = ['scripts', 'templates'];
const EXTENSIONS  = new Set(['.js', '.mjs', '.hbs']);

// U+2013 EN DASH  –
// U+2014 EM DASH  —
const DASH_RE = /[–—]/g;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Recursively collect files with a matching extension. */
function collectFiles(dir, exts) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    // Directory may not exist in all module variants — skip silently.
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, exts));
    } else if (exts.has(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

// ── Scan ─────────────────────────────────────────────────────────────────────

const errors = [];

for (const dir of SCAN_DIRS) {
  const files = collectFiles(dir, EXTENSIONS);

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Inline suppression: append  // validate-strings-ok  (JS)
      //                         or  {{!-- validate-strings-ok --}}  (HBS)
      // to explicitly allow a typographic dash on that line.
      if (line.includes('validate-strings-ok')) continue;

      let match;
      DASH_RE.lastIndex = 0;

      while ((match = DASH_RE.exec(line)) !== null) {
        const char = match[0];
        const name = char === '\u2014' ? 'em dash (U+2014)' : 'en dash (U+2013)';
        errors.push(`  ${file}:${i + 1}  ${name}\n    > ${line.trimEnd()}`);
      }
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error(`\nString validation FAILED — ${errors.length} typographic dash(es) found in source files:\n`);
  for (const e of errors) console.error(e);
  console.error('\nFix: replace em/en dashes with ASCII hyphens or the correct Unicode escape (\\u2014 / \\u2013) outside of string literals.');
  process.exit(1);
} else {
  console.log('String validation passed — no typographic dashes found in source files.');
}
