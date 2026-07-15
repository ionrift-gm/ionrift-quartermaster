import { MODULE_ID } from "../../data/moduleId.js";
/**
 * Empirical scroll distribution tests for cache generation balance.
 * Used by Vitest (synthetic index) and the Foundry test harness (live Scroll Forge pack).
 */

import { CacheGenerator, __testables__ } from "../cache/CacheGenerator.js";
import { ScrollForge } from "./ScrollForge.js";

const TIERS = {
    1: { _tier: 1, scrollLevelMax: 2, budgetCap: 150 },
    2: { _tier: 2, scrollLevelMax: 4, budgetCap: 600 },
    3: { _tier: 3, scrollLevelMax: 7, budgetCap: 2500 },
    4: { _tier: 4, scrollLevelMax: 9, budgetCap: 10000 }
};

/** Minimum share of picks that must reach this offset above tier floor. */
const MIN_ABOVE_FLOOR_RATE = {
    1: { offset: 0, rate: 0.35 },
    2: { offset: 1, rate: 0.20 },
    3: { offset: 1, rate: 0.25 },
    4: { offset: 1, rate: 0.25 }
};

/**
 * Build a flat synthetic Scroll Forge-style index with N spells per circle.
 *
 * @param {number} [perLevel=12]
 * @param {number} [maxLevel=9]
 * @returns {object[]}
 */
export function buildSyntheticScrollIndex(perLevel = 12, maxLevel = 9) {
    const index = [];
    for (let level = 1; level <= maxLevel; level++) {
        for (let n = 0; n < perLevel; n++) {
            const spellName = `Synthetic L${level} Spell ${n}`;
            index.push({
                _id: `syn-l${level}-${n}`,
                name: `Spell Scroll: ${spellName}`,
                flags: {
                    [MODULE_ID]: {
                        scrollMeta: { spellLevel: level, spellName }
                    }
                }
            });
        }
    }
    return index;
}

/**
 * @param {number[]} levels
 * @returns {Record<number, number>}
 */
export function histogramLevels(levels) {
    const hist = {};
    for (const lvl of levels) {
        hist[lvl] = (hist[lvl] ?? 0) + 1;
    }
    return hist;
}

/**
 * Run many scroll picks against an index and return distribution stats.
 *
 * @param {object} tierData
 * @param {object[]} index
 * @param {object} [opts]
 * @param {number} [opts.iterations=400]
 * @param {number} [opts.priceCeiling=Infinity]
 * @param {number} [opts.scrollSlotsRemaining=1]
 * @param {number} [opts.remainingBudget]
 * @returns {object}
 */
export function simulateScrollPicks(tierData, index, opts = {}) {
    const {
        iterations = 400,
        priceCeiling = Infinity,
        scrollSlotsRemaining = 1,
        remainingBudget = priceCeiling
    } = opts;

    const tier = tierData._tier ?? 1;
    const minLevel = __testables__.tierScrollMinLevel(tier);
    const maxLevel = tierData.scrollLevelMax ?? 2;
    const levels = [];
    let failures = 0;

    for (let i = 0; i < iterations; i++) {
        const pick = CacheGenerator._pickScrollFromIndex(index, tierData, priceCeiling, {
            scrollSlotsRemaining,
            remainingBudget
        });
        if (!pick?.spellLevel) {
            failures++;
            continue;
        }
        levels.push(pick.spellLevel);
    }

    const hist = histogramLevels(levels);
    const success = levels.length;
    const mean = success
        ? levels.reduce((a, b) => a + b, 0) / success
        : 0;
    const maxObserved = success ? Math.max(...levels) : 0;
    const minObserved = success ? Math.min(...levels) : 0;

    const aspireLevel = Math.min(
        maxLevel,
        minLevel + Math.max(1, Math.floor((maxLevel - minLevel) * 0.55))
    );
    const aboveFloor = levels.filter(l => l >= minLevel + (MIN_ABOVE_FLOOR_RATE[tier]?.offset ?? 1)).length;
    const aboveFloorRate = success ? aboveFloor / success : 0;

    return {
        tier,
        minLevel,
        maxLevel,
        aspireLevel,
        iterations,
        success,
        failures,
        hist,
        mean,
        minObserved,
        maxObserved,
        aboveFloorRate
    };
}

