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
import {
    NAMED_MAGIC_PER_CACHE,
    TIER_DATA,
    DEFAULT_EXPECTATIONS,
    ARMOR_SUBTYPES,
    CURVE_STRICT_KEYS,
    createSeededRandom,
    withSeededRandom,
    withSeededRandomAsync,
    resolveGearKind,
    isMagicalGear,
    classifyCacheItem,
    isMagicalArmorOrShield,
    isResistanceArmor,
    genericBonusShare,
    summarizeGenericBonusHist,
    deriveCurveStatsFromItems,
    buildSyntheticMastercraftPool,
    buildSyntheticFillerPool,
    buildSyntheticFullPool,
    readBalanceSimulationSettings,
    resolveSettingsProfile,
    loadSettingsProfiles,
    loadSettingsMatrix,
    applyBalanceSimulationSettings,
    resolveScenarioSettings,
    scaleExpectationsForProfile,
    isHealingCacheItem,
    cacheEffectiveWeight
} from "./CacheBalancePoolsAndSettings.js";
export * from "./CacheBalancePoolsAndSettings.js";
export * from "./CacheBalanceRunners.js";

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
    const effectiveBudget = (tierData.budgetCap ?? 600) * (ownerDef.budgetMultiplier ?? 1.0) * economy;
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
    const armorChance = game.settings?.get(MODULE_ID, "armourDropChance") ?? 0.65;
    const armorPresence = ownerTheme === "armaments"
        && CacheGenerator.ARMOR_PRESENCE_THEMES.has(ownerTheme)
        && Math.random() < armorChance;
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
        const namedMagicMult = game.settings?.get(MODULE_ID, "namedMagicFrequency") ?? 1.0;
        rejectNamedMagical = Math.random() >= Math.min(1, (NAMED_MAGIC_PER_CACHE[tier] ?? 0) * namedMagicMult);
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

    scanItemsForEconomyLeaks(picks, {
        label: `T${tier} ${opts.ownerTheme ?? "armaments"} mastercraft picks`
    });

    return buildMastercraftPickStats(picks, {
        tier,
        theme: opts.theme ?? "dungeon",
        iterations,
        nulls
    });
}

// ── Zero-economy leak detection (Monte Carlo / balance probes) ─────────

/**
 * Read weight from a cache result row or pool pick.
 * @param {object} item
 * @returns {number}
 */
export function extractCacheItemWeight(item) {
    if (item == null) return 0;
    const flat = item.weight;
    if (typeof flat === "number" && !Number.isNaN(flat)) return flat;
    const sys = item.system?.weight;
    if (typeof sys === "number") return sys;
    if (sys && typeof sys === "object") return Number(sys.value) || 0;
    return 0;
}

/**
 * Read unit gp price from a cache result row or pool pick.
 * @param {object} item
 * @returns {number}
 */
export function extractCacheItemUnitPrice(item) {
    if (item == null) return 0;
    if (item._unitPrice !== undefined && item._unitPrice !== null) {
        return Number(item._unitPrice) || 0;
    }
    const qty = Math.max(1, Number(item.quantity) || 1);
    const priceObj = item.system?.price;
    let line = Number(item.price ?? 0) || 0;
    if (line <= 0 && priceObj && typeof priceObj === "object") {
        line = Number(priceObj.value) || 0;
    } else if (line <= 0 && typeof priceObj === "number") {
        line = priceObj;
    }
    return line / qty;
}

/**
 * @param {object} item
 * @returns {string[]}
 */
export function inspectCacheItemEconomyIssues(item) {
    const issues = [];
    if (extractCacheItemUnitPrice(item) <= 0) issues.push("zero_price");
    if (extractCacheItemWeight(item) <= 0) issues.push("zero_weight");
    return issues;
}

/**
 * Scan generated cache rows for items with 0 gp and/or 0 lb.
 * Logs distinct leaks so incomplete compendium rows stay visible during Monte Carlo runs.
 *
 * @param {object[]} items Flat item rows or cache picks
 * @param {object} [opts]
 * @param {string} [opts.label]
 * @param {boolean} [opts.log=true]
 * @returns {object[]}
 */
export function scanItemsForEconomyLeaks(items, opts = {}) {
    const label = opts.label ?? "cache simulation";
    const log = opts.log !== false;
    const seen = new Map();

    for (const item of items ?? []) {
        const issues = inspectCacheItemEconomyIssues(item);
        if (!issues.length) continue;
        const key = `${item.name}|${issues.join(",")}`;
        const existing = seen.get(key);
        if (existing) {
            existing.count++;
            continue;
        }
        seen.set(key, {
            name: item.name,
            price: extractCacheItemUnitPrice(item),
            weight: extractCacheItemWeight(item),
            quantity: item.quantity ?? 1,
            slotType: item._cacheSlotType ?? item.slotType ?? null,
            issues,
            count: 1
        });
    }

    const leaks = [...seen.values()];
    if (log && leaks.length) {
        Logger.warn(MODULE_LABEL, `[economy leak] ${label}: ${leaks.length} distinct zero-economy item(s)`);
        for (const row of leaks) {
            const parts = row.issues.map(issue => (issue === "zero_price" ? "0 gp" : "0 lb")).join(", ");
            Logger.warn(MODULE_LABEL,
                `  - ${row.name} (${parts}, qty ${row.quantity}` +
                `${row.slotType ? `, slot ${row.slotType}` : ""}, seen ${row.count}x)`
            );
        }
    }
    return leaks;
}

/**
 * @param {object[]} runs CacheGenerator.generate results
 * @param {object} [opts]
 * @returns {object[]}
 */
export function scanCacheRunsForEconomyLeaks(runs, opts = {}) {
    const items = [];
    for (const run of runs ?? []) {
        items.push(...(run.items ?? []));
    }
    return scanItemsForEconomyLeaks(items, opts);
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
