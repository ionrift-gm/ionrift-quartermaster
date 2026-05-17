/**
 * D&D 5e variant encumbrance calculator.
 *
 * Uses the "Variant: Encumbrance" rule from the PHB:
 *   Encumbered:          STR * 5
 *   Heavily Encumbered:  STR * 10
 *   Max Carrying:        STR * 15
 */

/**
 * Compute the three variant encumbrance thresholds for a given STR score.
 * @param {number} str
 * @returns {{ encumbered: number, heavily: number, max: number }}
 */
export function thresholds(str) {
    return {
        encumbered: str * 5,
        heavily: str * 10,
        max: str * 15
    };
}

/**
 * Classify current encumbrance status.
 * @param {number} str - effective STR score
 * @param {number} totalWeight - total carried weight in lb
 * @returns {"normal" | "encumbered" | "heavily" | "immobile"}
 */
export function encumbranceStatus(str, totalWeight) {
    const t = thresholds(str);
    if (totalWeight > t.max) return "immobile";
    if (totalWeight > t.heavily) return "heavily";
    if (totalWeight > t.encumbered) return "encumbered";
    return "normal";
}

/**
 * Compute net carry capacity delta as a fraction.
 * Positive means the character still has headroom; negative means over-limit.
 *
 * @param {number} str - effective STR score
 * @param {number} totalWeight - total carried weight
 * @returns {{ headroomLb: number, headroomPct: number, usedPct: number }}
 */
export function carryDelta(str, totalWeight) {
    const max = str * 15;
    const headroomLb = max - totalWeight;
    const headroomPct = max > 0 ? headroomLb / max : 0;
    const usedPct = max > 0 ? totalWeight / max : 1;
    return { headroomLb, headroomPct, usedPct };
}
