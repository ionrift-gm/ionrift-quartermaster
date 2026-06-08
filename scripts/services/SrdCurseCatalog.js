/**
 * Canonical SRD cursed item manifest and loot-pool exclusion helpers.
 * Cursed rows belong in world.ionrift-srd-cursed (SrdCurseAdapter), not the
 * compiled loot pool or random cache draws.
 */

/** @type {{ match: string, tier: number, curseType: string, masking?: object }[]} */
export const SRD_CURSE_MANIFEST = [
    { match: "Berserker Axe",               tier: 1, curseType: "compulsion" },
    { match: "Dust of Sneezing and Choking", tier: 1, curseType: "deceptive"  },
    {
        match: "Potion of Poison",
        tier: 1,
        curseType: "deceptive",
        masking: {
            originalName: "Potion of Healing",
            originalRarity: "common",
            img: "icons/consumables/potions/potion-flask-stopped-red.webp",
            description: "<p><em>Potion, Common</em></p><p>This vial contains a red liquid that glimmers when agitated. As a Bonus Action, you can drink it or administer it to another creature within 5 feet of yourself. The creature that drinks the magical red liquid regains 2d4 + 2 Hit Points.</p>"
        }
    },
    { match: "Sword of Vengeance",           tier: 1, curseType: "compulsion" },
    { match: "Armor of Vulnerability",       tier: 3, curseType: "deceptive"  },
    { match: "Bag of Devouring",             tier: 3, curseType: "physical"   },
    { match: "Boots of Dancing",             tier: 2, curseType: "compulsion" },
    { match: "Cloak of Poisonousness",       tier: 2, curseType: "deceptive"  },
    { match: "Crown of Madness",             tier: 2, curseType: "compulsion" },
    { match: "Shield of Missile Attraction", tier: 2, curseType: "deceptive"  },
    { match: "Demon Armor",                  tier: 2, curseType: "binding"    },
    { match: "Necklace of Strangulation",    tier: 3, curseType: "binding"    },
    { match: "Scarab of Death",              tier: 3, curseType: "physical"   },
];

/** @type {Record<string, { price: number, weight: number, denomination: string }>} */
export const SRD_CURSE_ITEM_FALLBACKS = {
    "berserker axe":                { price: 9000,  weight: 7,   denomination: "gp" },
    "dust of sneezing and choking": { price: 450,   weight: 0.1, denomination: "gp" },
    "potion of poison":             { price: 100,   weight: 0.5, denomination: "gp" },
    "sword of vengeance":           { price: 6000,  weight: 3,   denomination: "gp" },
    "armor of vulnerability":       { price: 9000,  weight: 65,  denomination: "gp" },
    "bag of devouring":             { price: 0,     weight: 0.5, denomination: "gp" },
    "boots of dancing":             { price: 4000,  weight: 1,   denomination: "gp" },
    "cloak of poisonousness":       { price: 3000,  weight: 1,   denomination: "gp" },
    "crown of madness":             { price: 2500,  weight: 1,   denomination: "gp" },
    "shield of missile attraction": { price: 6000,  weight: 6,   denomination: "gp" },
    "demon armor":                  { price: 48000, weight: 65,  denomination: "gp" },
    "necklace of strangulation":    { price: 45000, weight: 1,   denomination: "gp" },
    "scarab of death":              { price: 36000, weight: 0,   denomination: "gp" },
};

const MANIFEST_NAMES_LC = new Set(
    SRD_CURSE_MANIFEST.map(entry => entry.match.trim().toLowerCase())
);

/**
 * 2024 template shells and expanded rows that must never enter the loot pool.
 * @param {string} name
 * @returns {boolean}
 */
export function isSrdCursedTemplateName(name) {
    const normalized = (name ?? "").trim().toLowerCase();
    if (!normalized) return false;
    return MANIFEST_NAMES_LC.has(normalized);
}

/**
 * True for canonical cursed items and their 2024 equipment24 permutations
 * (e.g. Berserker Battleaxe +2, Plate Armor of Vulnerability).
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSrdCursedLootName(name) {
    const normalized = (name ?? "").trim().toLowerCase();
    if (!normalized) return false;

    if (MANIFEST_NAMES_LC.has(normalized)) return true;

    if (/^berserker\b/.test(normalized)) return true;
    if (normalized.includes("armor of vulnerability")) return true;
    if (/^sword of vengeance\b/.test(normalized)) return true;
    if (/^shield of missile attraction\b/.test(normalized)) return true;
    if (/^demon armor\b/.test(normalized) || /^demon .+\barmor\b/.test(normalized)) return true;

    return false;
}
