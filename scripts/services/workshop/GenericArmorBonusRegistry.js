import { MODULE_ID } from "../../data/moduleId.js";
/**
 * Tier caps and pick weights for generic +N body armor and shields in mastercraft caches.
 * Independent of magic frequency and weapon +N curves.
 */


/** @type {{ cap: number, maxByTier: Record<number, number>, pickWeightsByTier: Record<number, Record<number, number>> }} */
export const DEFAULT_GENERIC_ARMOR_BONUS = {
    cap: 2,
    maxByTier: { 1: 0, 2: 1, 3: 1, 4: 2 },
    pickWeightsByTier: {
        1: { 1: 0, 2: 0, 3: 0 },
        2: { 1: 4, 2: 0, 3: 0 },
        3: { 1: 8, 2: 0, 3: 0 },
        4: { 1: 3, 2: 9, 3: 0 }
    }
};

/** @type {Record<string, typeof DEFAULT_GENERIC_ARMOR_BONUS>} */
export const GENERIC_ARMOR_BONUS_PRESETS = {
    standard: DEFAULT_GENERIC_ARMOR_BONUS,
    noPlusArmor: {
        cap: 0,
        maxByTier: { 1: 0, 2: 0, 3: 0, 4: 0 },
        pickWeightsByTier: {
            1: { 1: 0, 2: 0, 3: 0 },
            2: { 1: 0, 2: 0, 3: 0 },
            3: { 1: 0, 2: 0, 3: 0 },
            4: { 1: 0, 2: 0, 3: 0 }
        }
    },
    plus1Only: {
        cap: 1,
        maxByTier: { 1: 0, 2: 1, 3: 1, 4: 1 },
        pickWeightsByTier: {
            1: { 1: 0, 2: 0, 3: 0 },
            2: { 1: 4, 2: 0, 3: 0 },
            3: { 1: 8, 2: 0, 3: 0 },
            4: { 1: 6, 2: 0, 3: 0 }
        }
    }
};

export class GenericArmorBonusRegistry {

    /** @returns {typeof DEFAULT_GENERIC_ARMOR_BONUS} */
    static getDefaultConfig() {
        return foundry.utils.deepClone(DEFAULT_GENERIC_ARMOR_BONUS);
    }

    /**
     * @param {string|object|null|undefined} raw
     * @returns {typeof DEFAULT_GENERIC_ARMOR_BONUS}
     */
    static parse(raw) {
        if (!raw) return this.getDefaultConfig();
        try {
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            return this.normalize(parsed);
        } catch {
            return this.getDefaultConfig();
        }
    }

    /**
     * @param {object} config
     * @returns {typeof DEFAULT_GENERIC_ARMOR_BONUS}
     */
    static normalize(config) {
        const cap = this._clampBonus(config?.cap ?? DEFAULT_GENERIC_ARMOR_BONUS.cap);
        const maxByTier = {};
        const pickWeightsByTier = {};

        for (const tier of [1, 2, 3, 4]) {
            const rawMax = config?.maxByTier?.[tier] ?? config?.maxByTier?.[String(tier)]
                ?? DEFAULT_GENERIC_ARMOR_BONUS.maxByTier[tier] ?? 0;
            maxByTier[tier] = Math.min(this._clampBonus(rawMax), cap);

            const rawWeights = config?.pickWeightsByTier?.[tier]
                ?? config?.pickWeightsByTier?.[String(tier)]
                ?? DEFAULT_GENERIC_ARMOR_BONUS.pickWeightsByTier[tier]
                ?? { 1: 0, 2: 0, 3: 0 };
            pickWeightsByTier[tier] = {
                1: maxByTier[tier] >= 1 ? Math.max(0, Number(rawWeights[1] ?? rawWeights["1"] ?? 0) || 0) : 0,
                2: maxByTier[tier] >= 2 ? Math.max(0, Number(rawWeights[2] ?? rawWeights["2"] ?? 0) || 0) : 0,
                3: maxByTier[tier] >= 3 ? Math.max(0, Number(rawWeights[3] ?? rawWeights["3"] ?? 0) || 0) : 0
            };
        }

        return { cap, maxByTier, pickWeightsByTier };
    }

    /** @returns {typeof DEFAULT_GENERIC_ARMOR_BONUS} */
    static load() {
        try {
            const raw = game.settings.get(MODULE_ID, "genericArmorBonusConfig");
            return this.parse(raw);
        } catch {
            return this.getDefaultConfig();
        }
    }

    /**
     * @param {object} config
     * @returns {Promise<void>}
     */
    static async save(config) {
        const normalized = this.normalize(config);
        await game.settings.set(MODULE_ID, "genericArmorBonusConfig", JSON.stringify(normalized));
        const { ItemPoolResolver } = await import("../loot/ItemPoolResolver.js");
        ItemPoolResolver.clearCache();
    }

    /**
     * @param {string} presetId
     * @returns {typeof DEFAULT_GENERIC_ARMOR_BONUS}
     */
    static applyPreset(presetId) {
        const preset = GENERIC_ARMOR_BONUS_PRESETS[presetId] ?? DEFAULT_GENERIC_ARMOR_BONUS;
        return this.normalize(preset);
    }

    /**
     * Hard ceiling for generic +N armor and shields (global cap).
     * @returns {number}
     */
    static getCap() {
        return this.load().cap;
    }

    /**
     * Maximum generic +N bonus allowed for armor and shields at a party tier.
     * @param {number} tier
     * @returns {number}
     */
    static getMaxBonus(tier) {
        const config = this.load();
        const tierMax = config.maxByTier[tier] ?? config.maxByTier[String(tier)] ?? 0;
        return Math.min(this._clampBonus(tierMax), config.cap);
    }

    /**
     * Pick weights for generic +N armor and shields (mastercraft bonus bag).
     * @param {number} tier
     * @returns {Record<number, number>}
     */
    static getPickWeights(tier) {
        const config = this.load();
        const max = this.getMaxBonus(tier);
        const base = config.pickWeightsByTier[tier]
            ?? config.pickWeightsByTier[String(tier)]
            ?? { 1: 0, 2: 0, 3: 0 };
        return {
            1: max >= 1 ? (base[1] ?? 0) : 0,
            2: max >= 2 ? (base[2] ?? 0) : 0,
            3: max >= 3 ? (base[3] ?? 0) : 0
        };
    }

    /**
     * @param {number} bonus
     * @param {number} tier
     * @returns {boolean}
     */
    static allowsBonus(bonus, tier) {
        const b = Number(bonus) || 0;
        if (b <= 0) return false;
        return b <= this.getMaxBonus(tier);
    }

    /** @returns {string} */
    static getSummaryLabel() {
        const config = this.load();
        const parts = [`cap +${config.cap}`];
        for (const tier of [1, 2, 3, 4]) {
            const max = config.maxByTier[tier] ?? 0;
            parts.push(`T${tier} +${max}`);
        }
        return parts.join(" · ");
    }

    /** @param {number} value @returns {number} */
    static _clampBonus(value) {
        const n = Math.round(Number(value) || 0);
        return Math.max(0, Math.min(3, n));
    }
}
