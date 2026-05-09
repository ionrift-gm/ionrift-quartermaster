/**
 * compile-containers.mjs
 * Compiles packs/src/workshop-containers/*.json into a NEW temp LevelDB.
 * Because Foundry holds a LOCK on the live DB, we write to a temp path
 * and print instructions for swapping it in after Foundry closes.
 *
 * Run with: node compile-containers.mjs
 */
import { ClassicLevel } from 'classic-level';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir  = join(__dirname, 'packs', 'src', 'quartermaster-containers');
const tempPath = join(__dirname, 'packs', 'quartermaster-containers-compiled');
const livePath = join(__dirname, 'packs', 'quartermaster-containers');

async function main() {
    const db = new ClassicLevel(tempPath, { keyEncoding: 'utf8', valueEncoding: 'json' });
    await db.open();

    const files = readdirSync(srcDir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    console.log(`Found ${files.length} source files to compile.`);

    let count = 0;
    for (const file of files) {
        const raw = JSON.parse(readFileSync(join(srcDir, file), 'utf8'));
        const key = `!items!${raw._id}`;
        await db.put(key, raw);
        console.log(`  + ${raw.name} (${raw._id})`);
        count++;
    }

    await db.close();
    console.log(`\n✓ Compiled ${count} containers into: ${tempPath}`);
    console.log(`\nNEXT STEPS (close Foundry first, then run):`);
    console.log(`  Rename-Item -Path "${livePath}" -NewName "workshop-containers-backup"`);
    console.log(`  Rename-Item -Path "${tempPath}" -NewName "workshop-containers"`);
    console.log(`\nThen restart Foundry.`);
}

main().catch(err => { console.error(err); process.exit(1); });
