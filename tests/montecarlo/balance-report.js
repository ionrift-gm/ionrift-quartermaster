/**
 * Balance report aggregator.
 *
 * For each (profile, blueprint, session-type) combination, computes
 * encumbrance status at every phase, net carry delta, a verdict
 * ("no-brainer keep" / "genuine dilemma" / "obvious discard"), and
 * population-level aggregates with outlier detection.
 */

import { generateProfiles } from "./character-profiles.js";
import { generateSessions, tagCombatLoyalty } from "./session-simulator.js";
import { encumbranceStatus, carryDelta, thresholds } from "./encumbrance-calc.js";
import { resolvePhases, effectiveStr, itemWeightAtPhase, swapChanceAtPhase, extractCurseMeta } from "./phase-resolver.js";

/**
 * @typedef {"no-brainer keep" | "genuine dilemma" | "obvious discard"} Verdict
 */

/**
 * Run the full balance suite for an encumbrance-based cursed item (e.g. gauntlets).
 *
 * @param {object} blueprint - parsed item JSON
 * @param {string} sessionType - "dungeon" | "standard" | "fullDay"
 * @param {object} [opts]
 * @param {number} [opts.sessionCount=25]
 * @returns {object} balance report
 */
export function runEncumbranceSuite(blueprint, sessionType, opts = {}) {
    const sessionCount = opts.sessionCount ?? 25;
    const profiles = generateProfiles();
    const { sessions } = generateSessions(sessionType, sessionCount);

    const phaseResult = resolvePhases(blueprint, sessions);
    const meta = extractCurseMeta(blueprint);
    const phaseCount = meta.latent.exposure.phaseThresholds.length;

    const profileResults = [];

    for (const profile of profiles) {
        const phases = [];
        for (let p = 0; p <= phaseCount; p++) {
            const str = effectiveStr(blueprint, p, profile.naturalStr);
            const itemWeight = itemWeightAtPhase(blueprint, p);
            const totalWeight = profile.gearWeight + itemWeight;
            const status = encumbranceStatus(str, totalWeight);
            const delta = carryDelta(str, totalWeight);
            const t = thresholds(str);

            phases.push({
                phase: p,
                effectiveStr: str,
                itemWeight,
                totalWeight,
                status,
                headroomLb: delta.headroomLb,
                usedPct: Math.round(delta.usedPct * 100),
                thresholds: t
            });
        }

        const p4 = phases[phaseCount];
        const verdict = classifyVerdict(p4.status);

        let earliestProblem = null;
        for (let p = 1; p <= phaseCount; p++) {
            if (phases[p].status === "heavily" || phases[p].status === "immobile") {
                earliestProblem = p;
                break;
            }
        }

        profileResults.push({
            label: profile.label,
            archetype: profile.archetype,
            naturalStr: profile.naturalStr,
            gearWeight: profile.gearWeight,
            phases,
            verdict,
            earliestProblem
        });
    }

    const verdicts = { keep: 0, dilemma: 0, discard: 0 };
    for (const r of profileResults) {
        if (r.verdict === "no-brainer keep") verdicts.keep++;
        else if (r.verdict === "genuine dilemma") verdicts.dilemma++;
        else verdicts.discard++;
    }

    const outliers = profileResults
        .filter(r => r.verdict === "obvious discard" && r.earliestProblem !== null && r.earliestProblem <= 2)
        .map(r => ({
            label: r.label,
            verdict: r.verdict,
            reason: `${r.phases[r.earliestProblem].status} encumbered at Phase ${r.earliestProblem}`
        }));

    const phaseTiming = {};
    for (let p = 1; p <= phaseCount; p++) {
        const session = phaseResult.sessionsToPhase[p];
        phaseTiming[`p${p}`] = session !== null ? session + 1 : null; // 1-indexed
    }

    return {
        item: meta.curse?.name ?? "Unknown",
        sessionType,
        population: profiles.length,
        verdicts,
        outliers,
        phaseTimingRange: phaseTiming,
        profiles: profileResults,
        phaseResult
    };
}

