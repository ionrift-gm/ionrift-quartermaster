/**
 * Fetches ALL SRD spells (levels 1-9) from the 5e API and generates
 * a complete scroll compendium with proper metadata, folder structure,
 * class lists, school, and descriptions.
 *
 * Run: node scripts/fetch-srd-scrolls.mjs
 *
 * Output: packs/src/scrolls/ with fully enriched scroll entries + folders
 * Data license: SRD 5.1 CC-BY-4.0
 */

import { writeFile, mkdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'packs', 'src', 'scrolls');
const REFERENCE_DIR = join(__dirname, '..', 'data', 'triage-output');
const API_BASE = 'https://www.dnd5eapi.co/api/spells';

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

// Icons by level -- all verified to exist in Foundry's icon set
const SCROLL_ICONS = {
    1: 'icons/sundries/scrolls/scroll-writing-orange-black.webp',
    2: 'icons/sundries/scrolls/scroll-writing-brown.webp',
    3: 'icons/sundries/scrolls/scroll-runed-brown-purple.webp',
    4: 'icons/sundries/scrolls/scroll-runed-brown-blue.webp',
    5: 'icons/sundries/scrolls/scroll-bound-sealed-brown.webp',
    6: 'icons/sundries/scrolls/scroll-bound-sealed-blue.webp',
    7: 'icons/sundries/scrolls/scroll-bound-sealed-gold-red.webp',
    8: 'icons/sundries/scrolls/scroll-symbol-spiral.webp',
    9: 'icons/sundries/scrolls/scroll-symbol-eye-blue.webp'
};

// School-specific icon overrides -- adds visual flavour in the compendium
const SCHOOL_ICONS = {
    'Abjuration':   'icons/sundries/scrolls/scroll-bound-blue-white.webp',
    'Conjuration':  'icons/sundries/scrolls/scroll-bound-sealed-orange.webp',
    'Divination':   'icons/sundries/scrolls/scroll-symbol-eye-brown.webp',
    'Enchantment':  'icons/sundries/scrolls/scroll-bound-gold.webp',
    'Evocation':    'icons/sundries/scrolls/scroll-runed-brown-white.webp',
    'Illusion':     'icons/sundries/scrolls/scroll-runed-brown-grey.webp',
    'Necromancy':   'icons/sundries/scrolls/scroll-bound-skull-brown.webp',
    'Transmutation':'icons/sundries/scrolls/scroll-runed-brown-green.webp'
};

// Arcane classes vs Divine classes
const ARCANE_CLASSES = new Set(['Wizard', 'Sorcerer', 'Bard', 'Warlock']);
const DIVINE_CLASSES = new Set(['Cleric', 'Druid', 'Paladin', 'Ranger']);

function classifySpell(classNames) {
    const hasArcane = classNames.some(c => ARCANE_CLASSES.has(c));
    const hasDivine = classNames.some(c => DIVINE_CLASSES.has(c));
    if (hasArcane && hasDivine) return 'Shared';
    if (hasDivine) return 'Divine';
    return 'Arcane';
}

// Stable deterministic ID from string
function makeId(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(16).padStart(16, '0').substring(0, 16);
}

