import { QuartermasterItemAdapter } from "../../QuartermasterItemAdapter.js";
import { QM_FEATURES } from "../../../data/QMFeatures.js";
import {
    extractPf2ePriceGp,
    extractPf2eWeight,
    getPf2eCategory,
    getPf2eRarity,
    isPf2eExcludedFromPool,
    matchesPf2eSlotType,
    normalizePf2eRarityForTier
} from "./PF2ePoolRules.js";
import { PF2eScrollForge } from "./PF2eScrollForge.js";
import { detectPf2eMagical, applyPf2eMask } from "./Pf2eMaskingRules.js";

const PF2E_SOURCE_CANDIDATES = [
    "pf2e.equipment-srd",
    "pf2e.consumables-srd",
    "pf2e.equipment",
    "pf2e.consumables",
    "sf2e.equipment",
];

const PF2E_SUPPORTED = new Set([
    QM_FEATURES.LOOT_CACHE,
    QM_FEATURES.SIGNATURE_LEDGER,
    QM_FEATURES.WORKSHOP,
    QM_FEATURES.LATENT_MASKING,
]);

const PF2E_LIB_FEATURES = new Set([
    QM_FEATURES.SCROLL_FORGE,
    QM_FEATURES.SRD_CURSES,
]);

/** Pathfinder 2e: compendium-faithful loot; no QM latent masking or pool compile. */
export class PF2eItemAdapter extends QuartermasterItemAdapter {

    get id() { return "pf2e"; }

    supports(featureId) {
        if (PF2E_SUPPORTED.has(featureId)) return true;
        if (PF2E_LIB_FEATURES.has(featureId)) {
            return game.ionrift?.library?.system?.isSupported?.(featureId) ?? true;
        }
        return false;
    }

    getDefaultLootPoolSources() {
        return PF2E_SOURCE_CANDIDATES.filter(id => game.packs?.get(id));
    }

    getWorkshopItemTypes() {
        return ["weapon", "armor", "shield", "equipment", "consumable", "treasure", "kit"];
    }

    getCompendiumIndexFields() {
        return [
            "name", "type", "img", "flags",
            "system.price", "system.traits", "system.category",
            "system.bulk", "system.level", "system.description"
        ];
    }

    getRarityFromEntry(entry) {
        return getPf2eRarity(entry);
    }

    normalizeRarityForTier(rarity) {
        return normalizePf2eRarityForTier(rarity);
    }

    extractPrice(entry) {
        return extractPf2ePriceGp(entry);
    }

    extractWeight(entry) {
        return extractPf2eWeight(entry);
    }

    matchesSlotType(entry, slotType) {
        return matchesPf2eSlotType(entry, slotType);
    }

    isExcludedFromPool(entry) {
        return isPf2eExcludedFromPool(entry);
    }

    normalizePoolEntry(entry, packId) {
        const category = getPf2eCategory(entry);
        const level = Number(entry.system?.level?.value ?? entry.system?.level ?? entry.level ?? 0) || 0;
        return {
            name: entry.name,
            type: entry.type,
            img: entry.img,
            flags: entry.flags ?? {},
            price: this.extractPrice(entry),
            rarity: this.getRarityFromEntry(entry),
            weight: this.extractWeight(entry),
            level,
            _baseItem: entry.system?.baseItem ?? "",
            subtype: category,
            system: {
                level: { value: level },
                rarity: entry.system?.traits?.rarity ?? entry.system?.rarity,
                category: entry.system?.category,
                bulk: entry.system?.bulk,
                traits: entry.system?.traits
            },
            sourceCompendium: packId,
            _compendiumId: entry._id
        };
    }

    shouldApplyLatentMasking() { return true; }

    detectMagicalForCache(item, ctx = {}) {
        return detectPf2eMagical(item, ctx);
    }

    applyCacheMask(itemData, ctx) {
        applyPf2eMask(itemData, ctx);
    }

    getPowerScoreItemTypes() {
        return new Set(["weapon", "armor", "shield", "equipment"]);
    }

    getPowerScoreContribution(item, weights) {
        const lib = game.ionrift?.library?.system;
        if (lib?.getPowerScoreContribution) {
            return lib.getPowerScoreContribution(item, weights);
        }
        return super.getPowerScoreContribution(item, weights);
    }