/**
 * Run the balance suite for a swap-based cursed item (e.g. Verdant Fang).
 *
 * @param {object} blueprint - parsed item JSON
 * @param {string} sessionType - "dungeon" | "standard" | "fullDay"
 * @param {object} [opts]
 * @param {number} [opts.sessionCount=25]
 * @param {{ loyal: number, mixed: number, betrayed: number }} [opts.loyaltySplit]
 * @returns {object} balance report
 */
export function runSwapSuite(blueprint, sessionType, opts = {}) {
    const sessionCount = opts.sessionCount ?? 25;
    const profiles = generateProfiles();
    const { sessions: rawSessions } = generateSessions(sessionType, sessionCount);
    const sessions = tagCombatLoyalty(rawSessions, opts.loyaltySplit);

    const phaseResult = resolvePhases(blueprint, sessions);
    const meta = extractCurseMeta(blueprint);
    const phaseCount = meta.latent.exposure.phaseThresholds.length;

    const profileResults = [];

    for (const profile of profiles) {
        const phases = [];
        for (let p = 0; p <= phaseCount; p++) {
            const swap = swapChanceAtPhase(blueprint, p);
            const attacksPerRound = profile.attacksPerRound ?? 2;
            const expectedSwapsPerRound = swap * attacksPerRound;
            const noSwapProb = Math.pow(1 - swap, attacksPerRound);
            const atLeastOneSwapPct = Math.round((1 - noSwapProb) * 100);

            phases.push({
                phase: p,
                swapChance: swap,
                expectedSwapsPerRound,
                atLeastOneSwapPct,
                attacksPerRound
            });
        }

        const p4 = phases[phaseCount];
        const verdict = classifySwapVerdict(p4.atLeastOneSwapPct, profile.caster);

        profileResults.push({
            label: profile.label,
            archetype: profile.archetype,
            naturalStr: profile.naturalStr,
            caster: profile.caster,
            attacksPerRound: profile.attacksPerRound,
            phases,
            verdict
        });
    }

    const verdicts = { keep: 0, dilemma: 0, discard: 0 };
    for (const r of profileResults) {
        if (r.verdict === "no-brainer keep") verdicts.keep++;
        else if (r.verdict === "genuine dilemma") verdicts.dilemma++;
        else verdicts.discard++;
    }

    const outliers = profileResults
        .filter(r => r.verdict === "obvious discard" && r.caster)
        .map(r => ({
            label: r.label,
            verdict: r.verdict,
            reason: `caster with ${r.phases[phaseCount].atLeastOneSwapPct}% swap + psychic damage on cast`
        }));

    const phaseTiming = {};
    for (let p = 1; p <= phaseCount; p++) {
        const session = phaseResult.sessionsToPhase[p];
        phaseTiming[`p${p}`] = session !== null ? session + 1 : null;
    }

    return {
        item: meta.curse?.name ?? "Unknown",
        sessionType,
        population: profiles.length,
        verdicts,
        outliers,
        phaseTimingRange: phaseTiming,
        profiles: profileResults,
        phaseResult
    };
}

/**
 * Classify an encumbrance-based verdict at the final phase.
 * @param {"normal"|"encumbered"|"heavily"|"immobile"} status
 * @returns {Verdict}
 */
function classifyVerdict(status) {
    if (status === "normal") return "no-brainer keep";
    if (status === "encumbered") return "genuine dilemma";
    return "obvious discard"; // heavily or immobile
}

/**
 * Classify a swap-based verdict at Phase 4.
 * Casters take psychic damage at Phase 4, so the sword is much worse for them.
 *
 * @param {number} atLeastOneSwapPct
 * @param {boolean} isCaster
 * @returns {Verdict}
 */
function classifySwapVerdict(atLeastOneSwapPct, isCaster) {
    if (isCaster) {
        // Psychic damage on spell cast makes any significant swap rate punishing
        if (atLeastOneSwapPct > 50) return "obvious discard";
        return "genuine dilemma";
    }
    // For martials, the sword is still a +1 weapon -- swaps cost weapon choice,
    // not raw effectiveness. Thresholds are more generous.
    if (atLeastOneSwapPct <= 30) return "no-brainer keep";
    if (atLeastOneSwapPct <= 90) return "genuine dilemma";
    return "obvious discard";
}
