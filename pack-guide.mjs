/**
 * pack-guide.mjs
 * Rebuilds Quartermaster Guide LevelDB compendium from source JSON.
 * Usage (Foundry must be closed): node pack-guide.mjs
 * Requires: npm install classic-level (already installed)
 */
import { ClassicLevel } from 'classic-level';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const PACKS = [
    { src: 'packs/src/quartermaster-guide-gm', out: 'packs/quartermaster-guide-gm' },
];

function makeStats() {
    return {
        compendiumSource: null,
        duplicateSource: null,
        coreVersion: '12.331',
        systemId: null,
        systemVersion: null,
        createdTime: null,
        modifiedTime: null,
        lastModifiedBy: null,
    };
}

function loadSource(srcDir) {
    const files = readdirSync(srcDir).filter(f => f.endsWith('.json'));
    if (!files.length) {
        throw new Error(`No JSON files found in ${srcDir}`);
    }

    let parent = null;
    const pages = [];

    for (const file of files) {
        const data = JSON.parse(readFileSync(join(srcDir, file), 'utf8'));
        const key = data._key ?? '';

        if (key.startsWith('!journal.pages!')) {
            pages.push(data);
        } else if (key.startsWith('!journal!') || data.pages !== undefined) {
            parent = data;
        } else {
            console.warn(`Skipping unrecognised file: ${join(srcDir, file)}`);
        }
    }

    if (!parent) {
        throw new Error(`No parent journal document found in ${srcDir}`);
    }
    if (!pages.length) {
        throw new Error(`No page documents found in ${srcDir}`);
    }

    pages.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    return { parent, pages };
}

function buildBatch(parent, pages) {
    const batch = [];
    const journalKey = `!journal!${parent._id}`;
    const pageIds = pages.map(p => p._id);

    batch.push({
        type: 'put',
        key: journalKey,
        value: {
            _key: journalKey,
            _id: parent._id,
            name: parent.name,
            pages: pageIds,
            categories: [],
            ownership: parent.ownership || { default: 0 },
            flags: parent.flags || {},
            sort: parent.sort || 0,
            folder: parent.folder || null,
            _stats: parent._stats || makeStats(),
        }
    });

    for (const page of pages) {
        const pageKey = `!journal.pages!${parent._id}.${page._id}`;
        batch.push({
            type: 'put',
            key: pageKey,
            value: {
                _key: pageKey,
                _id: page._id,
                name: page.name,
                type: page.type || 'text',
                title: page.title || { show: true, level: 1 },
                image: page.image || {},
                video: page.video || { controls: true, volume: 0.5 },
                src: page.src || null,
                system: page.system || {},
                text: {
                    content: page.text?.content || '',
                    format: page.text?.format || 1,
                    markdown: page.text?.markdown || '',
                },
                sort: page.sort || 0,
                ownership: page.ownership || { default: -1 },
                flags: page.flags || {},
                _stats: page._stats || makeStats(),
            }
        });
    }

    return batch;
}

async function packOne(srcDir, packDir) {
    const { parent, pages } = loadSource(srcDir);
    const batch = buildBatch(parent, pages);
    const expectedKeys = new Set(batch.map(entry => entry.key));

    const db = new ClassicLevel(packDir, { valueEncoding: 'json', createIfMissing: true });
    await db.open();

    const orphanKeys = [];
    for await (const key of db.keys()) {
        if (!expectedKeys.has(key)) {
            orphanKeys.push(key);
        }
    }

    if (orphanKeys.length) {
        await db.batch(orphanKeys.map(key => ({ type: 'del', key })));
        console.log(`  Removed ${orphanKeys.length} stale key(s) from ${packDir}`);
    }

    await db.batch(batch);
    await db.close();
    console.log(`Packed ${batch.length} entries (1 journal + ${pages.length} pages) into ${packDir}`);
}

async function main() {
    for (const { src, out } of PACKS) {
        await packOne(src, out);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