/**
 * Simulate one Arcana cache's scroll slots (slot cap + budget share).
 *
 * @param {number} tier
 * @param {object[]} index
 * @param {object} [opts]
 * @param {number} [opts.budgetMax]
 * @param {number} [opts.goldSpent=50]
 * @param {number} [opts.iterations=200]
 * @returns {object}
 */
export function simulateArcanaScrollCache(tier, index, opts = {}) {
    const tierData = TIERS[tier];
    if (!tierData) throw new Error(`Unknown tier ${tier}`);

    const budgetMax = opts.budgetMax ?? tierData.budgetCap;
    const goldSpent = opts.goldSpent ?? Math.floor(tierData.budgetCap * 0.08);
    const iterations = opts.iterations ?? 200;
    const scrollSlotCount = __testables__.scrollSlotCap(tier, "arcana");
    const remainingBudget = Math.max(0, budgetMax - goldSpent);
    const share = remainingBudget / Math.max(1, scrollSlotCount);

    const allLevels = [];
    let uniqueSum = 0;
    let totalQty = 0;

    for (let run = 0; run < iterations; run++) {
        const lines = [];
        for (let s = 0; s < scrollSlotCount; s++) {
            const pick = CacheGenerator._pickScrollFromIndex(index, tierData, share, {
                scrollSlotsRemaining: scrollSlotCount - s,
                remainingBudget
            });
            if (!pick) continue;
            const qty = CacheGenerator._resolveScrollQuantity(
                pick.spellLevel, tierData, share
            );
            lines.push({ ...pick, quantity: qty });
            allLevels.push(pick.spellLevel);
        }
        const merged = CacheGenerator._consolidateScrollStacks(lines, tierData);
        const scrollOnly = merged.filter(i => i.spellName);
        uniqueSum += scrollOnly.length;
        for (const row of scrollOnly) {
            totalQty += row.quantity ?? 1;
        }
    }

    const hist = histogramLevels(allLevels);

    return {
        tier,
        scrollSlotCount,
        budgetMax,
        remainingBudget,
        sharePerSlot: share,
        iterations,
        hist,
        meanUniqueLines: uniqueSum / iterations,
        meanScrollQty: totalQty / iterations
    };
}

/**
 * @param {object} stats from simulateScrollPicks
 * @returns {{ ok: boolean, messages: string[] }}
 */
export function evaluateTierBand(stats) {
    const messages = [];
    const tier = stats.tier;
    const rule = MIN_ABOVE_FLOOR_RATE[tier];
    let ok = true;

    if (stats.success < stats.iterations * 0.95) {
        ok = false;
        messages.push(`too many null picks: ${stats.failures}/${stats.iterations}`);
    }

    if (stats.minObserved < stats.minLevel) {
        ok = false;
        messages.push(`below tier floor: min observed ${stats.minObserved} < ${stats.minLevel}`);
    }

    if (stats.maxObserved > stats.maxLevel) {
        ok = false;
        messages.push(`above tier cap: max observed ${stats.maxObserved} > ${stats.maxLevel}`);
    }

    if (rule && stats.aboveFloorRate < rule.rate) {
        ok = false;
        messages.push(
            `level >= ${stats.minLevel + rule.offset} only ${(stats.aboveFloorRate * 100).toFixed(1)}% ` +
            `(need ${(rule.rate * 100).toFixed(0)}%)`
        );
    }

    if (stats.maxObserved < stats.minLevel + 1 && stats.maxLevel > stats.minLevel + 1) {
        ok = false;
        messages.push(`never reached above floor (max ${stats.maxObserved})`);
    }

    return { ok, messages };
}

