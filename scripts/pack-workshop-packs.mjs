/**
 * pack-workshop-packs.mjs
 * Generalised LevelDB packer for all ionrift-quartermaster packs.
 * Reads from packs/src/<packname>/ and writes to packs/<packname>/
 *
 * Usage:
 *   node scripts/pack-workshop-packs.mjs [packname]
 *   node scripts/pack-workshop-packs.mjs all
 *
 * If no argument is given, packs all directories in packs/src/.
 */

import { ClassicLevel } from 'classic-level';
import { readFile, readdir, rm } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const SRC_ROOT = path.join(ROOT, 'packs', 'src');
const OUT_ROOT = path.join(ROOT, 'packs');

const NULL_STATS = {
    compendiumSource: null, duplicateSource: null,
    coreVersion: null, systemId: null, systemVersion: null,
    createdTime: null, modifiedTime: null, lastModifiedBy: null,
    exportSource: null,
};

const PAGE_DEFAULTS = {
    title: { show: true, level: 1 },
    image: {},
    video: { controls: true, volume: 0.5 },
    src: null,
    system: {},
};

async function packOne(packName) {
    const srcDir = path.join(SRC_ROOT, packName);
    const outDir = path.join(OUT_ROOT, packName);

    const allFiles = await readdir(srcDir);
    const jsonFiles = allFiles.filter(f => f.endsWith('.json') && !f.startsWith('_'));

    // Load folder manifest if present
    let folders = [];
    try {
        const raw = await readFile(path.join(srcDir, '_folders.json'), 'utf8');
        folders = JSON.parse(raw);
    } catch (_) { /* no folders file -- flat pack */ }

    console.log(`\nPacking [${packName}]: ${folders.length} folders + ${jsonFiles.length} items`);

    // Wipe the existing LevelDB so stale entries from previous builds don't persist
    await rm(outDir, { recursive: true, force: true });

    // Open fresh LevelDB
    const db = new ClassicLevel(outDir, { valueEncoding: 'utf8' });
    await db.open();

    const batch = db.batch();

    // Write folders
    for (const folder of folders) {
        const { _type: _, ...dbFolder } = folder; // strip internal _type marker
        batch.put(`!folders!${folder._id}`, JSON.stringify(dbFolder));
    }

    // Write documents (items, journal entries, etc.)
    for (const file of jsonFiles) {
        const raw = await readFile(path.join(srcDir, file), 'utf8');
        const doc = JSON.parse(raw);
        const key = doc._key ?? `!items!${doc._id}`;

        // Foundry V11+ stores journal pages as separate LevelDB records.
        // Parent `pages` array holds ID strings; each page is its own record.
        if (Array.isArray(doc.pages) && doc.pages.length > 0
            && typeof doc.pages[0] === 'object') {
            const pages = doc.pages;
            const parentId = doc._id;

            const parentDoc = {
                ...doc,
                pages: pages.map(p => p._id),
                categories: doc.categories ?? [],
                _stats: doc._stats ?? NULL_STATS,
                sort: doc.sort ?? 0,
                folder: doc.folder ?? null,
            };
            delete parentDoc._key;
            batch.put(key, JSON.stringify(parentDoc));

            for (const page of pages) {
                const fullPage = {
                    ...PAGE_DEFAULTS,
                    ...page,
                    _stats: page._stats ?? NULL_STATS,
                    category: page.category ?? null,
                };
                const pageKey = `!journal.pages!${parentId}.${page._id}`;
                batch.put(pageKey, JSON.stringify(fullPage));
            }
        } else {
            batch.put(key, JSON.stringify(doc));
        }
    }

    await batch.write();

    // Force compaction so data moves from WAL journal (.log) to SST (.ldb).
    // Foundry reads .ldb files for module-provided packs; without this,
    // small datasets may remain in the journal and not be visible.
    await db.compactRange('\x00', '\xff');
    await db.close();

    console.log(`  Done: ${folders.length} folders + ${jsonFiles.length} items -> packs/${packName}`);
}

async function main() {
    const arg = process.argv[2];

    // Determine which packs to build
    let packNames;
    if (!arg || arg === 'all') {
        const entries = await readdir(SRC_ROOT, { withFileTypes: true });
        packNames = entries.filter(e => e.isDirectory()).map(e => e.name);
    } else {
        packNames = [arg];
    }

    for (const name of packNames) {
        await packOne(name);
    }

    console.log('\nAll packs complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
