/**
 * fetch-containers.mjs
 * Generates the Container compendium -- thematic chests, sacks, urns, etc.
 * Each is a dnd5e 'container' type item with terrain tags.
 */

import { writeFile, mkdir, rm } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const OUTPUT_DIR = path.join(ROOT, 'packs/src/workshop-containers');

const CONTAINERS = [
    {
        name: 'Worn Leather Sack',
        img: 'icons/containers/bags/sack-worn-brown.webp',
        terrains: ['any'],
        cacheTypes: ['stash', 'camp_supplies'],
        capacity: 30,
        weight: 1,
        desc: 'A weathered leather sack, stitched crudely. It has seen better days, but still holds its contents.',
        price: 1
    },
    {
        name: 'Battered Wooden Chest',
        img: 'icons/containers/chest/chest-worn-oak-tan.webp',
        terrains: ['dungeon', 'ruin', 'urban'],
        cacheTypes: ['hoard', 'merchant_wreck'],
        capacity: 100,
        weight: 25,
        desc: 'A battered wooden chest with iron fittings, hinges worn loose from years of use.',
        price: 5
    },
    {
        name: 'Iron Lockbox',
        img: 'icons/containers/chest/chest-reinforced-steel-brown.webp',
        terrains: ['dungeon', 'urban', 'underground'],
        cacheTypes: ['hoard', 'arcane_cache'],
        capacity: 50,
        weight: 10,
        desc: 'A compact iron lockbox, hinged lid secured with a simple pin lock. Solid construction.',
        price: 10
    },
    {
        name: 'Clay Burial Urn',
        img: 'icons/containers/kitchenware/jug-clay-brown-sealed.webp',
        terrains: ['tomb', 'ruin', 'temple'],
        cacheTypes: ['hoard', 'arcane_cache'],
        capacity: 20,
        weight: 3,
        desc: 'A red-clay urn sealed with wax, likely intended for burial. Whatever was inside has long since settled.',
        price: 3
    },
    {
        name: 'Reed Basket',
        img: 'icons/containers/misc/basket-simple-yellow.webp',
        terrains: ['coastal', 'jungle', 'forest', 'wilderness'],
        cacheTypes: ['stash', 'camp_supplies'],
        capacity: 30,
        weight: 0.5,
        desc: 'A tightly woven reed basket with a fitted lid. Lightweight and common in coastal settlements.',
        price: 1
    },
    {
        name: 'Carved Stone Box',
        img: 'icons/containers/chest/chest-reinforced-stone.webp',
        terrains: ['temple', 'underground', 'dungeon'],
        cacheTypes: ['hoard', 'arcane_cache'],
        capacity: 80,
        weight: 40,
        desc: 'A heavy stone box with simple geometric carvings. Clearly intended for long-term storage.',
        price: 15
    },
    {
        name: 'Hollowed Tree Stump',
        img: 'icons/containers/barrels/barrel-oak-tan.webp',
        terrains: ['forest', 'wilderness', 'jungle'],
        cacheTypes: ['stash', 'camp_supplies'],
        capacity: 60,
        weight: 120,
        desc: 'A large rotting stump hollowed out and used as a natural cache. Damp on the inside.',
        price: 0
    },
    {
        name: "Sailor's Waterproof Box",
        img: 'icons/containers/chest/chest-simple-oak-steel-brown.webp',
        terrains: ['coastal', 'ship', 'port'],
        cacheTypes: ['merchant_wreck', 'stash'],
        capacity: 40,
        weight: 8,
        desc: 'A compact box sealed with pitch on the joins. Keeps contents dry even in rough seas.',
        price: 8
    },
    {
        name: "Old Adventurer's Pack",
        img: 'icons/containers/bags/pack-simple-leather-brown.webp',
        terrains: ['any'],
        cacheTypes: ['stash', 'camp_supplies', 'merchant_wreck'],
        capacity: 50,
        weight: 5,
        desc: "A weathered adventurer's pack that has clearly been through a great deal. Stains on the canvas.",
        price: 2
    },
    {
        name: 'Dwarven Tool Chest',
        img: 'icons/containers/chest/chest-reinforced-steel-red.webp',
        terrains: ['dungeon', 'underground', 'mountain'],
        cacheTypes: ['hoard', 'merchant_wreck'],
        capacity: 80,
        weight: 25,
        desc: 'A well-made iron-reinforced chest stamped with a dwarven mason mark. Heavy and dependable.',
        price: 25
    },
    {
        name: 'Woven Bamboo Box',
        img: 'icons/containers/misc/basket-handle-woven-yellow.webp',
        terrains: ['jungle', 'coastal', 'forest'],
        cacheTypes: ['stash', 'camp_supplies'],
        capacity: 25,
        weight: 1,
        desc: 'A finely woven bamboo box with a simple clasp. Clearly crafted with care.',
        price: 2
    },
    {
        name: 'Ancient Stone Coffer',
        img: 'icons/containers/chest/chest-simple-box-gold-brown.webp',
        terrains: ['tomb', 'temple', 'ruin'],
        cacheTypes: ['hoard', 'arcane_cache'],
        capacity: 40,
        weight: 35,
        desc: 'A stone coffer of clearly ancient manufacture, covered in faded script. Sealed with dried clay.',
        price: 0
    },
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

    // Single top-level folder -- containers don't need sub-tiers
    const rootFolder = {
        _id: makeId('container-root'),
        name: 'Containers',
        _type: 'folder',
        type: 'Item',
        sorting: 'a',
        sort: 0,
        color: null,
        folder: null,
        flags: {}
    };

    await writeFile(
        path.join(OUTPUT_DIR, '_folders.json'),
        JSON.stringify([rootFolder], null, 2)
    );

    let count = 0;
    for (const c of CONTAINERS) {
        const slug = slugify(c.name);
        const id = makeId(`container-${slug}`);

        const entry = {
            _id: id,
            name: c.name,
            type: 'container',
            img: c.img,
            folder: rootFolder._id,
            system: {
                description: {
                    value: `<p>${c.desc}</p>`,
                    chat: ''
                },
                source: { custom: '', book: 'Ionrift Workshop', page: '', license: '' },
                quantity: 1,
                weight: c.weight ?? 0,
                price: { value: c.price, denomination: 'gp' },
                rarity: 'common',
                identified: true,
                attunement: 0,
                equipped: false,
                capacity: { type: 'weight', value: c.capacity, weightlessContents: false },
                currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
                properties: []
            },
            flags: {
                'ionrift-quartermaster': {
                    itemRef: `container-${slug}`,
                    containerMeta: {
                        terrains: c.terrains,
                        cacheTypes: c.cacheTypes,
                        capacityLbs: c.capacity
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

    console.log(`Wrote ${count} containers to ${OUTPUT_DIR}`);
}

main().catch(console.error);
