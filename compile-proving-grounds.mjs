/**
 * compile-proving-grounds.mjs
 * Compiles packs/src/proving-grounds/*.json and
 * packs/src/proving-grounds-guide/*.json into temp LevelDBs.
 *
 * Foundry holds a LOCK on the live DBs at runtime, so:
 *   1. Close Foundry
 *   2. node compile-proving-grounds.mjs
 *   3. Follow the rename instructions printed at the end
 *   4. Restart Foundry
 */
import { ClassicLevel } from 'classic-level';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PACKS = [
    {
        label: 'proving-grounds',
        srcDir: join(__dirname, 'packs', 'src', 'proving-grounds'),
        tempPath: join(__dirname, 'packs', 'proving-grounds-compiled'),
        livePath: join(__dirname, 'packs', 'proving-grounds'),
        keyPrefix: '!items!'
    },
    {
        label: 'proving-grounds-guide',
        srcDir: join(__dirname, 'packs', 'src', 'proving-grounds-guide'),
        tempPath: join(__dirname, 'packs', 'proving-grounds-guide-compiled'),
        livePath: join(__dirname, 'packs', 'proving-grounds-guide'),
        keyPrefix: '!journal!'
    }
];

async function compilePack({ label, srcDir, tempPath, keyPrefix }) {
    const db = new ClassicLevel(tempPath, { keyEncoding: 'utf8', valueEncoding: 'json' });
    await db.open();

    const files = readdirSync(srcDir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    console.log(`\n[${label}] Found ${files.length} source files.`);

    let count = 0;
    for (const file of files) {
        const raw = JSON.parse(readFileSync(join(srcDir, file), 'utf8'));
        const id = raw._id;
        const key = raw._key || `${keyPrefix}${id}`;

        await db.put(key, raw);

        if (raw.pages) {
            for (const page of raw.pages) {
                const pageKey = `!journal.pages!${id}.${page._id}`;
                await db.put(pageKey, page);
            }
            console.log(`  + ${raw.name} (${id}) [${raw.pages.length} pages]`);
        } else {
            console.log(`  + ${raw.name} (${id})`);
        }
        count++;
    }

    await db.close();
    console.log(`  Compiled ${count} entries into: ${tempPath}`);
    return { label, tempPath, livePath: arguments[0].livePath };
}

async function main() {
    const results = [];
    for (const pack of PACKS) {
        results.push(await compilePack(pack));
    }

    console.log('\n--- NEXT STEPS (Foundry must be closed) ---\n');
    for (const { label, tempPath, livePath } of results) {
        console.log(`  # ${label}`);
        console.log(`  Rename-Item -Path "${livePath}" -NewName "${label}-backup"`);
        console.log(`  Rename-Item -Path "${tempPath}" -NewName "${label}"`);
        console.log();
    }
    console.log('Then restart Foundry and delete the in-world item.');
    console.log('Re-drag from the compendium to get the updated version.');
}

main().catch(err => { console.error(err); process.exit(1); });
