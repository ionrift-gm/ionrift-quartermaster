/**
 * fetch-treasure.mjs
 * Generates the workshop-treasure compendium.
 * Two categories:
 *   Art Objects -- jewelry, regalia, precious vessels, fine objects
 *   Trade Goods -- named quality commodities (not merchant stock -- special finds)
 *
 * All items are original Ionrift-native. No WotC IP names.
 * Weights represent carrying the item; prices reflect art/rarity value.
 */

import { writeFile, mkdir, rm } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const OUTPUT_DIR = path.join(ROOT, 'packs/src/workshop-treasure');

// ── Art Objects ──────────────────────────────────────────────────────────────
// Jewelry, regalia, vessels, and fine objects. Value from craftsmanship + material.
const ART_OBJECTS = [
    // Jewelry
    { name: 'Gold Filigree Necklace',       price: 75,   weight: 0.1,  img: 'icons/equipment/neck/choker-rounded-gold-green.webp',       desc: 'A delicate gold chain hung with a teardrop aquamarine pendant. Fine city work.' },
    { name: 'Silver Locket (Portrait)',      price: 25,   weight: 0.1,  img: 'icons/equipment/neck/pendant-rough-purple.webp',            desc: 'A tarnished silver locket. A faded portrait inside, too worn to identify.' },
    { name: 'Ruby Brooch',                   price: 150,  weight: 0.1,  img: 'icons/equipment/neck/amulet-round-blue.webp',               desc: 'A polished ruby set in gilded silver. Clearly a piece of some standing.' },
    { name: 'Pearl Drop Earrings (pair)',     price: 50,   weight: 0.05, img: 'icons/equipment/neck/pendant-rough-purple.webp',            desc: 'Matched white pearls on simple gold hooks. Elegant and old-fashioned.' },
    { name: 'Sapphire Signet Ring',          price: 200,  weight: 0.05, img: 'icons/equipment/neck/amulet-round-blue.webp',               desc: 'A heavy gold ring set with a cabochon sapphire. A crest is carved into the stone -- unrecognised.' },
    { name: 'Copper Cuff Bracelet (inlaid)', price: 15,   weight: 0.2,  img: 'icons/equipment/wrist/bracer-ornate-pink-green.webp',       desc: 'A wide copper bracelet inlaid with turquoise chips in a geometric pattern.' },
    { name: 'Ivory Hair Comb',               price: 20,   weight: 0.1,  img: 'icons/equipment/neck/choker-rounded-gold-green.webp',       desc: 'A carved ivory comb, teeth intact. Floral motifs along the spine.' },
    { name: 'Gold Ankle Chain',              price: 30,   weight: 0.1,  img: 'icons/equipment/neck/choker-rounded-gold-green.webp',       desc: 'A fine gold chain worn at the ankle. Small charms dangle from alternating links.' },
    { name: 'Jeweled Anklet',                price: 45,   weight: 0.1,  img: 'icons/equipment/neck/choker-rounded-gold-green.webp',       desc: 'A slim gold anklet set with small garnets. Delicate enough to suggest it was not made for travel.' },

    // Regalia
    { name: 'Silver Ceremonial Crown',       price: 250,  weight: 1,    img: 'icons/equipment/neck/amulet-round-blue.webp',               desc: 'A thin silver band worked into a crown shape, set with moonstones. Decorative, not functional.' },
    { name: 'Bronze Diadem',                 price: 80,   weight: 0.5,  img: 'icons/equipment/neck/choker-rounded-gold-green.webp',       desc: 'A hammered bronze diadem with a raised sunburst at the brow. Old and slightly dented.' },
    { name: 'Gilded Ceremonial Scepter',     price: 175,  weight: 2,    img: 'icons/weapons/maces/shortmace-ornate-gold.webp',            desc: 'A short scepter of gilded iron, topped with a carved fist. Ceremonial -- the shaft is too thin to be a weapon.' },
    { name: 'Enameled Heraldic Shield Boss', price: 60,   weight: 1,    img: 'icons/equipment/shield/heater-steel-spiral.webp',           desc: 'A removable shield boss enameled in blue and gold. A house crest, no longer identified.' },

    // Precious Vessels
    { name: 'Gold Goblet (engraved)',        price: 100,  weight: 1,    img: 'icons/containers/kitchenware/goblet-engraved-grey.webp',    desc: 'A solid gold goblet with vine motifs pressed into the sides. Heavy and impractical for field use.' },
    { name: 'Silver Chalice',                price: 60,   weight: 0.75, img: 'icons/containers/kitchenware/goblet-engraved-grey.webp',    desc: 'A plain silver chalice, unadorned except for a maker\'s mark on the base.' },
    { name: 'Crystal Decanter (stoppered)',  price: 80,   weight: 2,    img: 'icons/containers/kitchenware/jug-clay-brown-sealed.webp',   desc: 'A cut-crystal decanter with a glass stopper. Empty, but flawless. Catches light cleanly.' },
    { name: 'Ivory Drinking Horn (mounted)', price: 45,   weight: 0.5,  img: 'icons/containers/kitchenware/goblet-jeweled-gold-purple.webp', desc: 'A polished ivory horn with a brass tip and hanging ring. Well-made and clearly used.' },
    { name: 'Jeweled Reliquary Box',         price: 120,  weight: 1.5,  img: 'icons/containers/chest/chest-simple-oak-steel-brown.webp',  desc: 'A small hinged box of gilded wood set with semiprecious stones. Built to hold something precious. Currently empty.' },

    // Fine Objects
    { name: 'Silver Candelabra (three-arm)', price: 55,   weight: 3,    img: 'icons/sundries/misc/hourglass-wood.webp',                   desc: 'A three-armed silver candelabra, tapers still fitted. One arm is slightly bent.' },
    { name: 'Gilded Hand Mirror',            price: 40,   weight: 0.5,  img: 'icons/tools/navigation/compass-brass-blue-red.webp',        desc: 'A small hand mirror with a gilded frame worked into a floral backing. The glass is perfect.' },
    { name: 'Enamel Music Box',              price: 90,   weight: 1,    img: 'icons/containers/chest/chest-reinforced-steel-brown.webp',  desc: 'A wind-up music box enameled in red and black. Plays a few bars of a melody, then stops.' },
    { name: 'Jade Figurine (seated figure)', price: 70,   weight: 0.5,  img: 'icons/commodities/treasure/totem-wood-face-brown.webp',     desc: 'A smooth jade carving of a seated figure, cross-legged, hands in its lap. Expression unreadable.' },
    { name: 'Carved Obsidian Inkwell',       price: 35,   weight: 0.5,  img: 'icons/tools/scribal/spectacles-glasses.webp',               desc: 'An inkwell carved from a single piece of obsidian, polished to a mirror finish. Still faintly stained inside.' },
    { name: 'Bone Chess Set (partial)',      price: 25,   weight: 1,    img: 'icons/sundries/gaming/dice-runed-brown.webp',               desc: 'Hand-carved bone chess pieces in a felt-lined wooden box. Fourteen pieces remain. No board.' },
];

