import { MODULE_ID } from "../../data/moduleId.js";

/**
 * Canonical SRD cursed item manifest and loot-pool exclusion helpers.
 * Cursed rows belong in world.ionrift-srd-cursed (SrdCurseAdapter), not the
 * compiled loot pool or random cache draws.
 */

/** @type {{ match: string, tier: number, curseType: string, identifier: string, masking?: object }[]} */
export const SRD_CURSE_MANIFEST = [
    { match: "Berserker Axe",               tier: 1, curseType: "compulsion", identifier: "berserker-axe" },
    { match: "Dust of Sneezing and Choking", tier: 1, curseType: "deceptive",  identifier: "dust-of-sneezing-and-choking" },
    {
        match: "Potion of Poison",
        tier: 1,
        curseType: "deceptive",
        identifier: "potion-of-poison",
        masking: {
            originalName: "Potion of Healing",
            originalRarity: "common",
            img: "icons/consumables/potions/potion-flask-stopped-red.webp",
            description: "<p><em>Potion, Common</em></p><p>This vial contains a red liquid that glimmers when agitated. As a Bonus Action, you can drink it or administer it to another creature within 5 feet of yourself. The creature that drinks the magical red liquid regains 2d4 + 2 Hit Points.</p>"
        }
    },
    { match: "Sword of Vengeance",           tier: 1, curseType: "compulsion", identifier: "sword-of-vengeance" },
    { match: "Armor of Vulnerability",       tier: 3, curseType: "deceptive",  identifier: "armor-of-vulnerability" },
    { match: "Bag of Devouring",             tier: 3, curseType: "physical",   identifier: "bag-of-devouring" },
    { match: "Boots of Dancing",             tier: 2, curseType: "compulsion", identifier: "boots-of-dancing" },
    { match: "Cloak of Poisonousness",       tier: 2, curseType: "deceptive",  identifier: "cloak-of-poisonousness" },
    { match: "Crown of Madness",             tier: 2, curseType: "compulsion", identifier: "crown-of-madness" },
    { match: "Shield of Missile Attraction", tier: 2, curseType: "deceptive",  identifier: "shield-of-missile-attraction" },
    { match: "Demon Armor",                  tier: 2, curseType: "binding",    identifier: "demon-armor" },
    { match: "Necklace of Strangulation",    tier: 3, curseType: "binding",    identifier: "necklace-of-strangulation" },
    { match: "Scarab of Death",              tier: 3, curseType: "physical",   identifier: "scarab-of-death" },
];

/** @type {Record<string, { price: number, weight: number, denomination: string, identifier?: string }>} */
export const SRD_CURSE_ITEM_FALLBACKS = {
    "berserker axe":                { price: 9000,  weight: 7,   denomination: "gp", identifier: "berserker-axe" },
    "dust of sneezing and choking": { price: 450,   weight: 0.1, denomination: "gp", identifier: "dust-of-sneezing-and-choking" },
    "potion of poison":             { price: 100,   weight: 0.5, denomination: "gp", identifier: "potion-of-poison" },
    "sword of vengeance":           { price: 6000,  weight: 3,   denomination: "gp", identifier: "sword-of-vengeance" },
    "armor of vulnerability":       { price: 9000,  weight: 65,  denomination: "gp", identifier: "armor-of-vulnerability" },
    "bag of devouring":             { price: 0,     weight: 0.5, denomination: "gp", identifier: "bag-of-devouring" },
    "boots of dancing":             { price: 4000,  weight: 1,   denomination: "gp", identifier: "boots-of-dancing" },
    "cloak of poisonousness":       { price: 3000,  weight: 1,   denomination: "gp", identifier: "cloak-of-poisonousness" },
    "crown of madness":             { price: 2500,  weight: 1,   denomination: "gp", identifier: "crown-of-madness" },
    "shield of missile attraction": { price: 6000,  weight: 6,   denomination: "gp", identifier: "shield-of-missile-attraction" },
    "demon armor":                  { price: 48000, weight: 65,  denomination: "gp", identifier: "demon-armor" },
    "necklace of strangulation":    { price: 45000, weight: 1,   denomination: "gp", identifier: "necklace-of-strangulation" },
    "scarab of death":              { price: 36000, weight: 0,   denomination: "gp", identifier: "scarab-of-death" },
};

