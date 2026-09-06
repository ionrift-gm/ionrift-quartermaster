import { QuartermasterItemAdapter } from "../../QuartermasterItemAdapter.js";
import { QM_FEATURES } from "../../../data/QMFeatures.js";

const EXCLUDED_TYPES = new Set(["feat", "feature", "class", "spell", "subclass", "background", "race"]);

/**
 * System-agnostic fallback adapter for Quartermaster.
 *
 * Supports loot cache generation only. Scroll Forge, SRD curses, latent
 * masking, pool compilation, power scores, and the Signature Ledger are
 * disabled because they depend on system-specific item schemas (rarity
 * vocabulary, spell lists, attunement, Active Effects).
 *
 * The GM must manually select compendium sources in the Loot Pool
 * settings; no defaults are assumed for unknown systems.
 */
export class GenericItemAdapter extends QuartermasterItemAdapter {

    #systemId;

    /** @param {string} systemId  The Foundry system id (e.g. "earthdawn4e") */
    constructor(systemId) {
        super();
        this.#systemId = systemId ?? "unknown";
    }

    get id() { return this.#systemId; }

    supports(featureId) {
        return featureId === QM_FEATURES.LOOT_CACHE;
    }

    getDefaultLootPoolSources() { return []; }

    getWorkshopItemTypes() {
        return [
            "weapon", "armor", "equipment", "consumable",
            "loot", "treasure", "gear", "tool", "backpack"
        ];
    }

    getCompendiumIndexFields() {
        return [
            "name", "type", "img", "flags",
            "system.price", "system.weight", "system.description"
        ];
    }

    getRarityFromEntry(_entry) { return "common"; }

    normalizeRarityForTier(_rarity) { return "common"; }

    extractPrice(entry) {
        const price = entry.system?.price;
        if (price == null) return 0;
        if (typeof price === "number") return price;
        if (typeof price === "string") return Number(price) || 0;
        if (typeof price === "object") {
            if (price.value != null) return Number(price.value) || 0;
            const gp  = Number(price.gp  ?? 0) || 0;
            const sp  = Number(price.sp  ?? 0) || 0;
            const cp  = Number(price.cp  ?? 0) || 0;
            const pp  = Number(price.pp  ?? 0) || 0;
            return pp * 10 + gp + sp * 0.1 + cp * 0.01;
        }
        return 0;
    }

    extractWeight(entry) {
        const w = entry.system?.weight;
        if (w == null) return 0;
        if (typeof w === "number") return w;
        if (typeof w === "object") return Number(w.value ?? 0) || 0;
        return Number(w) || 0;
    }

    matchesSlotType(entry, slotType) {
        switch (slotType) {
            case "consumable":
                return entry.type === "consumable";
            case "mundane":
                return !EXCLUDED_TYPES.has(entry.type);
            default:
                return false;
        }
    }

    isExcludedFromPool(entry) {
        if (!entry.name?.trim()) return true;
        return EXCLUDED_TYPES.has(entry.type);
    }

    normalizePoolEntry(entry, packId) {
        return {
            name:              entry.name,
            type:              entry.type,
            img:               entry.img,
            flags:             entry.flags ?? {},
            price:             this.extractPrice(entry),
            rarity:            "common",
            weight:            this.extractWeight(entry),
            level:             0,
            _baseItem:         "",
            subtype:           "",
            system:            {},
            sourceCompendium:  packId,
            _compendiumId:     entry._id
        };
    }

    shouldApplyLatentMasking() { return false; }

    detectMagicalForCache(_item, _ctx) { return { isMagical: false }; }

    applyCacheMask(_itemData, _ctx) {}

    canCompileLootPool() { return false; }

    getPowerScoreItemTypes() { return new Set(); }

    getPowerScoreContribution(_item, _weights) { return 0; }

    buildFallbackPileItem(metaObj) {
        const w = Number(metaObj.weight);
        return {
            name:  metaObj.name,
            type:  metaObj.type ?? "loot",
            img:   metaObj.img,
            system: {
                price:  { value: metaObj.price ?? 0 },
                weight: { value: Number.isFinite(w) ? w : 0 }
            }
        };
    }

    getScrollForgeRules() { return null; }
}
