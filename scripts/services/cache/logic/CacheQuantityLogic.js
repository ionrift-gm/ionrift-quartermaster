import { isQmPackRole } from "./CachePackIndex.js";

export class CacheQuantityLogic {

    /** Small random stack for curated finds (treasure, tools, loose gems). */
    static MODEST_STACK_MAX = 5;

    /** Minimum unit weight (lb) treated as a single live animal, never stacked. */
    static LIVESTOCK_WEIGHT_FLOOR = 100;

    /**
     * Rations and water: modest stacks (not ammo-scale bulk).
     *
     * @param {object} item
     * @returns {boolean}
     */
    static _isRationOrWaterItem(item) {
        const type = item.type ?? "";
        if (type !== "consumable") return false;

        const subtype = (item.subtype ?? "").toLowerCase();
        const name = (item.name ?? "").toLowerCase().trim();
        if (subtype === "potion" || subtype === "poison" || subtype === "scroll") return false;

        if (/\brations?\b/.test(name)) return true;
        if (/\b(waters?|waterskin)\b/.test(name)) return true;
        if (subtype === "drink" && /\bwater\b/.test(name)) return true;
        return false;
    }

    /**
     * Cheap bulk goods (feed, ammo) that should appear as large stacks.
     * Rations and water use {@link _resolveRationWaterQuantity} instead.
     *
     * @param {object} item
     * @returns {boolean}
     */
    static _isBulkFillerItem(item) {
        if (this._isRationOrWaterItem(item)) return false;

        const type = item.type ?? "";
        const subtype = (item.subtype ?? "").toLowerCase();
        const name = (item.name ?? "").toLowerCase().trim();
        const unitPrice = item.price ?? 0;

        if (type !== "consumable") return false;
        if (subtype === "potion" || subtype === "poison" || subtype === "scroll") return false;

        if (subtype === "ammo" || subtype === "ammunition") return unitPrice < 1;
        if (/^(feed|arrows?|bolts?|needles?|sling bullets?)\b/.test(name)) return unitPrice < 1;
        if (subtype === "food" || subtype === "drink") return unitPrice < 1;
        return unitPrice > 0 && unitPrice < 0.1;
    }

    /**
     * Recognises thrown weapons that should arrive as a stack rather than
     * a single item. Detection is name-pattern first so it works against
     * plain SRD index entries that may not expose system.properties.
     *
     * Covered items and their typical 5e unit prices:
     *   dart      0.05 gp  (already stacks via price logic, but qty is too low)
     *   javelin   0.5  gp  (would stack, but slow; we want explicit control)
     *   handaxe   5    gp  (price gate blocks stacking entirely -- needs override)
     *
     * @param {object} item
     * @returns {boolean}
     */
    static _isThrownWeapon(item) {
        if (item.type !== "weapon") return false;

        const name = (item.name ?? "").toLowerCase().trim();

        // Name-pattern match covers all SRD items regardless of system data depth
        if (/\bdarts?\b/.test(name))     return true;
        if (/\bjavelins?\b/.test(name))  return true;
        if (/\bhand.?axe/.test(name))    return true;

        // System-properties fallback for custom items that carry the thrown flag
        const props = item.system?.properties;
        if (!props) return false;
        // dnd5e stores properties as a Set, object, or array depending on version
        if (props instanceof Set)   return props.has("thr") || props.has("thrown");
        if (Array.isArray(props))   return props.includes("thr") || props.includes("thrown");
        if (typeof props === "object") return !!(props.thr || props.thrown);
        return false;
    }

