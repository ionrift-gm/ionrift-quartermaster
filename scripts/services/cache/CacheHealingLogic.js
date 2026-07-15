import { MODULE_ID } from "../../data/moduleId.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { ItemPoolResolver } from "../loot/ItemPoolResolver.js";
import { PotionEnrichment } from "../scroll/PotionEnrichment.js";

export class CacheHealingLogic {

    /**
     * Boost consumable slot weight in the owner theme pool as healing frequency rises.
     *
     * @param {Record<string, number>} basePool
     * @param {number} healFreq
     * @returns {Record<string, number>}
     */
    static _scaleOwnerSlotPool(basePool, healFreq) {
        const pool = { ...basePool };
        const f = Math.max(0, Number(healFreq) || 0);
        if (f > 0 && pool.consumable) {
            pool.consumable = pool.consumable * (1 + 0.15 * f);
        }
        return pool;
    }

    /**
     * Extra healing potion lines added after the main slot loop.
     *
     * @param {number} freq
     * @returns {number}
     */
    static _healingBonusRollCount(freq) {
        const f = Math.max(0, Number(freq) || 0);
        if (f <= 0) return 0;
        if (f <= 1) return Math.random() < f * 0.5 ? 1 : 0;
        const target = f * 0.75;
        return Math.min(4, Math.floor(target) + (Math.random() < (target % 1) ? 1 : 0));
    }

    /**
     * @param {string} theme
     * @param {Object} tierData
     * @param {Object} tables
     * @param {number} [priceCeiling]
     * @returns {Promise<Object[]>}
     */
    static async _resolveHealingPotionPool(theme, tierData, tables, priceCeiling = Infinity) {
        let pool = [];
        try {
            pool = await ItemPoolResolver.resolve({
                slotType: "consumable",
                tier: tierData._tier ?? 1,
                theme,
                fallbackTables: tables
            });
        } catch (e) {
            Logger.warn(MODULE_LABEL, "ItemPoolResolver failed for healing pool:", e.message);
        }
        if (!pool.length) return [];

        const affordable = pool.filter(p => (p.price ?? 0) <= priceCeiling);
        const finalPool = affordable.length > 0 ? affordable : pool;
        return finalPool.filter(p => PotionEnrichment.isHealingPotion(p.name));
    }

    /**
     * Pick one healing potion row, tier-weighted.
     *
     * @param {string} theme
     * @param {Object} tierData
     * @param {Object} tables
     * @param {number} [priceCeiling]
     * @param {number} [healFreq]
     * @param {Object[]|null} [prefetchedPool]
     * @returns {Promise<Object|null>}
     */
    static async _pickHealingPotionOnly(
        theme, tierData, tables, priceCeiling = Infinity, healFreq, prefetchedPool = null
    ) {
        const healing = prefetchedPool
            ?? await CacheHealingLogic._resolveHealingPotionPool(theme, tierData, tables, priceCeiling);
        if (!healing.length) return null;

        const cacheTier = tierData._tier ?? 1;
        const freq = healFreq ?? game.settings?.get(MODULE_ID, "healingPotionFrequency") ?? 1.0;
        const SA = game.ionrift?.library?.system;
        const situational = SA?.getSituationalConsumables?.() ?? new Set();

        const pick = CacheHealingLogic._weightedHealingPick(healing, cacheTier, freq, situational);
        if (!pick) return null;

        return {
            name: pick.name,
            type: "consumable",
            subtype: pick.subtype ?? "potion",
            img: pick.img ?? "icons/consumables/potions/potion-bottle-corked-red.webp",
            price: pick.price ?? 0,
            weight: pick.weight || 0.1,
            rarity: pick.rarity ?? "common",
            quantity: 1,
            sourceCompendium: pick.sourceCompendium,
            _compendiumId: pick._compendiumId
        };
    }

    /**
     * @param {Object[]} healingRows
     * @param {number} cacheTier
     * @param {number} healFreq
     * @param {Set<string>} situational
     * @returns {Object|null}
     */
    static _weightedHealingPick(healingRows, cacheTier, healFreq, situational = new Set()) {
        if (!healingRows.length) return null;
        const tickets = [];
        for (const item of healingRows) {
            let count = situational.has((item.name ?? "").toLowerCase()) ? 1 : 3;
            const tierWeight = CacheHealingLogic._healingPotionTierWeight(
                item.name, cacheTier, healFreq
            );
            count = Math.max(1, Math.round(count * tierWeight));
            for (let i = 0; i < count; i++) tickets.push(item);
        }
        return tickets[Math.floor(Math.random() * tickets.length)];
    }

    /**
     * Chance a consumable slot resolves to a healing potion when any are in the pool.
     *
     * @param {number} freq
     * @returns {number} 0-1
     */
    static _healingPotionDirectShare(freq) {
        const f = Math.max(0, Number(freq) || 0);
        if (f <= 0) return 0;
        if (f >= 3) return 1;
        return Math.min(1, 0.25 + 0.25 * f);
    }

    /**
     * Share of potion-like picks that go to the healing branch (vs oils,
     * antitoxin, and other elixirs). Scaled by `healingPotionFrequency`.
     *
     * @param {number} freq
     * @returns {number} 0-0.95
     */
    static _healingPotionShare(freq) {
        const f = Math.max(0, Number(freq) || 0);
        if (f <= 0) return 0.25;
        return Math.min(0.98, 0.50 + 0.12 * f);
    }

    /**
     * Ticket multiplier for which healing tier wins inside the healing branch.
     * Higher cache tiers favour stronger healing tiers.
     *
     * @param {string} name
     * @param {number} cacheTier
     * @param {number} [freq]
     * @returns {number}
     */
    static _healingPotionTierWeight(name, cacheTier, freq) {
        const tierData = PotionEnrichment.getTierData(name);
        if (!tierData) return 1;

        const f = Math.max(0, freq ?? game.settings?.get(MODULE_ID, "healingPotionFrequency") ?? 1.0);
        if (f <= 0) return 1;

        const price = tierData.price ?? 50;
        const weightsByCacheTier = {
            1: { 50: 8, 100: 3, 250: 1, 500: 0.5 },
            2: { 50: 3, 100: 6, 250: 3, 500: 1.5 },
            3: { 50: 1.5, 100: 3, 250: 6, 500: 4 },
            4: { 50: 1, 100: 2, 250: 5, 500: 8 }
        };
        const table = weightsByCacheTier[cacheTier] ?? weightsByCacheTier[1];
        const tierWeight = table[price] ?? 1;

        if (f <= 1) return 1 + (tierWeight - 1) * f;
        return tierWeight * f;
    }
}
