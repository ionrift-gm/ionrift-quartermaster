/**
 * fetch-gemstones.mjs
 * Generates the Gemstone compendium entries from a curated static list.
 * Uses verified Foundry gem icon paths only.
 */

import { writeFile, mkdir, rm } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const OUTPUT_DIR = path.join(ROOT, 'packs/src/workshop-gemstones');

const BASE_ICON = 'icons/commodities/gems/';

// Tier -> folder sort order
const TIER_SORT = {
    'Chips & Fragments': 100,
    'Polished Common':   200,
    'Semi-Precious':     300,
    'Precious':          400,
    'Flawless':          500,
};

// Logical carry weight per gem tier (lbs)
// Gem chips are essentially dust. A flawless gem is still lighter than it sounds.
const TIER_WEIGHT = {
    'Chips & Fragments': 0.05, // a pinch of gem fragments -- takes up pouch space
    'Polished Common':   0.1,  // pebble-sized cabochon
    'Semi-Precious':     0.1,  // faceted stone, fits in a pouch
    'Precious':          0.2,  // a proper jewel
    'Flawless':          0.5,  // a large, significant stone
};

// Curated gemstone list -- verified icon names only
const GEMSTONES = [
    // ── Chips & Fragments (1-5 gp) ──────────────────────────────────────────
    { name: 'Rough Quartz Chip',        value: 1,  icon: 'gem-rough-cushion-white.webp',        tier: 'Chips & Fragments', desc: 'A tiny, worthless-looking chip of clear quartz. Catches light when tilted.' },
    { name: 'Rough Tourmaline Shard',   value: 2,  icon: 'gem-rough-navette-red.webp',           tier: 'Chips & Fragments', desc: 'A rough, uncut shard of deep red tourmaline.' },
    { name: 'Obsidian Flake',           value: 1,  icon: 'gem-shattered-violet.webp',            tier: 'Chips & Fragments', desc: 'A sharp volcanic glass flake. Useful as a blade, almost worthless as a gem.' },
    { name: 'Raw Garnet Fragment',      value: 3,  icon: 'gem-fragments-red.webp',               tier: 'Chips & Fragments', desc: 'A small cluster of deep red garnet fragments, still matrix-rough.' },
    { name: 'Pyrite Fleck',            value: 1,  icon: 'gem-fragments-rough-green.webp',        tier: 'Chips & Fragments', desc: "Fool's gold. Glitters beguilingly. A merchant will pay next to nothing for it." },
    { name: 'Rough Amethyst Chip',      value: 4,  icon: 'gem-fragments-purple.webp',            tier: 'Chips & Fragments', desc: 'A rough violet chip -- barely a gem, but the colour is striking.' },
    { name: 'River Agate Pebble',       value: 2,  icon: 'gem-rough-cushion-teal.webp',          tier: 'Chips & Fragments', desc: 'A smooth, banded pebble worn to roundness by a river. Collectors prize these.' },

    // ── Polished Common (10-30 gp) ───────────────────────────────────────────
    { name: 'Polished Onyx',            value: 10, icon: 'gem-faceted-round-black.webp',          tier: 'Polished Common', desc: 'A smooth oval of deep black onyx, polished to a mirror finish.' },
    { name: 'Turquoise Bead',           value: 12, icon: 'gem-rough-cushion-orange-red.webp',    tier: 'Polished Common', desc: 'A drilled turquoise bead, likely strung in a necklace at some point.' },
    { name: "Tiger's Eye Stone",        value: 15, icon: 'gem-rough-cushion-orange.webp',        tier: 'Polished Common', desc: 'A chatoyant stone that shimmers gold and brown when turned in the light.' },
    { name: 'Moonstone Cabochon',       value: 20, icon: 'gem-faceted-round-white.webp',         tier: 'Polished Common', desc: 'A pale stone with a blue adularescence -- like moonlight trapped in rock.' },
    { name: 'Polished Bloodstone',      value: 25, icon: 'gem-fragments-green.webp',             tier: 'Polished Common', desc: 'A dark green stone flecked with vivid red -- said to stop bleeding when held.' },
    { name: 'Polished Carnelian',       value: 18, icon: 'gem-rough-cushion-red.webp',           tier: 'Polished Common', desc: 'A warm reddish-orange stone, smooth and warm to the touch.' },
    { name: 'Blue Chalcedony',          value: 20, icon: 'gem-faceted-round-teal.webp',          tier: 'Polished Common', desc: 'A milky pale blue stone, cool and slightly translucent.' },

    // ── Semi-Precious (50-150 gp) ─────────────────────────────────────────────
    { name: 'Cut Amethyst',             value: 50,  icon: 'gem-cut-faceted-princess-purple.webp', tier: 'Semi-Precious', desc: 'A faceted violet amethyst. Clean internal colour, minor inclusions.' },
    { name: 'Faceted Citrine',          value: 60,  icon: 'gem-faceted-octagon-yellow.webp',      tier: 'Semi-Precious', desc: 'A warm golden-yellow citrine cut in an octagon. Bright and cheerful.' },
    { name: 'Small Garnet',             value: 75,  icon: 'gem-faceted-navette-red.webp',         tier: 'Semi-Precious', desc: 'A deep red garnet, faceted to catch the light. Good clarity.' },
    { name: 'Green Tourmaline',         value: 90,  icon: 'gem-rough-faceted-green.webp',         tier: 'Semi-Precious', desc: 'A rich forest-green tourmaline. A fine specimen, lightly included.' },
    { name: 'Blue Topaz',               value: 100, icon: 'gem-faceted-asscher-blue.webp',        tier: 'Semi-Precious', desc: 'A sky-blue topaz cut in an asscher style. Excellent clarity.' },
    { name: 'Rose Quartz Heart',        value: 80,  icon: 'gem-rough-heart-pink.webp',            tier: 'Semi-Precious', desc: 'A naturally heart-shaped rose quartz. Prized as a gift token.' },
    { name: 'Smoky Quartz',             value: 50,  icon: 'gem-rough-cushion-violet.webp',        tier: 'Semi-Precious', desc: 'A translucent brownish-grey quartz. Understated but striking when lit.' },
    { name: 'Peridot',                  value: 65,  icon: 'gem-rough-cushion-green.webp',         tier: 'Semi-Precious', desc: 'A vivid lime-green olivine stone. Said to be gifted by volcanoes.' },
    { name: 'Aquamarine',               value: 150, icon: 'gem-faceted-cushion-teal.webp',        tier: 'Semi-Precious', desc: 'A sea-blue beryl of excellent clarity. Sailors carry these for safe passage.' },
    { name: 'Amber with Insect',        value: 120, icon: 'gem-amber-insect-orange.webp',         tier: 'Semi-Precious', desc: 'Ancient tree resin, fossilised for millennia. A tiny insect is suspended inside.' },

    // ── Precious (200-600 gp) ─────────────────────────────────────────────────
    { name: 'Small Ruby',               value: 250, icon: 'gem-faceted-radiant-red.webp',         tier: 'Precious', desc: 'A pigeon-blood red ruby, 3 carats. Minor inclusions but rich colour.' },
    { name: 'Small Emerald',            value: 300, icon: 'gem-faceted-diamond-green.webp',       tier: 'Precious', desc: 'A vivid green emerald. Some natural inclusions -- the "garden" -- but excellent hue.' },
    { name: 'Blue Sapphire',            value: 200, icon: 'gem-faceted-radiant-blue.webp',        tier: 'Precious', desc: 'A cornflower blue sapphire. Clean stone with excellent brilliance.' },
    { name: 'Imperial Topaz',           value: 400, icon: 'gem-faceted-trillion-orange.webp',     tier: 'Precious', desc: 'A deep golden-orange topaz of Imperial grade. Rare and desirable.' },
    { name: 'Alexandrite',              value: 350, icon: 'gem-rough-navette-purple.webp',        tier: 'Precious', desc: 'Changes from green in daylight to red under firelight. Collectors prize these.' },
    { name: 'Star Ruby',                value: 500, icon: 'gem-oval-red.webp',                    tier: 'Precious', desc: 'A cabochon ruby with a natural six-rayed star. Mesmerising and extremely valuable.' },
    { name: 'Gleaming Pearl',           value: 100, icon: 'pearl-natural.webp',                   tier: 'Precious', desc: 'A large, lustrous natural pearl. Perfectly round, warm white.' },
    { name: 'Black Pearl',              value: 200, icon: 'pearl-purple-dark.webp',               tier: 'Precious', desc: 'A rare dark pearl with deep violet overtones. From a giant oyster.' },
    { name: 'Pink Pearl',               value: 150, icon: 'pearl-pink.webp',                      tier: 'Precious', desc: 'A soft pink pearls -- delicate and feminine, prized by jewellers.' },

    // ── Flawless (1000-5000 gp) ───────────────────────────────────────────────
    { name: 'Flawless Diamond',         value: 2000, icon: 'gem-faceted-diamond-pink-gold.webp',  tier: 'Flawless', desc: 'A perfect, colourless diamond. Not a single inclusion. Worth a fortune.' },
    { name: 'Giant Flawless Ruby',      value: 5000, icon: 'gem-rough-cushion-red-pink.webp',    tier: 'Flawless', desc: 'A 10-carat pigeon-blood ruby of impossible perfection. Museum-worthy.' },
    { name: 'Perfect Emerald',          value: 3000, icon: 'gem-faceted-large-green.webp',        tier: 'Flawless', desc: 'A brilliant green Colombian-grade emerald. No inclusions. Legendary.' },
    { name: 'Ancient Sapphire Cabochon',value: 1500, icon: 'gem-faceted-cushion-teal-black.webp', tier: 'Flawless', desc: 'A deep blue cabochon, visibly ancient. Carved with a faint sigil on the back.' },
    { name: 'Black Opal',               value: 1000, icon: 'gem-rough-cushion-purple-pink.webp', tier: 'Flawless', desc: 'A swirling black opal with every colour of the rainbow dancing inside it.' },
];