    /**
     * Dice-based quantity for thrown weapons.
     *
     * Quantities are shaped around realistic battlefield loadouts:
     *   darts    4d4  -> avg 10, range 4-16  (light, cheap, pocketable by the handful)
     *   javelins 2d4  -> avg  5, range 2-8   (5e standard soldier kit)
     *   handaxes 1d3  -> avg  2, range 1-3   (valuable enough to carry 1-3)
     *   generic  1d4  -> avg  2, range 1-4   (safe default for unknown thrown)
     *
     * Result is always capped by the container's remaining weight budget.
     *
     * @param {object} item
     * @param {Object} [opts]
     * @param {number|null} [opts.remainingWeight]
     * @returns {number}
     */
    static _resolveThrownWeaponQuantity(item, opts = {}) {
        const name = (item.name ?? "").toLowerCase();

        let qty;
        if (/\bdarts?\b/.test(name)) {
            // 4d4: 4 dice of d4
            qty = [1,2,3,4].reduce((s) => s + 1 + Math.floor(Math.random() * 4), 0);
        } else if (/\bjavelins?\b/.test(name)) {
            // 2d4
            qty = [1,2].reduce((s) => s + 1 + Math.floor(Math.random() * 4), 0);
        } else if (/\bhand.?axe/.test(name)) {
            // 1d3
            qty = 1 + Math.floor(Math.random() * 3);
        } else {
            // generic thrown: 1d4
            qty = 1 + Math.floor(Math.random() * 4);
        }

        // Weight-budget cap: never let the stack claim more than half remaining capacity
        const unitWeight = Number(item.weight) || 0;
        if (unitWeight > 0 && typeof opts.remainingWeight === "number" && opts.remainingWeight > 0) {
            const weightCap = Math.max(1, Math.floor((opts.remainingWeight * 0.5) / unitWeight));
            qty = Math.min(qty, weightCap);
        }

        return Math.max(1, qty);
    }

    /**
     * @param {object} item
     * @param {Object} [opts]
     * @param {number|null} [opts.remainingWeight]
     * @returns {number}
     */
    static _resolveRationWaterQuantity(item, opts = {}) {
        const maxQty = 10;
        let qty = 2 + Math.floor(Math.random() * (maxQty - 1));

        const unitWeight = Number(item.weight) || 0;
        if (unitWeight > 0 && typeof opts.remainingWeight === "number" && opts.remainingWeight > 0) {
            const weightCappedQty = Math.max(1, Math.floor(opts.remainingWeight / unitWeight));
            qty = Math.min(qty, weightCappedQty, maxQty);
        }

        return Math.max(1, qty);
    }

    /**
     * Small random stack for curated finds (treasure, tools, loose gems).
     * Never huge; usually 1, sometimes up to {@link MODEST_STACK_MAX}.
     *
     * @param {Object} [opts]
     * @param {Object} [opts.item]
     * @param {number} [opts.min]
     * @param {number} [opts.max]
     * @param {number|null} [opts.remainingWeight]
     * @returns {number}
     */
    static _resolveModestStackQuantity(opts = {}) {
        const min = opts.min ?? 1;
        const max = opts.max ?? this.MODEST_STACK_MAX;
        let qty = min + Math.floor(Math.random() * (max - min + 1));

        const unitWeight = Number(opts.item?.weight) || 0;
        if (unitWeight > 0 && typeof opts.remainingWeight === "number" && opts.remainingWeight > 0) {
            const weightCap = Math.max(1, Math.floor((opts.remainingWeight * 0.5) / unitWeight));
            qty = Math.min(qty, weightCap);
        }

        return Math.max(min, qty);
    }

    static _resolveKindlingQuantity() {
        let total = 0;
        for (let i = 0; i < 3; i++) {
            total += 1 + Math.floor(Math.random() * 4);
        }
        return total;
    }

    /**
     * @param {object} item
     * @returns {boolean}
     */
    static _isKindlingItem(item) {
        if ((item.name ?? "").trim().toLowerCase() !== "kindling") return false;
        const type = (item.type ?? "").toLowerCase();
        return type === "loot" || type === "consumable";
    }

    /**
     * True when item came from the SRD trade goods compendium.
     * @param {string|null|undefined} compendiumId
     * @returns {boolean}
     */
    static _isTradeGoodsSource(compendiumId) {
        if (!compendiumId) return false;
        return compendiumId.endsWith(".tradegoods");
    }

    /**
     * Livestock and draft animals ship as one head per line.
     * @param {object} item
     * @returns {boolean}
     */
    static _isLivestockUnit(item) {
        return (Number(item.weight) || 0) >= this.LIVESTOCK_WEIGHT_FLOOR;
    }

    /**
     * Bulk commodity loot: SRD trade goods (flour, spices, ingots) and
     * other cheap measured loot. Excludes tools, livestock, and QM treasure.
     *
     * @param {object} item
     * @returns {boolean}
     */
    static _isBulkCommodityLoot(item) {
        if ((item.type ?? "").toLowerCase() !== "loot") return false;
        if (this._isLivestockUnit(item)) return false;

        if (this._isTradeGoodsSource(item.sourceCompendium)) return true;

        const unitPrice = item.price ?? 0;
        const unitWeight = Number(item.weight) || 0;
        return unitPrice > 0 && unitPrice < 1 && unitWeight > 0 && unitWeight <= 25;
    }