// Rate-limited fetch
async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
    return res.json();
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    console.log('Fetching SRD spell list...');

    // Fetch all spells at once
    const allSpells = [];
    for (let level = 1; level <= 9; level++) {
        const list = await fetchJson(`${API_BASE}?level=${level}`);
        console.log(`  Level ${level}: ${list.count} spells`);
        allSpells.push(...list.results.map(r => ({ ...r, level })));
        await sleep(100); // Be polite to the API
    }

    console.log(`\nTotal SRD spells: ${allSpells.length}. Fetching details...`);

    // Fetch each spell's detail
    const spellDetails = [];
    for (let i = 0; i < allSpells.length; i++) {
        const spell = allSpells[i];
        try {
            const detail = await fetchJson(`https://www.dnd5eapi.co${spell.url}`);
            spellDetails.push(detail);
            if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${allSpells.length} fetched...`);
        } catch (e) {
            console.warn(`  Skipping ${spell.name}: ${e.message}`);
        }
        await sleep(50); // Rate limit
    }

    console.log(`\nFetched ${spellDetails.length} spell details. Building compendium...`);

    // Clean output
    await rm(OUTPUT_DIR, { recursive: true, force: true });
    await mkdir(OUTPUT_DIR, { recursive: true });

    // Build folders: School > Level N
    const folderEntries = [];
    const schoolFolders = {};   // 'Abjuration' -> id
    const levelFolders = {};    // 'Abjuration/3' -> id

    // Build item entries
    const compendiumEntries = [];

    for (const spell of spellDetails) {
        const level = spell.level;
        if (level < 1 || level > 9) continue;

        const classNames = (spell.classes ?? []).map(c => c.name);
        const school = spell.school?.name ?? 'Unknown';

        // Ensure school folder exists
        if (!schoolFolders[school]) {
            const schoolId = makeId(`school-${school}`);
            schoolFolders[school] = schoolId;
            folderEntries.push({
                _id: schoolId,
                name: school,
                type: 'Item',
                sorting: 'a',
                sort: 0,
                color: null,
                flags: {}
            });
        }

        // Ensure level folder exists under school
        const lvlKey = `${school}/${level}`;
        if (!levelFolders[lvlKey]) {
            const lvlId = makeId(`lvl-${school}-${level}`);
            levelFolders[lvlKey] = lvlId;
            folderEntries.push({
                _id: lvlId,
                name: `Level ${level}`,
                type: 'Item',
                sorting: 'a',
                sort: level * 100,
                color: null,
                folder: schoolFolders[school],
                flags: {}
            });
        }

        const folderId = levelFolders[lvlKey];
        const stats = SCROLL_STATS[level];
        const scrollSlug = `scroll-${spell.index}`;
        const id = makeId(scrollSlug);

        // Build description from API data
        const descParagraphs = (spell.desc ?? []).map(p => `<p>${p}</p>`).join('');
        const higherLevel = (spell.higher_level ?? []).map(p => `<p><em>${p}</em></p>`).join('');
        const components = (spell.components ?? []).join(', ');

        const description = `<p><strong>Scroll of ${spell.name}</strong> (Level ${level} ${school})</p>`
            + descParagraphs
            + higherLevel
            + `<p><strong>Components:</strong> ${components}${spell.material ? ` (${spell.material})` : ''}</p>`
            + `<p><strong>Casting Time:</strong> ${spell.casting_time ?? '1 action'} | `
            + `<strong>Range:</strong> ${spell.range ?? 'Self'} | `
            + `<strong>Duration:</strong> ${spell.duration ?? 'Instantaneous'}`
            + `${spell.concentration ? ' (Concentration)' : ''}`
            + `${spell.ritual ? ' (Ritual)' : ''}</p>`
            + `<p><em>Classes: ${classNames.join(', ')}</em></p>`;

        // Determine action type based on spell
        let actionType = '';
        if (spell.attack_type === 'ranged') actionType = 'rsak';
        else if (spell.attack_type === 'melee') actionType = 'msak';
        else if (spell.dc) actionType = 'save';
        else if (spell.heal_at_slot_level) actionType = 'heal';

        // Build damage/save data
        const saveAbility = spell.dc?.dc_type?.index ?? '';
        const damageData = [];
        if (spell.damage?.damage_at_slot_level) {
            const baseLevel = String(level);
            const baseDamage = spell.damage.damage_at_slot_level[baseLevel];
            if (baseDamage) {
                damageData.push([baseDamage, spell.damage.damage_type?.index ?? '']);
            }
        }

        const entry = {
            _id: id,
            name: `Scroll of ${spell.name}`,
            type: 'consumable',
            img: SCHOOL_ICONS[school] ?? SCROLL_ICONS[level],
            folder: folderId,
            system: {
                description: { value: description, chat: '' },
                source: { custom: '', book: 'SRD 5.1', page: '', license: 'CC-BY-4.0' },
                quantity: 1,
                weight: 0.1,
                price: { value: stats.price, denomination: 'gp' },
                rarity: stats.rarity,
                identified: true,
                activation: { type: 'action', cost: 1, condition: '' },
                duration: {
                    value: spell.duration?.replace(/[^0-9]/g, '') || '',
                    units: spell.concentration ? 'minute' : ''
                },
                range: {
                    value: parseInt(spell.range) || null,
                    long: null,
                    units: spell.range?.includes('mile') ? 'mi' : spell.range?.includes('feet') ? 'ft' : ''
                },
                uses: { value: 1, max: '1', per: 'charges', recovery: '', autoDestroy: true, prompt: true },
                type: { value: 'scroll', subtype: '' },
                save: saveAbility ? { ability: saveAbility, dc: stats.saveDC, scaling: 'flat' } : { ability: '', dc: null, scaling: '' },
                attack: actionType.includes('ak') ? { bonus: String(stats.attackBonus), flat: false } : { bonus: '', flat: false },
                actionType: actionType,
                damage: { parts: damageData, versatile: '' },
                properties: ['mgc']
            },
            flags: {
                'ionrift-quartermaster': {
                    itemRef: scrollSlug,
                    scrollMeta: {
                        spellName: spell.name,
                        spellLevel: level,
                        school: school.toLowerCase(),
                        saveDC: stats.saveDC,
                        attackBonus: stats.attackBonus,
                        classLists: classNames,
                        ritual: spell.ritual ?? false,
                        concentration: spell.concentration ?? false,
                        components: spell.components ?? []
                    }
                }
            }
        };

        compendiumEntries.push(entry);
        await writeFile(join(OUTPUT_DIR, `${scrollSlug}.json`), JSON.stringify(entry, null, 2));
    }

    // Write folder files
    for (const folder of folderEntries) {
        await writeFile(join(OUTPUT_DIR, `_folder_${folder._id}.json`), JSON.stringify(folder, null, 2));
    }

    // Build school breakdown for reference
    const schools = Object.keys(schoolFolders).sort();
    const schoolBreakdown = Object.fromEntries(
        schools.map(s => [s, compendiumEntries.filter(e => e.flags['ionrift-quartermaster'].scrollMeta.school === s.toLowerCase()).length])
    );

    // Write combined reference
    await mkdir(REFERENCE_DIR, { recursive: true });
    await writeFile(
        join(REFERENCE_DIR, 'compendium-scrolls-full.json'),
        JSON.stringify({
            count: compendiumEntries.length,
            folders: folderEntries.length,
            levelBreakdown: Object.fromEntries(
                Array.from({ length: 9 }, (_, i) => [
                    i + 1,
                    compendiumEntries.filter(e => e.flags['ionrift-quartermaster'].scrollMeta.spellLevel === i + 1).length
                ])
            ),
            schoolBreakdown
        }, null, 2)
    );

    // Print summary
    console.log(`\n=== COMPLETE SRD SCROLL COMPENDIUM ===`);
    console.log(`Total scrolls: ${compendiumEntries.length}`);
    console.log(`Total folders: ${folderEntries.length}`);
    console.log(`\nBy level:`);
    for (let lvl = 1; lvl <= 9; lvl++) {
        const count = compendiumEntries.filter(e => e.flags['ionrift-quartermaster'].scrollMeta.spellLevel === lvl).length;
        console.log(`  Level ${lvl}: ${count} scrolls`);
    }
    console.log(`\nBy school (folder structure):`);
    for (const school of schools) {
        const schoolId = schoolFolders[school];
        const lvlFolders = folderEntries.filter(f => f.folder === schoolId).sort((a, b) => a.sort - b.sort);
        const total = compendiumEntries.filter(e => e.flags['ionrift-quartermaster'].scrollMeta.school === school.toLowerCase()).length;
        console.log(`  ${school}/ (${total})`);
        for (const lf of lvlFolders) {
            const count = compendiumEntries.filter(e => e.folder === lf._id).length;
            console.log(`    ${lf.name}: ${count} scrolls`);
        }
    }

    console.log(`\nSource files written to: ${OUTPUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });

