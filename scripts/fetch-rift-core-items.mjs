/**
 * fetch-rift-core-items.mjs
 * Imports cultural weapons, armor, trinkets, and treasures from riftitems_export.json
 * into packs/src/workshop-core/ as individual JSON item files.
 */

import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const SOURCE_JSON = path.resolve(ROOT, '../../Antigrav_Working_logs/riftitems_export.json');
const OUTPUT_DIR = path.join(ROOT, 'packs/src/workshop-core');

// Map source folder -> compendium category label + sort order
const FOLDER_MAP = {
    // Generic high-fantasy cultural materials -- defensible in any setting
    'Elven Steel':  { category: 'Cultural Weapons', sort: 100 },
    'Dwarven Steel':{ category: 'Cultural Weapons', sort: 100 },
    'Ironwood':     { category: 'Cultural Weapons', sort: 100 },  // forest-adjacent but generic
    'Mastercraft':  { category: 'Mastercraft',      sort: 200 },
    'Trinkets':     { category: 'Trinkets',         sort: 300 },

    // Intentionally excluded -- moved to terrain content packs:
    // 'Coral Steel'    → ionrift-coastal pack (coastal/aquatic material, includes Yklwa)
    // 'Hardened Bamboo'→ ionrift-jungle pack  (tropical material, includes Jungle Whisperer)
    // 'Obsidian'       → ionrift-jungle pack  (Chult volcanic material, includes Yklwa)
    // 'Reed Woven'     → ionrift-jungle pack  (tropical armor)
    // 'Jaguar Hide'    → ionrift-jungle pack  (creature-specific, Chult)
    // 'Heavy Armor'    → removed (Chain Mail, Plate, Ring Mail, Splint are SRD duplicates)
    // 'Local Flora & Fauna' → ionrift-jungle pack (all ToA/WotC plant names)
    // 'Herbs'          → ionrift-jungle pack (ToA-adjacent herbs)
    // 'Treasures'      → disbanded: Gleaming Pearl → workshop-gemstones, Jeweled Anklet +
    //                    Raw Gold Nuggets → workshop-treasure. Ancient Map Fragment → Trinkets (via ITEM_REMAP).
};

// Individual items from excluded source folders that should be admitted to a different category.
// Key = item name (must match riftitems_export exactly). Value = { category, material } override.
const ITEM_REMAP = {
    'Ancient Map Fragment': { category: 'Trinkets', material: 'Curiosities' },
};


// Items excluded from the core pack by name.
// Split into jungle pack (future ionrift-jungle) and coastal pack (future ionrift-coastal).
const EXCLUDE_ITEMS = new Set([
    // ── Jungle pack (Treasures) ───────────────────────────────────────────────
    'Emerald Dinosaur Statuette',   // ToA creature reference
    'Dragon Turtle Scale Pendant',  // WotC creature IP
    'Feathered Headdress',          // Chult cultural
    'Golden Tribal Mask',           // Chult cultural
    'Carved Wooden Totem',          // Chult cultural

    // ── Jungle pack (Trinkets) ────────────────────────────────────────────────
    'Enchanted Jaguar Statue',      // Chult creature
    'Gilded Tribal Drum',           // Chult cultural
    'Golden Insect Pendant',        // jungle-specific
    'Miniature Totem Pole',         // Chult cultural
    'Jungle Vine Bracelet',         // jungle-specific
    'Feather of the Rainbow Bird',  // jungle creature
    'Luminous Beetle Shell',        // jungle creature
    'Tiny Jade Elephant',           // jungle/Asian cultural
    'Petrified Frog',               // jungle fauna
    'Petal of the Moonflower',      // exotic jungle flora
    'Carved Wooden Mask',           // Chult cultural
    'Enchanted Leaf',               // jungle-adjacent

    // ── Coastal pack (Trinkets) ───────────────────────────────────────────────
    'Shimmering Fish Scale',        // coastal fauna
    'Whispering Shell',             // coastal

    // ── Remove entirely (not trinkets) ────────────────────────────────────────
    'Shield of Arrow Deflection',   // this is a weapon, not a trinket
    'Crystal Scrying Basin',        // major magical item, not loot
]);

// Source folders with material-level subfolders under Cultural Weapons
const MATERIAL_FOLDERS = new Set(['Elven Steel', 'Dwarven Steel', 'Ironwood']);