    /**
     * Target-value quantity bands for consumables and bulk commodity loot.
     *
     * @param {object} item
     * @param {Object} [opts]
     * @param {number|null} [opts.remainingWeight]
     * @returns {number}
     */
    static _resolvePriceBandQuantity(item, opts = {}) {
        const unitPrice = item.price ?? 0;
        if (unitPrice <= 0) return 1;

        let targetMin, targetMax, qtyMax;
        if (unitPrice < 0.05) {
            targetMin = 0.5;  targetMax = 2;   qtyMax = 50;
        } else if (unitPrice < 0.5) {
            targetMin = 0.5;  targetMax = 3;   qtyMax = 20;
        } else if (unitPrice < 2) {
            targetMin = 1;    targetMax = 4;   qtyMax = 10;
        } else if (unitPrice < 5) {
            targetMin = 2;    targetMax = 6;   qtyMax = 4;
        } else {
            return 1;
        }

        const targetValue = targetMin + Math.random() * (targetMax - targetMin);
        let qty = Math.max(1, Math.min(qtyMax, Math.round(targetValue / unitPrice)));

        const unitWeight = Number(item.weight) || 0;
        if (unitWeight > 0) {
            const remaining = opts.remainingWeight;
            const stackWeightCap = (typeof remaining === "number" && remaining > 0)
                ? Math.max(5, remaining * 0.5)
                : 15;
            const weightCappedQty = Math.max(1, Math.floor(stackWeightCap / unitWeight));
            qty = Math.min(qty, weightCappedQty);
        }

        return qty;
    }

    /**
     * Quantity resolver for cache line items.
     *
     * Kindling always stacks 3d4. Cheap consumables and SRD trade goods stack via
     * {@link _resolvePriceBandQuantity}. Trinkets stay singular; treasure, tools,
     * and gems use modest stacks (1-5).
     *
     * @param {Object} item
     * @param {Object} [opts]
     * @param {number|null} [opts.remainingWeight] Remaining bag capacity in lb.
     * @returns {number}
     */
    static _resolveQuantity(item, opts = {}) {
        // Never stack signatures or trinkets
        if (item.isSignature || item.spellName) return 1;
        if (item._qmKind === "trinkets") return 1;
        if (isQmPackRole(item.sourceCompendium, "trinkets")) return 1;

        if (this._isRationOrWaterItem(item)) {
            return this._resolveRationWaterQuantity(item, opts);
        }

        // Thrown weapons: dice-based quantity reflecting battlefield loadouts
        // (darts 4d4, javelins 2d4, handaxes 1d3). Checked before the price
        // gate so e.g. handaxes at 5 gp aren't silently capped to qty 1.
        if (this._isThrownWeapon(item)) {
            return this._resolveThrownWeaponQuantity(item, opts);
        }

        // Bulk ammo/feed: large stacks; ignore compendium rarity typos and weight caps.
        if (this._isBulkFillerItem(item)) {
            return 10 + Math.floor(Math.random() * 41);
        }

        if (this._isKindlingItem(item)) {
            return this._resolveKindlingQuantity();
        }

        const rarity = (item.rarity ?? "common").toLowerCase();
        if (rarity !== "common" && rarity !== "none" && rarity !== "") return 1;

        const modestOpts = { item, remainingWeight: opts.remainingWeight };

        if (item._qmKind === "treasure" || isQmPackRole(item.sourceCompendium, "treasure")) {
            return this._resolveModestStackQuantity(modestOpts);
        }
        if (item._qmKind === "gemstones" || isQmPackRole(item.sourceCompendium, "gemstones")) {
            return this._resolveModestStackQuantity(modestOpts);
        }

        const itemType = (item.type ?? "").toLowerCase();
        if (itemType === "tool") {
            return this._resolveModestStackQuantity(modestOpts);
        }
        if (this._isBulkCommodityLoot(item)) {
            return this._resolvePriceBandQuantity(item, opts);
        }
        if (itemType !== "consumable") return 1;

        return this._resolvePriceBandQuantity(item, opts);
    }
}
