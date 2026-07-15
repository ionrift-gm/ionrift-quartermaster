/**
 * Shared helpers for Loot Cache Generator Progression Advisory strips
 * (party shelf, cursed pool, scroll plan). Keeps cap + visibility logic in one place.
 */

/**
 * Walk `ranked` in order and take up to `cap` entries that pass `isVisible`.
 * @template T
 * @param {T[]} ranked
 * @param {(row: T) => boolean} isVisible
 * @param {number} cap
 * @returns {T[]}
 */
export function takeVisibleCapped(ranked, isVisible, cap) {
    const n = Math.max(0, Math.floor(Number(cap)) || 0);
    if (!n || !ranked?.length) return [];
    const out = [];
    for (const row of ranked) {
        if (out.length >= n) break;
        if (isVisible(row)) out.push(row);
    }
    return out;
}