// ── Trade Goods ───────────────────────────────────────────────────────────────
// Named quality commodities -- not standard merchant stock. Special finds.
// These are distinct from the generic items in dnd5e.tradegoods.
const TRADE_GOODS = [
    { name: 'Pouch of Fine Saffron',         price: 50,   weight: 0.1,  img: 'icons/consumables/plants/dried-herbs-leaves-brown.webp',    desc: 'A thumb-sized cloth pouch of deep red saffron threads, dried and fragrant. The quantity is small. The quality is not.' },
    { name: 'Vial of Dark Perfume',           price: 40,   weight: 0.1,  img: 'icons/consumables/potions/potion-flask-corked-cyan.webp',   desc: 'A dark glass vial stoppered with wax. Rich and heavy -- night-blooming flowers and cedar resin. A city scent.' },
    { name: 'Bolt of Pale Silk',              price: 100,  weight: 5,    img: 'icons/equipment/chest/robe-layered-blue.webp',              desc: 'A bolt of near-white silk, woven so finely it catches almost no shadow. Trade-stamped at one end, origin unreadable.' },
    { name: 'Block of Pressed Incense',       price: 25,   weight: 0.5,  img: 'icons/consumables/plants/succulent-bundle-green.webp',      desc: 'A dense block of compressed incense resin, black and slightly tacky. Burns for hours. Temple-quality stock.' },
    { name: 'Cask of Aged Red Wine',          price: 60,   weight: 10,   img: 'icons/containers/kitchenware/jug-clay-brown-sealed.webp',   desc: 'A small sealed cask bearing a vintner\'s stamp. Twelve years old at bottling. The real thing, not table wine.' },
    { name: 'Prime Sable Pelt (cured)',       price: 80,   weight: 2,    img: 'icons/equipment/back/cape-layered-simple-brown.webp',       desc: 'A single prime sable pelt, cured and dried flat. Deep brown, no damage to the fur. Trapper\'s grade.' },
    { name: 'Roll of Deep Velvet',            price: 75,   weight: 3,    img: 'icons/equipment/chest/coat-collared-red-gold.webp',         desc: 'A short roll of plum velvet, enough for a doublet. No flaws in the weave. Whoever packed it knew its value.' },
    { name: 'Tin of Mixed Warm Spices',       price: 30,   weight: 0.3,  img: 'icons/containers/bags/coinpouch-simple-leather-tan.webp',   desc: 'A sealed tin of clove, mace, and something sharper. Cook\'s blend. Expedition quality -- stays fresh sealed.' },
    { name: 'Mapmaker\'s Instrument Roll',    price: 45,   weight: 1,    img: 'icons/tools/navigation/spyglass-telescope-brass-blue.webp',  desc: 'A leather roll containing blank vellum sheets, a compass rose stamp, and three fine-nib pens. Unused.' },
    { name: 'Varnished Hardwood Box (empty)', price: 20,   weight: 1,    img: 'icons/containers/chest/chest-worn-oak-tan.webp',            desc: 'A small rosewood-toned box with brass hinges, varnished to a deep red-brown. Velvet-lined. Built for something specific. That something is gone.' },
    { name: 'Raw Gold Nuggets',               price: 35,   weight: 0.5,  img: 'icons/commodities/treasure/trinket-totem-bone-green.webp',  desc: 'A small cloth bundle of unrefined gold nuggets. Unprocessed, but the weight is real.' },
];

