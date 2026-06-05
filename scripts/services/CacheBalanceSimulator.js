/**
 * Empirical loot cache distribution tests for cache generation balance.
 * Used by Vitest (synthetic pool) and the Foundry test harness (live compendiums).
 *
 * Pattern mirrors ScrollBalanceSimulator.js.
 */

import { CacheGenerator } from "./CacheGenerator.js";
import { ItemPoolResolver } from "./ItemPoolResolver.js";
import { ItemClassifier } from "./ItemClassifier.js";
import { ItemMaskingHelper } from "./ItemMaskingHelper.js";

const MODULE_ID = "ionrift-quartermaster";

/** Per-cache named-magic eligibility (matches CacheGenerator.generate). */
const NAMED_MAGIC_PER_CACHE = { 1: 0, 2: 0.10, 3: 0.20, 4: 0.35 };

const TIER_DATA = {
    1: { _tier: 1, scrollLevelMax: 2, budgetCap: 150, rarityMax: "uncommon" },
    2: { _tier: 2, scrollLevelMax: 4, budgetCap: 600, rarityMax: "rare" },
    3: { _tier: 3, scrollLevelMax: 7, budgetCap: 2500, rarityMax: "veryRare" },
    4: { _tier: 4, scrollLevelMax: 9, budgetCap: 10000, rarityMax: "legendary" }
};

