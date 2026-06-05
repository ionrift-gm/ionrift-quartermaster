/**
 * ItemClassifier
 *
 * Classifies pool items by narrative weight so that downstream pickers can
 * distinguish between mundane drops, generic +N enhancements, and named
 * magical items that should be tier-gated and throttled (Stance B policy).
 *
 * Categories:
 *   MUNDANE       - rarity common/none, no magical significance
 *   GENERIC_MAGIC - matches +N pattern ("+1 Longsword", "Arrows +2")
 *   NAMED_MAGIC   - uncommon+ rarity, does NOT match +N (Javelin of Lightning)
 *   CONSUMABLE    - potions, scrolls, food (not ammo)
 *   AMMO          - subtype ammo/ammunition or name-matched projectiles
 */

import { AmmoTypeRegistry } from "./AmmoTypeRegistry.js";

/** Pattern that reliably identifies generic bonus items: "+1", "+2", "+3". */
const GENERIC_BONUS_PATTERN = /\+\d\b/;

/** Name-based ammo detection for compendiums that use empty/wrong subtypes. */
const AMMO_NAME_PATTERN = /^(arrows?|bolts?|needles?|sling bullets?)\b/i;

export class ItemClassifier {

    static CATEGORY = Object.freeze({
        MUNDANE:       "mundane",
        GENERIC_MAGIC: "generic_magic",
        NAMED_MAGIC:   "named_magic",
        CONSUMABLE:    "consumable",
        AMMO:          "ammo"
    });

    /**
     * Classify an item by its narrative weight.
     *
     * @param {Object} item - Pool-resolved item or compendium index entry.
     *   Accepts both flat shapes ({ name, type, subtype, rarity }) and nested
     *   system shapes ({ name, type, system: { type: { value }, rarity } }).
     * @returns {string} One of {@link CATEGORY} values.
     */
    static classify(item) {
        const subtype = (item.subtype ?? item.system?.type?.value ?? "").toLowerCase();
        const name    = (item.name ?? "").trim();
        const nameLc  = name.toLowerCase();

        // ── Ammo (before consumable - ammo IS consumable in dnd5e) ────
        if (this._isAmmoSignal(subtype, nameLc)) {
            return this.CATEGORY.AMMO;
        }

        // ── Consumables (potions, scrolls, food - not ammo) ──────────
        const type = (item.type ?? "").toLowerCase();
        if (type === "consumable") {
            return this.CATEGORY.CONSUMABLE;
        }

        // ── Mundane vs magical ───────────────────────────────────────
        const rarity = (item.rarity ?? item.system?.rarity ?? "").toLowerCase();
        const isMagicalRarity = rarity && rarity !== "common" && rarity !== "none";

        if (!isMagicalRarity) {
            return this.CATEGORY.MUNDANE;
        }

        // Has magical rarity - generic +N or named?
        if (GENERIC_BONUS_PATTERN.test(nameLc)) {
            return this.CATEGORY.GENERIC_MAGIC;
        }

        return this.CATEGORY.NAMED_MAGIC;
    }

    // ── Convenience predicates ───────────────────────────────────────

    /** @returns {boolean} True if item is a named magical item (Stance B gated). */
    static isNamedMagical(item) {
        return this.classify(item) === this.CATEGORY.NAMED_MAGIC;
    }

    /** @returns {boolean} True if item is a generic +N enhancement. */
    static isGenericMagic(item) {
        return this.classify(item) === this.CATEGORY.GENERIC_MAGIC;
    }

    /**
     * Slaying ammunition (single-use narrative ammo).
     * Matches legacy rows and compiled "Arrow of Slaying (Dragons)" permutations.
     *
     * @param {Object} item
     * @returns {boolean}
     */
    static isSlayingAmmo(item) {
        const name = (item?.name ?? "").trim();
        if (!name) return false;
        if (/^ammunition of slaying(\s|$|\()/i.test(name)) return true;
        return /\bof slaying(\s|\(|$)/i.test(name);
    }

    /** @returns {boolean} True if item is ammunition (mundane or magical). */
    static isAmmo(item) {
        return this.classify(item) === this.CATEGORY.AMMO;
    }

    // ── Ammo helpers ─────────────────────────────────────────────────

    /**
     * Detect the +N bonus tier from an item name.
     * @param {string} name
     * @returns {number} 1, 2, 3, or 0 if no bonus found.
     */
    static detectBonusTier(name) {
        const match = (name ?? "").match(/\+(\d)\b/);
        return match ? parseInt(match[1], 10) : 0;
    }

    /**
     * Detect ammo type category from item name for type-tilting.
     * @param {Object} item
     * @returns {string}
     */
    static detectAmmoType(item) {
        if (game.settings?.get) {
            return AmmoTypeRegistry.detectType(item);
        }

        const name = (item?.name ?? "").toLowerCase();
        if (/\barrows?\b/.test(name)) return "arrows";
        if (/\bbolts?\b/.test(name) || /\bcrossbow\b/.test(name)) return "bolts";
        if (/\bneedles?\b/.test(name) || /\bblowgun\b/.test(name)) return "needles";
        if (/\bsling bullets?\b/.test(name) || /\bbullets?\b/.test(name)) return "sling";
        return "other";
    }

    // ── Internal ─────────────────────────────────────────────────────

    /**
     * @param {string} subtype - normalised item subtype
     * @param {string} nameLc  - lowercased item name
     * @returns {boolean}
     */
    static _isAmmoSignal(subtype, nameLc) {
        if (subtype === "ammo" || subtype === "ammunition") return true;
        return AMMO_NAME_PATTERN.test(nameLc);
    }
}
