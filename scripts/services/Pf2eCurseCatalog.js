/**
 * Pathfinder 2e specific cursed items (GMG / GM Core Treasure Trove).
 *
 * Scope draft for Pf2eCurseAdapter and Cursewright PF2e port planning.
 * Do not wire into SrdCurseAdapter; dnd5e manifest stays separate.
 *
 * Sources: pf2e.equipment-srd (same LevelDB as pf2e.equipment in the system module).
 * Items carry the `cursed` trait in system.traits.value.
 *
 * @see ionrift-quartermaster/.cursor/specs/PF2E_CURSE_CATALOG.md
 */

/** Compendium packs scanned for PF2e cursed items. */
export const PF2E_CURSE_PACK_SOURCES = [
    "pf2e.equipment-srd",
    "pf2e.consumables-srd",
];

/**
 * Cursewright behaviour archetypes (ionrift-cursewright).
 * @typedef {"slow-burn-equipment"|"deceptive-consumable"|"combat-trigger"|"devouring-container"|"threshold-reversal"|"compendium-faithful"|"bespoke"} Pf2eArchetypeTarget
 */

/**
 * @typedef {object} Pf2eCurseCatalogEntry
 * @property {string} match           Exact compendium name (Foundry pf2e equipment pack).
 * @property {number} tier            Ionrift curse tier 1-4 (design vocabulary, not item level).
 * @property {string} curseType       compulsion | deceptive | physical | binding
 * @property {number} [itemLevel]     PF2e item level when known (GMG table).
 * @property {Pf2eArchetypeTarget} archetypeTarget
 * @property {string|null} cursewrightRecipe  Shipped recipe id, or null if none.
 * @property {string|null} dnd5eSrdAnalogue   Closest D&D SRD manifest name, if any.
 * @property {"phase-1"|"phase-2"|"phase-3"|"phase-4"|"backlog"} implementation
 * @property {string} [notes]
 */

/**
 * GMG / GM Core "Specific Cursed Items" plus level variants as separate rows.
 * Sorted by item level for reference; compile order can differ.
 *
 * @type {Pf2eCurseCatalogEntry[]}
 */
export const PF2E_GMG_CURSE_MANIFEST = [
    {
        match: "Stone of Weight",
        tier: 1,
        curseType: "deceptive",
        itemLevel: 2,
        archetypeTarget: "slow-burn-equipment",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: null,
        implementation: "phase-3",
        notes: "Loadstone lure. Encumbrance trap. No D&D SRD row; no Cursewright recipe."
    },
    {
        match: "Bag of Weasels",
        tier: 1,
        curseType: "deceptive",
        itemLevel: 4,
        archetypeTarget: "devouring-container",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: null,
        implementation: "phase-3",
        notes: "Type I bag of holding lure. PF2e-only. Lighter than Maw Satchel."
    },
    {
        match: "Poisonous Cloak (Type I)",
        tier: 2,
        curseType: "deceptive",
        itemLevel: 6,
        archetypeTarget: "slow-burn-equipment",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: "Cloak of Poisonousness",
        implementation: "phase-2",
        notes: "Verify Foundry pack label; may be 'Poisonous Cloak' with level suffix only."
    },
    {
        match: "Poisonous Cloak (Type II)",
        tier: 2,
        curseType: "deceptive",
        itemLevel: 10,
        archetypeTarget: "slow-burn-equipment",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: "Cloak of Poisonousness",
        implementation: "phase-2",
        notes: "Higher-level variant; one recipe can skin all four types."
    },
    {
        match: "Poisonous Cloak (Type III)",
        tier: 2,
        curseType: "deceptive",
        itemLevel: 13,
        archetypeTarget: "slow-burn-equipment",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: "Cloak of Poisonousness",
        implementation: "phase-2"
    },
    {
        match: "Poisonous Cloak (Type IV)",
        tier: 2,
        curseType: "deceptive",
        itemLevel: 17,
        archetypeTarget: "slow-burn-equipment",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: "Cloak of Poisonousness",
        implementation: "phase-2"
    },
    {
        match: "Bag of Devouring (Type I)",
        tier: 3,
        curseType: "physical",
        itemLevel: 7,
        archetypeTarget: "devouring-container",
        cursewrightRecipe: "maw-satchel",
        dnd5eSrdAnalogue: "Bag of Devouring",
        implementation: "phase-1",
        notes: "Primary Maw Satchel PF2e match. Confirm exact Foundry name."
    },
    {
        match: "Bag of Devouring (Type II)",
        tier: 3,
        curseType: "physical",
        itemLevel: 11,
        archetypeTarget: "devouring-container",
        cursewrightRecipe: "maw-satchel",
        dnd5eSrdAnalogue: "Bag of Devouring",
        implementation: "phase-1"
    },
    {
        match: "Bag of Devouring (Type III)",
        tier: 3,
        curseType: "physical",
        itemLevel: 13,
        archetypeTarget: "devouring-container",
        cursewrightRecipe: "maw-satchel",
        dnd5eSrdAnalogue: "Bag of Devouring",
        implementation: "phase-1"
    },
    {
        match: "Cloak of Immolation",
        tier: 2,
        curseType: "physical",
        itemLevel: 7,
        archetypeTarget: "combat-trigger",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: null,
        implementation: "phase-4",
        notes: "Elvenkind lure. Ignites under stress. PF2e-only."
    },
    {
        match: "Gloves of Carelessness",
        tier: 2,
        curseType: "compulsion",
        itemLevel: 7,
        archetypeTarget: "slow-burn-equipment",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: null,
        implementation: "phase-4",
        notes: "Gloves of storing lure. Not Gauntlets of Ogre Power; different arc."
    },
    {
        match: "Ring of Truth",
        tier: 2,
        curseType: "deceptive",
        itemLevel: 10,
        archetypeTarget: "slow-burn-equipment",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: null,
        implementation: "phase-4",
        notes: "Appears as ring of lies. PF2e-only."
    },
    {
        match: "Boots of Dancing",
        tier: 2,
        curseType: "compulsion",
        itemLevel: 11,
        archetypeTarget: "combat-trigger",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: "Boots of Dancing",
        implementation: "phase-3",
        notes: "Same name as D&D SRD; no Cursewright recipe yet on either system."
    },
    {
        match: "Medusa Armor",
        tier: 3,
        curseType: "deceptive",
        itemLevel: 14,
        archetypeTarget: "combat-trigger",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: "Demon Armor",
        implementation: "phase-5",
        notes: "Conceptual overlap with Hellforged Plate (bound armor), not a skin match."
    },
    {
        match: "Necklace of Strangulation",
        tier: 3,
        curseType: "binding",
        itemLevel: 15,
        archetypeTarget: "slow-burn-equipment",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: "Necklace of Strangulation",
        implementation: "phase-3",
        notes: "Same name as D&D SRD; no Cursewright recipe yet."
    },
    {
        match: "Monkey's Paw",
        tier: 4,
        curseType: "physical",
        itemLevel: 20,
        archetypeTarget: "bespoke",
        cursewrightRecipe: null,
        dnd5eSrdAnalogue: null,
        implementation: "phase-5",
        notes: "Wish-granter trap. Tier 4 original scope like Idol of the Gilded Hour."
    }
];