const DEFAULT_EXPECTATIONS = {
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
                "ionrift-quartermaster": {
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
            flags: { "ionrift-quartermaster": { coreMeta: { category: "Treasure" } } },
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
                "ionrift-quartermaster": {
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

const ARMOR_SUBTYPES = new Set(["heavy", "medium", "light", "shield"]);

/**
 * GM loot settings used by CacheGenerator.generate and balance probes.
 * @returns {object}
 */
export function readBalanceSimulationSettings() {
    return {
        lootEconomy: game.settings?.get(MODULE_ID, "lootEconomy") ?? 1.0,
        magicFrequency: game.settings?.get(MODULE_ID, "magicFrequency") ?? 1.0,
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
                low: { lootEconomy: 0.5, magicFrequency: 0.25, magicAmmoFrequency: 0, healingPotionFrequency: 0.5 },
                standard: { lootEconomy: 1, magicFrequency: 1, magicAmmoFrequency: 1, healingPotionFrequency: 1 },
                high: { lootEconomy: 1.5, magicFrequency: 1.5, magicAmmoFrequency: 1.5, healingPotionFrequency: 2.5 }
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

const CURVE_STRICT_KEYS = new Set([
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

/**
 * @param {object[]} picks
 * @param {object} [opts]
 * @returns {object}
 */
export function buildMastercraftPickStats(picks, opts = {}) {
    const iterations = opts.iterations ?? picks.length;
    const nulls = opts.nulls ?? 0;
    let magical = 0;
    let pickMagicalArmor = 0;
    const bonusHist = {};
    const categoryHist = {};

    for (const item of picks) {
        const mask = ItemMaskingHelper.detectMagical(item, { terrainTag: opts.theme ?? "dungeon" });
        if (mask.isMagical && item._isMagical === undefined) item._isMagical = true;

        const info = classifyCacheItem(item);
        categoryHist[info.category] = (categoryHist[info.category] ?? 0) + 1;
        if (info.isMagicalGear) magical++;
        if (isMagicalArmorOrShield(item)) pickMagicalArmor++;
        if (info.bonus > 0) bonusHist[info.bonus] = (bonusHist[info.bonus] ?? 0) + 1;
    }

    const success = picks.length;
    const curve = deriveCurveStatsFromItems(picks);
    return {
        tier: opts.tier,
        iterations,
        success,
        nulls,
        nullRate: iterations > 0 ? nulls / iterations : 0,
        magical,
        magicalRate: success ? magical / success : 0,
        pickMagicalArmor,
        mastercraftPickMagicalArmorRate: success ? pickMagicalArmor / success : 0,
        bonusHist,
        mastercraftPickGenericBonusHist: curve.genericBonusHist,
        mastercraftPickGenericPlus1Share: curve.genericPlus1Share,
        mastercraftPickGenericPlus2Share: curve.genericPlus2Share,
        mastercraftPickGenericPlus3Share: curve.genericPlus3Share,
        categoryHist,
        picks
    };
}

/**
 * Mastercraft pick metrics from real CacheGenerator.generate runs.
 * @param {object[]} runs
 * @param {object} [opts]
 * @returns {object}
 */
export function extractMastercraftPickStats(runs, opts = {}) {
    const picks = [];
    let attempted = 0;
    let empty = 0;

    for (const run of runs) {
        const slotStats = run.meta?.mastercraftSlots;
        if (slotStats) {
            attempted += slotStats.attempted ?? 0;
            empty += slotStats.empty ?? 0;
        }
        for (const item of run.items ?? []) {
            if (item._cacheSlotType === "mastercraft") picks.push(item);
        }
    }

    return buildMastercraftPickStats(picks, {
        tier: opts.tier,
        theme: opts.theme,
        iterations: attempted || picks.length,
        nulls: empty
    });
}

/**
 * One mastercraft slot draw using the same budgets and repick path as generate().
 * @param {number} tier
 * @param {object} [opts]
 * @returns {Promise<object|null>}
 */
export async function drawMastercraftInCacheContext(tier, opts = {}) {
    const settings = opts.settings ?? readBalanceSimulationSettings();
    const theme = opts.theme ?? "dungeon";
    const ownerTheme = opts.ownerTheme ?? "armaments";
    const tables = opts.tables ?? {
        tiers: Object.fromEntries(
            Object.entries(TIER_DATA).map(([key, row]) => [key, { ...row, _tier: parseInt(key, 10) }])
        ),
        ownerThemes: SYNTHETIC_CACHE_TABLES.ownerThemes
    };
    const tierData = { ...(tables.tiers?.[String(tier)] ?? TIER_DATA[tier]), _tier: tier };
    const ownerDef = tables.ownerThemes?.[ownerTheme] ?? SYNTHETIC_CACHE_TABLES.ownerThemes.armaments;
    const economy = settings.lootEconomy ?? 1.0;
    const effectiveBudget = (tierData.budgetCap ?? 600)
        * (ownerDef.budgetMultiplier ?? 1.0)
        * economy;
    const goldFillerFloor = [0, 3, 9, 25, 60][tier] ?? 3;

    const capacityLbs = opts.capacityLbs ?? 140;
    const weightBudgets = CacheGenerator._resolveWeightBudgets(capacityLbs);
    const tierScale = [0, 1.0, 1.5, 2.0, 2.5][tier] ?? 1.0;
    const slotRange = ownerDef.totalSlots ?? { min: 5, max: 8 };
    const scaledMin = Math.round(slotRange.min * tierScale);
    const scaledMax = Math.round(slotRange.max * tierScale);
    const totalSlots = opts.totalSlots
        ?? Math.floor(Math.random() * (scaledMax - scaledMin + 1)) + scaledMin;

    const guaranteedBase = (ownerDef.guaranteed ?? []).reduce((sum, entry) => {
        if (typeof entry === "string") return sum + 1;
        if (entry?.type === "mastercraft") {
            const min = Math.round((entry.min ?? 1) * tierScale);
            const max = Math.round((entry.max ?? min) * tierScale);
            return sum + Math.round((min + max) / 2);
        }
        return sum;
    }, 0);
    const armorPresence = ownerTheme === "armaments"
        && CacheGenerator.ARMOR_PRESENCE_THEMES.has(ownerTheme)
        && Math.random() < CacheGenerator.ARMOR_PRESENCE_CHANCE;
    const guaranteedSlots = guaranteedBase + (armorPresence ? 1 : 0);

    const slotsProcessed = Math.min(
        totalSlots - 1,
        Math.floor(Math.random() * Math.max(1, totalSlots))
    );
    const slotsRemaining = Math.max(1, totalSlots - slotsProcessed);
    const fillRatio = slotsProcessed / Math.max(1, totalSlots);
    const currentWeight = weightBudgets.nominal * fillRatio * (0.35 + Math.random() * 0.35);
    const isGuaranteed = slotsProcessed < guaranteedSlots;
    const fillerSlotsLeft = Math.max(1, totalSlots - Math.max(slotsProcessed, guaranteedSlots));
    const remainingBudget = Math.max(
        goldFillerFloor,
        effectiveBudget * (1 - fillRatio * 0.65)
    );

    const priceCeiling = CacheGenerator._computeMastercraftPriceCeiling({
        hardCap: false,
        isGuaranteed,
        effectiveBudget,
        remainingBudget,
        totalSlotsLeft: slotsRemaining,
        fillerSlotsLeft,
        goldFillerFloor,
        tier,
        ownerTheme
    });

    let slotWeightAllowance = CacheGenerator._slotWeightAllowance(
        weightBudgets,
        currentWeight,
        slotsRemaining
    );
    if (slotsProcessed === 0 && slotsRemaining > 1) {
        slotWeightAllowance = Math.min(
            slotWeightAllowance,
            weightBudgets.nominal * CacheGenerator.FIRST_ITEM_MAX_NOMINAL_SHARE
        );
    }

    const isArmamentsMastercraft = ownerTheme === "armaments";
    const requireArmor = opts.requireArmor ?? false;
    const remainingGeneration = Math.max(2, weightBudgets.generation - currentWeight);

    let rejectNamedMagical = opts.rejectNamedMagical ?? true;
    if (opts.simulateNamedMagicRoll && tier >= 2) {
        rejectNamedMagical = Math.random() >= (NAMED_MAGIC_PER_CACHE[tier] ?? 0);
    }

    const pickOpts = {
        rejectNamedMagical,
        ownerTheme,
        preferArmor: isArmamentsMastercraft && !requireArmor,
        requireArmor,
        slotsRemaining,
        effectiveWeightFn: cacheEffectiveWeight
    };

    let item = null;
    let pickAttempts = 0;
    while (pickAttempts < 5) {
        const weightAttempt = requireArmor || isArmamentsMastercraft || isGuaranteed ? 3 : pickAttempts;
        const attemptAllowance = weightAttempt >= 3
            ? remainingGeneration
            : (pickAttempts < 3
                ? slotWeightAllowance
                : Math.min(slotWeightAllowance, remainingGeneration));
        item = await CacheGenerator._pickItem(
            "mastercraft",
            theme,
            tierData,
            tables,
            priceCeiling,
            {
                ...pickOpts,
                maxEffectiveWeight: attemptAllowance > 0 ? attemptAllowance : remainingGeneration
            }
        );
        if (!item) break;
        const unitWeight = cacheEffectiveWeight(item.weight, item.type, item.system);
        if (CacheGenerator._itemExceedsWeightPickLimit(
            unitWeight, weightAttempt, weightBudgets, currentWeight
        )) {
            item = null;
            pickAttempts++;
            continue;
        }
        const itemPrice = ItemPoolResolver._mastercraftEffectivePrice(item);
        if (itemPrice > priceCeiling) {
            item = null;
            pickAttempts++;
            continue;
        }
        break;
    }

    if (!item) {
        item = await CacheGenerator._pickMastercraft(theme, tierData, priceCeiling, tables, {
            ...pickOpts,
            maxEffectiveWeight: remainingGeneration
        });
    }

    if (item) {
        const mask = ItemMaskingHelper.detectMagical(item, { terrainTag: theme });
        if (mask.isMagical) item._isMagical = true;
    }

    return item;
}

// ── Mastercraft pick simulation ────────────────────────────────────────

/**
 * Typical armaments cache slot budget for live mastercraft pick probes.
 * @param {number} tier
 * @param {object} [opts]
 * @returns {number}
 */
export function realisticMastercraftSlotCeiling(tier, opts = {}) {
    const budget = TIER_DATA[tier]?.budgetCap ?? 600;
    const tierScale = [0, 1.0, 1.5, 2.0, 2.5][tier] ?? 1.0;
    const totalSlots = opts.totalSlotsLeft ?? Math.round(7 * tierScale);
    const guaranteedSlots = opts.guaranteedSlots ?? Math.round(1.5 * tierScale);
    return CacheGenerator._computeMastercraftPriceCeiling({
        hardCap: false,
        isGuaranteed: opts.isGuaranteed ?? false,
        effectiveBudget: budget,
        remainingBudget: opts.remainingBudget ?? Math.round(budget * 0.75),
        fillerSlotsLeft: opts.fillerSlotsLeft ?? Math.max(1, totalSlots - guaranteedSlots),
        totalSlotsLeft: totalSlots,
        goldFillerFloor: [0, 3, 9, 25, 60][tier] ?? 3,
        tier,
        ownerTheme: opts.ownerTheme ?? "armaments"
    });
}

/**
 * @param {number} tier
 * @param {object} [opts]
 * @returns {object}
 */
export function mastercraftPickOpts(tier, opts = {}) {
    const tierData = TIER_DATA[tier] ?? TIER_DATA[1];
    const priceCeiling = opts.priceCeiling ?? tierData.budgetCap;
    const priceMax = Math.min([0, 100, 400, 1500, 5000][tier] ?? 5000, priceCeiling);
    const priceMin = [0, 5, 30, 200, 800][tier] ?? 0;
    const rejectNamedMagical = opts.rejectNamedMagical ?? true;

    return {
        slotType: "mastercraft",
        tier,
        theme: opts.theme ?? "dungeon",
        priceCeiling,
        priceMin,
        priceMax,
        rarityMax: tierData.rarityMax,
        rejectNamedMagical,
        maxGenericBonusTier: ItemPoolResolver.MAX_GENERIC_BONUS_BY_TIER[tier] ?? 0,
        ownerTheme: opts.ownerTheme ?? "armaments",
        preferArmor: opts.preferArmor ?? false,
        requireArmor: opts.requireArmor ?? false,
        fallbackTables: { tiers: { [String(tier)]: tierData } }
    };
}

/**
 * Run many mastercraft picks against an injected simulation pool.
 *
 * @param {number} tier
 * @param {object[]} pool
 * @param {object} [opts]
 * @param {number} [opts.iterations=400]
 * @returns {object}
 */
export async function simulateMastercraftPicks(tier, pool, opts = {}) {
    const iterations = opts.iterations ?? 400;
    const useInjection = Array.isArray(pool) && pool.length > 0;
    const tables = opts.tables ?? {
        tiers: Object.fromEntries(
            Object.entries(TIER_DATA).map(([key, row]) => [key, { ...row, _tier: parseInt(key, 10) }])
        ),
        ownerThemes: SYNTHETIC_CACHE_TABLES.ownerThemes
    };
    const settings = opts.settings ?? readBalanceSimulationSettings();

    if (useInjection) {
        ItemPoolResolver.setSimulationPool(pool);
    }

    const picks = [];
    let nulls = 0;

    try {
        for (let i = 0; i < iterations; i++) {
            const item = await drawMastercraftInCacheContext(tier, {
                theme: opts.theme ?? "dungeon",
                ownerTheme: opts.ownerTheme ?? "armaments",
                tables,
                settings,
                simulateNamedMagicRoll: opts.simulateNamedMagicRoll ?? true,
                requireArmor: opts.requireArmor ?? false,
                capacityLbs: opts.capacityLbs ?? 140
            });
            if (!item) {
                nulls++;
                continue;
            }
            picks.push(item);
        }
    } finally {
        if (useInjection) {
            ItemPoolResolver.clearSimulationPool();
        }
    }

    return buildMastercraftPickStats(picks, {
        tier,
        theme: opts.theme ?? "dungeon",
        iterations,
        nulls
    });
}

// ── Full cache simulation ──────────────────────────────────────────────

/** Minimal cache tables for offline generate() runs. */
export const SYNTHETIC_CACHE_TABLES = {
    tiers: {
        "1": { label: "Tier 1", budgetCap: 150, goldDice: "0", rarityMax: "uncommon", scrollLevelMax: 2 },
        "2": { label: "Tier 2", budgetCap: 600, goldDice: "0", rarityMax: "rare", scrollLevelMax: 4 },
        "3": { label: "Tier 3", budgetCap: 2500, goldDice: "0", rarityMax: "veryRare", scrollLevelMax: 7 },
        "4": { label: "Tier 4", budgetCap: 10000, goldDice: "0", rarityMax: "legendary", scrollLevelMax: 9 }
    },
    ownerThemes: {
        armaments: {
            label: "Armaments",
            budgetMultiplier: 1.0,
            totalSlots: { min: 6, max: 8 },
            slotPool: {
                mastercraft: 5, mundane: 3, consumable: 2,
                ammo: 2, treasure: 1, gemstone: 1, scroll: 0.5, trinket: 0.5
            },
            guaranteed: [{ type: "mastercraft", min: 1, max: 2 }]
        },
        unspecified: {
            label: "Unspecified",
            budgetMultiplier: 1.0,
            totalSlots: { min: 5, max: 8 },
            slotPool: {
                mundane: 2, consumable: 2, scroll: 1.5,
                mastercraft: 1.5, gemstone: 1.5, treasure: 1.5, trinket: 1,
                ammo: 0.5
            },
            guaranteed: []
        }
    },
    flavorPhrases: {}
};

/**
 * @param {object[]} runs CacheGenerator.generate results
 * @returns {object}
 */
export function aggregateCacheRuns(runs) {
    let cachesWithMagicalGear = 0;
    let cachesWithMagicalArmor = 0;
    let cachesWithResistanceArmor = 0;
    let totalItems = 0;
    let magicalGearItems = 0;
    let weaponOrArmorItems = 0;
    let healingItems = 0;
    let totalItemValue = 0;
    let totalGold = 0;
    const bonusHist = {};
    const categoryHist = {};
    const allMagicalGear = [];

    for (const run of runs) {
        totalGold += run.gold ?? 0;
        let cacheHasMagic = false;
        let cacheHasArmor = false;
        let cacheHasResistance = false;
        for (const item of run.items ?? []) {
            totalItems++;
            totalItemValue += item.price ?? 0;
            if (isHealingCacheItem(item)) healingItems++;
            const info = classifyCacheItem(item);
            categoryHist[info.category] = (categoryHist[info.category] ?? 0) + 1;
            if (info.kind === "weapon" || info.kind === "armor" || info.kind === "shield") {
                weaponOrArmorItems++;
            }
            if (info.isMagicalGear) {
                magicalGearItems++;
                cacheHasMagic = true;
                allMagicalGear.push(item);
            }
            if (isMagicalArmorOrShield(item)) {
                cacheHasArmor = true;
            }
            if (isResistanceArmor(item)) {
                cacheHasResistance = true;
            }
            if (info.bonus > 0) {
                bonusHist[info.bonus] = (bonusHist[info.bonus] ?? 0) + 1;
            }
        }
        if (cacheHasMagic) cachesWithMagicalGear++;
        if (cacheHasArmor) cachesWithMagicalArmor++;
        if (cacheHasResistance) cachesWithResistanceArmor++;
    }

    const curve = deriveCurveStatsFromItems(allMagicalGear);
    const n = runs.length || 1;
    return {
        cacheCount: runs.length,
        cacheHasMagicalGearRate: cachesWithMagicalGear / n,
        cachesWithMagicalGear,
        cacheHasMagicalArmorRate: cachesWithMagicalArmor / n,
        cachesWithMagicalArmor,
        cacheHasResistanceArmorRate: cachesWithResistanceArmor / n,
        cachesWithResistanceArmor,
        totalItems,
        magicalGearItems,
        magicalArmorItems: curve.magicalArmorItems,
        magicalWeaponItems: curve.magicalWeaponItems,
        magicalGearByKind: curve.magicalGearByKind,
        magicalGearItemRate: totalItems ? magicalGearItems / totalItems : 0,
        weaponOrArmorItems,
        bonusHist,
        cacheGenericBonusHist: curve.genericBonusHist,
        cacheGenericPlus1Share: curve.genericPlus1Share,
        cacheGenericPlus2Share: curve.genericPlus2Share,
        cacheGenericPlus3Share: curve.genericPlus3Share,
        categoryHist,
        meanItemsPerCache: totalItems / n,
        healingItems,
        healingItemsPerCache: healingItems / n,
        meanItemValuePerCache: totalItemValue / n,
        meanGoldPerCache: totalGold / n
    };
}

/**
 * Snapshot live mastercraft pool health for diagnostics.
 * @param {number} tier
 * @returns {Promise<object>}
 */
export async function probeLiveMastercraftPool(tier) {
    const tierData = TIER_DATA[tier] ?? TIER_DATA[1];
    let compileStatus = "unknown";
    let compileMeta = null;
    try {
        const { LootPoolCompiler } = await import("./LootPoolCompiler.js");
        compileStatus = LootPoolCompiler.getStatus?.() ?? "unknown";
        compileMeta = LootPoolCompiler.getCompiledMeta?.() ?? null;
    } catch {
        compileStatus = "unavailable";
    }

    const pool = await ItemPoolResolver.resolve({
        slotType: "mastercraft",
        tier,
        theme: "dungeon",
        fallbackTables: { tiers: { [String(tier)]: tierData } }
    });

    let magicalGear = 0;
    let genericPlus = 0;
    let genericPlus1 = 0;
    let genericPlus2 = 0;
    let genericPlus3 = 0;
    let genericWeaponPlus2 = 0;
    let genericArmorPlus2 = 0;
    let namedMagic = 0;
    let mundaneGear = 0;
    for (const item of pool) {
        const info = classifyCacheItem(item);
        if (info.kind !== "weapon" && info.kind !== "armor" && info.kind !== "shield") continue;
        if (info.isMagicalGear) magicalGear++;
        if (info.category === ItemClassifier.CATEGORY.GENERIC_MAGIC) {
            genericPlus++;
            if (info.bonus === 1) genericPlus1++;
            else if (info.bonus === 2) {
                genericPlus2++;
                if (info.kind === "weapon") genericWeaponPlus2++;
                else if (info.kind === "armor" || info.kind === "shield") genericArmorPlus2++;
            }
            else if (info.bonus === 3) genericPlus3++;
        } else if (info.category === ItemClassifier.CATEGORY.NAMED_MAGIC) namedMagic++;
        else mundaneGear++;
    }

    return {
        tier,
        compileStatus,
        compilerVersion: compileMeta?.compilerVersion ?? null,
        genericWeaponCount: compileMeta?.genericWeaponCount ?? null,
        compileMeta,
        mastercraftCount: pool.length,
        magicalGear,
        genericPlus,
        genericPlus1,
        genericPlus2,
        genericPlus3,
        genericWeaponPlus2,
        genericArmorPlus2,
        genericArmorPlusCount: compileMeta?.genericArmorPlusCount ?? null,
        namedMagic,
        mundaneGear
    };
}

/**
 * @param {object} merged stats
 * @param {object} probe from probeLiveMastercraftPool
 * @returns {string}
 */
export function formatLiveFailureContext(merged, probe, settings = null) {
    const plus2Pick = ((merged.mastercraftPickGenericPlus2Share ?? 0) * 100).toFixed(0);
    const plus3Pick = ((merged.mastercraftPickGenericPlus3Share ?? 0) * 100).toFixed(0);
    const simSettings = settings ?? readBalanceSimulationSettings();
    const parts = [
        `settings magic ${simSettings.magicFrequency}x economy ${simSettings.lootEconomy}x heal ${simSettings.healingPotionFrequency}x`,
        `pool ${probe.mastercraftCount} rows (${probe.magicalGear} magical gear, compile ${probe.compileStatus})`,
        `slot ceiling ~${realisticMastercraftSlotCeiling(probe.tier)} gp`,
        `pick magical ${(merged.mastercraftPickMagicalRate * 100).toFixed(0)}% (+2 ${plus2Pick}%, +3 ${plus3Pick}%)`,
        `pick armor ${((merged.mastercraftPickMagicalArmorRate ?? 0) * 100).toFixed(0)}%`,
        `caches w/ magic ${(merged.cacheHasMagicalGearRate * 100).toFixed(0)}%`,
        `caches w/ armor ${(merged.cacheHasMagicalArmorRate * 100).toFixed(0)}%`,
        `gear lines ${merged.weaponOrArmorItems} in ${merged.cacheCount} caches`
    ];
    return parts.join("; ");
}

/**
 * @param {object} pickStats from simulateMastercraftPicks
 * @param {object} cacheStats from aggregateCacheRuns
 * @returns {object}
 */
export function mergePickAndCacheStats(pickStats, cacheStats) {
    return {
        ...cacheStats,
        mastercraftPickNullRate: pickStats.nullRate,
        mastercraftPickMagicalRate: pickStats.magicalRate,
        mastercraftPickMagicalArmorRate: pickStats.mastercraftPickMagicalArmorRate,
        mastercraftPickBonusHist: pickStats.bonusHist,
        mastercraftPickGenericBonusHist: pickStats.mastercraftPickGenericBonusHist,
        mastercraftPickGenericPlus1Share: pickStats.mastercraftPickGenericPlus1Share,
        mastercraftPickGenericPlus2Share: pickStats.mastercraftPickGenericPlus2Share,
        mastercraftPickGenericPlus3Share: pickStats.mastercraftPickGenericPlus3Share,
        mastercraftPickCategoryHist: pickStats.categoryHist
    };
}

// ── Expectations ───────────────────────────────────────────────────────

/**
 * @returns {Promise<object>}
 */
export async function loadExpectations() {
    if (_expectationsCache) return _expectationsCache;
    try {
        const response = await fetch(`modules/${MODULE_ID}/data/cache-balance-expectations.json`);
        _expectationsCache = await response.json();
    } catch {
        _expectationsCache = DEFAULT_EXPECTATIONS;
    }
    return _expectationsCache;
}

/**
 * Wilson-style margin for proportion guardrails.
 * @param {number} p
 * @param {number} n
 * @param {number} [z=2.0]
 * @returns {number}
 */
export function proportionMargin(p, n, z = 2.0) {
    if (n <= 0) return 1;
    return z * Math.sqrt((p * (1 - p)) / n);
}

/**
 * @param {object} stats
 * @param {object} spec
 * @returns {{ ok: boolean, messages: string[] }}
 */
export function evaluateCacheExpectations(stats, spec) {
    const messages = [];
    let ok = true;
    const n = stats.cacheCount ?? stats.iterations ?? spec.iterations ?? 1;

    const cacheOnlyKeys = new Set([
        "cacheHasMagicalArmor",
        "cacheGenericPlus2Share",
        "cacheGenericPlus3Share"
    ]);

    const checkMin = (key, rate, label) => {
        if (spec[key]?.min === undefined) return;
        if (cacheOnlyKeys.has(key) && !stats.cacheCount) return;
        const floor = spec[key].min - proportionMargin(spec[key].min, n);
        if (rate < floor) {
            ok = false;
            messages.push(
                `${label}: ${(rate * 100).toFixed(1)}% (need >= ${(spec[key].min * 100).toFixed(0)}%, ` +
                `floor ${(floor * 100).toFixed(1)}% at n=${n})`
            );
        }
    };

    const checkMax = (key, rate, label) => {
        if (spec[key]?.max === undefined) return;
        if (cacheOnlyKeys.has(key) && !stats.cacheCount) return;
        if (key === "mastercraftPickNullRate" && stats.cacheCount) return;
        const ceiling = spec[key].max + proportionMargin(spec[key].max, n);
        if (rate > ceiling) {
            ok = false;
            messages.push(
                `${label}: ${(rate * 100).toFixed(1)}% (need <= ${(spec[key].max * 100).toFixed(0)}%)`
            );
        }
    };

    checkMin(
        "cacheHasMagicalWeaponOrArmor",
        stats.cacheHasMagicalGearRate ?? 0,
        "caches with magical weapon/armor"
    );
    checkMin(
        "mastercraftPickMagicalRate",
        stats.mastercraftPickMagicalRate ?? stats.magicalRate ?? 0,
        "mastercraft pick magical rate"
    );
    checkMax(
        "mastercraftPickNullRate",
        stats.mastercraftPickNullRate ?? stats.nullRate ?? 0,
        "mastercraft null pick rate"
    );

    checkMin(
        "cacheHasMagicalArmor",
        stats.cacheHasMagicalArmorRate ?? 0,
        "caches with magical armor/shield"
    );
    checkMin(
        "mastercraftPickMagicalArmorRate",
        stats.mastercraftPickMagicalArmorRate ?? 0,
        "mastercraft pick magical armor rate"
    );
    checkMin(
        "mastercraftPickGenericPlus2Share",
        stats.mastercraftPickGenericPlus2Share ?? 0,
        "mastercraft pick +2 share (generic)"
    );
    checkMax(
        "mastercraftPickGenericPlus3Share",
        stats.mastercraftPickGenericPlus3Share ?? 0,
        "mastercraft pick +3 share (generic)"
    );
    checkMin(
        "cacheGenericPlus2Share",
        stats.cacheGenericPlus2Share ?? 0,
        "cache +2 share (generic gear)"
    );
    checkMax(
        "cacheGenericPlus3Share",
        stats.cacheGenericPlus3Share ?? 0,
        "cache +3 share (generic gear)"
    );

    if (spec.genericBonusMinObserved !== undefined) {
        const observed = Object.keys(stats.mastercraftPickBonusHist ?? stats.bonusHist ?? {})
            .map(Number)
            .filter(b => (stats.mastercraftPickBonusHist ?? stats.bonusHist ?? {})[b] > 0);
        const minBonus = observed.length ? Math.min(...observed) : 0;
        if (minBonus < spec.genericBonusMinObserved) {
            ok = false;
            messages.push(
                `generic bonus floor: min observed +${minBonus} (need >= +${spec.genericBonusMinObserved})`
            );
        }
    }

    if (spec.meanItemsPerCache?.min !== undefined) {
        const rate = stats.meanItemsPerCache ?? 0;
        if (rate < spec.meanItemsPerCache.min) {
            ok = false;
            messages.push(
                `mean items/cache: ${rate.toFixed(1)} (need >= ${spec.meanItemsPerCache.min})`
            );
        }
    }

    if (spec.healingItemsPerCache?.min !== undefined) {
        const rate = stats.healingItemsPerCache ?? 0;
        const floor = spec.healingItemsPerCache.min - proportionMargin(spec.healingItemsPerCache.min, n);
        if (rate < floor) {
            ok = false;
            messages.push(
                `healing lines/cache: ${rate.toFixed(2)} (need >= ${spec.healingItemsPerCache.min})`
            );
        }
    }

    if (spec.healingItemsPerCache?.max !== undefined) {
        const rate = stats.healingItemsPerCache ?? 0;
        const ceiling = spec.healingItemsPerCache.max + proportionMargin(spec.healingItemsPerCache.max, n);
        if (rate > ceiling) {
            ok = false;
            messages.push(
                `healing lines/cache: ${rate.toFixed(2)} (need <= ${spec.healingItemsPerCache.max})`
            );
        }
    }

    if (spec.meanItemValuePerCache?.min !== undefined) {
        const value = stats.meanItemValuePerCache ?? 0;
        if (value < spec.meanItemValuePerCache.min) {
            ok = false;
            messages.push(
                `mean item value/cache: ${value.toFixed(0)} gp (need >= ${spec.meanItemValuePerCache.min} gp)`
            );
        }
    }

    return { ok, messages };
}

/**
 * Compare two scenario runs for monotonic settings response.
 * @param {object} rule
 * @param {object} lowStats
 * @param {object} highStats
 * @returns {{ ok: boolean, message: string }}
 */
export function evaluateSettingsOrdering(rule, lowStats, highStats) {
    const lowVal = lowStats?.[rule.metric] ?? 0;
    const highVal = highStats?.[rule.metric] ?? 0;
    const delta = highVal - lowVal;
    const ok = delta >= (rule.minDelta ?? 0);
    const label = rule.metric;
    const message = ok
        ? `${label}: ${lowVal.toFixed(3)} -> ${highVal.toFixed(3)} (delta ${delta.toFixed(3)})`
        : `${label}: ${lowVal.toFixed(3)} -> ${highVal.toFixed(3)} (need delta >= ${rule.minDelta}, got ${delta.toFixed(3)})`;
    return { ok, message };
}

/**
 * Build expectation spec for one matrix scenario.
 * @param {object} scenario
 * @param {object} expectations
 * @param {object} profilesDoc
 * @returns {object|null}
 */
export function buildScenarioExpectations(scenario, expectations, profilesDoc) {
    const tier = scenario.tier;
    const ownerTheme = scenario.ownerTheme ?? "armaments";
    const iterations = scenario.iterations ?? 80;

    if (tier === 1) {
        return { iterations, meanItemsPerCache: { min: 2 } };
    }

    let spec = expectations[ownerTheme]?.[String(tier)];
    if (!spec) return null;

    if (scenario.profile) {
        spec = scaleExpectationsForProfile(spec, scenario.profile, profilesDoc) ?? spec;
    } else if (scenario.edgeCase) {
        spec = structuredClone(spec);
        if (scenario.edgeCase === "healHeavy") {
            spec.healingItemsPerCache = { min: 0.25 };
            delete spec.mastercraftPickGenericPlus2Share;
            delete spec.cacheGenericPlus2Share;
        } else if (scenario.edgeCase === "healOff") {
            for (const key of CURVE_STRICT_KEYS) delete spec[key];
        } else if (scenario.edgeCase === "magicWeak") {
            spec = scaleExpectationsForProfile(spec, "low", profilesDoc) ?? spec;
        } else if (scenario.edgeCase === "economyLow") {
            spec.meanItemValuePerCache = { min: 80 };
        }
        for (const key of CURVE_STRICT_KEYS) {
            if (scenario.edgeCase !== "standard") delete spec[key];
        }
    }

    return { ...spec, iterations: scenario.iterations ?? spec.iterations ?? iterations };
}

/**
 * @param {object} stats
 * @param {object} settings
 * @returns {string}
 */
export function formatScenarioPassMessage(stats, settings) {
    return `magic ${settings.magicFrequency}x economy ${settings.lootEconomy}x heal ${settings.healingPotionFrequency}x | ` +
        `caches w/ magic ${((stats.cacheHasMagicalGearRate ?? 0) * 100).toFixed(0)}%, ` +
        `pick magic ${((stats.mastercraftPickMagicalRate ?? 0) * 100).toFixed(0)}%, ` +
        `healing ${(stats.healingItemsPerCache ?? 0).toFixed(2)}/cache`;
}

/**
 * Run one matrix scenario: apply QM settings, generate caches, evaluate.
 * @param {object} scenario
 * @param {object} ctx
 * @returns {Promise<object>}
 */
export async function runSettingsMatrixScenario(scenario, ctx) {
    const {
        profilesDoc,
        matrixDoc,
        expectations,
        pool,
        prepareGenerate,
        live = false
    } = ctx;

    const settings = resolveScenarioSettings(scenario, profilesDoc);
    if (settings) {
        applyBalanceSimulationSettings(settings);
    }

    if (typeof prepareGenerate === "function") {
        await prepareGenerate();
    }

    const tier = scenario.tier;
    const ownerTheme = scenario.ownerTheme ?? "armaments";
    const iterations = scenario.iterations
        ?? matrixDoc.tierIterations?.[String(tier)]
        ?? matrixDoc.defaultIterations
        ?? 80;

    const runs = [];
    if (!live) {
        ItemPoolResolver.setSimulationPool(pool);
    }

    try {
        for (let i = 0; i < iterations; i++) {
            runs.push(await CacheGenerator.generate({
                tier,
                theme: "dungeon",
                ownerTheme,
                silent: true
            }));
        }
    } finally {
        if (!live) {
            ItemPoolResolver.clearSimulationPool();
        }
    }

    const cacheStats = aggregateCacheRuns(runs);
    const pickStats = extractMastercraftPickStats(runs, { tier, theme: "dungeon" });
    const merged = mergePickAndCacheStats(pickStats, cacheStats);
    const applied = readBalanceSimulationSettings();
    const spec = buildScenarioExpectations(scenario, expectations, profilesDoc);
    const verdict = spec
        ? evaluateCacheExpectations(merged, spec)
        : { ok: true, messages: [] };

    return {
        scenarioId: scenario.id,
        name: scenario.id,
        tier,
        ownerTheme,
        profile: scenario.profile ?? scenario.edgeCase ?? null,
        settings: { ...applied },
        status: verdict.ok ? "pass" : "fail",
        message: verdict.ok
            ? formatScenarioPassMessage(merged, applied)
            : verdict.messages.join("; "),
        stats: merged,
        verdict
    };
}

/**
 * Sequential E2E matrix: for each scenario, apply QM slider values, generate, validate.
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function runSyntheticSettingsMatrixSuite(opts = {}) {
    const [profilesDoc, matrixDoc, expectations] = await Promise.all([
        opts.profilesDoc ? Promise.resolve(opts.profilesDoc) : loadSettingsProfiles(),
        opts.matrixDoc ? Promise.resolve(opts.matrixDoc) : loadSettingsMatrix(),
        opts.expectations ? Promise.resolve(opts.expectations) : loadExpectations()
    ]);

    const scenarios = opts.scenarios ?? matrixDoc.scenarios ?? [];
    const pool = opts.pool ?? buildSyntheticFullPool(opts.poolOpts);
    const ctx = {
        profilesDoc,
        matrixDoc,
        expectations,
        pool,
        prepareGenerate: opts.prepareGenerate,
        live: false
    };

    const results = [];
    const statsByScenarioId = new Map();
    let passed = 0;
    let failed = 0;

    for (const scenario of scenarios) {
        const row = await runSettingsMatrixScenario(scenario, ctx);
        results.push(row);
        statsByScenarioId.set(scenario.id, row.stats);
        if (row.status === "pass") passed++;
        else failed++;
    }

    const orderingResults = [];
    const orderingRules = opts.skipOrdering
        ? []
        : (opts.orderingRules ?? profilesDoc.orderingRules ?? []);

    for (const rule of orderingRules) {
        if (rule.synthetic === false) continue;
        const lowStats = statsByScenarioId.get(rule.lowScenario);
        const highStats = statsByScenarioId.get(rule.highScenario);
        if (!lowStats || !highStats) {
            orderingResults.push({
                ...rule,
                status: "skip",
                ok: false,
                message: `missing scenario stats (${rule.lowScenario} or ${rule.highScenario})`
            });
            continue;
        }
        const ord = evaluateSettingsOrdering(rule, lowStats, highStats);
        orderingResults.push({
            ...rule,
            status: ord.ok ? "pass" : "fail",
            ok: ord.ok,
            message: ord.message
        });
        if (ord.ok) passed++;
        else failed++;
    }

    return {
        passed,
        failed,
        total: results.length + orderingResults.length,
        scenarioTotal: results.length,
        orderingTotal: orderingResults.length,
        results,
        orderingResults
    };
}

/**
 * Live Foundry matrix: same sequential settings drive against compendium pools.
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function runLiveSettingsMatrixSuite(opts = {}) {
    const [profilesDoc, matrixDoc, expectations] = await Promise.all([
        loadSettingsProfiles(),
        loadSettingsMatrix(),
        loadExpectations()
    ]);

    ItemPoolResolver.clearSimulationPool();

    const scenarios = (opts.scenarios ?? matrixDoc.scenarios ?? []).map(scenario => ({
        ...scenario,
        iterations: Math.min(
            scenario.iterations
                ?? matrixDoc.tierIterations?.[String(scenario.tier)]
                ?? matrixDoc.defaultIterations
                ?? 80,
            opts.maxIterations ?? 100
        )
    }));

    const ctx = {
        profilesDoc,
        matrixDoc,
        expectations,
        pool: null,
        prepareGenerate: null,
        live: true
    };

    const results = [];
    const statsByScenarioId = new Map();
    let passed = 0;
    let failed = 0;

    for (const scenario of scenarios) {
        const row = await runSettingsMatrixScenario(scenario, ctx);
        results.push(row);
        statsByScenarioId.set(scenario.id, row.stats);
        if (row.status === "pass") passed++;
        else failed++;
    }

    const orderingResults = [];
    for (const rule of profilesDoc.orderingRules ?? []) {
        const lowStats = statsByScenarioId.get(rule.lowScenario);
        const highStats = statsByScenarioId.get(rule.highScenario);
        if (!lowStats || !highStats) continue;
        const ord = evaluateSettingsOrdering(rule, lowStats, highStats);
        orderingResults.push({
            ...rule,
            status: ord.ok ? "pass" : "fail",
            ok: ord.ok,
            message: ord.message
        });
        if (ord.ok) passed++;
        else failed++;
    }

    return {
        passed,
        failed,
        total: results.length + orderingResults.length,
        scenarioTotal: results.length,
        orderingTotal: orderingResults.length,
        results,
        orderingResults
    };
}

// ── Suite runners ──────────────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function runSyntheticMastercraftSuite(opts = {}) {
    const expectations = opts.expectations ?? DEFAULT_EXPECTATIONS;
    const pool = buildSyntheticMastercraftPool(opts.poolOpts);
    const results = [];
    let passed = 0;
    let failed = 0;

    for (const tier of opts.tiers ?? [2, 3, 4]) {
        const spec = expectations.armaments?.[String(tier)] ?? expectations.armaments?.[tier];
        if (!spec) continue;

        const iterations = opts.iterations ?? spec.iterations ?? 400;
        const stats = await simulateMastercraftPicks(tier, pool, {
            iterations,
            ownerTheme: "armaments",
            simulateNamedMagicRoll: true,
            priceCeiling: TIER_DATA[tier].budgetCap
        });
        const verdict = evaluateCacheExpectations(
            {
                iterations: stats.iterations,
                cacheHasMagicalGearRate: stats.magicalRate,
                mastercraftPickMagicalRate: stats.magicalRate,
                mastercraftPickMagicalArmorRate: stats.mastercraftPickMagicalArmorRate,
                mastercraftPickNullRate: stats.nullRate,
                mastercraftPickBonusHist: stats.bonusHist,
                mastercraftPickGenericPlus2Share: stats.mastercraftPickGenericPlus2Share,
                mastercraftPickGenericPlus3Share: stats.mastercraftPickGenericPlus3Share
            },
            spec
        );

        if (verdict.ok) passed++;
        else failed++;

        results.push({
            name: `T${tier} armaments mastercraft picks (synthetic)`,
            status: verdict.ok ? "pass" : "fail",
            message: verdict.ok
                ? `magical ${(stats.magicalRate * 100).toFixed(1)}%, null ${(stats.nullRate * 100).toFixed(1)}%`
                : verdict.messages.join("; "),
            stats,
            verdict
        });
    }

    return { passed, failed, total: results.length, results };
}

/**
 * @param {object} opts
 * @param {() => Promise<void>} opts.prepareGenerate Vitest hook: mock container, tables, gold
 * @returns {Promise<object>}
 */
export async function runSyntheticFullCacheSuite(opts = {}) {
    const expectations = opts.expectations ?? DEFAULT_EXPECTATIONS;
    const pool = opts.pool ?? buildSyntheticFullPool(opts.poolOpts);
    const ownerTheme = opts.ownerTheme ?? "armaments";
    const tier = opts.tier ?? 4;
    const spec = expectations[ownerTheme]?.[String(tier)] ?? expectations[ownerTheme]?.[tier];
    const iterations = opts.iterations ?? spec?.iterations ?? 300;

    if (typeof opts.prepareGenerate === "function") {
        await opts.prepareGenerate();
    }

    ItemPoolResolver.setSimulationPool(pool);
    const runs = [];

    try {
        for (let i = 0; i < iterations; i++) {
            runs.push(await CacheGenerator.generate({
                tier,
                theme: "dungeon",
                ownerTheme,
                silent: true
            }));
        }
    } finally {
        ItemPoolResolver.clearSimulationPool();
    }

    const cacheStats = aggregateCacheRuns(runs);
    const pickStats = extractMastercraftPickStats(runs, {
        tier,
        theme: opts.theme ?? "dungeon"
    });
    const merged = mergePickAndCacheStats(pickStats, cacheStats);
    const verdict = spec
        ? evaluateCacheExpectations(merged, spec)
        : { ok: true, messages: [] };

    return {
        passed: verdict.ok ? 1 : 0,
        failed: verdict.ok ? 0 : 1,
        total: 1,
        results: [{
            name: `T${tier} ${ownerTheme} full cache (synthetic)`,
            status: verdict.ok ? "pass" : "fail",
            message: verdict.ok
                ? `${(merged.cacheHasMagicalGearRate * 100).toFixed(1)}% caches with magical gear, ` +
                  `~${merged.meanItemsPerCache.toFixed(1)} items/cache`
                : verdict.messages.join("; "),
            stats: merged,
            verdict
        }]
    };
}

/**
 * Foundry harness: live compendium pools.
 * @returns {Promise<object>}
 */
export async function runLiveCacheBalanceSuite() {
    const expectations = await loadExpectations();
    const scenarios = [
        { tier: 4, ownerTheme: "armaments" },
        { tier: 3, ownerTheme: "armaments" },
        { tier: 2, ownerTheme: "armaments" }
    ];

    const results = [];
    let passed = 0;
    let failed = 0;

    ItemPoolResolver.clearSimulationPool();
    const simSettings = readBalanceSimulationSettings();

    for (const scenario of scenarios) {
        const spec = expectations[scenario.ownerTheme]?.[String(scenario.tier)];
        if (!spec) continue;

        const iterations = Math.min(spec.iterations ?? 300, 200);
        const runs = [];

        for (let i = 0; i < iterations; i++) {
            runs.push(await CacheGenerator.generate({
                tier: scenario.tier,
                theme: "dungeon",
                ownerTheme: scenario.ownerTheme,
                silent: true
            }));
        }

        const cacheStats = aggregateCacheRuns(runs);
        const pickStats = extractMastercraftPickStats(runs, {
            tier: scenario.tier,
            theme: "dungeon"
        });
        const merged = mergePickAndCacheStats(pickStats, cacheStats);
        const probe = await probeLiveMastercraftPool(scenario.tier);
        const verdict = evaluateCacheExpectations(merged, spec);

        if (verdict.ok) passed++;
        else failed++;

        const failDetail = verdict.ok
            ? ""
            : ` | ${formatLiveFailureContext(merged, probe, simSettings)}`;

        results.push({
            name: `T${scenario.tier} ${scenario.ownerTheme} (live)`,
            status: verdict.ok ? "pass" : "fail",
            message: verdict.ok
                ? `${(merged.cacheHasMagicalGearRate * 100).toFixed(1)}% caches with magical gear, ` +
                  `pick magical ${(merged.mastercraftPickMagicalRate * 100).toFixed(1)}%`
                : `${verdict.messages.join("; ")}${failDetail}`,
            stats: merged,
            probe,
            verdict
        });
    }

    return { passed, failed, total: results.length, results };
}
