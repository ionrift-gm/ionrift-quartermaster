export function keyToIdentifier(key) {
    if (!key) return "";
    let s = String(key).trim().toLowerCase();
    s = s.replace(/,\s*\+(\d+)/g, "-$1");
    s = s.replace(/\s*\+(\d+)/g, "-$1");
    s = s.replace(/[^a-z0-9]+/g, "-");
    return s.replace(/^-|-$/g, "");
}

export function findSourceDoc(allByName, allByIdentifier, key) {
    if (!key) return null;
    const byIdent = allByIdentifier ?? allByName?._allByIdentifier;
    const lowerKey = String(key).trim().toLowerCase();
    const identKey = keyToIdentifier(key);

    return allByName?.get(lowerKey)
        ?? byIdent?.get(lowerKey)
        ?? (identKey ? byIdent?.get(identKey) : null)
        ?? (identKey ? allByName?.get(identKey) : null)
        ?? null;
}

// ── Weapon Template Manifest ──────────────────────────────────────────────
//
// Named weapon templates from dnd5e.equipment24. Each entry defines which
// base weapon subtypes the template is applied to, and which bonus tiers
// (1/2/3) are generated. Rarity is derived from tier at expansion time.
//
// This is a closed set - only templates confirmed to exist in equipment24
// as zero-weight, no-subtype shells are listed here.

export const WEAPON_TEMPLATES = {
    "Dragon Slayer": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [1, 2, 3]
    },
    "Holy Avenger": {
        bases: ["Greatsword", "Longsword", "Rapier"],
        tiers: [1, 2, 3]
    },
    "Vorpal Sword": {
        bases: ["Greatsword", "Longsword", "Scimitar"],
        tiers: [2, 3]
    },
    "Flame Tongue": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [1, 2, 3]
    },
    "Frost Brand": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [1, 2, 3]
    },
    "Giant Slayer": {
        bases: ["Battleaxe", "Greataxe", "Greatsword", "Longsword", "Rapier"],
        tiers: [1, 2, 3]
    },
    "Sword of Life Stealing": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [2, 3]
    },
    "Sword of Sharpness": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar"],
        tiers: [2, 3]
    },
    "Sword of Wounding": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [2, 3]
    },
    "Sun Blade": {
        bases: ["Longsword"],
        tiers: [2, 3]
    },
    "Nine Lives Stealer": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [3]
    },
    "Dancing Sword": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [2, 3]
    },
};

// ── Range Stub Expansions ─────────────────────────────────────────────────
//
// Aggregate stubs like "Ammunition, +1, +2, or +3" are roll-table pointers,
// not loot items. Expand them into discrete singular ammo items.
// Plural bundle forms (Arrows, Bolts) are already excluded by _isBulkAmmoCollection.

export const RANGE_STUB_EXPANSIONS = {
    "Ammunition, +1, +2, or +3": [
        { base: "Arrow",        tiers: [1, 2, 3] },
        { base: "Crossbow Bolt", tiers: [1, 2, 3] },
        { base: "Needle",       tiers: [1, 2, 3] },
        { base: "Sling Bullet", tiers: [1, 2, 3] },
    ],
    "Weapon, +1, +2, or +3": [
        // Expanded by _expandGenericWeaponBonus (base weapon x tier pass).
    ],
};

// ── Rarity by bonus tier ──────────────────────────────────────────────────
export const TIER_RARITY = {
    1: "uncommon",
    2: "rare",
    3: "veryRare",
};

// Shield +N uses the standard tier ladder; body armor is one step higher per tier.
export const SHIELD_BONUS_RARITY = { ...TIER_RARITY };
export const ARMOR_BONUS_RARITY  = { 1: "rare", 2: "veryRare", 3: "legendary" };

// ── Armor Template Manifest ───────────────────────────────────────────────
//
// Named armor templates from dnd5e.equipment24. Same GM-application shell
// pattern as weapons: zero weight, no subtype, rarity+price set on the shell.

export const BASE_ARMORS = [
    "Padded Armor", "Leather Armor", "Studded Leather Armor",
    "Hide Armor", "Chain Shirt", "Scale Mail", "Breastplate", "Half Plate Armor",
    "Ring Mail", "Chain Mail", "Splint Armor", "Plate Armor",
    "Shield",
];