// ── Coin Finds ────────────────────────────────────────────────────────────────
// Physical currency finds -- a coin purse IS an item the players pick up.
// Priced to gate naturally by tier (T1 priceMin=10, T2=40, T3=100, T4=250).
const COIN_FINDS = [
    { name: 'Scattered Coins',       price: 10,  weight: 0.1, img: 'icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp', desc: 'A loose scatter of gold and silver coins. Enough to matter.' },
    { name: 'Small Coin Purse',      price: 25,  weight: 0.2, img: 'icons/containers/bags/coinpouch-simple-leather-tan.webp',              desc: 'A small leather purse, knotted shut. Heavy for its size.' },
    { name: "Merchant's Coin Pouch", price: 75,  weight: 0.5, img: 'icons/containers/bags/coinpouch-simple-leather-tan.webp',              desc: 'A well-made pouch bearing a merchant seal. Well-used but intact.' },
    { name: 'Heavy Coin Sack',       price: 200, weight: 2,   img: 'icons/containers/bags/coinpouch-simple-leather-tan.webp',              desc: 'A canvas sack heavy with coin, tied with a double knot. Significant weight.' },
];

// ── Folders ───────────────────────────────────────────────────────────────────
const FOLDERS = [
    { key: 'art',   name: 'Art Objects',  sort: 100 },
    { key: 'trade', name: 'Trade Goods',  sort: 200 },
    { key: 'coin',  name: 'Coin Finds',   sort: 300 },
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

    // Build folder entries
    const folderMap = {};
    const folderEntries = FOLDERS.map(f => {
        const entry = {
            _id: makeId(`treasure-folder-${f.key}`),
            name: f.name,
            _type: 'folder',
            type: 'Item',
            sorting: 'a',
            sort: f.sort,
            color: null,
            folder: null,
            flags: {}
        };
        folderMap[f.key] = entry;
        return entry;
    });

    await writeFile(
        path.join(OUTPUT_DIR, '_folders.json'),
        JSON.stringify(folderEntries, null, 2)
    );

    // Write items
    const sections = [
        { items: ART_OBJECTS,   folderKey: 'art',   category: 'artObject'  },
        { items: TRADE_GOODS,   folderKey: 'trade', category: 'tradeGood'  },
        { items: COIN_FINDS,    folderKey: 'coin',  category: 'coinFind'   },
    ];

    let count = 0;
    for (const { items, folderKey, category } of sections) {
        const folderId = folderMap[folderKey]._id;
        for (const item of items) {
            const slug = slugify(item.name);
            const id   = makeId(`treasure-${slug}`);

            const entry = {
                _id: id,
                name: item.name,
                type: 'loot',
                img: item.img,
                folder: folderId,
                system: {
                    description: { value: `<p>${item.desc}</p>`, chat: '' },
                    source: { custom: '', book: 'Ionrift Workshop', page: '', license: '' },
                    quantity: 1,
                    weight: item.weight,
                    price: { value: item.price, denomination: 'gp' },
                    rarity: item.price >= 150 ? 'uncommon' : 'common',
                    identified: true,
                    attunement: 0,
                    equipped: false,
                    properties: []
                },
                flags: {
                    'ionrift-quartermaster': {
                        itemRef: `treasure-${slug}`,
                        treasureMeta: {
                            category: category,
                            priceGp: item.price
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
    }

    console.log(`Wrote ${count} treasure items (${ART_OBJECTS.length} art objects, ${TRADE_GOODS.length} trade goods, ${COIN_FINDS.length} coin finds) to ${OUTPUT_DIR}`);
}

main().catch(console.error);
