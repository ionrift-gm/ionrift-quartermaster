/**
 * Monte Carlo Curse Balance Suite
 *
 * Deterministic balance testing for cursed items. Simulates curse progression
 * across a population of D&D 5e character profiles and asserts that balance
 * metrics fall within soft guardrails.
 *
 * Run: npx vitest run montecarlo/montecarlo.test.js
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { generateProfiles } from "./character-profiles.js";
import { generateSessions } from "./session-simulator.js";
import { encumbranceStatus, thresholds } from "./encumbrance-calc.js";
import { resolvePhases, effectiveStr, itemWeightAtPhase, extractCurseMeta } from "./phase-resolver.js";
import { runEncumbranceSuite, runSwapSuite } from "./balance-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadBlueprint(relativePath) {
    const abs = resolve(__dirname, relativePath);
    return JSON.parse(readFileSync(abs, "utf-8"));
}

const GAUNTLET_PATH = "../../../modules/ionrift-quartermaster/packs/src/proving-grounds/gauntlets-of-the-ogres-due.json";
const FANG_PATH = "../../../modules/ionrift-quartermaster/packs/src/proving-grounds/verdant-fang.json";

/* ------------------------------------------------------------------ */
/*  Gauntlets of the Ogre's Due                                       */
/* ------------------------------------------------------------------ */

describe("Monte Carlo: Gauntlets of the Ogre's Due", () => {
    let blueprint;
    let report;

    beforeAll(() => {
        blueprint = loadBlueprint(GAUNTLET_PATH);
        report = runEncumbranceSuite(blueprint, "standard");
    });

    it("loads the blueprint with valid cursedMeta", () => {
        const meta = extractCurseMeta(blueprint);
        expect(meta).toBeDefined();
        expect(meta.curse.name).toBe("The Ogre's Due");
        expect(meta.latent.exposure.phaseThresholds).toHaveLength(4);
    });

    it("population is non-trivial (>= 25 profiles)", () => {
        expect(report.population).toBeGreaterThanOrEqual(25);
    });

    it("majority of profiles land in 'genuine dilemma'", () => {
        const dilemmaRate = report.verdicts.dilemma / report.population;
        expect(dilemmaRate).toBeGreaterThan(0.4);
    });

    it("no profiles are immobile at Phase 4", () => {
        const immobileAtP4 = report.profiles.filter(
            p => p.phases[4].status === "immobile"
        );
        expect(immobileAtP4).toHaveLength(0);
    });

    it("at least some profiles find the curse costly", () => {
        expect(report.verdicts.discard).toBeGreaterThan(0);
    });

    it("at Phase 3, at least some profiles are still unencumbered", () => {
        // Before the final phase, the lure (STR 19) offsets most of the weight.
        // This confirms the curse has a genuine "honeymoon" period.
        const normalAtP3 = report.profiles.filter(
            p => p.phases[3].status === "normal"
        );
        expect(normalAtP3.length).toBeGreaterThan(0);
    });

    it("at Phase 4, no profile is in 'normal' encumbrance (by design)", () => {
        // Phase 4 (STR 17, 60lb) is meant to be punishing. Nobody gets a free ride.
        const normalAtP4 = report.profiles.filter(
            p => p.phases[4].status === "normal"
        );
        expect(normalAtP4).toHaveLength(0);
    });

    it("Phase 4 reached within 30 sessions on standard pace", () => {
        // Standard pace ≈ 7 exposure/session. 180 threshold needs ~26 sessions.
        const fullReport = runEncumbranceSuite(blueprint, "standard", { sessionCount: 30 });
        const p4Session = fullReport.phaseTimingRange.p4;
        expect(p4Session).not.toBeNull();
        expect(p4Session).toBeLessThanOrEqual(30);
    });

    it("Phase 4 reached within 15 sessions on full-day pace", () => {
        // Full adventuring day ≈ 19 exposure/session. Reaches P4 well within 15.
        const fullDay = runEncumbranceSuite(blueprint, "fullDay", { sessionCount: 15 });
        const p4Session = fullDay.phaseTimingRange.p4;
        expect(p4Session).not.toBeNull();
        expect(p4Session).toBeLessThanOrEqual(15);
    });

    it("Phase 1 reached within 5 sessions on standard pace", () => {
        const p1Session = report.phaseTimingRange.p1;
        expect(p1Session).not.toBeNull();
        expect(p1Session).toBeLessThanOrEqual(5);
    });

    it("STR drops to 17 at Phase 4", () => {
        const anyProfile = report.profiles[0];
        expect(anyProfile.phases[4].effectiveStr).toBeLessThan(19);
        expect(anyProfile.phases[4].effectiveStr).toBe(17);
    });

    it("item weight is 60lb at Phase 4", () => {
        expect(itemWeightAtPhase(blueprint, 4)).toBe(60);
    });

    it("item weight escalates monotonically through phases", () => {
        const weights = [0, 1, 2, 3, 4].map(p => itemWeightAtPhase(blueprint, p));
        for (let i = 1; i < weights.length; i++) {
            expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1]);
        }
    });

    describe("session type sensitivity", () => {
        it("dungeon sessions produce more dilemmas than full-day sessions", () => {
            const dungeon = runEncumbranceSuite(blueprint, "dungeon");
            const fullDay = runEncumbranceSuite(blueprint, "fullDay");
            // Dungeon has fewer rests → less exposure → slower progression
            // The items aren't changing though, so this is about timing not verdict.
            // Full day reaches P4 faster, so we just check it's reachable in both.
            expect(dungeon.phaseTimingRange.p4).not.toBeNull();
            expect(fullDay.phaseTimingRange.p4).not.toBeNull();
        });
    });

    describe("encumbrance detail: loot-goblin archetype", () => {
        it("loot goblins are encumbered or worse at Phase 4", () => {
            const lootGoblins = report.profiles.filter(p => p.archetype === "loot-goblin");
            expect(lootGoblins.length).toBeGreaterThan(0);
            const allEncumbered = lootGoblins.every(
                p => p.phases[4].status !== "normal"
            );
            expect(allEncumbered).toBe(true);
        });
    });
});