const MANIFEST_NAMES_LC = new Set(
    SRD_CURSE_MANIFEST.map(entry => entry.match.trim().toLowerCase())
);

const MANIFEST_BY_NAME = new Map(
    SRD_CURSE_MANIFEST.map(entry => [entry.match.trim().toLowerCase(), entry])
);

const MANIFEST_BY_IDENTIFIER = new Map(
    SRD_CURSE_MANIFEST.map(entry => [entry.identifier.toLowerCase(), entry])
);

function _matchSrdVariantName(normalized) {
    if (/^berserker\b/.test(normalized)) return MANIFEST_BY_NAME.get("berserker axe");
    if (normalized.includes("armor of vulnerability")) return MANIFEST_BY_NAME.get("armor of vulnerability");
    if (/^sword of vengeance\b/.test(normalized)) return MANIFEST_BY_NAME.get("sword of vengeance");
    if (/^shield of missile attraction\b/.test(normalized)) return MANIFEST_BY_NAME.get("shield of missile attraction");
    if (/^demon armor\b/.test(normalized) || /^demon .+\barmor\b/.test(normalized)) return MANIFEST_BY_NAME.get("demon armor");
    return null;
}

function _matchSrdVariantIdentifier(ident) {
    if (/^berserker-/.test(ident)) return MANIFEST_BY_IDENTIFIER.get("berserker-axe");
    if (ident.includes("armor-of-vulnerability")) return MANIFEST_BY_IDENTIFIER.get("armor-of-vulnerability");
    if (/^sword-of-vengeance/.test(ident)) return MANIFEST_BY_IDENTIFIER.get("sword-of-vengeance");
    if (/^shield-of-missile-attraction/.test(ident)) return MANIFEST_BY_IDENTIFIER.get("shield-of-missile-attraction");
    if (/^demon-.*armor/.test(ident) || ident === "demon-armor") return MANIFEST_BY_IDENTIFIER.get("demon-armor");
    return null;
}

/**
 * Resolves an entry from SRD_CURSE_MANIFEST by:
 * 1. flags["ionrift-quartermaster"].curseSlug (or doc.getFlag)
 * 2. doc.system?.identifier
 * 3. _stats.compendiumSource UUID suffix or doc.id / doc._id
 * 4. Fallback to doc.name (with prefix/variant matching).
 *
 * @param {object|string} docOrEntry
 * @returns {object|null} Matching manifest entry or null
 */