/**
 * Vitest / harness entry: run all tier bands on a synthetic index.
 *
 * @param {object} [opts]
 * @param {number} [opts.iterations=400]
 * @returns {object}
 */
export function runSyntheticBalanceSuite(opts = {}) {
    const index = buildSyntheticScrollIndex(12, 9);
    const iterations = opts.iterations ?? 400;
    const results = [];

    for (const tier of [1, 2, 3, 4]) {
        const tierData = TIERS[tier];
        const scrollSlots = __testables__.scrollSlotCap(tier, "arcana");
        const stats = simulateScrollPicks(tierData, index, {
            iterations,
            priceCeiling: Infinity,
            scrollSlotsRemaining: scrollSlots,
            remainingBudget: Infinity
        });
        const verdict = evaluateTierBand(stats);
        results.push({ tier, stats, verdict });
    }

    const passed = results.filter(r => r.verdict.ok).length;
    const failed = results.length - passed;
    return {
        passed,
        failed,
        total: results.length,
        results: results.map(r => ({
            name: `T${r.tier} scroll band`,
            status: r.verdict.ok ? "pass" : "fail",
            message: r.verdict.ok
                ? `mean ${r.stats.mean.toFixed(2)} hist ${JSON.stringify(r.stats.hist)}`
                : r.verdict.messages.join("; "),
            stats: r.stats
        }))
    };
}

/**
 * Foundry harness: use live forged scroll pack when present.
 *
 * @returns {Promise<object>}
 */
export async function runLiveScrollBalanceSuite() {
    const forgedId = `world.${ScrollForge.WORLD_PACK_NAME}`;
    const pack = game.packs.get(forgedId);
    if (!pack) {
        return {
            passed: 0,
            failed: 1,
            total: 1,
            skipped: true,
            results: [{
                name: "live-scroll-pack",
                status: "skip",
                message: `Pack ${forgedId} not found. Compile Scroll Forge first.`
            }]
        };
    }

    const index = await pack.getIndex({
        fields: ["name", "img", "system.level", "flags"]
    });
    const entries = index.contents ?? Array.from(index);
    if (!entries.length) {
        return {
            passed: 0,
            failed: 1,
            total: 1,
            results: [{
                name: "live-scroll-pack",
                status: "fail",
                message: "Forged scroll pack is empty."
            }]
        };
    }

    const results = [];
    let passed = 0;
    let failed = 0;

    for (const tier of [1, 2, 3, 4]) {
        const tierData = TIERS[tier];
        const scrollSlots = __testables__.scrollSlotCap(tier, "arcana");
        const budget = tierData.budgetCap;
        const stats = simulateScrollPicks(tierData, entries, {
            iterations: 300,
            priceCeiling: Infinity,
            scrollSlotsRemaining: scrollSlots,
            remainingBudget: Infinity
        });
        const verdict = evaluateTierBand(stats);
        const arcana = simulateArcanaScrollCache(tier, entries, {
            budgetMax: budget,
            iterations: 80
        });

        const ok = verdict.ok && arcana.meanUniqueLines <= scrollSlots + 0.5;
        if (ok) passed++;
        else failed++;

        results.push({
            name: `T${tier} live scroll balance`,
            status: ok ? "pass" : "fail",
            message: ok
                ? `mean lvl ${stats.mean.toFixed(2)}, ~${arcana.meanUniqueLines.toFixed(1)} unique lines/run`
                : [...verdict.messages,
                    arcana.meanUniqueLines > scrollSlots + 0.5
                        ? `too many unique lines (${arcana.meanUniqueLines.toFixed(1)} vs ${scrollSlots} slots)`
                        : null
                ].filter(Boolean).join("; "),
            stats,
            arcana
        });
    }

    return { passed, failed, total: results.length, results };
}
