/**
 * Build script: generates Foundry compendium source files from triaged scroll data.
 * Now includes folder assignments by primary class and spell level.
 *
 * Run with: node scripts/build-scroll-compendium.mjs
 */

import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT = join(__dirname, '..', 'data', 'triage-output', 'scrolls.json');
const OUTPUT_DIR = join(__dirname, '..', 'packs', 'src', 'scrolls');

// DMG scroll stats by level
const SCROLL_STATS = {
    1: { saveDC: 13, attackBonus: 5, rarity: 'common', price: 60 },
    2: { saveDC: 13, attackBonus: 5, rarity: 'common', price: 120 },
    3: { saveDC: 15, attackBonus: 7, rarity: 'uncommon', price: 200 },
    4: { saveDC: 15, attackBonus: 7, rarity: 'rare', price: 320 },
    5: { saveDC: 17, attackBonus: 9, rarity: 'rare', price: 640 },
    6: { saveDC: 17, attackBonus: 9, rarity: 'very rare', price: 1280 },
    7: { saveDC: 18, attackBonus: 10, rarity: 'very rare', price: 2560 },
    8: { saveDC: 18, attackBonus: 10, rarity: 'very rare', price: 5120 },
    9: { saveDC: 19, attackBonus: 11, rarity: 'legendary', price: 10240 }
};

const SCROLL_ICONS = {
    1: 'icons/sundries/scrolls/scroll-writing-orange-black.webp',
    2: 'icons/sundries/scrolls/scroll-bound-green.webp',
    3: 'icons/sundries/scrolls/scroll-runed-brown-purple.webp',
    4: 'icons/sundries/scrolls/scroll-worn-brown.webp',
    5: 'icons/sundries/scrolls/scroll-bound-sealed-red.webp',
    6: 'icons/sundries/scrolls/scroll-worn-tan.webp',
    7: 'icons/sundries/scrolls/scroll-bound-sealed-brown.webp',
    8: 'icons/sundries/scrolls/scroll-bound-yellow.webp',
    9: 'icons/sundries/scrolls/scroll-symbol-gold.webp'
};