/**
 * D&D SRD manifest items with no PF2e GMG specific-cursed analogue.
 * Keep excluded from PF2e loot via trait scan; do not expect manifest match.
 *
 * @type {{ match: string, cursewrightRecipe: string|null, archetypeTarget: Pf2eArchetypeTarget, notes: string }[]}
 */
export const DND5E_ONLY_SRD_CURSES = [
    { match: "Berserker Axe", cursewrightRecipe: "oathcleaver", archetypeTarget: "combat-trigger", notes: "No PF2e GMG row." },
    { match: "Dust of Sneezing and Choking", cursewrightRecipe: "apothecary-folly", archetypeTarget: "deceptive-consumable", notes: "No PF2e equivalent." },
    { match: "Potion of Poison", cursewrightRecipe: "poison-potion", archetypeTarget: "deceptive-consumable", notes: "PF2e may use cursed healing potion entries instead." },
    { match: "Sword of Vengeance", cursewrightRecipe: null, archetypeTarget: "combat-trigger", notes: "No PF2e GMG row." },
    { match: "Armor of Vulnerability", cursewrightRecipe: "vigil-robe", archetypeTarget: "threshold-reversal", notes: "Recipe withheld; no PF2e GMG row." },
    { match: "Crown of Madness", cursewrightRecipe: null, archetypeTarget: "combat-trigger", notes: "No PF2e GMG row." },
    { match: "Shield of Missile Attraction", cursewrightRecipe: "lodestone-aegis", archetypeTarget: "slow-burn-equipment", notes: "No PF2e GMG row." },
    { match: "Demon Armor", cursewrightRecipe: "hellforged-plate", archetypeTarget: "combat-trigger", notes: "Medusa Armor is the closest PF2e armor curse, different mechanics." },
    { match: "Scarab of Death", cursewrightRecipe: null, archetypeTarget: "physical", notes: "No PF2e GMG row." }
];

/** @type {Pf2eArchetypeTarget} */
export const PF2E_V1_COMPILER_MODE = "compendium-faithful";

/**
 * Resolve catalog metadata for a PF2e compendium cursed item.
 * @param {string} name
 * @param {number|null} [itemLevel]
 * @returns {Pf2eCurseCatalogEntry|null}
 */
