#!/usr/bin/env node
// validate-changelog.mjs
// Validates the latest CHANGELOG.md entry against Ionrift formatting rules.
// Exits 1 if any violations are found — intended to run in CI before release.

import { readFileSync } from 'fs';

const content = readFileSync('CHANGELOG.md', 'utf8');
const lines = content.split('\n');

// Extract the latest entry: lines between the first ## heading and the second.
let inEntry = false;
const entryLines = [];
let entryVersion = '';

for (const line of lines) {
  if (line.startsWith('## ')) {
    if (inEntry) break;
    inEntry = true;
    entryVersion = line.trim();
    continue;
  }
  if (inEntry) entryLines.push(line);
}

if (!entryLines.length) {
  console.error('ERROR: No changelog entry found in CHANGELOG.md.');
  process.exit(1);
}

console.log(`Validating: ${entryVersion}`);

const errors = [];

for (let i = 0; i < entryLines.length; i++) {
  const line = entryLines[i];
  const lineNum = i + 2; // +2 accounts for the ## heading line

  // Soft-wrap check: a line starting with 2+ spaces that is not a sub-bullet
  // indicates a continuation of the previous bullet — not allowed.
  if (/^ {2,}\S/.test(line) && !line.trimStart().startsWith('-')) {
    errors.push(`  Line ${lineNum}: soft-wrapped continuation (bullets must be single unwrapped lines)\n    > ${line.trimEnd()}`);
  }
}

if (errors.length > 0) {
  console.error(`\nCHANGELOG validation FAILED — ${errors.length} issue(s):\n`);
  for (const e of errors) console.error(e);
  process.exit(1);
} else {
  console.log('CHANGELOG validation passed.');
}