// ── SRD Spell Class Mapping ─────────────────────────────
// Primary class = first entry. Full list used for flags/seeder.
const SPELL_CLASSES = {
    'Alarm':                        ['Wizard', 'Ranger'],
    'Bane':                         ['Cleric', 'Bard'],
    'Bless':                        ['Cleric', 'Paladin'],
    'Burning Hands':                ['Wizard', 'Sorcerer'],
    'Ceremony':                     ['Cleric'],
    'Charm Person':                 ['Bard', 'Wizard', 'Sorcerer', 'Warlock', 'Druid'],
    'Chromatic Orb':                ['Wizard', 'Sorcerer'],
    'Color Spray':                  ['Wizard', 'Sorcerer'],
    'Command':                      ['Cleric', 'Paladin', 'Bard'],
    'Comprehend Languages':         ['Wizard', 'Bard', 'Sorcerer', 'Warlock'],
    'Create or Destroy Water':      ['Cleric', 'Druid'],
    'Cure Wounds':                  ['Cleric', 'Bard', 'Druid', 'Paladin', 'Ranger'],
    'Detect Evil and Good':         ['Cleric', 'Paladin'],
    'Detect Magic':                 ['Wizard', 'Bard', 'Cleric', 'Druid', 'Paladin', 'Ranger', 'Sorcerer'],
    'Detect Poison and Disease':    ['Cleric', 'Druid', 'Paladin', 'Ranger'],
    'Disguise Self':                ['Wizard', 'Bard', 'Sorcerer'],
    'Expeditious Retreat':          ['Wizard', 'Sorcerer', 'Warlock'],
    'False Life':                   ['Wizard', 'Sorcerer'],
    'Feather Fall':                 ['Wizard', 'Bard', 'Sorcerer'],
    'Find Familiar':                ['Wizard'],
    'Fog Cloud':                    ['Wizard', 'Druid', 'Ranger', 'Sorcerer'],
    'Grease':                       ['Wizard'],
    'Guiding Bolt':                 ['Cleric'],
    'Healing Word':                 ['Cleric', 'Bard', 'Druid'],
    'Identify':                     ['Wizard', 'Bard'],
    'Illusory Script':              ['Wizard', 'Bard', 'Warlock'],
    'Inflict Wounds':               ['Cleric'],
    'Jump':                         ['Wizard', 'Druid', 'Ranger', 'Sorcerer'],
    'Longstrider':                  ['Wizard', 'Bard', 'Druid', 'Ranger'],
    'Mage Armor':                   ['Wizard', 'Sorcerer'],
    'Magic Missile':                ['Wizard', 'Sorcerer'],
    'Protection from Evil and Good':['Cleric', 'Wizard', 'Paladin', 'Warlock'],
    'Purify Food and Drink':        ['Cleric', 'Druid', 'Paladin'],
    'Ray of Sickness':              ['Wizard', 'Sorcerer'],
    'Sanctuary':                    ['Cleric'],
    'Shield':                       ['Wizard', 'Sorcerer'],
    'Shield of Faith':              ['Cleric', 'Paladin'],
    'Silent Image':                 ['Wizard', 'Bard', 'Sorcerer'],
    'Sleep':                        ['Wizard', 'Bard', 'Sorcerer'],
    "Tasha's Hideous Laughter":     ['Wizard', 'Bard'],
    "Tenser's Floating Disk":       ['Wizard'],
    'Thunderwave':                  ['Wizard', 'Bard', 'Sorcerer', 'Druid'],
    'Unseen Servant':               ['Wizard', 'Bard', 'Warlock'],
    'Witch Bolt':                   ['Wizard', 'Sorcerer', 'Warlock']
};

// Stable folder IDs (deterministic for reproducibility)
function makeFolderId(name) {
    // 16 char hex from name hash
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0').substring(0, 16).padEnd(16, '0');
}