export function lookupPf2eCurseCatalogEntry(name, itemLevel = null) {
    const normalized = normalizePf2eCurseName(name);
    if (!normalized) return null;

    for (const entry of PF2E_GMG_CURSE_MANIFEST) {
        if (normalizePf2eCurseName(entry.match) === normalized) return entry;
    }

    if (itemLevel != null) {
        for (const entry of PF2E_GMG_CURSE_MANIFEST) {
            if (entry.itemLevel === itemLevel && normalized.startsWith(
                normalizePf2eCurseName(entry.match).replace(/\s*\(type\s+[ivx\d]+\)$/i, "")
            )) {
                return entry;
            }
        }
    }

    const prefixMatches = PF2E_GMG_CURSE_MANIFEST.filter((entry) => {
        const prefix = normalizePf2eCurseName(entry.match).replace(/\s*\(type\s+[ivx\d]+\)$/i, "");
        return prefix && normalized.startsWith(prefix);
    });
    if (prefixMatches.length === 1) return prefixMatches[0];

    return null;
}

/**
 * Normalize PF2e curse item names for manifest matching.
 * @param {string} name
 * @returns {string}
 */
export function normalizePf2eCurseName(name) {
    let normalized = (name ?? "").trim().toLowerCase();
    normalized = normalized.replace(/\s*,\s*type\s+([ivx\d]+)/gi, " (type $1)");
    normalized = normalized.replace(/\s*\(\s*type\s+([ivx\d]+)\s*\)/gi, (_, token) => {
        return ` (type ${String(token).toLowerCase()})`;
    });
    return normalized;
}

/**
 * @param {object} sourceItem  Item document or plain object with name/system
 * @returns {{ tier: number, curseType: string, catalogMatch: string|null }}
 */
export function inferPf2eCurseMeta(sourceItem) {
    const name = sourceItem?.name ?? "";
    const levelRaw = sourceItem?.system?.level?.value ?? sourceItem?.system?.level;
    const numericLevel = Number(levelRaw);
    const itemLevel = Number.isFinite(numericLevel) ? numericLevel : null;

    const catalog = lookupPf2eCurseCatalogEntry(name, itemLevel);
    if (catalog) {
        return {
            tier: catalog.tier,
            curseType: catalog.curseType,
            catalogMatch: catalog.match
        };
    }

    const lvl = itemLevel ?? 1;
    let tier = 1;
    if (lvl >= 18) tier = 4;
    else if (lvl >= 13) tier = 3;
    else if (lvl >= 7) tier = 2;

    return { tier, curseType: "deceptive", catalogMatch: null };
}

/**
 * @param {Item|object} item
 * @returns {boolean}
 */
export function itemHasPf2eCursedTrait(item) {
    const traits = item?.system?.traits?.value ?? [];
    return Array.isArray(traits) && traits.includes("cursed");
}

const MANIFEST_NAMES_LC = new Set(
    PF2E_GMG_CURSE_MANIFEST.map(e => e.match.trim().toLowerCase())
);

/** Prefix patterns for leveled PF2e variants when exact manifest name differs in pack. */
const PF2E_CURSE_PREFIXES = [
    "poisonous cloak",
    "bag of devouring",
    "bag of weasels"
];

/**
 * True when a compendium row is a known GMG specific cursed item by name.
 * @param {string} name
 */
export function isPf2eGmgCursedName(name) {
    const normalized = (name ?? "").trim().toLowerCase();
    if (!normalized) return false;
    if (MANIFEST_NAMES_LC.has(normalized)) return true;
    for (const prefix of PF2E_CURSE_PREFIXES) {
        if (normalized.startsWith(prefix)) return true;
    }
    return false;
}

/**
 * True for any item that should never enter PF2e random loot pools.
 * Prefer trait scan at runtime; use name heuristics as fallback.
 *
 * @param {object} entry  Compendium index row or item-like object
 * @returns {boolean}
 */
export function isPf2eCursedLootEntry(entry) {
    const traits = entry?.system?.traits?.value ?? entry?.system?.traits ?? [];
    const traitList = Array.isArray(traits) ? traits : (traits?.value ?? []);
    if (traitList.includes("cursed")) return true;
    return isPf2eGmgCursedName(entry?.name);
}

/**
 * Group manifest rows by recommended implementation phase.
 * @returns {Record<string, Pf2eCurseCatalogEntry[]>}
 */
export function groupPf2eCursesByPhase() {
    /** @type {Record<string, Pf2eCurseCatalogEntry[]>} */
    const out = {};
    for (const row of PF2E_GMG_CURSE_MANIFEST) {
        const phase = row.implementation ?? "backlog";
        (out[phase] ??= []).push(row);
    }
    return out;
}

/**
 * Rows that can reuse an existing Cursewright recipe with only a match-string / PF2e skin pass.
 * @returns {Pf2eCurseCatalogEntry[]}
 */
export function getPf2eCursePhase1Candidates() {
    return PF2E_GMG_CURSE_MANIFEST.filter(r => r.implementation === "phase-1");
}
