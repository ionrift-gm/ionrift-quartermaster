import { QuartermasterItemAdapter } from "./QuartermasterItemAdapter.js";
import { QM_FEATURES } from "../constants/QMFeatures.js";
import {
    extractPf2ePriceGp,
    extractPf2eWeight,
    getPf2eCategory,
    getPf2eRarity,
    isPf2eExcludedFromPool,
    matchesPf2eSlotType,
    normalizePf2eRarityForTier
} from "./PF2ePoolRules.js";
import { PF2eScrollForge } from "./scroll/PF2eScrollForge.js";

const PF2E_SOURCE_CANDIDATES = [
    "pf2e.equipment-srd",
    "pf2e.consumables-srd",
    "pf2e.equipment",
    "pf2e.consumables",
];

const PF2E_SUPPORTED = new Set([
    QM_FEATURES.LOOT_CACHE,
    QM_FEATURES.SIGNATURE_LEDGER,
    QM_FEATURES.WORKSHOP,
]);

const PF2E_LIB_FEATURES = new Set([
    QM_FEATURES.SCROLL_FORGE,
]);

/**
 * Pass-through loot mode for Pathfinder 2e. Items drop as compendium-faithful
 * documents without QM latent-magic masking or loot-pool compilation.
 */
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
        return {
            name: entry.name,
            type: entry.type,
            img: entry.img,
            flags: entry.flags ?? {},
            price: this.extractPrice(entry),
            rarity: this.getRarityFromEntry(entry),
            weight: this.extractWeight(entry),
            _baseItem: entry.system?.baseItem ?? "",
            subtype: category,
            system: {
                rarity: entry.system?.traits?.rarity ?? entry.system?.rarity,
                category: entry.system?.category,
                bulk: entry.system?.bulk,
                traits: entry.system?.traits
            },
            sourceCompendium: packId,
            _compendiumId: entry._id
        };
    }

    shouldApplyLatentMasking() { return false; }

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