function makeId(str) {
    return createHash('md5').update(str).digest('hex').substring(0, 16);
}

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function main() {
    const raw = await readFile(SOURCE_JSON, 'utf8');
    const data = JSON.parse(raw);
    const allItems = data.items;

    const wanted = allItems.filter(i =>
        (FOLDER_MAP[i.folderName] || ITEM_REMAP[i.name]) && !EXCLUDE_ITEMS.has(i.name)
    );
    console.log(`Found ${wanted.length} items from riftitems_export.json to import (after exclusions).`);

    // Rebuild output dir
    await rm(OUTPUT_DIR, { recursive: true, force: true });
    await mkdir(OUTPUT_DIR, { recursive: true });

    // Build category folder entries
    const categoryFolders = {};  // 'Cultural Weapons' -> folder entry
    const materialFolders = {};  // 'Elven Steel'      -> folder entry

    for (const [folderName, info] of Object.entries(FOLDER_MAP)) {
        if (!categoryFolders[info.category]) {
            categoryFolders[info.category] = {
                _id: makeId(`cat-${info.category}`),
                name: info.category,
                _type: 'folder',
                type: 'Item',
                sorting: 'a',
                sort: info.sort,
                color: null,
                folder: null,  // top-level
                flags: {}
            };
        }
        if (MATERIAL_FOLDERS.has(folderName) && !materialFolders[folderName]) {
            materialFolders[folderName] = {
                _id: makeId(`mat-${folderName}`),
                name: folderName,
                _type: 'folder',
                type: 'Item',
                sorting: 'a',
                sort: 0,
                color: null,
                folder: categoryFolders[info.category]._id,
                flags: {}
            };
        }
    }

    // Write folder manifest (read by packer)
    const allFolders = [
        ...Object.values(categoryFolders),
        ...Object.values(materialFolders)
    ];
    await writeFile(
        path.join(OUTPUT_DIR, '_folders.json'),
        JSON.stringify(allFolders, null, 2)
    );

    // Write item JSON files
    const seen = new Set();
    let count = 0;
    let skipped = 0;

    for (const item of wanted) {
        // Resolve category: ITEM_REMAP overrides FOLDER_MAP
        const remap = ITEM_REMAP[item.name];
        const info  = remap ?? FOLDER_MAP[item.folderName];
        const category = info.category;

        // Ensure the category folder exists (remapped items may use categories not in FOLDER_MAP)
        if (!categoryFolders[category]) {
            categoryFolders[category] = {
                _id: makeId(`cat-${category}`),
                name: category,
                _type: 'folder',
                type: 'Item',
                sorting: 'a',
                sort: 300,  // same sort as Trinkets for remapped curiosities
                color: null,
                folder: null,
                flags: {}
            };
        }

        const folderId = MATERIAL_FOLDERS.has(item.folderName)
            ? materialFolders[item.folderName]._id
            : categoryFolders[category]._id;

        const slug = slugify(item.name);

        // Deduplicate by name (riftitems has some duplicates)
        if (seen.has(slug)) { skipped++; continue; }
        seen.add(slug);

        const id = makeId(`core-${slug}`);

        // Minimum weight policy: nothing ships at 0 lb. 0.05 is the floor.
        const rawWeight = item.system?.weight ?? 0;
        const weight = Math.max(rawWeight, 0.05);

        const clean = {
            _id: id,
            name: item.name,
            type: item.type,
            img: item.img,
            folder: folderId,
            system: { ...item.system, weight },
            flags: {
                'ionrift-quartermaster': {
                    itemRef: `core-${slug}`,
                    coreMeta: {
                        category: category,
                        material: remap?.material ?? item.folderName,
                        priceGp: item.system.price?.value ?? 0
                    }
                }
            }
        };

        await writeFile(
            path.join(OUTPUT_DIR, `${slug}.json`),
            JSON.stringify(clean, null, 2)
        );
        count++;
    }

    console.log(`\nWrote ${count} items (${skipped} duplicates skipped).`);
    console.log('Categories:', Object.keys(categoryFolders).join(', '));
    console.log('Material subfolders:', Object.keys(materialFolders).join(', '));
}

main().catch(console.error);
