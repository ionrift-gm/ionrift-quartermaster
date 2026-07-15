import { MODULE_ID } from "../../data/moduleId.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { ItemPoolResolver } from "../loot/ItemPoolResolver.js";
import { ItemClassifier } from "../workshop/ItemClassifier.js";
import { AmmoTypeRegistry } from "../workshop/AmmoTypeRegistry.js";

export class CacheAmmoLogic {

    /**
     * Probability of a magical ammo pick per cache tier.
     * Scaled by the GM's `magicAmmoFrequency` setting.
     */
    static MAGIC_AMMO_CHANCE = { 1: 0.05, 2: 0.25, 3: 0.50, 4: 0.70 };

    /**
     * Within magical ammo, weight distribution across +1/+2/+3 per tier.
     * Higher weight = more likely to be drawn.
     */
    static MAGIC_AMMO_BONUS_WEIGHTS = {
        1: { 1: 1, 2: 0, 3: 0 },       // T1: +1 only
        2: { 1: 6, 2: 1, 3: 0 },       // T2: mostly +1, rare +2
        3: { 1: 3, 2: 3, 3: 1 },       // T3: +1/+2 common, occasional +3
        4: { 1: 2, 2: 3, 3: 2 }        // T4: balanced, solid +3
    };

    /**
     * Quantity dice [count, sides] for magical ammo, by [tier][bonus].
     */
    static MAGIC_AMMO_QTY_DICE = {
        1: { 1: [1, 4] },                                     // +1: 1d4
        2: { 1: [2, 6], 2: [1, 4], 3: [1, 4] },              // +1: 2d6, +2: 1d4, +3: 1d4
        3: { 1: [3, 6], 2: [2, 6], 3: [1, 4] },              // +1: 3d6, +2: 2d6, +3: 1d4
        4: { 1: [4, 6], 2: [4, 6], 3: [2, 6] }               // +1: 4d6, +2: 4d6, +3: 2d6
    };

    /**
     * Pick ammunition for a cache slot. Separates mundane from magical ammo
     * and applies a tier-respecting curve for +N magical ammunition.
     *
     * Named magical ammo (e.g. Walloping Ammunition) follows the same
     * Stance B throttle as named magical weapons.
     *
     * @param {string} theme
     * @param {Object} tierData
     * @param {Object} tables
     * @param {number} priceCeiling
     * @param {Object} pickOpts
     */
    static async _pickAmmo(theme, tierData, tables, priceCeiling = Infinity, pickOpts = {}) {
        const tier = tierData._tier ?? 1;
        const magicAmmoFreq = game.settings?.get(MODULE_ID, "magicAmmoFrequency") ?? 1.0;
        const ammoConfig = AmmoTypeRegistry.load();

        // Resolve the full ammo pool from enabled compendiums
        let pool = [];
        try {
            pool = await ItemPoolResolver.resolve({
                slotType: "ammo",
                tier,
                theme,
                fallbackTables: tables,
                rarityMax: tierData.rarityMax ?? "uncommon"
            });
        } catch (e) {
            Logger.warn(MODULE_LABEL, "ItemPoolResolver failed for ammo:", e.message);
        }

        if (!pool.length) return null;

        // Price ceiling
        const affordable = pool.filter(p => (p.price ?? 0) <= priceCeiling);
        const finalPool = affordable.length > 0 ? affordable : pool;

        // Split mundane vs magical
        const mundane = finalPool.filter(i => {
            const r = (i.rarity || "").toLowerCase();
            return !r || r === "common" || r === "none";
        });
        const magical = finalPool.filter(i => {
            const r = (i.rarity || "").toLowerCase();
            return r && r !== "common" && r !== "none";
        });

        // If the consumable ammo pool has no magical entries, try picking
        // magical ammo from the mastercraft (weapon) pool - dnd5e 5e24
        // compendiums type "Arrows +1" as weapon, not consumable/ammo.
        let magicalPool = magical;
        if (magical.length === 0) {
            try {
                const weaponPool = await ItemPoolResolver.resolve({
                    slotType: "mastercraft",
                    tier,
                    theme,
                    fallbackTables: tables,
                    rarityMax: tierData.rarityMax ?? "uncommon"
                });
                // Filter to weapon-type items that dnd5e compendiums sometimes
                // type as weapon instead of consumable/ammo (e.g. Arrows +1).
                // ItemClassifier name rules exclude the sling weapon ("Sling +1").
                magicalPool = weaponPool.filter(i => {
                    const rarity = (i.rarity || "").toLowerCase();
                    const isMagical = rarity && rarity !== "common" && rarity !== "none";
                    return isMagical && ItemClassifier.isAmmo(i);
                });
            } catch (e) {
                Logger.warn(MODULE_LABEL, "Magical ammo weapon pool fallback failed:", e.message);
            }
        }

        // Decide: mundane or magical?
        const baseChance = this.MAGIC_AMMO_CHANCE[tier] ?? 0.05;
        const scaledChance = Math.min(1.0, baseChance * magicAmmoFreq);

        let pick;
        let isMagicalPick = false;

        if (magicalPool.length > 0 && magicAmmoFreq > 0 && Math.random() < scaledChance) {
            // Magical ammo pick - tier-respecting +N distribution
            pick = this._pickMagicalAmmo(magicalPool, tier, pickOpts);
            isMagicalPick = !!pick;
        }

        // Fallback to mundane if magical pick failed or wasn't attempted
        if (!pick) {
            const mundanePool = mundane.length > 0 ? mundane : finalPool;
            pick = this._tiltedAmmoPick(mundanePool, ammoConfig);
        }

        if (!pick) return null;

        // Quantity: magical uses tier-respecting dice, mundane uses bulk stacking
        let qty;
        if (isMagicalPick) {
            qty = this._magicalAmmoQuantity(pick, tier);
        } else {
            // Mundane bulk: 10-50 units
            qty = 10 + Math.floor(Math.random() * 41);
        }

        const unitPrice = pick.price ?? 0;
        const unitWeight = pick.weight ?? 0.02;
        return {
            name: pick.name,
            type: "consumable",
            subtype: pick.subtype ?? "ammo",
            img: pick.img ?? "icons/weapons/ammunition/arrows-bundle-brown.webp",
            price: unitPrice,
            weight: unitWeight,
            rarity: pick.rarity ?? "common",
            quantity: qty,
            sourceCompendium: pick.sourceCompendium,
            _compendiumId: pick._compendiumId,
            _qmKind: "ammo"
        };
    }