    /**
     * PF2E-shaped payload for the "Add to Items" fallback (no Item Piles).
     * Emits PF2E's real Item schema so `Item.create` does not reject the
     * document: valid PF2E item type, `system.price.value.{gp}`, `system.bulk`,
     * `system.traits.rarity`.
     */
    buildCacheItemPayload(item, meta = {}) {
        const priceGp = Number(item.price ?? 0) || 0;
        const w = Number(item.weight);
        const bulk = Number.isFinite(w) && w > 0 ? Math.max(0.1, w / 5) : 0;
        return {
            name: item.name,
            type: item.type ?? "treasure",
            img: item.img,
            system: {
                quantity: item.quantity ?? 1,
                price: { value: { gp: priceGp } },
                bulk: { value: bulk },
                traits: { rarity: item.rarity ?? "common" },
                description: {
                    value: `<p>Generated from a ${meta.cacheLabel ?? "loot cache"}.</p>`
                }
            }
        };
    }

    /**
     * PF2E coin drop: single Coin Purse treasure item carrying the total
     * gold value. Individual denominations (pp/gp/sp/cp) roll up into gp
     * for the sidebar fallback; the GM redistributes when moving the
     * purse into a Loot actor or party stash.
     */
    buildCoinItems(result, _meta = {}) {
        const gold = Number(result?.gold) || 0;
        if (gold <= 0) return [];
        return [{
            name: "Coin Purse",
            type: "treasure",
            img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
            system: {
                quantity: 1,
                price: { value: { gp: gold } },
                bulk: { value: 0 },
                description: { value: `<p>${gold} gold pieces in a purse.</p>` }
            }
        }];
    }

    /**
     * PF2E has a native `loot` actor type with dedicated distribute-coins,
     * loot-selected-tokens, and party-stash workflows. When Item Piles is
     * not installed, deploying a cache as a Loot actor is the idiomatic
     * choice on PF2E worlds.
     */
    canCreateLootActor() { return true; }

    getLootActorType() { return "loot"; }

    buildLootActorPayload(result, meta = {}) {
        const label = meta.cacheLabel ?? "Loot Cache";
        const containerImg = result?.container?.img;
        return {
            name: `Cache: ${label}`,
            type: "loot",
            img: containerImg ?? "icons/containers/chest/chest-reinforced-steel.webp",
            system: {
                details: {
                    description: {
                        value: `<p>Generated by Quartermaster from a ${label}.</p>`
                    },
                    level: { value: Number(meta.tier) || 0 }
                },
                lootSheetType: "Loot",
                hiddenWhenEmpty: false
            }
        };
    }

    /**
     * Populate the loot actor's currency via PF2E's public inventory API.
     * `addCoins` creates the correct SRD-linked treasure items with
     * `category: "coin"`, which the sheet aggregates into the pp/gp/sp/cp row.
     */
    async depositLootActorCurrency(actor, result) {
        const coins = result?.coinage ?? (result?.gold > 0 ? { gp: Number(result.gold) || 0 } : null);
        if (!coins) return;

        const filtered = Object.fromEntries(
            Object.entries(coins).filter(([denom, amount]) => {
                if (!["pp", "gp", "sp", "cp"].includes(denom)) return false;
                return Number(amount) > 0;
            })
        );
        if (Object.keys(filtered).length === 0) return;

        if (typeof actor?.inventory?.addCoins === "function") {
            await actor.inventory.addCoins(filtered);
        } else {
            // Fallback if the PF2E API is unavailable for any reason
            await super.depositLootActorCurrency(actor, result);
        }
    }

    resolvePileItemData(data) {
        if (Array.isArray(data.effects) && data.effects.length > 0) {
            data.effects = [];
        }
        return data;
    }

    buildFallbackPileItem(metaObj) {
        const w = Number(metaObj.weight);
        return {
            name: metaObj.name,
            type: metaObj.type ?? "treasure",
            img: metaObj.img,
            system: {
                price: { value: metaObj.price ?? 0, denomination: "gp" },
                bulk: { value: Number.isFinite(w) ? Math.max(0.1, w / 5) : 0.1 }
            }
        };
    }

    normalizeItemData(itemData) {
        const data = foundry.utils.deepClone(itemData);
        data.system = data.system || {};
        if (!data.system.description) {
            data.system.description = { value: `A generic ${data.type}.` };
        }
        return data;
    }

    getScrollForgeRules() { return PF2eScrollForge; }
}
