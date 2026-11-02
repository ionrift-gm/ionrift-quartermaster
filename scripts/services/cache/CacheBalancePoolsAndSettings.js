import { MODULE_ID } from "../../data/moduleId.js";
/**
 * Empirical loot cache distribution tests for cache generation balance.
 * Used by Vitest (synthetic pool) and the Foundry test harness (live compendiums).
 *
 * Pattern mirrors ScrollBalanceSimulator.js.
 */

import { CacheGenerator } from "./CacheGenerator.js";
import { ItemPoolResolver } from "../loot/ItemPoolResolver.js";
import { ItemClassifier } from "../workshop/ItemClassifier.js";
import { ItemMaskingHelper } from "../identify/ItemMaskingHelper.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";


/** Per-cache named-magic eligibility (matches CacheGenerator.generate). */
export const NAMED_MAGIC_PER_CACHE = { 1: 0, 2: 0.10, 3: 0.20, 4: 0.35 };

export const TIER_DATA = {
    1: { _tier: 1, scrollLevelMax: 2, budgetCap: 150, rarityMax: "uncommon" },
    2: { _tier: 2, scrollLevelMax: 4, budgetCap: 600, rarityMax: "rare" },
    3: { _tier: 3, scrollLevelMax: 7, budgetCap: 2500, rarityMax: "veryRare" },
    4: { _tier: 4, scrollLevelMax: 9, budgetCap: 10000, rarityMax: "legendary" }
};

export const DEFAULT_EXPECTATIONS = {
    armaments: {
        2: {
            iterations: 400,
            cacheHasMagicalWeaponOrArmor: { min: 0.55 },
            mastercraftPickMagicalRate: { min: 0.45 },
            mastercraftPickNullRate: { max: 0.05 },
            cacheHasMagicalArmor: { min: 0.12 },
            mastercraftPickMagicalArmorRate: { min: 0.12 }
        },
        3: {
            iterations: 400,
            cacheHasMagicalWeaponOrArmor: { min: 0.70 },
            mastercraftPickMagicalRate: { min: 0.60 },
            mastercraftPickNullRate: { max: 0.05 },
            mastercraftPickGenericPlus2Share: { min: 0.35 },
            mastercraftPickMagicalArmorRate: { min: 0.15 },
            cacheHasMagicalArmor: { min: 0.18 },
            cacheGenericPlus2Share: { min: 0.22 }
        },
        4: {
            iterations: 500,
            cacheHasMagicalWeaponOrArmor: { min: 0.80 },
            mastercraftPickMagicalRate: { min: 0.70 },
            mastercraftPickNullRate: { max: 0.05 },
            genericBonusMinObserved: 2,
            mastercraftPickGenericPlus3Share: { max: 0.28 },
            mastercraftPickMagicalArmorRate: { min: 0.15 },
            cacheHasMagicalArmor: { min: 0.20 },
            cacheGenericPlus3Share: { max: 0.22 }
        }
    }
};

let _expectationsCache = null;

// ── Seeded RNG ───────────────────────────────────────────────────────

/**
 * Mulberry32 PRNG for reproducible Monte Carlo runs.
 * @param {number} seed
 * @returns {() => number}
 */
export function createSeededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state += 0x6D2B79F5;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * Run fn with Math.random replaced by a seeded PRNG.
 * @template T
 * @param {number} seed
 * @param {() => T} fn
 * @returns {T}
 */
export function withSeededRandom(seed, fn) {
    const original = Math.random;
    Math.random = createSeededRandom(seed);
    try {
        return fn();
    } finally {
        Math.random = original;
    };
}

/**
 * @template T
 * @param {number} seed
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSeededRandomAsync(seed, fn) {
    const original = Math.random;
    Math.random = createSeededRandom(seed);
    try {
        return await fn();
    } finally {
        Math.random = original;
    };
}

// ── Item classification ────────────────────────────────────────────────

/**
 * @param {object} item
 * @returns {"weapon"|"armor"|"shield"|"other"}
 */
export function resolveGearKind(item) {
    const type = (item?.type ?? "").toLowerCase();
    if (type === "weapon") return "weapon";
    if (type === "armor") return "armor";
    const sub = (item?.subtype ?? item?.system?.type?.value ?? "").toLowerCase();
    if (sub === "shield") return "shield";
    if (["heavy", "medium", "light"].includes(sub)) return "armor";
    return "other";
}

/**
 * @param {object} item
 * @returns {boolean}
 */
export function isMagicalGear(item) {
    const cat = ItemClassifier.classify(item);
    if (cat !== ItemClassifier.CATEGORY.GENERIC_MAGIC
        && cat !== ItemClassifier.CATEGORY.NAMED_MAGIC) {
        return false;
    }
    const kind = resolveGearKind(item);
    return kind === "weapon" || kind === "armor" || kind === "shield";
}

/**
 * @param {object} item
 * @returns {object}
 */
export function classifyCacheItem(item) {
    const category = ItemClassifier.classify(item);
    const kind = resolveGearKind(item);
    const magicalByFlag = item?._isMagical === true;
    const isMagic = magicalByFlag
        || category === ItemClassifier.CATEGORY.GENERIC_MAGIC
        || category === ItemClassifier.CATEGORY.NAMED_MAGIC;
    return {
        category,
        kind,
        bonus: ItemClassifier.detectBonusTier(item),
        isMagicalGear: isMagic && (kind === "weapon" || kind === "armor" || kind === "shield")
    };
}

/**
 * @param {object} item
 * @returns {boolean}
 */
export function isMagicalArmorOrShield(item) {
    const info = classifyCacheItem(item);
    return info.isMagicalGear && (info.kind === "armor" || info.kind === "shield");
}

/**
 * Compiled or SRD resistance-variant armor (Armor of X Resistance).
 * @param {object} item
 * @returns {boolean}
 */
export function isResistanceArmor(item) {
    const name = item?.name ?? "";
    if (!/\bresistance\b/i.test(name)) return false;
    const kind = resolveGearKind(item);
    return kind === "armor" || kind === "shield";
}

/**
 * Share of generic +N gear at one bonus tier (0 when no +N rows).
 * @param {Record<number, number>} bonusHist
 * @param {number} bonus
 * @returns {number}
 */
export function genericBonusShare(bonusHist, bonus) {
    const total = [1, 2, 3].reduce((sum, tier) => sum + (bonusHist[tier] ?? bonusHist[String(tier)] ?? 0), 0);
    if (!total) return 0;
    return (bonusHist[bonus] ?? bonusHist[String(bonus)] ?? 0) / total;
}

/**
 * @param {Record<number, number>} bonusHist
 * @returns {{ total: number, shares: Record<number, number> }}
 */
export function summarizeGenericBonusHist(bonusHist = {}) {
    const total = [1, 2, 3].reduce((sum, tier) => sum + (bonusHist[tier] ?? bonusHist[String(tier)] ?? 0), 0);
    const shares = {};
    for (const tier of [1, 2, 3]) {
        shares[tier] = total ? (bonusHist[tier] ?? bonusHist[String(tier)] ?? 0) / total : 0;
    }
    return { total, shares };
}

/**
 * Derive curve metrics from classified magical gear rows.
 * @param {object[]} items
 * @returns {object}
 */
export function deriveCurveStatsFromItems(items) {
    let magicalArmorItems = 0;
    let magicalWeaponItems = 0;
    const genericBonusHist = {};
    const magicalGearByKind = { weapon: 0, armor: 0, shield: 0 };

    for (const item of items) {
        const info = classifyCacheItem(item);
        if (!info.isMagicalGear) continue;
        magicalGearByKind[info.kind] = (magicalGearByKind[info.kind] ?? 0) + 1;
        if (info.kind === "weapon") magicalWeaponItems++;
        if (info.kind === "armor" || info.kind === "shield") magicalArmorItems++;
        if (info.category === ItemClassifier.CATEGORY.GENERIC_MAGIC && info.bonus > 0) {
            genericBonusHist[info.bonus] = (genericBonusHist[info.bonus] ?? 0) + 1;
        }
    }

    const bonusSummary = summarizeGenericBonusHist(genericBonusHist);
    return {
        magicalArmorItems,
        magicalWeaponItems,
        magicalGearByKind,
        genericBonusHist,
        genericPlus1Share: bonusSummary.shares[1],
        genericPlus2Share: bonusSummary.shares[2],
        genericPlus3Share: bonusSummary.shares[3]
    };
}

// ── Synthetic pools ────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {number} [opts.weaponsPerBonus=4]
 * @param {number} [opts.armorPerBonus=4]
 * @param {number} [opts.namedCount=6]
 * @param {number} [opts.mundaneMastercraft=8]
 * @returns {object[]}
 */
