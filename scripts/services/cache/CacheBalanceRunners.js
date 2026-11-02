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
import {
    buildMastercraftPickStats,
    extractMastercraftPickStats,
    drawMastercraftInCacheContext,
    realisticMastercraftSlotCeiling,
    mastercraftPickOpts,
    simulateMastercraftPicks,
    extractCacheItemWeight,
    extractCacheItemUnitPrice,
    inspectCacheItemEconomyIssues,
    scanItemsForEconomyLeaks,
    scanCacheRunsForEconomyLeaks,
    SYNTHETIC_CACHE_TABLES,
    aggregateCacheRuns
} from "./CacheBalanceSimulator.js";

export async function probeLiveMastercraftPool(tier) {
    const tierData = TIER_DATA[tier] ?? TIER_DATA[1];
    let compileStatus = "unknown";
    let compileMeta = null;
    try {
        const { LootPoolCompiler } = await import("../loot/LootPoolCompiler.js");
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

    const economyLeaks = scanCacheRunsForEconomyLeaks(runs, {
        label: `${scenario.id ?? "scenario"} T${tier} ${ownerTheme}`
    });

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
        verdict,
        economyLeaks
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

    const economyLeaks = scanCacheRunsForEconomyLeaks(runs, {
        label: `T${tier} ${ownerTheme} full cache (synthetic)`
    });

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
            verdict,
            economyLeaks
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

        const economyLeaks = scanCacheRunsForEconomyLeaks(runs, {
            label: `T${scenario.tier} ${scenario.ownerTheme} (live)`
        });

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
            verdict,
            economyLeaks
        });
    }

    return { passed, failed, total: results.length, results };
}

