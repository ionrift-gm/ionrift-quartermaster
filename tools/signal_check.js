const fs = require('fs');
const path = require('path');

// CI copy — logic kept in sync with devtools reference implementation.

const TARGET_DIR = path.resolve(process.argv[2] || path.resolve(__dirname, '../scripts'));
// Derive repo root from TARGET_DIR so symlinked dev dirs resolve correctly.
const REPO_ROOT = path.dirname(TARGET_DIR);

// Files exempt from scanning — contain legitimate matches for domain vocabulary.
const ALLOWLIST_PATHS = new Set([
    // Foundry VTT compendium ownership API uses "ASSISTANT" as a role name — not an AI artifact.
    path.normalize('scripts/services/SrdCurseAdapter.js'),
]);

const _d = (s) => Buffer.from(s, 'base64').toString('utf8');

const AI_INDICATORS = [
    { pattern: new RegExp(_d('YXMgYW4gQUk='), 'i'),              label: 'Explicit Identity' },
    { pattern: new RegExp(_d('bGFuZ3VhZ2UgbW9kZWw='), 'i'),      label: 'Explicit Identity' },
    { pattern: new RegExp(_d('Y2VydGFpbmx5'), 'i'),              label: 'Conversational Filler' },
    { pattern: new RegExp(_d('aGVyZSBpcyB0aGU='), 'i'),          label: 'Conversational Hand-off' },
    { pattern: new RegExp(_d('SSBoYXZlIHVwZGF0ZWQ='), 'i'),      label: 'First-Person Update' },
    { pattern: new RegExp(_d('aW4gdGhpcyBzbmlwcGV0'), 'i'),      label: 'Meta-Commentary' },
    { pattern: new RegExp(_d('YmVsb3cgaXMgdGhl'), 'i'),          label: 'Meta-Commentary' },
    { pattern: new RegExp(_d('ZW5zdXJlIHRoYXQgdGhl'), 'i'),      label: 'Verbose Instruction' },
    { pattern: new RegExp(_d('dGhpcyBmdW5jdGlvbiB3aWxs'), 'i'),  label: 'Future Tense Description' },
    { pattern: new RegExp(_d('c2ltcGxlIHV0aWxpdHkgdG8='), 'i'), label: 'Subjective Descriptor' },
    { pattern: new RegExp(_d('cHJvbXB0Og=='), 'i'),              label: 'Prompt Leak' },
    { pattern: new RegExp(_d('dXNlcjo='), 'i'),                   label: 'Conversation Leak' },
    { pattern: new RegExp(_d('YXNzaXN0YW50Og=='), 'i'),          label: 'Conversation Leak' },
    { pattern: new RegExp(_d('aW9ucmlmdC1jbG91ZA=='), 'i'),      label: 'Cloud Leak' },
];

function scan(dir) {
    let findings = [];

    if (!fs.existsSync(dir)) {
        console.error(`Target directory not found: ${dir}`);
        return [];
    }

    const files = fs.readdirSync(dir);

    for (const file of files) {
        const fullPath = path.join(dir, file);
        const relativePath = path.relative(REPO_ROOT, fullPath);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
            if (file === 'node_modules' || file === '.git' || file === 'dist') continue;
            findings = findings.concat(scan(fullPath));
        } else {
            if (!file.endsWith('.js') && !file.endsWith('.md')) continue;
            if (ALLOWLIST_PATHS.has(path.normalize(relativePath))) continue;

            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');

            lines.forEach((line, index) => {
                AI_INDICATORS.forEach(indicator => {
                    if (indicator.pattern.test(line)) {
                        findings.push({
                            file: relativePath,
                            line: index + 1,
                            type: indicator.label,
                            content: line.trim().substring(0, 80)
                        });
                    }
                });
            });
        }
    }
    return findings;
}

console.log(`\n--- Ionrift Signal Check ---`);
console.log(`Target: ${TARGET_DIR}\n`);

const results = scan(TARGET_DIR);

if (results.length === 0) {
    console.log('✅ No AI patterns detected.');
} else {
    console.log(`⚠️  Found ${results.length} potential AI artifacts:\n`);
    results.forEach(r => {
        console.log(`[${r.type}] ${r.file}:${r.line}`);
        console.log(`    "${r.content}"`);
    });
    console.log('\n❌ Review recommended.');
    process.exit(1);
}