function makeId(str) {
    return createHash('md5').update(str).digest('hex').substring(0, 16);
}

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function main() {
    await rm(OUTPUT_DIR, { recursive: true, force: true });
    await mkdir(OUTPUT_DIR, { recursive: true });

    // Build tier folders
    const tierFolders = {};
    for (const [tier, sort] of Object.entries(TIER_SORT)) {
        tierFolders[tier] = {
            _id: makeId(`gem-tier-${tier}`),
            name: tier,
            _type: 'folder',
            type: 'Item',
            sorting: 'a',
            sort,
            color: null,
            folder: null,
            flags: {}
        };
    }

    await writeFile(
        path.join(OUTPUT_DIR, '_folders.json'),
        JSON.stringify(Object.values(tierFolders), null, 2)
    );

    let count = 0;
    for (const gem of GEMSTONES) {
        const slug = slugify(gem.name);
        const id = makeId(`gem-${slug}`);
        const folderId = tierFolders[gem.tier]._id;

        const entry = {
            _id: id,
            name: gem.name,
            type: 'loot',
            img: `${BASE_ICON}${gem.icon}`,
            folder: folderId,
            system: {
                description: {
                    value: `<p>${gem.desc}</p>`,
                    chat: ''
                },
                source: { custom: '', book: 'Ionrift Workshop', page: '', license: '' },
                quantity: 1,
                weight: TIER_WEIGHT[gem.tier] ?? 0.1,
                price: { value: gem.value, denomination: 'gp' },
                rarity: gem.tier === 'Flawless' ? 'veryRare'
                      : gem.tier === 'Precious' ? 'rare'
                      : gem.tier === 'Semi-Precious' ? 'uncommon'
                      : 'common',
                identified: true,
                attunement: 0,
                equipped: false,
                type: { value: 'gem', subtype: '' },
                properties: []
            },
            flags: {
                'ionrift-quartermaster': {
                    itemRef: `gem-${slug}`,
                    gemMeta: {
                        tier: gem.tier,
                        priceGp: gem.value
                    }
                }
            }
        };

        await writeFile(
            path.join(OUTPUT_DIR, `${slug}.json`),
            JSON.stringify(entry, null, 2)
        );
        count++;
    }

    console.log(`Wrote ${count} gemstones across ${Object.keys(tierFolders).length} tiers to ${OUTPUT_DIR}`);
}

main().catch(console.error);
