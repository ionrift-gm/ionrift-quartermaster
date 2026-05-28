import { describe, it, expect } from "vitest";
import { CacheGenerator } from "../scripts/services/CacheGenerator.js";
import {
    buildSyntheticScrollIndex,
    simulateScrollPicks,
    simulateArcanaScrollCache,
    evaluateTierBand,
    runSyntheticBalanceSuite,
    histogramLevels
} from "../scripts/services/ScrollBalanceSimulator.js";

const TIERS = {
    1: { _tier: 1, scrollLevelMax: 2, budgetCap: 150 },
    2: { _tier: 2, scrollLevelMax: 4, budgetCap: 600 },
    3: { _tier: 3, scrollLevelMax: 7, budgetCap: 2500 },
    4: { _tier: 4, scrollLevelMax: 9, budgetCap: 10000 }
};

describe("scroll price ceiling", () => {

    it("T2 allows aspire band (level 3) when budget share is healthy", () => {
        const tierData = TIERS[2];
        const ceiling = CacheGenerator._scrollPriceCeiling(tierData, 120, {
            scrollSlotsRemaining: 5,
            remainingBudget: 1100
        });
        expect(ceiling).toBeGreaterThanOrEqual(200);
    });

    it("does not exceed aspire band when slot ceiling is tight", () => {
        const tierData = TIERS[2];
        const ceiling = CacheGenerator._scrollPriceCeiling(tierData, 80, {
            scrollSlotsRemaining: 5,
            remainingBudget: 400
        });
        expect(ceiling).toBeLessThanOrEqual(200);
        expect(ceiling).toBeGreaterThanOrEqual(120);
    });
});

describe("weighted scroll level with tier floor", () => {

    it("T2 never rolls below level 2", () => {
        for (let i = 0; i < 200; i++) {
            expect(CacheGenerator._weightedScrollLevel(4, 2, 2)).toBeGreaterThanOrEqual(2);
        }
    });

    it("T2 reaches level 3+ over many rolls", () => {
        const hist = {};
        for (let i = 0; i < 500; i++) {
            const lvl = CacheGenerator._weightedScrollLevel(4, 2, 2);
            hist[lvl] = (hist[lvl] ?? 0) + 1;
        }
        expect(hist[3] ?? 0).toBeGreaterThan(50);
    });
});

describe("pickScrollFromIndex (synthetic)", () => {

    const index = buildSyntheticScrollIndex(10, 9);

    it("T2 produces level 3+ with fair budget", () => {
        const stats = simulateScrollPicks(TIERS[2], index, {
            iterations: 500,
            priceCeiling: 220,
            scrollSlotsRemaining: 5,
            remainingBudget: 1100
        });
        const verdict = evaluateTierBand(stats);
        expect(verdict.ok, verdict.messages.join("; ")).toBe(true);
        expect(stats.maxObserved).toBeGreaterThanOrEqual(3);
    });

    it("T4 produces level 6+ sometimes", () => {
        const stats = simulateScrollPicks(TIERS[4], index, {
            iterations: 500,
            priceCeiling: 10000 / 7,
            scrollSlotsRemaining: 7,
            remainingBudget: 10000
        });
        expect(stats.minObserved).toBeGreaterThanOrEqual(5);
        expect(stats.maxObserved).toBeGreaterThanOrEqual(6);
    });
});

describe("arcana cache scroll simulation", () => {

    const index = buildSyntheticScrollIndex(10, 9);

    it("T2 mean unique lines stay near slot cap", () => {
        const arcana = simulateArcanaScrollCache(2, index, {
            budgetMax: 1100,
            goldSpent: 75,
            iterations: 150
        });
        expect(arcana.scrollSlotCount).toBe(5);
        expect(arcana.meanUniqueLines).toBeLessThanOrEqual(5.5);
        expect(arcana.meanScrollQty).toBeGreaterThan(arcana.meanUniqueLines);
    });

    it("T2 level histogram spans above floor", () => {
        const arcana = simulateArcanaScrollCache(2, index, {
            budgetMax: 1100,
            iterations: 120
        });
        const maxLvl = Math.max(...Object.keys(arcana.hist).map(Number));
        expect(maxLvl).toBeGreaterThanOrEqual(3);
    });
});

describe("full synthetic balance suite", () => {

    it("passes all tier bands", () => {
        const report = runSyntheticBalanceSuite({ iterations: 350 });
        if (report.failed > 0) {
            const lines = report.results
                .filter(r => r.status === "fail")
                .map(r => `${r.name}: ${r.message}`);
            expect.fail(lines.join("\n"));
        }
        expect(report.passed).toBe(4);
    });
});

describe("histogramLevels", () => {

    it("counts levels", () => {
        expect(histogramLevels([2, 2, 3])).toEqual({ 2: 2, 3: 1 });
    });
});