export function lookupSrdCurseManifestEntry(docOrEntry) {
    if (!docOrEntry) return null;

    if (typeof docOrEntry === "string") {
        const norm = docOrEntry.trim().toLowerCase();
        if (!norm) return null;
        if (MANIFEST_BY_NAME.has(norm)) return MANIFEST_BY_NAME.get(norm);
        if (MANIFEST_BY_IDENTIFIER.has(norm)) return MANIFEST_BY_IDENTIFIER.get(norm);
        return _matchSrdVariantName(norm);
    }

    // 1. flags["ionrift-quartermaster"].curseSlug
    const curseSlug = (docOrEntry.getFlag?.(MODULE_ID, "curseSlug")
        ?? docOrEntry.flags?.[MODULE_ID]?.curseSlug
        ?? docOrEntry.flags?.[MODULE_ID]?.cursedMeta?.curseSlug);
    if (curseSlug) {
        const slugNorm = String(curseSlug).trim().toLowerCase();
        if (MANIFEST_BY_IDENTIFIER.has(slugNorm)) return MANIFEST_BY_IDENTIFIER.get(slugNorm);
        const slugWithSpaces = slugNorm.replace(/-/g, " ");
        if (MANIFEST_BY_NAME.has(slugWithSpaces)) return MANIFEST_BY_NAME.get(slugWithSpaces);
    }

    // 2. system.identifier
    const ident = (docOrEntry.system?.identifier ?? "").trim().toLowerCase();
    if (ident) {
        if (MANIFEST_BY_IDENTIFIER.has(ident)) return MANIFEST_BY_IDENTIFIER.get(ident);
        const identSpaces = ident.replace(/-/g, " ");
        if (MANIFEST_BY_NAME.has(identSpaces)) return MANIFEST_BY_NAME.get(identSpaces);
        const variant = _matchSrdVariantIdentifier(ident);
        if (variant) return variant;
    }

    // 3. _stats.compendiumSource suffix or doc.id / doc._id
    const sourceUuid = docOrEntry._stats?.compendiumSource;
    if (sourceUuid) {
        const suffix = String(sourceUuid).split(".").pop()?.trim().toLowerCase();
        if (suffix && MANIFEST_BY_IDENTIFIER.has(suffix)) return MANIFEST_BY_IDENTIFIER.get(suffix);
    }
    const docId = (docOrEntry.id ?? docOrEntry._id ?? "").trim().toLowerCase();
    if (docId && MANIFEST_BY_IDENTIFIER.has(docId)) return MANIFEST_BY_IDENTIFIER.get(docId);

    // 4. doc.name fallback
    const rawName = (docOrEntry.name ?? "").trim().toLowerCase();
    if (rawName) {
        if (MANIFEST_BY_NAME.has(rawName)) return MANIFEST_BY_NAME.get(rawName);
        return _matchSrdVariantName(rawName);
    }

    return null;
}

/**
 * 2024 template shells and expanded rows that must never enter the loot pool.
 * @param {string|object} nameOrEntry
 * @returns {boolean}
 */
export function isSrdCursedTemplateName(nameOrEntry) {
    if (typeof nameOrEntry === "object" && nameOrEntry !== null) {
        const entry = lookupSrdCurseManifestEntry(nameOrEntry);
        return !!entry;
    }
    const normalized = (nameOrEntry ?? "").trim().toLowerCase();
    if (!normalized) return false;
    if (MANIFEST_NAMES_LC.has(normalized)) return true;
    const identSpaces = normalized.replace(/-/g, " ");
    return MANIFEST_NAMES_LC.has(identSpaces);
}

/**
 * True for canonical cursed items and their 2024 equipment24 permutations,
 * checking flags, system.identifier, compendium source, or name.
 *
 * @param {object|string} entry
 * @returns {boolean}
 */
export function isSrdCursedLootEntry(entry) {
    if (!entry) return false;
    if (typeof entry === "string") return isSrdCursedLootName(entry);

    // 1. Explicit cursed flags
    const qmFlags = entry.flags?.[MODULE_ID];
    if (qmFlags?.isCurseItem) return true;

    // 2. Lookup in manifest
    if (lookupSrdCurseManifestEntry(entry)) return true;

    // 3. Fallback to name heuristic
    return isSrdCursedLootName(entry.name);
}

/**
 * True for canonical cursed items and their 2024 equipment24 permutations
 * (e.g. Berserker Battleaxe +2, Plate Armor of Vulnerability).
 * Accepts either a string name or an item/entry object.
 *
 * @param {string|object} nameOrEntry
 * @returns {boolean}
 */
export function isSrdCursedLootName(nameOrEntry) {
    if (typeof nameOrEntry === "object" && nameOrEntry !== null) {
        return isSrdCursedLootEntry(nameOrEntry);
    }
    const normalized = (nameOrEntry ?? "").trim().toLowerCase();
    if (!normalized) return false;

    if (MANIFEST_NAMES_LC.has(normalized)) return true;

    if (/^berserker\b/.test(normalized)) return true;
    if (normalized.includes("armor of vulnerability")) return true;
    if (/^sword of vengeance\b/.test(normalized)) return true;
    if (/^shield of missile attraction\b/.test(normalized)) return true;
    if (/^demon armor\b/.test(normalized) || /^demon .+\barmor\b/.test(normalized)) return true;

    return false;
}