export function buildSyntheticMastercraftPool(opts = {}) {
    const weaponsPerBonus = opts.weaponsPerBonus ?? 4;
    const armorPerBonus = opts.armorPerBonus ?? 4;
    const namedCount = opts.namedCount ?? 6;
    const mundaneMastercraft = opts.mundaneMastercraft ?? 8;
    const pool = [];

    const weaponBases = ["Longsword", "Battleaxe", "Warhammer", "Rapier"];
    const armorBases = [
        { name: "Chain Mail", sub: "heavy" },
        { name: "Breastplate", sub: "medium" },
        { name: "Studded Leather Armor", sub: "light" },
        { name: "Shield", sub: "shield" }
    ];

    const rarityByBonus = { 1: "uncommon", 2: "rare", 3: "veryRare" };

    for (let bonus = 1; bonus <= 3; bonus++) {
        for (let i = 0; i < weaponsPerBonus; i++) {
            const base = weaponBases[i % weaponBases.length];
            pool.push({
                name: `${base} +${bonus}`,
                type: "weapon",
                price: 15,
                rarity: rarityByBonus[bonus],
                weight: 3,
                system: { type: { value: "martialM" }, rarity: rarityByBonus[bonus] }
            });
        }
        for (let i = 0; i < armorPerBonus; i++) {
            const { name, sub } = armorBases[i % armorBases.length];
            pool.push({
                name: `${name} +${bonus}`,
                type: "equipment",
                price: 75,
                rarity: rarityByBonus[bonus],
                weight: sub === "shield" ? 6 : (sub === "heavy" ? 20 : 12),
                system: { type: { value: sub }, rarity: rarityByBonus[bonus] }
            });
        }
    }

    const namedWeapons = [
        { name: "Flame Tongue", rarity: "rare" },
        { name: "Dragon Slayer Longsword", rarity: "rare" },
        { name: "Sun Blade", rarity: "rare" },
        { name: "Oathbow", rarity: "veryRare" },
        { name: "Hammer of Thunderbolts", rarity: "legendary" },
        { name: "Holy Avenger", rarity: "legendary" }
    ];
    const namedArmor = [
        { name: "Breastplate of Fire Resistance", sub: "medium", rarity: "rare" },
        { name: "Chain Mail of Cold Resistance", sub: "heavy", rarity: "rare" },
        { name: "Studded Leather Armor of Lightning Resistance", sub: "light", rarity: "rare" },
        { name: "Shield of Force Resistance", sub: "shield", rarity: "veryRare" }
    ];
    const includeNamedArmor = opts.includeNamedArmor ?? (armorPerBonus > 0);
    for (let i = 0; i < namedCount; i++) {
        const row = namedWeapons[i % namedWeapons.length];
        pool.push({
            name: row.name,
            type: "weapon",
            price: 2500,
            rarity: row.rarity,
            weight: 3,
            system: { type: { value: "martialM" }, rarity: row.rarity }
        });
    }
    if (includeNamedArmor) {
        for (let i = 0; i < Math.max(4, Math.floor(namedCount / 2)); i++) {
            const row = namedArmor[i % namedArmor.length];
            pool.push({
                name: row.name,
                type: "equipment",
                price: 3500,
                rarity: row.rarity,
                weight: row.sub === "shield" ? 6 : 40,
                system: { type: { value: row.sub }, rarity: row.rarity }
            });
        }
    }

    for (let i = 0; i < mundaneMastercraft; i++) {
        pool.push({
            name: `Mastercraft Longsword ${i + 1}`,
            type: "weapon",
            price: 50,
            rarity: "common",
            weight: 3,
            system: { type: { value: "martialM" }, rarity: "common" },
            flags: {
                [MODULE_ID]: {
                    coreMeta: { category: "Mastercraft" }
                }
            }
        });
    }

    return pool;
}

/**
 * Filler items so full cache generation can resolve non-mastercraft slots.
 * @returns {object[]}
 */