async function main() {
    console.log('Reading triaged scrolls...');
    const raw = await readFile(INPUT, 'utf-8');
    const { items } = JSON.parse(raw);
    console.log(`Processing ${items.length} scrolls.`);

    // Clean and recreate output
    await rm(OUTPUT_DIR, { recursive: true, force: true });
    await mkdir(OUTPUT_DIR, { recursive: true });

    // Build folder structure
    // Top level: class folders. Under each: level folders.
    const classFolders = {};  // className -> folderId
    const levelFolders = {};  // "className/Level N" -> folderId

    const compendiumEntries = [];
    const folderEntries = [];
    const seen = new Set();

    for (const item of items) {
        const meta = item._scrollMeta ?? {};
        const spellName = meta.spellName;
        const spellLevel = meta.spellLevel ?? 1;

        if (!spellName) {
            console.warn(`  Skipping: no spell name for "${item.name}"`);
            continue;
        }

        const key = `${spellLevel}-${spellName.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Determine primary class
        const classes = SPELL_CLASSES[spellName] ?? ['Wizard'];
        const primaryClass = classes[0];

        // Ensure class folder exists
        if (!classFolders[primaryClass]) {
            const classId = makeFolderId(`class-${primaryClass}`);
            classFolders[primaryClass] = classId;
            folderEntries.push({
                _id: classId,
                name: primaryClass,
                type: 'Item',
                sorting: 'a',
                sort: 0,
                color: null,
                flags: {}
            });
        }

        // Ensure level folder exists under class
        const levelKey = `${primaryClass}/Level ${spellLevel}`;
        if (!levelFolders[levelKey]) {
            const levelId = makeFolderId(`level-${primaryClass}-${spellLevel}`);
            levelFolders[levelKey] = levelId;
            folderEntries.push({
                _id: levelId,
                name: `Level ${spellLevel}`,
                type: 'Item',
                sorting: 'a',
                sort: spellLevel * 100,
                color: null,
                folder: classFolders[primaryClass],
                flags: {}
            });
        }

        const folderId = levelFolders[levelKey];
        const stats = SCROLL_STATS[spellLevel] ?? SCROLL_STATS[1];
        const scrollId = `scroll-${spellName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')}`;

        const entry = {
            _id: randomUUID().replace(/-/g, '').substring(0, 16),
            name: `Scroll of ${spellName}`,
            type: 'consumable',
            img: item.img ?? SCROLL_ICONS[spellLevel] ?? SCROLL_ICONS[1],
            folder: folderId,
            system: {
                ...(item.system ?? {}),
                description: {
                    value: buildDescription(spellName, spellLevel, classes),
                    chat: ''
                },
                quantity: 1,
                weight: 0,
                price: { value: stats.price, denomination: 'gp' },
                rarity: stats.rarity,
                identified: true,
                activation: { type: 'action', cost: 1, condition: '' },
                uses: { value: 1, max: '1', per: 'charges', recovery: '', autoDestroy: true, prompt: true },
                type: { value: 'scroll', subtype: '' },
                save: item.system?.save?.dc ? item.system.save : { ability: '', dc: stats.saveDC, scaling: 'flat' },
                attack: { bonus: String(stats.attackBonus), flat: false },
                properties: ['mgc']
            },
            flags: {
                'ionrift-quartermaster': {
                    itemRef: scrollId,
                    scrollMeta: {
                        spellName,
                        spellLevel,
                        saveDC: stats.saveDC,
                        attackBonus: stats.attackBonus,
                        primaryClass,
                        classLists: classes,
                        schoolHint: meta.schoolHint ?? null
                    }
                }
            }
        };

        compendiumEntries.push(entry);

        const filename = `${scrollId}.json`;
        await writeFile(join(OUTPUT_DIR, filename), JSON.stringify(entry, null, 2));
    }

    // Write folder entries as separate files
    for (const folder of folderEntries) {
        await writeFile(
            join(OUTPUT_DIR, `_folder_${folder._id}.json`),
            JSON.stringify(folder, null, 2)
        );
    }

    // Write combined reference
    await writeFile(
        join(__dirname, '..', 'data', 'triage-output', 'compendium-scrolls.json'),
        JSON.stringify({
            count: compendiumEntries.length,
            folders: folderEntries.length,
            entries: compendiumEntries,
            folderEntries
        }, null, 2)
    );

    console.log(`\nBuilt ${compendiumEntries.length} scroll entries + ${folderEntries.length} folders.`);

    // Print folder structure
    console.log('\nFolder structure:');
    const topFolders = folderEntries.filter(f => !f.folder);
    for (const top of topFolders.sort((a, b) => a.name.localeCompare(b.name))) {
        const children = folderEntries.filter(f => f.folder === top._id);
        const itemCount = compendiumEntries.filter(e => children.some(c => c._id === e.folder)).length;
        console.log(`  ${top.name} (${itemCount} scrolls)`);
        for (const child of children.sort((a, b) => a.sort - b.sort)) {
            const count = compendiumEntries.filter(e => e.folder === child._id).length;
            console.log(`    ${child.name}: ${count} scrolls`);
        }
    }
}

function buildDescription(spellName, level, classes) {
    const classList = classes.join(', ');
    return `<p>A spell scroll bearing the spell <strong>${spellName}</strong> (Level ${level}).</p>`
        + `<p>When you use an action to read the scroll, the spell is cast at its base level. `
        + `After the spell is cast, the scroll crumbles to dust.</p>`
        + `<p>If the spell is not on your class's spell list, you must make a DC ${10 + level} `
        + `Intelligence (Arcana) check or the casting fails and the scroll is not consumed.</p>`
        + `<p><em>Spell lists: ${classList}</em></p>`;
}

main().catch(e => { console.error(e); process.exit(1); });
