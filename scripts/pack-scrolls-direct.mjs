/**
 * Legacy: packed spell scrolls into a module compendium (removed from the module).
 * Scroll Forge now builds scrolls at runtime into a world compendium.
 *
 * Run: node scripts/pack-scrolls-direct.mjs
 * Requires: classic-level (npm install classic-level --no-save)
 */

import { ClassicLevel } from 'classic-level';
import { readdir, readFile, mkdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..', 'packs', 'src', 'scrolls');
/** @deprecated Output path was removed from the module manifest; change if you run this locally. */
const DB_DIR = join(__dirname, '..', 'packs', 'workshop-scrolls');

async function main() {
    // Clean and recreate
    await rm(DB_DIR, { recursive: true, force: true });
    await mkdir(DB_DIR, { recursive: true });

    const db = new ClassicLevel(DB_DIR, {
        keyEncoding: 'utf8',
        valueEncoding: 'utf8'
    });

    const files = await readdir(SRC_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    let folderCount = 0;
    let itemCount = 0;

    // Process folders first, then items
    const folders = jsonFiles.filter(f => f.startsWith('_folder_'));
    const items = jsonFiles.filter(f => !f.startsWith('_folder_'));

    console.log(`Packing ${folders.length} folders + ${items.length} items into ${DB_DIR}`);

    // Pack folders
    for (const file of folders) {
        const raw = await readFile(join(SRC_DIR, file), 'utf-8');
        const data = JSON.parse(raw);
        const key = `!folders!${data._id}`;
        await db.put(key, JSON.stringify(data));
        folderCount++;
    }

    // Pack items
    for (const file of items) {
        const raw = await readFile(join(SRC_DIR, file), 'utf-8');
        const data = JSON.parse(raw);
        const key = `!items!${data._id}`;
        await db.put(key, JSON.stringify(data));
        itemCount++;
    }

    await db.close();
    console.log(`\nPacked ${folderCount} folders + ${itemCount} items into LevelDB.`);
}

main().catch(e => { console.error(e); process.exit(1); });
