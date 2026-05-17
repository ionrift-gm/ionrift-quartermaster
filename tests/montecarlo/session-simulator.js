/**
 * Deterministic session event generator for Monte Carlo balance testing.
 *
 * Produces fixed sequences of session events (combats, rests) that drive
 * the exposure accumulator. Three session profiles match the estimates
 * in CURSED_ITEM_DESIGN_GUIDE.md.
 *
 * For the Verdant Fang, combats are tagged with a loyalty outcome
 * (loyal / mixed / betrayed) based on a configurable split.
 */

const SESSION_PROFILES = {
    dungeon: {
        label: "Dungeon Crawl",
        events: ["combat", "combat", "combat"]
    },
    standard: {
        label: "Standard Session",
        events: ["combat", "combat", "shortRest"]
    },
    fullDay: {
        label: "Full Adventuring Day",
        events: ["combat", "combat", "combat", "shortRest", "shortRest", "longRest"]
    }
};

const DEFAULT_LOYALTY_SPLIT = { loyal: 0.3, mixed: 0.5, betrayed: 0.2 };

/**
 * Generate N sessions of a given profile type.
 * Returns a flat array of event strings per session.
 *
 * @param {string} profileId - "dungeon" | "standard" | "fullDay"
 * @param {number} count - number of sessions to generate
 * @returns {{ label: string, sessions: string[][] }}
 */
export function generateSessions(profileId, count = 25) {
    const profile = SESSION_PROFILES[profileId];
    if (!profile) throw new Error(`Unknown session profile: ${profileId}`);

    const sessions = [];
    for (let i = 0; i < count; i++) {
        sessions.push([...profile.events]);
    }

    return { label: profile.label, sessions };
}

/**
 * Tag combat events with loyalty outcomes for the Verdant Fang.
 * Distributes loyalty deterministically across all combats in sequence
 * according to the split ratios.
 *
 * @param {string[][]} sessions - array of session event arrays
 * @param {{ loyal: number, mixed: number, betrayed: number }} split
 * @returns {string[][]} sessions with combat events replaced by loyalty-tagged variants
 */
export function tagCombatLoyalty(sessions, split = DEFAULT_LOYALTY_SPLIT) {
    const allCombats = [];
    const positions = [];

    for (let s = 0; s < sessions.length; s++) {
        for (let e = 0; e < sessions[s].length; e++) {
            if (sessions[s][e] === "combat") {
                allCombats.push({ s, e });
            }
        }
    }

    const total = allCombats.length;
    const loyalCount = Math.round(total * split.loyal);
    const mixedCount = Math.round(total * split.mixed);

    const tagged = sessions.map(s => [...s]);

    for (let i = 0; i < allCombats.length; i++) {
        const { s, e } = allCombats[i];
        if (i < loyalCount) {
            tagged[s][e] = "combatLoyal";
        } else if (i < loyalCount + mixedCount) {
            tagged[s][e] = "combatMixed";
        } else {
            tagged[s][e] = "combatBetrayed";
        }
    }

    return tagged;
}

/**
 * Calculate expected exposure per session for a given profile and weights.
 * @param {string} profileId
 * @param {object} weights - exposure weights from blueprint
 * @returns {number}
 */
export function expectedExposurePerSession(profileId, weights) {
    const profile = SESSION_PROFILES[profileId];
    if (!profile) return 0;
    return profile.events.reduce((sum, evt) => sum + (weights[evt] ?? 0), 0);
}

export { SESSION_PROFILES, DEFAULT_LOYALTY_SPLIT };
