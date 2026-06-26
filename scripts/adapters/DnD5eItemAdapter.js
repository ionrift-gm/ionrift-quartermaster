import { QuartermasterItemAdapter } from "./QuartermasterItemAdapter.js";
import { QM_FEATURES } from "../constants/QMFeatures.js";
import { ItemMaskingHelper } from "../services/ItemMaskingHelper.js";
import { PotionEnrichment } from "../services/PotionEnrichment.js";
import * as DnD5ePool from "./pool/DnD5ePoolRules.js";
import { DnD5eScrollForge } from "./scroll/DnD5eScrollForge.js";

const DND5E_DEFAULT_SOURCES = [
    "dnd5e.items",
    "dnd5e.tradegoods",
    "world.ionrift-forged-scrolls"
];

const LIB_FEATURES = new Set([
    QM_FEATURES.SCROLL_FORGE,
    QM_FEATURES.SRD_CURSES,
    QM_FEATURES.SIGNATURE_LEDGER,
    QM_FEATURES.WORKSHOP,
]);

const QM_ONLY_FEATURES = new Set([
    QM_FEATURES.LOOT_CACHE,
    QM_FEATURES.LOOT_POOL_COMPILE,
    QM_FEATURES.LATENT_MASKING,
]);

/**
 * Full Quartermaster pipeline for DnD 5e / 2024.
 */
export class DnD5eItemAdapter extends QuartermasterItemAdapter {

    get id() { return "dnd5e"; }

    supports(featureId) {
        if (QM_ONLY_FEATURES.has(featureId)) return true;
        if (LIB_FEATURES.has(featureId)) {
            return game.ionrift?.library?.system?.isSupported?.(featureId) ?? true;
        }
        return false;
    }

    getDefaultLootPoolSources() {
        return DND5E_DEFAULT_SOURCES.filter(id => game.packs?.get(id));
    }

    getRarityFromEntry(entry) {
        return (entry.system?.rarity ?? "common").toLowerCase().trim();
    }

    extractPrice(entry) {
        return DnD5ePool.extractDnd5ePrice(entry);
    }

    extractWeight(entry) {
        return DnD5ePool.extractDnd5eWeight(entry);
    }

    matchesSlotType(entry, slotType) {
        return DnD5ePool.matchesDnd5eSlotType(entry, slotType);
    }

    isExcludedFromPool(entry) {
        return DnD5ePool.isDnd5eExcludedFromPool(entry);
    }

    shouldApplyLatentMasking() { return true; }

    detectMagicalForCache(item, ctx = {}) {
        return ItemMaskingHelper.detectMagical(item, ctx);
    }

    applyCacheMask(itemData, ctx) {
        ItemMaskingHelper.applyMask(itemData, ctx);
    }

    resolvePileItemData(data) {
        ItemMaskingHelper.applyAuthoredDisguise(data);
        PotionEnrichment.enrichPileItemData(data);
        if (data.type === "consumable" && data.system) {
            data.system.attunement = "";
        }
        if (Array.isArray(data.effects) && data.effects.length > 0) {
            data.effects = [];
        }
        return data;
    }

    canCompileLootPool() { return true; }

    getPowerScoreItemTypes() {
        return new Set(["weapon", "equipment", "tool", "container"]);
    }

    normalizeItemData(itemData) {
        const data = foundry.utils.deepClone(itemData);
        data.system = data.system || {};
        if (!data.system.description || !data.system.description.value) {
            data.system.description = {
                value: `<p>A generic ${data.type}.</p>`,
                chat: "",
                unidentified: ""
            };
        }
        return data;
    }

    getScrollForgeRules() { return DnD5eScrollForge; }
}