export function buildSyntheticFillerPool() {
    return [
        {
            name: "Healing Potion",
            type: "consumable",
            price: 50,
            rarity: "common",
            weight: 0.5,
            system: { type: { value: "potion" }, rarity: "common" }
        },
        {
            name: "Antitoxin (vial)",
            type: "consumable",
            price: 50,
            rarity: "common",
            weight: 0.5,
            system: { type: { value: "potion" }, rarity: "common" }
        },
        {
            name: "Rope, hempen (50 feet)",
            type: "loot",
            price: 1,
            rarity: "common",
            weight: 10,
            system: { rarity: "common" }
        },
        {
            name: "Arrows",
            type: "consumable",
            price: 1,
            rarity: "common",
            weight: 1,
            system: { type: { value: "ammo" }, rarity: "common" }
        },
        {
            name: "Silver Chalice",
            type: "loot",
            price: 25,
            rarity: "common",
            weight: 1,
            flags: { [MODULE_ID]: { coreMeta: { category: "Treasure" } } },
            system: { rarity: "common" }
        },
        {
            name: "Spell Scroll: Synthetic Cantrip",
            type: "consumable",
            price: 60,
            rarity: "common",
            weight: 0.01,
            system: { type: { value: "scroll" }, rarity: "common" },
            flags: {
                [MODULE_ID]: {
                    scrollMeta: { spellLevel: 1, spellName: "Synthetic Cantrip" }
                }
            }
        }
    ];
}

/**
 * @param {object} [opts]
 * @returns {object[]}
 */
export function buildSyntheticFullPool(opts = {}) {
    return [
        ...buildSyntheticMastercraftPool(opts),
        ...buildSyntheticFillerPool()
    ];
}

// ── Settings + in-cache mastercraft simulation ─────────────────────────

export const ARMOR_SUBTYPES = new Set(["heavy", "medium", "light", "shield"]);

/**
 * GM loot settings used by CacheGenerator.generate and balance probes.
 * @returns {object}
 */
export function readBalanceSimulationSettings() {
    return {
        lootEconomy: game.settings?.get(MODULE_ID, "lootEconomy") ?? 1.0,
        magicFrequency: game.settings?.get(MODULE_ID, "magicFrequency") ?? 1.0,
        armourDropChance: game.settings?.get(MODULE_ID, "armourDropChance") ?? 0.65,
        namedMagicFrequency: game.settings?.get(MODULE_ID, "namedMagicFrequency") ?? 1.0,
        magicAmmoFrequency: game.settings?.get(MODULE_ID, "magicAmmoFrequency") ?? 1.0,
        healingPotionFrequency: game.settings?.get(MODULE_ID, "healingPotionFrequency") ?? 1.0
    };
}

/** @type {object|null} */
let _settingsProfilesCache = null;

/** @type {object|null} */
let _settingsMatrixCache = null;

/**
 * @param {object} [profilesDoc]
 * @returns {object}
 */
export function resolveSettingsProfile(profilesDoc, key) {
    if (!key) return null;
    return profilesDoc.profiles?.[key] ?? profilesDoc.edgeCases?.[key] ?? null;
}

/**
 * @returns {Promise<object>}
 */
export async function loadSettingsProfiles() {
    if (_settingsProfilesCache) return _settingsProfilesCache;
    try {
        const response = await fetch(`modules/${MODULE_ID}/data/cache-balance-settings-profiles.json`);
        _settingsProfilesCache = await response.json();
    } catch {
        _settingsProfilesCache = {
            profiles: {
                low: {
                    lootEconomy: 0.5,
                    magicFrequency: 0.25,
                    armourDropChance: 0.30,
                    namedMagicFrequency: 0.5,
                    magicAmmoFrequency: 0,
                    healingPotionFrequency: 0.5
                },
                standard: {
                    lootEconomy: 1,
                    magicFrequency: 1,
                    armourDropChance: 0.65,
                    namedMagicFrequency: 1.0,
                    magicAmmoFrequency: 1,
                    healingPotionFrequency: 1
                },
                high: {
                    lootEconomy: 1.5,
                    magicFrequency: 1.5,
                    armourDropChance: 0.90,
                    namedMagicFrequency: 1.5,
                    magicAmmoFrequency: 1.5,
                    healingPotionFrequency: 2.5
                }
            },
            edgeCases: {},
            profileExpectationScale: {
                low: { magic: 0.55, economy: 0.85, curveStrict: false },
                standard: { magic: 1.0, economy: 1.0, curveStrict: true },
                high: { magic: 1.08, economy: 1.05, curveStrict: true }
            },
            orderingRules: []
        };
    }
    return _settingsProfilesCache;
}

/**
 * @returns {Promise<object>}
 */