    /**
     * Select a magical ammo item from the pool, respecting tier-appropriate
     * bonus weights. Named magical ammo follows Stance B throttle.
     *
     * @param {Object[]} magicalPool
     * @param {number} tier
     * @param {Object} pickOpts
     * @returns {Object|null}
     */
    static _pickMagicalAmmo(magicalPool, tier, pickOpts = {}) {
        const weights = this.MAGIC_AMMO_BONUS_WEIGHTS[tier] ?? this.MAGIC_AMMO_BONUS_WEIGHTS[1];

        // Classify magical ammo by bonus tier
        const byBonus = { 1: [], 2: [], 3: [], named: [] };
        for (const item of magicalPool) {
            if (ItemClassifier.isSlayingAmmo(item)) continue;
            const bonus = ItemClassifier.detectBonusTier(item.name);
            if (bonus >= 1 && bonus <= 3) {
                byBonus[bonus].push(item);
            } else {
                byBonus.named.push(item);
            }
        }

        const tierBag = [];
        for (const bonusStr of ["1", "2", "3"]) {
            const bonus = parseInt(bonusStr, 10);
            const w = weights[bonus] ?? 0;
            if (w === 0 || !byBonus[bonus].length) continue;
            const tickets = Math.max(1, Math.round(w));
            for (let i = 0; i < tickets; i++) tierBag.push(bonus);
        }

        if (tierBag.length) {
            const chosenBonus = tierBag[Math.floor(Math.random() * tierBag.length)];
            const picked = ItemPoolResolver._pickUniformByClass(byBonus[chosenBonus]);
            if (picked) return picked;
        }

        if (!pickOpts.rejectNamedMagical && byBonus.named.length > 0) {
            return ItemPoolResolver._pickUniformByClass(byBonus.named);
        }

        return null;
    }

    /**
     * Resolve quantity for a magical ammo pick using tier-respecting dice.
     *
     * @param {Object} pick
     * @param {number} tier
     * @returns {number}
     */
    static _magicalAmmoQuantity(pick, tier) {
        const bonus = ItemClassifier.detectBonusTier(pick.name);
        const table = this.MAGIC_AMMO_QTY_DICE[tier] ?? this.MAGIC_AMMO_QTY_DICE[1];
        const dice = table[bonus] ?? table[1] ?? [1, 4];

        // Roll NdS
        let total = 0;
        for (let i = 0; i < dice[0]; i++) {
            total += 1 + Math.floor(Math.random() * dice[1]);
        }
        return Math.max(1, total);
    }

    /**
     * Pick an ammo item from the pool, applying the GM's ammo type curve.
     *
     * Uses TYPE-FIRST selection: picks which ammo category to draw from
     * using configured weights, then selects one random item within that
     * category. This prevents pool-composition bias where one type dominates
     * simply by having more compendium entries.
     *
     * @param {Object[]} pool
     * @param {{ types: object[] }} ammoConfig
     * @returns {Object|null}
     */
    static _tiltedAmmoPick(pool, ammoConfig) {
        if (!pool.length) return null;

        const config = ammoConfig ?? AmmoTypeRegistry.load();
        const weightMap = AmmoTypeRegistry.getWeightMap(config);

        /** @type {Record<string, object[]>} */
        const byType = {};
        for (const typeEntry of config.types) byType[typeEntry.id] = [];

        for (const item of pool) {
            const typeId = AmmoTypeRegistry.detectType(item, config);
            (byType[typeId] ??= []).push(item);
        }

        const availableTypes = Object.entries(byType).filter(([, items]) => items.length > 0);
        if (!availableTypes.length) return null;

        const typeBag = [];
        for (const [typeName, items] of availableTypes) {
            const rawWeight = weightMap[typeName] ?? 1;
            if (rawWeight <= 0) continue;
            const w = Math.max(1, Math.round(rawWeight * 3));
            for (let i = 0; i < w; i++) typeBag.push(typeName);
        }

        if (!typeBag.length) {
            const [typeName, items] = availableTypes[Math.floor(Math.random() * availableTypes.length)];
            return items[Math.floor(Math.random() * items.length)];
        }

        const chosenType = typeBag[Math.floor(Math.random() * typeBag.length)];
        const chosenPool = byType[chosenType];
        return chosenPool[Math.floor(Math.random() * chosenPool.length)];
    }
}