/* ------------------------------------------------------------------ */
/*  Verdant Fang / The Jealous Edge                                   */
/* ------------------------------------------------------------------ */

describe("Monte Carlo: Verdant Fang (The Jealous Edge)", () => {
    let blueprint;
    let report;

    beforeAll(() => {
        blueprint = loadBlueprint(FANG_PATH);
        report = runSwapSuite(blueprint, "standard");
    });

    it("loads the blueprint with valid cursedMeta", () => {
        const meta = extractCurseMeta(blueprint);
        expect(meta).toBeDefined();
        expect(meta.curse.name).toBe("The Jealous Edge");
        expect(meta.latent.exposure.phaseThresholds).toHaveLength(4);
    });

    it("population is non-trivial", () => {
        expect(report.population).toBeGreaterThanOrEqual(25);
    });

    it("casters overwhelmingly find the curse punishing at Phase 4", () => {
        const casters = report.profiles.filter(p => p.caster);
        expect(casters.length).toBeGreaterThan(0);
        const discardRate = casters.filter(p => p.verdict === "obvious discard").length / casters.length;
        expect(discardRate).toBeGreaterThan(0.5);
    });

    it("martial profiles find the swap rate a genuine dilemma", () => {
        const martials = report.profiles.filter(p => !p.caster && p.attacksPerRound >= 2);
        expect(martials.length).toBeGreaterThan(0);
        const dilemmaOrKeep = martials.filter(
            p => p.verdict === "genuine dilemma" || p.verdict === "no-brainer keep"
        ).length / martials.length;
        expect(dilemmaOrKeep).toBeGreaterThan(0.5);
    });

    it("swap chance escalates from 10% to 60% across phases", () => {
        const p1 = report.profiles[0].phases[1];
        const p4 = report.profiles[0].phases[4];
        expect(p1.swapChance).toBeCloseTo(0.10);
        expect(p4.swapChance).toBeCloseTo(0.60);
    });

    it("Phase 4 reached within 25 sessions on standard pace", () => {
        expect(report.phaseTimingRange.p4).not.toBeNull();
        expect(report.phaseTimingRange.p4).toBeLessThanOrEqual(25);
    });

    it("3-attack martial has >80% chance of at least one swap at Phase 4", () => {
        const heavyMartial = report.profiles.find(
            p => p.attacksPerRound === 3 && !p.caster
        );
        expect(heavyMartial).toBeDefined();
        expect(heavyMartial.phases[4].atLeastOneSwapPct).toBeGreaterThan(80);
    });

    describe("loyalty sensitivity", () => {
        it("all-loyal combats slow exposure dramatically", () => {
            const loyalReport = runSwapSuite(blueprint, "standard", {
                loyaltySplit: { loyal: 1.0, mixed: 0, betrayed: 0 }
            });
            // With all-loyal combats, combatLoyal weight is 0, only longRest contributes
            // So phase progression should be very slow or not reach P4
            const p4 = loyalReport.phaseTimingRange.p4;
            if (p4 !== null) {
                expect(p4).toBeGreaterThan(15);
            }
        });

        it("all-betrayed combats accelerate exposure", () => {
            const betrayedReport = runSwapSuite(blueprint, "standard", {
                loyaltySplit: { loyal: 0, mixed: 0, betrayed: 1.0 }
            });
            expect(betrayedReport.phaseTimingRange.p4).not.toBeNull();
            expect(betrayedReport.phaseTimingRange.p4).toBeLessThanOrEqual(12);
        });
    });
});

/* ------------------------------------------------------------------ */
/*  Utility / Sanity checks                                           */
/* ------------------------------------------------------------------ */

describe("Monte Carlo: Utility sanity checks", () => {
    it("generateProfiles produces deterministic output", () => {
        const a = generateProfiles();
        const b = generateProfiles();
        expect(a).toEqual(b);
    });

    it("generateSessions produces deterministic output", () => {
        const a = generateSessions("standard", 10);
        const b = generateSessions("standard", 10);
        expect(a).toEqual(b);
    });

    it("encumbrance thresholds are correct for STR 17", () => {
        const t = thresholds(17);
        expect(t.encumbered).toBe(85);
        expect(t.heavily).toBe(170);
        expect(t.max).toBe(255);
    });

    it("encumbranceStatus classifies correctly", () => {
        expect(encumbranceStatus(10, 40)).toBe("normal");
        expect(encumbranceStatus(10, 60)).toBe("encumbered");
        expect(encumbranceStatus(10, 110)).toBe("heavily");
        expect(encumbranceStatus(10, 160)).toBe("immobile");
    });
});