export async function loadSettingsMatrix() {
    if (_settingsMatrixCache) return _settingsMatrixCache;
    try {
        const response = await fetch(`modules/${MODULE_ID}/data/cache-balance-settings-matrix.json`);
        _settingsMatrixCache = await response.json();
    } catch {
        _settingsMatrixCache = { defaultIterations: 80, tierIterations: { "4": 100 }, scenarios: [] };
    }
    return _settingsMatrixCache;
}

/**
 * Apply loot slider values for balance simulation.
 * @param {object} settings
 */
export function applyBalanceSimulationSettings(settings = {}) {
    const keys = [
        "lootEconomy",
        "magicFrequency",
        "armourDropChance",
        "namedMagicFrequency",
        "magicAmmoFrequency",
        "healingPotionFrequency"
    ];
    for (const key of keys) {
        if (settings[key] !== undefined) {
            game.settings.set(MODULE_ID, key, settings[key]);
        }
    }
}

/**
 * @param {object} scenario
 * @param {object} profilesDoc
 * @returns {object|null}
 */
export function resolveScenarioSettings(scenario, profilesDoc) {
    if (scenario.settings) return scenario.settings;
    if (scenario.edgeCase) return resolveSettingsProfile(profilesDoc, scenario.edgeCase);
    if (scenario.profile) return resolveSettingsProfile(profilesDoc, scenario.profile);
    return null;
}

export const CURVE_STRICT_KEYS = new Set([
    "mastercraftPickGenericPlus2Share",
    "mastercraftPickGenericPlus3Share",
    "cacheGenericPlus2Share",
    "cacheGenericPlus3Share",
    "genericBonusMinObserved"
]);

/**
 * Scale absolute guardrails for low/high loot profiles.
 * @param {object} spec
 * @param {string} profileKey
 * @param {object} profilesDoc
 * @returns {object|null}
 */
export function scaleExpectationsForProfile(spec, profileKey, profilesDoc) {
    if (!spec) return null;
    const scale = profilesDoc.profileExpectationScale?.[profileKey]
        ?? profilesDoc.profileExpectationScale?.standard
        ?? { magic: 1, economy: 1, curveStrict: true };
    const scaled = structuredClone(spec);

    const scaleMin = (key, factor, floor = 0.05) => {
        if (scaled[key]?.min === undefined) return;
        scaled[key] = { ...scaled[key], min: Math.max(floor, scaled[key].min * factor) };
    };
    const scaleMax = (key, factor, ceiling = 0.98) => {
        if (scaled[key]?.max === undefined) return;
        scaled[key] = { ...scaled[key], max: Math.min(ceiling, scaled[key].max * (2 - factor)) };
    };

    scaleMin("cacheHasMagicalWeaponOrArmor", scale.magic);
    scaleMin("mastercraftPickMagicalRate", scale.magic);
    scaleMin("cacheHasMagicalArmor", scale.magic);
    scaleMin("mastercraftPickMagicalArmorRate", scale.magic);
    scaleMin("mastercraftPickGenericPlus2Share", scale.magic, 0.08);
    scaleMin("cacheGenericPlus2Share", scale.magic, 0.08);
    scaleMax("mastercraftPickNullRate", scale.magic, 0.25);

    if (!scale.curveStrict) {
        for (const key of CURVE_STRICT_KEYS) {
            delete scaled[key];
        }
    } else {
        scaleMax("mastercraftPickGenericPlus3Share", scale.magic);
        scaleMax("cacheGenericPlus3Share", scale.magic);
    }

    return scaled;
}

/**
 * @param {object} item
 * @returns {boolean}
 */
export function isHealingCacheItem(item) {
    const name = (item?.name ?? "").toLowerCase();
    if (/potion of healing|healing potion|greater healing|superior healing|supreme healing/.test(name)) {
        return true;
    }
    if (/antitoxin/.test(name)) return true;
    const type = (item?.type ?? "").toLowerCase();
    const subtype = (item?.system?.type?.value ?? "").toLowerCase();
    return type === "consumable" && subtype === "potion" && name.includes("heal");
}

/**
 * Type-aware weight floors (matches CacheGenerator.generate).
 * @param {number} w
 * @param {string} type
 * @param {object} system
 * @returns {number}
 */
export function cacheEffectiveWeight(w, type, system) {
    const raw = Number(w) || 0;
    if (type === "weapon") return Math.max(raw, 3.0);
    if (type === "equipment" && ARMOR_SUBTYPES.has((system?.type?.value ?? "").trim())) {
        return Math.max(raw, 4.0);
    }
    return Math.max(raw, 0.01);
}

