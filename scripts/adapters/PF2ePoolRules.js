/**
 * PF2e compendium pool matching and exclusion rules for ItemPoolResolver.
 */

import { isPf2eCursedLootEntry } from "../services/curse/Pf2eCurseCatalog.js";

const PF2E_CONSUMABLE_CATEGORIES = new Set(["potion", "poison", "drug", "oil", "other", ""]);

/**
 * @param {object} entry
 * @returns {string}
 */
export function getPf2eCategory(entry) {
    return (entry.system?.category ?? "").toString().toLowerCase();
}

/**
 * @param {object} entry
 * @returns {string}
 */
export function getPf2eRarity(entry) {
    const raw = entry.system?.traits?.rarity ?? entry.system?.rarity ?? "common";
    return String(raw).toLowerCase().trim();
}

/**
 * Map PF2e rarity to the tier vocabulary used by ItemPoolResolver ceilings.
 * @param {string} rarity
 * @returns {string}
 */
export function normalizePf2eRarityForTier(rarity) {
    const r = (rarity ?? "").toLowerCase().trim();
    if (r === "unique") return "legendary";
    return r || "common";
}

/**
 * @param {object} entry
 * @returns {number}
 */
export function extractPf2ePriceGp(entry) {
    const lib = game.ionrift?.library?.system;
    if (lib?.getPrice) return lib.getPrice(entry);
    const price = entry.system?.price;
    if (!price?.value) return 0;
    const v = price.value;
    if (typeof v === "number") return v;
    return (v.gp ?? 0) + (v.sp ?? 0) / 10 + (v.cp ?? 0) / 100;
}

/**
 * Bulk to a numeric weight budget unit (approximate lbs for pick limits).
 * @param {object} entry
 * @returns {number}
 */
export function extractPf2eWeight(entry) {
    const lib = game.ionrift?.library?.system;
    if (lib?.getWeight) return lib.getWeight(entry);
    const bulk = entry.system?.bulk?.value ?? entry.system?.bulk;
    if (bulk === null || bulk === undefined) return 0;
    if (bulk === "L" || bulk === "-") return 0.1;
    const n = Number(bulk);
    return Number.isFinite(n) ? n * 5 : 0;
}

/**
 * @param {object} entry
 * @param {string} slotType
 * @returns {boolean}
 */
export function matchesPf2eSlotType(entry, slotType) {
    const type = entry.type;
    const category = getPf2eCategory(entry);
    const nameLc = (entry.name ?? "").toLowerCase();

    switch (slotType) {
        case "consumable": {
            if (type !== "consumable") return false;
            if (category === "scroll") return false;
            if (category === "ammo") return false;
            return PF2E_CONSUMABLE_CATEGORIES.has(category)
                || /potion|elixir|antidote|serum/i.test(nameLc);
        }
        case "ammo": {
            if (type === "ammo") return true;
            if (type !== "consumable") return false;
            return category === "ammo"
                || /^(arrows?|bolts?|bullets?)\b/i.test(nameLc);
        }
        case "scroll":
            return type === "consumable" && category === "scroll";
        case "mundane": {
            if (type === "treasure" || type === "kit") return true;
            if (type === "equipment" || type === "weapon" || type === "armor" || type === "shield") {
                const rarity = getPf2eRarity(entry);
                return !rarity || rarity === "common";
            }
            return false;
        }
        case "mastercraft":
            return type === "weapon" || type === "armor" || type === "shield";
        default:
            return false;
    }
}

/**
 * @param {object} entry
 * @returns {boolean}
 */
export function isPf2eExcludedFromPool(entry) {
    const type = entry.type;
    if (type === "feat" || type === "class" || type === "spell" || type === "action") return true;
    if (type === "background" || type === "ancestry" || type === "heritage") return true;
    if (!entry.name?.trim()) return true;

    if (isPf2eCursedLootEntry(entry)) return true;

    const level = entry.system?.level?.value;
    if (typeof level === "number" && level > 20) return true;

    return false;
}
