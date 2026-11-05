import { QuartermasterItemAdapter } from "../../QuartermasterItemAdapter.js";
import { QM_FEATURES } from "../../../data/QMFeatures.js";
import { MODULE_ID } from "../../../data/moduleId.js";
import { ItemMaskingHelper } from "../../../services/identify/ItemMaskingHelper.js";
import { PotionEnrichment } from "../../../services/scroll/PotionEnrichment.js";
import * as DnD5ePool from "./DnD5ePoolRules.js";
import { DnD5eScrollForge } from "./DnD5eScrollForge.js";

const DND5E_RARITY_LEVEL_FALLBACK = Object.freeze({
    common: 1,
    uncommon: 4,
    rare: 8,
    veryrare: 13,
    "very rare": 13,
    legendary: 17,
    artifact: 20
});

const DND5E_BONUS_LEVEL_FALLBACK = Object.freeze({
    1: 4,
    2: 8,
    3: 13
});

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

    /**
     * Derive an effective 1-20 item level for D&D 5e items (where items lack a native
     * item level) using spell level, stashed or live magical bonus (+1/+2/+3), and rarity.
     *
     * @param {Item|object} entry
     * @returns {number}
     */
    getEffectiveItemLevel(entry) {
        if (!entry) return 0;
        const latent = entry.flags?.[MODULE_ID]?.latentMagic ?? {};
        const type = String(entry.type ?? "").toLowerCase();
        const subtype = String(entry.subtype ?? entry.system?.type?.value ?? "").toLowerCase();

        const rawSpellLevel = Number(entry.system?.level ?? latent.level ?? NaN);
        if (Number.isFinite(rawSpellLevel) && (type === "spell" || subtype === "scroll" || /\bscroll\b/i.test(entry.name || latent.originalName || ""))) {
            return rawSpellLevel <= 0 ? 1 : Math.min(20, rawSpellLevel * 2 - 1);
        }

        const rawBonus = latent.magicalBonus ?? entry.system?.magicalBonus ?? "";
        const parsedBonus = Number(String(rawBonus).replace(/^\+/, "")) || 0;
        const nameForBonus = String(latent.originalName || entry.name || "");
        const nameBonusMatch = !parsedBonus ? nameForBonus.match(/(?:^|\s)\+([1-3])(?:\b|\s|$)/) : null;
        const effectiveBonus = parsedBonus || (nameBonusMatch ? Number(nameBonusMatch[1]) : 0);
        const bonusLevel = DND5E_BONUS_LEVEL_FALLBACK[effectiveBonus] ?? 0;

        const rawRarity = String(latent.originalRarity || entry.rarity || entry.system?.rarity || "").toLowerCase().trim();
        let rarityLevel = DND5E_RARITY_LEVEL_FALLBACK[rawRarity] ?? 0;

        if (rarityLevel === 1) {
            const mask = ItemMaskingHelper.detectMagical(entry);
            if (!mask?.isMagical && !latent.originalName && !effectiveBonus) {
                rarityLevel = 0;
            }
        }

        return Math.max(bonusLevel, rarityLevel);
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
