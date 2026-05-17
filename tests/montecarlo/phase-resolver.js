/**
 * Headless exposure accumulator and phase resolver.
 *
 * Reads `cursedMeta.latent.exposure.weights` and `phaseThresholds` from a
 * blueprint JSON. Given a sequence of session events, resolves which phase
 * the item is at after each session and tracks cumulative `apply` fields.
 */

/**
 * Extract the curse config from a raw blueprint JSON object.
 * @param {object} blueprint - parsed item JSON
 * @returns {object} cursedMeta
 */
export function extractCurseMeta(blueprint) {
    return blueprint?.flags?.["ionrift-quartermaster"]?.cursedMeta;
}

/**
 * Resolve phases across a sequence of sessions.
 *
 * @param {object} blueprint - parsed item JSON (full Foundry item structure)
 * @param {string[][]} sessions - array of session event arrays
 * @returns {{
 *   sessionsToPhase: (number|null)[],
 *   finalExposure: number,
 *   phaseAtSession: number[],
 *   applyAtPhase: object[],
 *   escalationLog: object[]
 * }}
 */
export function resolvePhases(blueprint, sessions) {
    const meta = extractCurseMeta(blueprint);
    if (!meta?.latent?.exposure) {
        throw new Error("Blueprint has no exposure config");
    }

    const weights = meta.latent.exposure.weights;
    const thresholds = meta.latent.exposure.phaseThresholds;
    const escalation = meta.latent.escalation;

    const phaseCount = thresholds.length;
    const sessionsToPhase = new Array(phaseCount + 1).fill(null);
    sessionsToPhase[0] = 0; // phase 0 (latent) starts immediately

    const phaseAtSession = [];
    const escalationLog = [];
    let totalExposure = 0;
    let currentPhase = 0;

    for (let s = 0; s < sessions.length; s++) {
        const events = sessions[s];
        let sessionExposure = 0;

        for (const evt of events) {
            const w = weights[evt] ?? 0;
            sessionExposure += w;
        }

        totalExposure += sessionExposure;

        while (currentPhase < phaseCount && totalExposure >= thresholds[currentPhase]) {
            currentPhase++;
            if (sessionsToPhase[currentPhase] === null) {
                sessionsToPhase[currentPhase] = s;
                escalationLog.push({
                    phase: currentPhase,
                    session: s,
                    exposure: totalExposure,
                    threshold: thresholds[currentPhase - 1]
                });
            }
        }

        phaseAtSession.push(currentPhase);
    }

    const applyAtPhase = buildApplyStack(escalation);

    return {
        sessionsToPhase,
        finalExposure: totalExposure,
        phaseAtSession,
        applyAtPhase,
        escalationLog
    };
}

/**
 * Build cumulative apply state at each phase.
 * Each phase inherits prior apply fields and merges new ones on top.
 *
 * @param {object[]} escalation - the escalation array from cursedMeta.latent
 * @returns {object[]} apply state per phase index (0 = latent/base, 1..N = phases)
 */
function buildApplyStack(escalation) {
    const stack = [{}]; // phase 0: no changes

    let cumulative = {};
    for (const step of escalation) {
        cumulative = { ...cumulative, ...(step.apply ?? {}) };
        stack.push({ ...cumulative });
    }

    return stack;
}

/**
 * Get the effective STR for a character at a given curse phase.
 * The blueprint may set an explicit STR via `apply.strength`.
 * During the lure phase, the lure grants STR 19 (for the gauntlets).
 * At Phase 4, the blueprint may override that.
 *
 * @param {object} blueprint - parsed item JSON
 * @param {number} phase - current phase (0 = latent/lure active)
 * @param {number} naturalStr - character's natural STR
 * @returns {number}
 */
export function effectiveStr(blueprint, phase, naturalStr) {
    const meta = extractCurseMeta(blueprint);
    const applyStack = buildApplyStack(meta.latent.escalation);

    const lureStr = 19; // Gauntlets of Ogre Power: STR 19
    const baseEffective = Math.max(naturalStr, lureStr);

    const phaseApply = applyStack[phase] ?? {};
    if (phaseApply.strength !== undefined) {
        return Math.max(naturalStr, phaseApply.strength);
    }

    return baseEffective;
}

/**
 * Get the item weight at a given curse phase.
 * @param {object} blueprint
 * @param {number} phase
 * @returns {number}
 */
export function itemWeightAtPhase(blueprint, phase) {
    const meta = extractCurseMeta(blueprint);
    const baseWeight = blueprint.system?.weight ?? 0;
    const applyStack = buildApplyStack(meta.latent.escalation);
    return applyStack[phase]?.weight ?? baseWeight;
}

/**
 * Get the swap chance at a given phase for the Verdant Fang.
 * @param {object} blueprint
 * @param {number} phase
 * @returns {number} 0-1 swap probability
 */
export function swapChanceAtPhase(blueprint, phase) {
    const meta = extractCurseMeta(blueprint);
    if (phase < 1 || phase > meta.latent.escalation.length) return 0;
    return meta.latent.escalation[phase - 1]?.swapChance ?? 0;
}