/** Martial and simple bases expanded into generic +N weapons (stub pass). */
export const GENERIC_WEAPON_BASES = [
    "Dagger", "Handaxe", "Javelin", "Light Hammer", "Mace", "Quarterstaff",
    "Spear", "Shortbow", "Longbow", "Light Crossbow",
    "Battleaxe", "Flail", "Glaive", "Greataxe", "Greatsword", "Halberd",
    "Longsword", "Maul", "Morningstar", "Pike", "Rapier", "Scimitar",
    "Shortsword", "Trident", "War Pick", "Warhammer", "Whip"
];

// Adamantine/Mithral apply to medium and heavy armor only (SRD: not hide, not light, not shield).
export const ADAMANTINE_MITHRAL_BASES = [
    "Chain Shirt", "Scale Mail", "Breastplate", "Half Plate Armor",
    "Ring Mail", "Chain Mail", "Splint Armor", "Plate Armor",
];

export const RESISTANCE_BASES = BASE_ARMORS.filter(name => name !== "Shield");
export const RESISTANCE_TYPES = [
    "Acid", "Cold", "Fire", "Force", "Lightning",
    "Necrotic", "Poison", "Psychic", "Radiant", "Thunder",
];



export const SPECIFIC_ARMOR_TEMPLATES = [
    {
        // Efreeti Chain: fire immunity + speaks Ignan are passive,
        // but may carry a template activity - keep for fidelity.
        template: "Efreeti Chain",
        base:     "Chain Mail",
        opts:     { keepActivities: true },
    },
    {
        template: "Elven Chain",
        base:     "Chain Mail",
        opts:     { name: "Elven Chain", rarity: "rare", subtype: "medium", weight: 20 },
    },
    {
        // Plate Armor of Etherealness: has a real Use action (become Ethereal).
        template: "Plate Armor of Etherealness",
        base:     "Plate Armor",
        opts:     { name: "Plate Armor of Etherealness", keepActivities: true },
    },
    {
        template: "Plate Armor of Etherealness",
        base:     "Half Plate Armor",
        opts:     { name: "Half Plate Armor of Etherealness", keepActivities: true },
    },
];

/** Generic wondrous template shells expanded into discrete SRD variants. */
export const WONDROUS_TEMPLATE_SHELLS = {
    "Belt of Giant Strength": [
        { name: "Belt of Hill Giant Strength",  rarity: "rare",     price: 8000,  weight: 1 },
        { name: "Belt of Stone Giant Strength", rarity: "veryRare", price: 20000, weight: 1 },
        { name: "Belt of Frost Giant Strength", rarity: "veryRare", price: 20000, weight: 1 },
        { name: "Belt of Fire Giant Strength",  rarity: "veryRare", price: 20000, weight: 1 },
        { name: "Belt of Cloud Giant Strength", rarity: "legendary", price: 42000, weight: 1 },
        { name: "Belt of Storm Giant Strength", rarity: "legendary", price: 42000, weight: 1 }
    ]
};

/**
 * Named items that ship with mechanics but zero economy in equipment24.
 * Compiler emits loot-ready rows; raw shells stay excluded via ItemPoolResolver.
 */
export const NAMED_ECONOMY_ENRICHMENT = {
    "Helm of Brilliance":               { price: 75000, weight: 2, subtype: "light" },
    "Helm of Teleportation":            { price: 81000, weight: 2, subtype: "light" },
    "Helm of Comprehending Languages":  { price: 12000, weight: 2, subtype: "light" },
    "Helm of Telepathy":                { price: 27000, weight: 2, subtype: "light" }
};

/** 2024 slaying ammo shell expanded into base ammo × creature type rows. */
export const SLAYING_AMMO_TEMPLATE = "Ammunition of Slaying";

export const SLAYING_AMMO_BASES = [
    { base: "Arrow",         short: "Arrow" },
    { base: "Crossbow Bolt", short: "Bolt" },
    { base: "Needle",        short: "Needle" },
    { base: "Sling Bullet",  short: "Sling Bullet" }
];

export const SLAYING_CREATURE_TYPES = [
    "Aberrations", "Beasts", "Celestials", "Constructs", "Dragons",
    "Elementals", "Fey", "Fiends", "Giants", "Humanoids",
    "Monstrosities", "Oozes", "Plants", "Undead"
];

/** Matches legacy dnd5e.items slaying ammo pricing. */
export const SLAYING_AMMO_PRICE = 20000;

// ── 2024-architecture source detection ───────────────────────────────────
export const ARCHITECTURE_2024_PACKS = new Set(["dnd5e.equipment24"]);

