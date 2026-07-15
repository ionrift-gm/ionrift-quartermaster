/**
 * CacheGenerator
 * Generates level-tuned, terrain-themed loot caches for placement on enemies,
 * in treasure rooms, or directly onto scenes.
 */

import { ItemPoolResolver } from "./ItemPoolResolver.js";
import { ItemMaskingHelper } from "./ItemMaskingHelper.js";
import { ItemClassifier } from "./ItemClassifier.js";
import { AmmoTypeRegistry } from "./AmmoTypeRegistry.js";
import { SignatureLedger } from "./SignatureLedger.js";
import { ScrollForge } from "./ScrollForge.js";
import { TerrainDataRegistry } from "./TerrainDataRegistry.js";
import { PotionEnrichment } from "./PotionEnrichment.js";
import { roundCoinGp, formatCoinPrice, withCoinPriceLabel } from "./CoinFormat.js";
import { Logger, MODULE_LABEL } from "../utils/Logger.js";
import { getQuartermasterAdapter } from "../adapters/getAdapter.js";

const MODULE_ID = "ionrift-quartermaster";

/** SRD scroll price by spell level (gp). */
const SCROLL_PRICES_BY_LEVEL = {
    1: 60, 2: 120, 3: 200, 4: 320, 5: 640, 6: 1280, 7: 2560, 8: 5120, 9: 10240
};

/** Minimum spell level for cache scroll slots by party tier. */
const TIER_SCROLL_MIN_LEVEL = [0, 1, 2, 3, 5];

/** Max distinct scroll lines after consolidation, by tier. */
const TIER_SCROLL_MAX_UNIQUES = [0, 2, 4, 5, 6];

/** Max scroll slots in one cache (arcana / apothecary / default), by tier. */
const SCROLL_SLOT_CAP = {
    arcana:      [0, 3, 5, 6, 7],
    apothecary:  [0, 2, 4, 5, 5],
    default:     [0, 2, 3, 4, 5]
};

/**
 * Compendium suffixes that identify Quartermaster pack roles regardless of
 * delivery (module manifest packs vs world packs materialised from overlays).
 */
const PACK_SUFFIX = {
    gemstones: "quartermaster-gemstones",
    treasure: "quartermaster-treasure",
    core: "quartermaster-core",
    containers: "quartermaster-containers"
};

function isQmPackRole(compendiumId, role) {
    if (!compendiumId) return false;
    const suffix = PACK_SUFFIX[role];
    return !!suffix && compendiumId.endsWith(`.${suffix}`);
}

export const __testables__ = {
    MODULE_ID,
    PACK_SUFFIX,
    SCROLL_PRICES_BY_LEVEL,
    TIER_SCROLL_MIN_LEVEL,
    TIER_SCROLL_MAX_UNIQUES,
    isQmPackRole,
    resolveScrollLevel: (e) => CacheGenerator._resolveScrollLevel(e),
    weightedScrollLevel: (max, min, tier) => CacheGenerator._weightedScrollLevel(max, min, tier),
    resolveScrollPrice: (e, lvl) => CacheGenerator._resolveScrollPrice(e, lvl),
    tierScrollMinLevel: (tier) => CacheGenerator._tierScrollMinLevel(tier),
    pickScrollFromEligible: (eligible, target, min) =>
        CacheGenerator._pickScrollFromEligible(eligible, target, min),
    scrollSlotCap: (tier, owner) => CacheGenerator._scrollSlotCap(tier, owner),
    consolidateScrollStacks: (items, tierData) =>
        CacheGenerator._consolidateScrollStacks(items, tierData),
    resolveScrollQuantity: (lvl, tierData, ceiling) =>
        CacheGenerator._resolveScrollQuantity(lvl, tierData, ceiling),
    scrollPriceCeiling: (tierData, slotCeiling, opts) =>
        CacheGenerator._scrollPriceCeiling(tierData, slotCeiling, opts),
    pickScrollFromIndex: (index, tierData, ceiling) =>
        CacheGenerator._pickScrollFromIndex(index, tierData, ceiling),
    resolveWeightBudgets: (cap) => CacheGenerator._resolveWeightBudgets(cap),
    itemExceedsWeightPickLimit: (w, attempt, budgets, current) =>
        CacheGenerator._itemExceedsWeightPickLimit(w, attempt, budgets, current),
    get GENERATION_WEIGHT_FLOOR() { return CacheGenerator.GENERATION_WEIGHT_FLOOR; },
    resolveQmAnyPacks: (suffix) => resolveQmAnyPacks(suffix),
    resolveQmContainerPacks: () => resolveQmContainerPacks(),
    resolveQmTreasurePacks: () => resolveQmTreasurePacks(),
    resolveQmGemPacks: () => resolveQmGemPacks(),
    resolveQmCorePacks: () => resolveQmCorePacks(),
    loadContainerPoolIndex: () => loadContainerPoolIndex(),
    containerMatchesTerrain: (entry, theme) => containerMatchesTerrain(entry, theme),
    containerIsTerrainSpecific: (entry, theme) => containerIsTerrainSpecific(entry, theme),
    containerOwnerThemeMatches: (entry, ownerTheme) => containerOwnerThemeMatches(entry, ownerTheme),
    isBundledContainerEntry: (entry) => isBundledContainerEntry(entry),
    selectBlendedContainerPool: (byTerrain) => selectBlendedContainerPool(byTerrain),
    get CONTAINER_BUNDLED_BIAS() { return CONTAINER_BUNDLED_BIAS; },
    flavorMatchesTerrain: (entry, theme) => flavorMatchesTerrain(entry, theme),
    flavorIsTerrainBound: (entry) => flavorIsTerrainBound(entry),
    flavorEligibleForTheme: (entry, theme) => flavorEligibleForTheme(entry, theme),
    get FLAVOR_TERRAIN_MATCH_MULTIPLIER() { return FLAVOR_TERRAIN_MATCH_MULTIPLIER; },
    get FLAVOR_TERRAIN_SPECIFIC_BIAS() { return FLAVOR_TERRAIN_SPECIFIC_BIAS; },
    applyBudgetFloor: (result, min, max) => CacheGenerator.applyBudgetFloor(result, min, max)
};

/**
 * Read the GM-managed `lootPoolSources` setting as a Set. This setting is the
 * third-party source list consumed by {@link ItemPoolResolver} (dnd5e.items,
 * dnd5e.tradegoods, world.ionrift-forged-scrolls by default). It is also where
 * {@link OverlayItemMaterialiser} records materialised `world.quartermaster-*`
 * packs so the GM can toggle them via the LootPoolConfigApp.
 *
 * Returns `null` when the setting is missing or unparseable; callers treat
 * `null` as "no constraint" and include every candidate overlay pack.
 *
 * @returns {Set<string>|null}
 */
function readEnabledPackSources() {
    try {
        const raw = game.settings.get(MODULE_ID, "lootPoolSources");
        return new Set(JSON.parse(raw));
    } catch {
        return null;
    }
}

/**
 * Generic pool scanner for a Quartermaster role (containers, treasure, gems,
 * core). Returns:
 *   1. The module-shipped pack for the role (always included; this is
 *      canonical QM content and is never gated by `lootPoolSources`).
 *   2. Every materialised overlay pack under `world.quartermaster-*` whose
 *      collection id is present in `lootPoolSources` (or all of them when the
 *      setting is missing). Overlays self-register on install via
 *      {@link OverlayItemMaterialiser._registerLootSources}, so the GM can
 *      disable an installed overlay via the LootPoolConfigApp without
 *      uninstalling it.
 *
 * Overlay packs hold mixed content (containers + gems + treasure + trinkets
 * in one sublayer), so callers filter the merged index by item kind.
 *
 * @param {string} modulePackSuffix  e.g. PACK_SUFFIX.containers
 * @returns {CompendiumCollection[]}
 */
function resolveQmAnyPacks(modulePackSuffix) {
    const enabled = readEnabledPackSources();
    const packs = [];
    const seen = new Set();

    if (modulePackSuffix) {
        const mod = game.packs.get(`${MODULE_ID}.${modulePackSuffix}`);
        if (mod) {
            packs.push(mod);
            seen.add(mod.collection);
        }
    }

    const worldPrefix = "world.quartermaster-";
    for (const pack of game.packs) {
        if (pack.metadata?.type !== "Item") continue;
        const col = pack.collection;
        if (!col.startsWith(worldPrefix)) continue;
        if (seen.has(col)) continue;
        if (enabled && !enabled.has(col)) continue;
        packs.push(pack);
        seen.add(col);
    }

    return packs;
}

/**
 * Container compendiums for cache generation. Pulls the module-shipped pack
 * plus every materialised overlay pack under `world.quartermaster-*` (one per
 * overlay sublayer). The overlay packs hold mixed content, so the index merge
 * in {@link loadContainerPoolIndex} filters to `type === "container"`.
 *
 * @returns {CompendiumCollection[]}
 */
function resolveQmContainerPacks() {
    return resolveQmAnyPacks(PACK_SUFFIX.containers);
}

/** Treasure pool. Module ships none today; overlays fill this in. */
function resolveQmTreasurePacks() {
    return resolveQmAnyPacks(PACK_SUFFIX.treasure);
}

/** Gemstone pool. Module ships none today; overlays fill this in. */
function resolveQmGemPacks() {
    return resolveQmAnyPacks(PACK_SUFFIX.gemstones);
}

/** Core pool (cultural, mastercraft, trinkets). Module ships none today. */
function resolveQmCorePacks() {
    return resolveQmAnyPacks(PACK_SUFFIX.core);
}

/** @param {string} html */
function parseDiscoveryPhrases(html) {
    if (!html || typeof html !== "string") return [];
    return html
        .split(/<\/p>/i)
        .map(part => part.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
        .filter(Boolean);
}

/**
 * True if the entry is valid for the given terrain. A container is valid when
 * its tags name the theme explicitly OR include the universal "any" marker.
 * Bundled fallback containers ship tagged ["any"] so they remain candidates
 * for every terrain alongside any terrain-specific containers shipped by
 * content overlays.
 *
 * @param {object} entry
 * @param {string} theme
 */
function containerMatchesTerrain(entry, theme) {
    const terrains = entry.flags?.["ionrift-quartermaster"]?.containerMeta?.terrains ?? ["any"];
    return terrains.includes(theme) || terrains.includes("any");
}

/** True when tagged for this terrain and not a generic any-only entry. */
function containerIsTerrainSpecific(entry, theme) {
    const terrains = entry.flags?.["ionrift-quartermaster"]?.containerMeta?.terrains ?? ["any"];
    return terrains.includes(theme) && !(terrains.length === 1 && terrains[0] === "any");
}

/**
 * True when a container pool entry comes from the bundled module pack
 * (ionrift-quartermaster.quartermaster-containers), as opposed to an
 * overlay-materialised pack under `world.quartermaster-*`.
 */
function isBundledContainerEntry(entry) {
    return entry._sourceCollection === `${MODULE_ID}.${PACK_SUFFIX.containers}`;
}

/**
 * True when a container is appropriate for the given owner theme.
 *
 * An entry that declares `containerMeta.ownerThemes` must list the active
 * theme. An entry that does NOT declare ownerThemes is treated as universal
 * and matches every owner theme. This is critical for the bundled compendium,
 * which ships with legacy `cacheTypes` ("stash", "camp_supplies", "hoard")
 * but no `ownerThemes` - those two fields name orthogonal axes and the legacy
 * cacheTypes vocabulary does not overlap with the owner theme vocabulary
 * ("unspecified", "arcana", "armaments", etc.). Treating missing ownerThemes
 * as a hard mismatch silently dropped every bundled container the moment any
 * overlay declared `ownerThemes`, because the picker would prefer the
 * overlay-matched subset and never fall through.
 */
function containerOwnerThemeMatches(entry, ownerTheme) {
    const themes = entry.flags?.["ionrift-quartermaster"]?.containerMeta?.ownerThemes;
    if (!Array.isArray(themes) || themes.length === 0) return true;
    return themes.includes(ownerTheme);
}

/**
 * Blended container picker. When the pool contains entries from both the
 * bundled module pack and one or more overlay-materialised packs, the picker
 * biases the choice between the two sources so a content overlay does not
 * shadow the bundled compendium entirely. Falls through cleanly when one
 * side is empty.
 *
 * Tuned by {@link CONTAINER_BUNDLED_BIAS}; 0.5 means equal chance per side.
 *
 * @param {object[]} byTerrain  Pre-filtered to entries valid for `theme`.
 * @returns {object[]}  The pool to uniform-random-pick from.
 */
const CONTAINER_BUNDLED_BIAS = 0.5;

/**
 * Per-entry weight when `flags.ionrift-quartermaster.terrain` includes the
 * active theme. Only applies inside the eligible pool after exclusivity filter.
 */
const FLAVOR_TERRAIN_MATCH_MULTIPLIER = 2;

/**
 * When both terrain-exclusive and generic entries are eligible, prefer the
 * exclusive subset this often before the weighted draw.
 */
const FLAVOR_TERRAIN_SPECIFIC_BIAS = 0.7;

/** @param {object} entry */
function flavorTerrainTags(entry) {
    return entry.flags?.["ionrift-quartermaster"]?.terrain ?? [];
}

/** True when the item declares at least one terrain (not universal). */
function flavorIsTerrainBound(entry) {
    return flavorTerrainTags(entry).length > 0;
}

/** @param {object} entry @param {string} theme */
function flavorMatchesTerrain(entry, theme) {
    return flavorTerrainTags(entry).includes(theme);
}

/**
 * Universal items (no terrain flag) are eligible everywhere. Terrain-bound
 * items are eligible only when the active theme is listed.
 *
 * @param {object} entry
 * @param {string} theme
 */
function flavorEligibleForTheme(entry, theme) {
    if (!flavorIsTerrainBound(entry)) return true;
    return flavorMatchesTerrain(entry, theme);
}

function selectBlendedContainerPool(byTerrain) {
    const bundled = byTerrain.filter(isBundledContainerEntry);
    const overlay = byTerrain.filter(e => !isBundledContainerEntry(e));
    if (bundled.length > 0 && overlay.length > 0) {
        return Math.random() < CONTAINER_BUNDLED_BIAS ? bundled : overlay;
    }
    if (bundled.length > 0) return bundled;
    if (overlay.length > 0) return overlay;
    return byTerrain;
}

/**
 * @returns {Promise<object[]>}
 */
async function loadContainerPoolIndex() {
    const packs = resolveQmContainerPacks();
    if (!packs.length) return [];

    const modulePackId = `${MODULE_ID}.${PACK_SUFFIX.containers}`;
    const merged = [];
    for (const pack of packs) {
        try {
            const index = await pack.getIndex({ fields: ["name", "img", "system", "flags", "type"] });
            const chunk = index.contents || Array.from(index) || [];
            const isModulePack = pack.collection === modulePackId;
            for (const entry of chunk) {
                if (!isModulePack && entry.type !== "container") continue;
                merged.push({ ...entry, _sourceCollection: pack.collection });
            }
        } catch (err) {
            Logger.warn(MODULE_LABEL, `Container index failed for ${pack.collection}:`, err.message);
        }
    }
    return merged;
}

/**
 * Build a merged pool index from one or more compendiums and apply a
 * caller-supplied kind filter. Used by gem, treasure, and trinket pickers
 * which need to scan both their role pack and every overlay sublayer pack.
 *
 * @param {CompendiumCollection[]} packs
 * @param {(entry: object) => boolean} kindFilter
 * @param {string} label  Human-readable kind name for log messages.
 * @returns {Promise<object[]>}
 */
async function loadFilteredPoolIndex(packs, kindFilter, label) {
    const merged = [];
    for (const pack of packs) {
        try {
            const index = await pack.getIndex({ fields: ["name", "img", "system", "flags", "type"] });
            const chunk = index.contents || Array.from(index) || [];
            for (const entry of chunk) {
                if (!kindFilter(entry)) continue;
                merged.push({ ...entry, _sourceCollection: pack.collection });
            }
        } catch (err) {
            Logger.warn(MODULE_LABEL, `${label} index failed for ${pack.collection}:`, err.message);
        }
    }
    return merged;
}

/** Treasure entries: loot type tagged as Treasure category. */
function isTreasureEntry(entry) {
    if (entry.type !== "loot") return false;
    const cat = entry.flags?.["ionrift-quartermaster"]?.coreMeta?.category;
    return cat === "Treasure";
}

/** Trinket entries: loot type tagged as Trinkets category. */
function isTrinketEntry(entry) {
    if (entry.type !== "loot") return false;
    const cat = entry.flags?.["ionrift-quartermaster"]?.coreMeta?.category;
    return cat === "Trinkets";
}

/** Gem entries: loot subtype "gem" or carrying a gemMeta.tier. */
function isGemEntry(entry) {
    if (entry.type !== "loot") return false;
    const sub = entry.system?.type?.value;
    if (sub === "gem") return true;
    const tier = entry.flags?.["ionrift-quartermaster"]?.gemMeta?.tier
        ?? entry.flags?.["ionrift-workshop"]?.gemMeta?.tier;
    return !!tier;
}

export class CacheGenerator {

    /** @type {Object|null} Loaded cache table data */
    static _tables = null;

    /** Minimum generation budget for QM cache containers (nominal cap is flavor). */
    static GENERATION_WEIGHT_FLOOR = 110;

    /** Owner themes that may roll a reserved armor mastercraft slot (B1). */
    static ARMOR_PRESENCE_THEMES = new Set(["armaments", "unspecified"]);

    /** Armaments caches prefer containers at or above this nominal capacity. */
    static CONTAINER_STURDY_MIN_LBS = 110;

    /** Minimum container nominal capacity by tier when picking a cache vessel. */
    static TIER_CONTAINER_MIN_LBS = { 1: 70, 2: 70, 3: 110, 4: 140 };

    /** Nominal fill ratio above which filler slots prefer light item types. */
    static CONTAINER_PRESSURE_RATIO = 0.55;

    /** Remaining nominal lbs below which filler slots prefer light item types. */
    static CONTAINER_PRESSURE_REMAINING_LBS = 12;

    /** First item may not exceed this share of nominal capacity when more slots remain. */
    static FIRST_ITEM_MAX_NOMINAL_SHARE = 0.45;

    /** Max share of cache budget a single guaranteed slot may consume (Policy A). */
    static GUARANTEED_SLOT_MAX_SHARE = 0.35;

    /** Item at or above this share of budget triggers dressing pairing (Policy F). */
    static ANCHOR_ITEM_SHARE = 0.40;

    /** Number of filler slots forced to cheap supplies after an anchor item. */
    static PAIRING_DRESSING_SLOTS = 2;

    /** Per-tier price ceiling for pairing / dressing picks (gp). */
    static PAIRING_DRESSING_CEILING = { 1: 15, 2: 25, 3: 40, 4: 60 };

    /** Minimum item lines before density top-up runs (Policy B). */
    /** When the GM sets a budget bracket, cap the coin roll so items carry most of the band. */
    static COIN_ROLL_BUDGET_SHARE = { 1: 0.35, 2: 0.30, 3: 0.25, 4: 0.20 };

    static MIN_CACHE_ITEMS = { 1: 4, 2: 5, 3: 6, 4: 6 };

    /** Max total gp spent on density padding as a share of cache budget. */
    static DRESSING_BUDGET_SHARE = 0.12;

    /** Per-item gp ceiling during density top-up by tier. */
    static DRESSING_ITEM_CEILING = { 1: 15, 2: 25, 3: 50, 4: 75 };

    /** Slot types eligible for pairing and density padding. */
    static DRESSING_SLOT_TYPES = ["consumable", "mundane", "ammo"];

    /**
     * Nominal capacity drives fill bar; generation budget may exceed it for armor.
     * @param {number} nominalCapacityLbs
     * @returns {{ nominal: number, generation: number, singleItemMax: number }}
     */
    static _resolveWeightBudgets(nominalCapacityLbs) {
        const nominal = Number(nominalCapacityLbs) || 999;
        if (nominal >= 999) {
            return { nominal, generation: nominal, singleItemMax: nominal };
        }
        // Legacy/test containers below QM compact tier stay strict.
        if (nominal < 45) {
            return { nominal, generation: nominal, singleItemMax: nominal };
        }
        const generation = Math.max(
            nominal,
            Math.round(nominal * 1.15),
            this.GENERATION_WEIGHT_FLOOR
        );
        const singleItemMax = nominal <= 70 ? 100
            : nominal <= 110 ? 130
            : nominal <= 140 ? 160
            : nominal <= 175 ? 200
            : 240;
        return { nominal, generation, singleItemMax };
    }

    /**
     * @param {number} ownerTheme
     * @returns {boolean}
     */
    static _rollArmorPresence(ownerTheme) {
        if (!this.ARMOR_PRESENCE_THEMES.has(ownerTheme)) return false;
        const chance = game.settings?.get(MODULE_ID, "armourDropChance") ?? 0.65;
        return Math.random() < chance;
    }

    /**
     * Soft repick: early attempts prefer nominal fit; later attempts allow generation headroom.
     * @param {number} effectiveWeight
     * @param {number} pickAttempt
     * @param {{ nominal: number, generation: number, singleItemMax: number }} budgets
     * @param {number} currentWeight
     * @returns {boolean}
     */
    static _itemExceedsWeightPickLimit(effectiveWeight, pickAttempt, budgets, currentWeight) {
        if (effectiveWeight > budgets.singleItemMax) return true;
        const remainingNominal = Math.max(2, budgets.nominal - currentWeight);
        const remainingGeneration = Math.max(2, budgets.generation - currentWeight);
        if (pickAttempt < 3) return effectiveWeight > remainingNominal;
        return effectiveWeight > remainingGeneration;
    }

    /**
     * Per-slot weight allowance: fair share of remaining nominal capacity, capped by generation budget.
     * @param {{ nominal: number, generation: number }} budgets
     * @param {number} currentWeight
     * @param {number} slotsRemaining
     * @returns {number}
     */
    static _slotWeightAllowance(budgets, currentWeight, slotsRemaining) {
        const remainingNominal = Math.max(0, budgets.nominal - currentWeight);
        const remainingGeneration = Math.max(0, budgets.generation - currentWeight);
        if (remainingGeneration <= 0) return 0;
        const fairShare = slotsRemaining > 0
            ? remainingNominal / slotsRemaining
            : remainingNominal;
        return Math.min(remainingGeneration, Math.max(0.01, fairShare));
    }

    /**
     * @param {number} tier
     * @returns {number}
     */
    static _tierContainerMinLbs(tier) {
        return this.TIER_CONTAINER_MIN_LBS[tier] ?? 45;
    }

    /**
     * When the container is nearly full, steer filler away from heavy slot types.
     * Armaments caches keep mastercraft slots so magical gear is not swapped for rations.
     * @param {string} effectiveSlotType
     * @param {boolean} pairingActive
     * @param {boolean} isGuaranteed
     * @param {string} [ownerTheme]
     * @returns {string}
     */
    static _resolveSlotTypeUnderPressure(effectiveSlotType, pairingActive, isGuaranteed, ownerTheme = "unspecified") {
        if (pairingActive || isGuaranteed) return effectiveSlotType;
        if (ownerTheme === "armaments" && effectiveSlotType === "mastercraft") return effectiveSlotType;
        if (this.DRESSING_SLOT_TYPES.includes(effectiveSlotType)) return effectiveSlotType;
        if (["mastercraft", "treasure", "gemstone"].includes(effectiveSlotType)) {
            return this.DRESSING_SLOT_TYPES[
                Math.floor(Math.random() * this.DRESSING_SLOT_TYPES.length)
            ];
        }
        return effectiveSlotType;
    }

    /**
     * Last resort before gold filler: try cheap light supply lines that fit remaining capacity.
     */
    static async _tryLightSlotFallback(theme, tierData, tables, priceCeiling, pickOpts, weightBudgets, currentWeight, effectiveWeightFn) {
        const allowance = this._slotWeightAllowance(
            weightBudgets,
            currentWeight,
            pickOpts.slotsRemaining ?? 1
        );
        if (allowance <= 0) return null;

        const lightOpts = {
            ...pickOpts,
            maxEffectiveWeight: allowance,
            effectiveWeightFn
        };

        for (const slotType of this.DRESSING_SLOT_TYPES) {
            const item = await this._pickItem(slotType, theme, tierData, tables, priceCeiling, lightOpts);
            if (!item) continue;
            const unitWeight = effectiveWeightFn(item.weight, item.type, item.system);
            if (this._itemExceedsWeightPickLimit(unitWeight, 4, weightBudgets, currentWeight)) continue;
            if (await this._isBanned(item.name)) continue;
            return item;
        }
        return null;
    }

    /**
     * @param {object} item
     * @param {(w: number, type: string, system: object) => number} effectiveWeightFn
     * @returns {boolean}
     */
    static _isArmorCacheItem(item, effectiveWeightFn) {
        if (!item) return false;
        const system = item.system ?? { type: { value: item.subtype ?? "" } };
        return ItemPoolResolver._isArmorPoolItem({
            type: item.type,
            subtype: item.subtype ?? system?.type?.value ?? "",
            system
        });
    }

    /**
     * Price ceiling for a cache slot. Guaranteed slots no longer use Infinity.
     * @param {object} opts
     * @returns {number}
     */
    static _computeSlotPriceCeiling(opts) {
        const {
            hardCap, isGuaranteed, slotType, effectiveBudget, remainingBudget,
            totalSlotsLeft, fillerSlotsLeft, scrollSlotsRemaining, goldFillerFloor,
            pairingActive, tier
        } = opts;

        if (pairingActive) {
            return this.PAIRING_DRESSING_CEILING[tier] ?? 25;
        }

        const fairShare = Math.max(remainingBudget / totalSlotsLeft, goldFillerFloor);

        if (hardCap) {
            if (slotType === "scroll") {
                return Math.max(
                    remainingBudget / Math.max(1, scrollSlotsRemaining),
                    goldFillerFloor
                );
            }
            return fairShare;
        }

        if (isGuaranteed) {
            const guaranteedCap = effectiveBudget * this.GUARANTEED_SLOT_MAX_SHARE;
            return Math.max(
                Math.min(fairShare, guaranteedCap, remainingBudget),
                goldFillerFloor
            );
        }

        return Math.max(remainingBudget / fillerSlotsLeft, goldFillerFloor);
    }

    /** Tier table bands passed to ItemPoolResolver for mastercraft picks. */
    static TIER_MASTERCRAFT_PRICE_MAX = [0, 100, 400, 1500, 5000];
    static TIER_MASTERCRAFT_PRICE_MIN = [0, 5, 30, 200, 800];

    /**
     * Price ceiling for mastercraft slots. Filler-slot fair share is too low for
     * imputed +N values (e.g. T4 +2 floor 800 gp vs ~500 gp fair share).
     * @param {object} opts
     * @returns {number}
     */
    static _computeMastercraftPriceCeiling(opts) {
        const {
            hardCap, isGuaranteed, effectiveBudget, remainingBudget,
            fillerSlotsLeft, totalSlotsLeft, goldFillerFloor, tier, ownerTheme,
            mastercraftSlotCount = 1
        } = opts;

        const tierTableMax = this.TIER_MASTERCRAFT_PRICE_MAX[tier] ?? 5000;
        const tierBandMin = this.TIER_MASTERCRAFT_PRICE_MIN[tier] ?? 0;
        const minBonus = ItemPoolResolver.MIN_GENERIC_BONUS_BY_TIER[tier] ?? 0;
        const aspireBonus = ItemPoolResolver.ASPIRATIONAL_GENERIC_BONUS_BY_TIER[tier] ?? 0;
        const ceilingBonus = Math.max(minBonus, aspireBonus);
        const magicalFloor = ceilingBonus > 0
            ? (ItemPoolResolver.GENERIC_BONUS_VALUE_FLOOR[ceilingBonus] ?? tierBandMin)
            : tierBandMin;
        const aspireFloor = aspireBonus > 0
            ? (ItemPoolResolver.GENERIC_BONUS_VALUE_FLOOR[aspireBonus] ?? 0)
            : 0;

        const shareDivisor = Math.max(
            1,
            isGuaranteed ? totalSlotsLeft : fillerSlotsLeft
        );
        const fairShare = remainingBudget / shareDivisor;

        // Mastercraft uses tier table bands, not filler-slot fair share. The 35%
        // guaranteed cap blocked T2 +1 gear (210 gp cap vs 400 gp table band).
        let ceiling;
        const armamentsMastercraft = ownerTheme === "armaments";
        if (hardCap) {
            if (armamentsMastercraft) {
                ceiling = Math.min(remainingBudget, tierTableMax);
            } else {
                ceiling = Math.min(
                    remainingBudget,
                    isGuaranteed ? tierTableMax : fairShare,
                    tierTableMax
                );
            }
        } else {
            ceiling = Math.min(remainingBudget, tierTableMax);
        }

        if (armamentsMastercraft && aspireFloor > 0 && mastercraftSlotCount > 0) {
            const slotShare = effectiveBudget / mastercraftSlotCount;
            const armamentsFloor = Math.min(
                remainingBudget,
                Math.max(slotShare, aspireFloor)
            );
            ceiling = Math.max(ceiling, armamentsFloor);
        }

        return Math.min(
            remainingBudget,
            Math.max(ceiling, magicalFloor, tierBandMin, goldFillerFloor)
        );
    }

    /**
     * Add cheap supply lines when a cache is visually sparse (Policy B).
     * @returns {Promise<number>} Updated content weight in lbs.
     */
    static async _applyDensityTopUp(result, ctx) {
        const {
            tier, theme, tierData, tables, effectiveBudget, ownerTheme,
            container, weightBudgets, currentWeight, effectiveWeightFn
        } = ctx;

        const minItems = this.MIN_CACHE_ITEMS[tier] ?? 4;
        if (result.items.length >= minItems) return currentWeight;

        const dressingBudgetCap = Math.max(
            effectiveBudget * this.DRESSING_BUDGET_SHARE,
            this.DRESSING_ITEM_CEILING[tier] ?? 25
        );
        let dressingSpent = 0;
        let weight = currentWeight;
        let attempts = 0;
        const maxAttempts = (minItems - result.items.length) * 3;

        while (result.items.length < minItems && dressingSpent < dressingBudgetCap && attempts < maxAttempts) {
            attempts++;
            const perItemCap = Math.min(
                this.DRESSING_ITEM_CEILING[tier] ?? 25,
                dressingBudgetCap - dressingSpent
            );
            if (perItemCap < 1) break;

            const slotType = this.DRESSING_SLOT_TYPES[(result.items.length + attempts) % this.DRESSING_SLOT_TYPES.length];
            let item = await this._pickItem(slotType, theme, tierData, tables, perItemCap, { ownerTheme });
            if (!item) continue;
            if (await this._isBanned(item.name)) continue;

            const unitWeight = effectiveWeightFn(item.weight, item.type, item.system);
            const remainingGeneration = container
                ? Math.max(2, weightBudgets.generation - weight)
                : 45;
            if (unitWeight > remainingGeneration) continue;

            const qty = (item.quantity !== null && item.quantity !== undefined && item.quantity > 1)
                ? item.quantity
                : this._resolveQuantity(item, {
                    remainingWeight: container
                        ? Math.max(0, weightBudgets.nominal - weight)
                        : null
                });
            const unitPrice = item.price ?? 0;
            const cappedQty = unitPrice > 0
                ? Math.min(qty, Math.max(1, Math.floor(perItemCap / unitPrice)))
                : qty;
            const totalItemPrice = Math.round(unitPrice * cappedQty * 100) / 100;
            if (totalItemPrice > perItemCap) continue;

            const totalItemWeight = unitWeight * cappedQty;
            if (container && (weight + totalItemWeight) > weightBudgets.generation) continue;

            weight += totalItemWeight;
            dressingSpent += totalItemPrice;
            result.items.push({
                ...item,
                quantity: cappedQty,
                price: totalItemPrice,
                _unitPrice: unitPrice,
                _qmKind: item._qmKind ?? "dressing"
            });
        }

        return weight;
    }

    /**
     * @param {object[]} sources
     * @param {"create"|"update"|"pack"} [mode="create"]
     */
    static _guardMintSources(sources, mode = "create") {
        const minting = game.ionrift?.library?.minting;
        if (!minting?.guardAll || !sources?.length) return;
        minting.guardAll(sources, { moduleId: MODULE_ID, mode });
    }

    // ── Public API ────────────────────────────────────────────────

    /**
     * Generates a loot cache using the slot pool draw model.
     * @param {Object} options
     * @param {number} [options.tier=1] - Party tier (1-4)
     * @param {string} [options.theme="dungeon"] - Terrain theme (where the cache is)
     * @param {string} [options.ownerTheme="unspecified"] - Owner theme (whose cache it is)
     * @param {boolean} [options.silent=false] - If true, returns data without posting to chat
     * @returns {Object} { gold, items: [{ name, type, img, price, rarity, quantity }] }
     */
    static async generate(options = {}) {
        const defaultTier = game.settings?.get("ionrift-quartermaster", "defaultCacheTier") ?? 1;
        const defaultTheme = game.settings?.get("ionrift-quartermaster", "defaultCacheTheme") ?? "dungeon";

        const tier = Math.clamp(options.tier ?? defaultTier, 1, 4);
        const theme = options.theme ?? defaultTheme;
        const ownerTheme = options.ownerTheme ?? "unspecified";

        // Economy multiplier (GM configurable, default 1.0)
        const economy = game.settings?.get("ionrift-quartermaster", "lootEconomy") ?? 1.0;
        const magicMult = game.settings?.get("ionrift-quartermaster", "magicFrequency") ?? 1.0;

        const tables = await this._loadTables();
        if (tables.tiers) {
            for (const [key, td] of Object.entries(tables.tiers)) td._tier = parseInt(key);
        }
        const tierData = tables.tiers[String(tier)];
        const ownerDef = tables.ownerThemes?.[ownerTheme] ?? tables.ownerThemes?.unspecified;

        if (!tierData) {
            Logger.error(MODULE_LABEL, `Unknown tier: ${tier}`);
            return { gold: 0, items: [], container: null };
        }
        if (!ownerDef) {
            Logger.error(MODULE_LABEL, `Unknown owner theme: ${ownerTheme}`);
            return { gold: 0, items: [], container: null };
        }

        // Effective budget for this cache.
        // budgetMax caps the tier default from above (user set a ceiling).
        // budgetMin raises it from below (user wants a richer cache than the tier default).
        let effectiveBudget = (tierData.budgetCap ?? 150) * (ownerDef.budgetMultiplier ?? 1.0) * economy;
        if (options.budgetMax !== null && options.budgetMax !== undefined) effectiveBudget = Math.min(effectiveBudget, options.budgetMax);
        if (options.budgetMin !== null && options.budgetMin !== undefined) effectiveBudget = Math.max(effectiveBudget, Math.min(options.budgetMin, options.budgetMax ?? Infinity));
        const budgetFloor = options.budgetMin ?? 0;
        const hardCap = options.budgetMax !== null && options.budgetMax !== undefined;
        /** Item value only; coin is rolled separately and must not consume the item budget. */
        let itemSpentBudget = 0;
        const debug = game.settings?.get(MODULE_ID, "debug") === true;
        const debugSlots = [];

        // Capitalise theme for display purposes when owner is unspecified
        const themeDisplay = theme.charAt(0).toUpperCase() + theme.slice(1);
        const cacheLabel = ownerTheme === "unspecified"
            ? `${themeDisplay} Cache`
            : ownerDef.label;

        const result = {
            gold: 0, items: [], container: null,
            meta: { 
                tier, theme, ownerTheme, tierLabel: tierData.label, 
                cacheLabel, economy,
                mintBatch: foundry.utils.randomID(8)
            }
        };

        // Tier-specific GP floor for filler slots. Tuned down from the
        // previous 5/15/40/100 set so failed slots and weight-overflow
        // contributions do not dominate the cache value with coin. The
        // floor still gates filler-slot price ceilings.
        const goldFillerFloor = [0, 3, 9, 25, 60][tier] ?? 3;

        // Discovery flavor is resolved after the container is picked (container
        // description paragraphs take priority over terrain phrases).

        // ── Gold: always roll, scaled by owner theme (does not reduce item budget) ──
        const rawGold = await this._rollGold(tierData.goldDice);
        result.gold = Math.max(0, Math.round(rawGold * (ownerDef.budgetMultiplier ?? 1.0) * economy));
        if (hardCap && effectiveBudget > 0) {
            const share = this.COIN_ROLL_BUDGET_SHARE[tier] ?? 0.25;
            result.gold = Math.min(result.gold, Math.round(effectiveBudget * share));
        }
        result.meta.budgetMin = options.budgetMin ?? 0;
        if (options.budgetMax !== null && options.budgetMax !== undefined) {
            result.meta.budgetMax = options.budgetMax;
        }

        // ── Signature: always check the Progression Registry ──────────
        const partyActors = game.ionrift?.library?.party?.getMembers()
            ?? game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
        const sugg = await SignatureLedger.getSuggestedRecipient(partyActors);
        if (sugg && !sugg.isSuppressed && sugg.actorId) {
            result.signatureOpportunity = sugg;
        }

        // ── Slot Pool Draw: build item slot list from owner theme ─────
        // Tier scaling factor: higher tiers produce larger, richer caches
        // T1: 1.0x, T2: 1.5x, T3: 2.0x, T4: 2.5x
        const tierScale = [0, 1.0, 1.5, 2.0, 2.5][tier] ?? 1.0;

        const slotRange = ownerDef.totalSlots ?? { min: 5, max: 8 };
        const scaledMin = Math.round(slotRange.min * tierScale);
        const scaledMax = Math.round(slotRange.max * tierScale);
        const totalSlotCount = Math.floor(Math.random() * (scaledMax - scaledMin + 1)) + scaledMin;
        const healFreq = game.settings?.get(MODULE_ID, "healingPotionFrequency") ?? 1.0;
        const pool = CacheGenerator._scaleOwnerSlotPool(ownerDef.slotPool ?? {}, healFreq);

        // Expand guaranteed entries into a flat list of slot types.
        // Entries can be plain strings ("scroll") or range objects ({ type, min, max }).
        // Range min/max are scaled by tier.
        const guaranteed = [];
        for (const entry of (ownerDef.guaranteed ?? [])) {
            if (typeof entry === "string") {
                guaranteed.push(entry);
            } else if (entry?.type) {
                const min = Math.round((entry.min ?? 1) * tierScale);
                const max = Math.round((entry.max ?? min) * tierScale);
                let count = Math.floor(Math.random() * (max - min + 1)) + min;
                if (entry.type === "scroll") {
                    count = Math.min(count, this._scrollSlotCap(tier, ownerTheme));
                }
                for (let j = 0; j < count; j++) guaranteed.push(entry.type);
            }
        }

        // Build the slot draw list: guaranteed first, then random from pool
        const drawnSlots = [...guaranteed];
        const remainingCount = Math.max(0, totalSlotCount - drawnSlots.length);
        for (let i = 0; i < remainingCount; i++) {
            drawnSlots.push(this._weightedPoolDraw(pool));
        }

        this._trimExcessScrollSlots(drawnSlots, tier, ownerTheme, pool);

        const armorPresencePending = this._rollArmorPresence(ownerTheme);
        if (armorPresencePending) {
            drawnSlots.unshift("mastercraft");
        }

        const mastercraftSlotCount = Math.max(
            1,
            drawnSlots.filter(slot => slot === "mastercraft").length
        );

        // Container-first ordering: pick the container before items so we
        // know the weight budget. Items that won't fit are converted to gold.
        const container = await this._pickContainer(ownerTheme, theme, 0, tier);
        const weightBudgets = this._resolveWeightBudgets(container?.capacityLbs);
        let currentWeight = 0;
        let armorPresenceSlotPending = armorPresencePending;
        let pairingSlotsRemaining = 0;
        const anchorThreshold = effectiveBudget * this.ANCHOR_ITEM_SHARE;

        // ── Fill slots ────────────────────────────────────────────────
        const guaranteedCount = guaranteed.length + (armorPresencePending ? 1 : 0);
        let slotsProcessed = 0;

        // Named-magical throttle (Stance B): decide ONCE per cache whether a
        // named magical item is eligible at all. Only one named magical item
        // can appear per cache. The probability is low and tier-gated.
        //   T1: 0%   - mastercraft sweet spot, no named magic
        //   T2: 10%  - rare find, a genuine discovery
        //   T3: 20%  - meaningful but not common
        //   T4: 35%  - more frequent but still cache-by-cache
        const namedMagicMult = game.settings?.get(MODULE_ID, "namedMagicFrequency") ?? 1.0;
        const NAMED_MAGIC_PER_CACHE = { 1: 0, 2: 0.10, 3: 0.20, 4: 0.35 };
        const namedMagicalBudget = (() => {
            const chance = Math.min(1, (NAMED_MAGIC_PER_CACHE[tier] ?? 0) * namedMagicMult);
            if (chance === 0) return 0;  // never
            return Math.random() < chance ? 1 : 0;  // 0 = blocked, 1 = one allowed
        })();
        let namedMagicalRemaining = namedMagicalBudget;

        // Type-aware weight floors - sentinel values that make leaked zero-weight
        // items meaningfully heavy in container math without affecting items that
        // are legitimately featherweight (rings, scrolls, wondrous items).
        //   weapon  -> 3 lb  (lightest real weapon: dart ~0.25 lb; 3 lb covers swords)
        //   armor   -> 4 lb  (lightest real armor: padded 8 lb; 4 lb is a safe floor)
        //   other   -> 0.01 lb (rings, scrolls, wands - canonically near-weightless)
        const ARMOR_SUBTYPES = new Set(["heavy", "medium", "light", "shield"]);
        const _effectiveWeight = (w, type, system) => {
            const raw = Number(w) || 0;
            if (type === "weapon") return Math.max(raw, 3.0);
            if (type === "equipment" && ARMOR_SUBTYPES.has((system?.type?.value ?? "").trim()))
                return Math.max(raw, 4.0);
            return Math.max(raw, 0.01);
        };

        for (const slotType of drawnSlots) {
            const isGuaranteed = slotsProcessed < guaranteedCount;

            // Budget gate: filler always; guaranteed only when GM has set a hard cap
            if (itemSpentBudget >= effectiveBudget && (!isGuaranteed || hardCap)) break;

            let pairingActive = false;
            let effectiveSlotType = slotType;
            if (pairingSlotsRemaining > 0) {
                pairingActive = true;
                effectiveSlotType = this.DRESSING_SLOT_TYPES[
                    (this.PAIRING_DRESSING_SLOTS - pairingSlotsRemaining) % this.DRESSING_SLOT_TYPES.length
                ];
                pairingSlotsRemaining--;
            }

            const slotsRemaining = Math.max(1, drawnSlots.length - slotsProcessed);
            const remainingNominal = container
                ? Math.max(0, weightBudgets.nominal - currentWeight)
                : 999;
            const underCapacityPressure = container && (
                currentWeight / weightBudgets.nominal >= this.CONTAINER_PRESSURE_RATIO
                || remainingNominal < this.CONTAINER_PRESSURE_REMAINING_LBS
            );
            if (underCapacityPressure) {
                effectiveSlotType = this._resolveSlotTypeUnderPressure(
                    effectiveSlotType, pairingActive, isGuaranteed, ownerTheme
                );
            }

            let slotWeightAllowance = this._slotWeightAllowance(
                weightBudgets, currentWeight, slotsRemaining
            );
            if (result.items.length === 0 && slotsRemaining > 1) {
                slotWeightAllowance = Math.min(
                    slotWeightAllowance,
                    weightBudgets.nominal * this.FIRST_ITEM_MAX_NOMINAL_SHARE
                );
            }

            const isArmamentsMastercraft = ownerTheme === "armaments" && effectiveSlotType === "mastercraft";

            const totalSlotsLeft    = Math.max(1, drawnSlots.length - slotsProcessed);
            const fillerSlotsLeft   = Math.max(1, drawnSlots.length - Math.max(slotsProcessed, guaranteedCount));
            const remainingBudget   = effectiveBudget - itemSpentBudget;
            const scrollSlotsRemaining = drawnSlots
                .slice(slotsProcessed)
                .filter(s => s === "scroll").length;
            const priceCeiling = effectiveSlotType === "mastercraft"
                ? this._computeMastercraftPriceCeiling({
                    hardCap,
                    isGuaranteed,
                    effectiveBudget,
                    remainingBudget,
                    totalSlotsLeft,
                    fillerSlotsLeft,
                    goldFillerFloor,
                    tier,
                    ownerTheme,
                    mastercraftSlotCount
                })
                : this._computeSlotPriceCeiling({
                    hardCap,
                    isGuaranteed,
                    slotType: effectiveSlotType,
                    effectiveBudget,
                    remainingBudget,
                    totalSlotsLeft,
                    fillerSlotsLeft,
                    scrollSlotsRemaining,
                    goldFillerFloor,
                    pairingActive,
                    tier
                });

            let item = null;
            let pickAttempts = 0;

            const requireArmor = armorPresenceSlotPending && effectiveSlotType === "mastercraft";
            const pickOpts = {
                scrollSlotsRemaining,
                remainingBudget,
                rejectNamedMagical: namedMagicalRemaining <= 0,
                ownerTheme,
                preferArmor: isArmamentsMastercraft && !requireArmor,
                requireArmor,
                slotsRemaining,
                effectiveWeightFn: _effectiveWeight,
            };

            const remainingGeneration = container
                ? Math.max(2, weightBudgets.generation - currentWeight)
                : 45;

            // Repick logic: prefer nominal fit early, allow generation headroom later.
            // Armaments mastercraft uses generation headroom immediately so armor can land.
            while (pickAttempts < 5) {
                const weightAttempt = requireArmor || isArmamentsMastercraft || isGuaranteed
                    ? 3
                    : pickAttempts;
                const attemptAllowance = weightAttempt >= 3
                    ? remainingGeneration
                    : (pickAttempts < 3 ? slotWeightAllowance : Math.min(slotWeightAllowance, remainingGeneration));
                item = await this._pickItem(effectiveSlotType, theme, tierData, tables, priceCeiling, {
                    ...pickOpts,
                    maxEffectiveWeight: attemptAllowance > 0 ? attemptAllowance : remainingGeneration,
                });
                if (!item) break;
                const unitWeight = _effectiveWeight(item.weight, item.type, item.system);
                if (this._itemExceedsWeightPickLimit(unitWeight, weightAttempt, weightBudgets, currentWeight)) {
                    item = null;
                    pickAttempts++;
                } else {
                    const itemPrice = effectiveSlotType === "mastercraft"
                        ? ItemPoolResolver._mastercraftEffectivePrice(item)
                        : (item.price ?? 0);
                    if (itemPrice > priceCeiling) {
                        item = null;
                        pickAttempts++;
                    } else if (await this._isBanned(item.name)) {
                        item = null;
                        pickAttempts++;
                    } else {
                        break;
                    }
                }
            }

            // Mastercraft fallback: relax weight allowance, keep weapons in play.
            // Do not force armor-only; that path collapsed to helms in tight packs.
            if (!item && effectiveSlotType === "mastercraft") {
                item = await this._pickMastercraft(theme, tierData, priceCeiling, tables, {
                    ...pickOpts,
                    maxEffectiveWeight: remainingGeneration,
                });
                if (item) {
                    const unitWeight = _effectiveWeight(item.weight, item.type, item.system);
                    if (this._itemExceedsWeightPickLimit(unitWeight, 4, weightBudgets, currentWeight)) {
                        item = null;
                    }
                }
                if (!item && isArmamentsMastercraft) {
                    item = await this._pickMastercraft(theme, tierData, priceCeiling, tables, {
                        ...pickOpts,
                        preferArmor: false,
                        requireArmor: false,
                        maxEffectiveWeight: Math.min(remainingGeneration, 12),
                    });
                    if (item) {
                        const unitWeight = _effectiveWeight(item.weight, item.type, item.system);
                        if (this._itemExceedsWeightPickLimit(unitWeight, 4, weightBudgets, currentWeight)) {
                            item = null;
                        }
                    }
                }
            }

            if (!item && container && remainingNominal > 0
                && !(ownerTheme === "armaments" && effectiveSlotType === "mastercraft")) {
                item = await this._tryLightSlotFallback(
                    theme, tierData, tables, priceCeiling, pickOpts,
                    weightBudgets, currentWeight, _effectiveWeight
                );
            }

            if (requireArmor) {
                armorPresenceSlotPending = false;
            }

            slotsProcessed++;

            if (effectiveSlotType === "mastercraft") {
                result.meta.mastercraftSlots = result.meta.mastercraftSlots ?? {
                    attempted: 0, filled: 0, empty: 0, overflow: 0
                };
                result.meta.mastercraftSlots.attempted++;
            }

            if (item) {
                if (effectiveSlotType === "mastercraft" && item._isMagical === undefined) {
                    const adapter = getQuartermasterAdapter();
                    if (adapter.shouldApplyLatentMasking()) {
                        const mask = adapter.detectMagicalForCache(item, { terrainTag: theme });
                        if (mask.isMagical) {
                            item._isMagical = true;
                            item._baseItemName = mask.baseItemName;
                            item._mundaneDesc = mask.mundaneDesc;
                        }
                    }
                }
                // Quantity heuristic is capacity-aware: a single stack should
                // never claim more than a fair share of what is left in the bag,
                // so cheap bulky items (greatclubs, sacks of flour) cannot
                // ramp themselves up to 70 lb in a 35 lb pack.
                const remainingWeight = container
                    ? Math.max(0, weightBudgets.nominal - currentWeight)
                    : null;
                let qty;
                if (item.spellName) {
                    qty = this._resolveScrollQuantity(
                        item.spellLevel ?? 1, tierData, priceCeiling
                    );
                } else if (item.quantity !== null && item.quantity !== undefined && item.quantity > 1) {
                    qty = item.quantity;
                } else {
                    qty = this._resolveQuantity(item, { remainingWeight });
                }
                let totalItemPrice = Math.round((item.price ?? 0) * qty * 100) / 100;
                // Type-aware weight floor (see _effectiveWeight above).
                let totalItemWeight = _effectiveWeight(item.weight, item.type, item.system) * qty;

                let totalAfter = currentWeight + totalItemWeight;
                let overGeneration = container
                    && totalAfter > weightBudgets.generation
                    && result.items.length > 0;

                // Heavy armor can exceed generation headroom; try a light weapon before coin.
                if (overGeneration && isArmamentsMastercraft && !requireArmor) {
                    const lightPick = await this._pickMastercraft(
                        theme, tierData, priceCeiling, tables, {
                            ...pickOpts,
                            preferArmor: false,
                            requireArmor: false,
                            maxEffectiveWeight: Math.max(
                                3,
                                Math.min(12, weightBudgets.generation - currentWeight)
                            ),
                        }
                    );
                    if (lightPick) {
                        item = lightPick;
                        qty = 1;
                        totalItemPrice = Math.round((item.price ?? 0) * qty * 100) / 100;
                        totalItemWeight = _effectiveWeight(item.weight, item.type, item.system) * qty;
                        totalAfter = currentWeight + totalItemWeight;
                        overGeneration = container
                            && totalAfter > weightBudgets.generation
                            && result.items.length > 0;
                    }
                }

                if (overGeneration) {
                    const filler = Math.floor(totalItemPrice * 0.5);
                    result.gold += filler;
                    itemSpentBudget += filler;
                    if (effectiveSlotType === "mastercraft") {
                        result.meta.mastercraftSlots.overflow++;
                    }
                } else {
                    currentWeight += totalItemWeight;
                    itemSpentBudget += totalItemPrice;
                    result.items.push({
                        ...item,
                        quantity: qty,
                        price: totalItemPrice,
                        _unitPrice: item.price ?? 0,
                        _cacheSlotType: effectiveSlotType
                    });
                    if (effectiveSlotType === "mastercraft") {
                        result.meta.mastercraftSlots.filled++;
                    }
                    if (!pairingActive && (
                        totalItemPrice >= anchorThreshold
                        || ItemClassifier.isNamedMagical(item)
                    )) {
                        pairingSlotsRemaining = this.PAIRING_DRESSING_SLOTS;
                    }
                    // Consume the named-magical budget when a named magical item lands
                    if (namedMagicalRemaining > 0 && ItemClassifier.isNamedMagical(item)) {
                        namedMagicalRemaining--;
                    }
                }
                if (debug) {
                    debugSlots.push({
                        slotType: effectiveSlotType, isGuaranteed, priceCeiling, ok: true,
                        name: item.name, price: totalItemPrice,
                        spellLevel: item.spellLevel ?? null,
                        pairingActive
                    });
                }
            } else {
                // Nothing useful in this slot -- coin filler (does not consume item budget)
                const filler = Math.floor(goldFillerFloor * (0.5 + Math.random()));
                result.gold += filler;
                if (effectiveSlotType === "mastercraft") {
                    result.meta.mastercraftSlots.empty++;
                }
                if (debug) {
                    debugSlots.push({
                        slotType: effectiveSlotType, isGuaranteed, priceCeiling, ok: false,
                        fillerGp: filler, pairingActive
                    });
                }
            }
        }

        currentWeight = await this._applyDensityTopUp(result, {
            tier,
            theme,
            tierData,
            tables,
            effectiveBudget,
            ownerTheme,
            container,
            weightBudgets,
            currentWeight,
            effectiveWeightFn: _effectiveWeight
        });

        const minItems = this.MIN_CACHE_ITEMS[tier] ?? 4;
        if (result.items.length < minItems) {
            currentWeight = await this._applyDensityTopUp(result, {
                tier,
                theme,
                tierData,
                tables,
                effectiveBudget,
                ownerTheme,
                container,
                weightBudgets,
                currentWeight,
                effectiveWeightFn: _effectiveWeight
            });
        }

        // Extra healing potion rolls driven by the GM slider (independent of slot type).
        const bonusHealingRolls = CacheGenerator._healingBonusRollCount(healFreq);
        for (let bonusIdx = 0; bonusIdx < bonusHealingRolls; bonusIdx++) {
            if (itemSpentBudget >= effectiveBudget && hardCap) break;

            const remainingBudget = effectiveBudget - itemSpentBudget;
            const priceCeiling = hardCap
                ? Math.max(remainingBudget, goldFillerFloor)
                : Infinity;

            const pick = await CacheGenerator._pickHealingPotionOnly(
                theme, tierData, tables, priceCeiling, healFreq
            );
            if (!pick) break;

            const qty = 1;
            const totalItemPrice = Math.round((pick.price ?? 0) * qty * 100) / 100;
            const totalItemWeight = _effectiveWeight(pick.weight, pick.type, pick.system) * qty;

            if (container && (currentWeight + totalItemWeight) > weightBudgets.generation) break;

            currentWeight += totalItemWeight;
            if (hardCap) itemSpentBudget += totalItemPrice;
            result.items.push({
                ...pick,
                quantity: qty,
                price: totalItemPrice,
                _unitPrice: pick.price ?? 0
            });
        }

        const scrollCountBefore = result.items.filter(i => i.spellName).length;
        result.items = this._consolidateScrollStacks(result.items, tierData);
        const scrollCountAfter = result.items.filter(i => i.spellName).length;

        // Attach container metadata (container was picked before the item loop)
        if (container) {
            const fillPercent = container.capacityLbs > 0
                ? Math.min(100, Math.round((currentWeight / container.capacityLbs) * 100))
                : 0;

            result.container = {
                ...container,
                contentWeightLbs: currentWeight,
                generationBudgetLbs: weightBudgets.generation,
                fillPercent,
                isOverweight: currentWeight > (container.capacityLbs ?? 0)
            };

            CacheGenerator.applyContainerFlavor(result, theme, tables);
        }

        // Curse injection point - reserved for ionrift-cursewright.
        // Cursewright listens on this hook and runs its own applyCacheCurses().
        // Call signature: (result, options) - result.meta.mintBatch is the batch identity key.
        Hooks.callAll("ionrift-quartermaster.cacheGenerated", result, options);

        // Budget floor: if a minimum was dialled in and total value fell short, bridge with gold
        const itemValue = result.items.reduce((sum, i) => sum + (i.price ?? 0), 0);
        result.meta.preFloorGold = result.gold;
        const totalCacheValue = result.gold + itemValue;
        if (budgetFloor > 0 && totalCacheValue < budgetFloor) {
            result.gold += Math.round(budgetFloor - totalCacheValue);
        }
        this._syncCacheCoinage(result);

        if (debug) {
            const scrollLines = result.items.filter(i => i.spellName);
            this._cacheDebug("generate complete", {
                tier, ownerTheme, theme, hardCap,
                effectiveBudget, itemSpentBudget, itemValue,
                gold: result.gold, totalCacheValue: result.gold + itemValue,
                slotsDrawn: drawnSlots.length,
                scrollSlotsInDraw: drawnSlots.filter(s => s === "scroll").length,
                scrollLinesBefore: scrollCountBefore,
                scrollLinesAfter: scrollCountAfter,
                scrollStacks: scrollLines.map(s => ({
                    name: s.spellName, level: s.spellLevel, qty: s.quantity, price: s.price
                })),
                itemsPlaced: result.items.length,
                slotTrace: debugSlots
            });
        }

        if (!options.silent) {
            await this._postChatCard(result);
        }

        return result;
    }

    /**
     * Set result.meta.flavor from the picked container description (one random
     * paragraph) or fall back to terrain discovery phrases.
     * @param {Object} result
     * @param {string} theme
     * @param {Object} [tables]
     */
    static applyContainerFlavor(result, theme, tables = null) {
        const container = result.container;
        if (!container) return;

        const descPhrases = parseDiscoveryPhrases(container.system?.description?.value);
        if (descPhrases.length) {
            result.meta.flavor = descPhrases[Math.floor(Math.random() * descPhrases.length)];
            return;
        }

        const fromRegistry = TerrainDataRegistry.getFlavorPhrases(theme);
        const phrases = (fromRegistry?.length ? fromRegistry : null)
            ?? tables?.flavorPhrases?.[theme]
            ?? this._tables?.flavorPhrases?.[theme]
            ?? [];
        if (!phrases.length) return;

        let line = phrases[Math.floor(Math.random() * phrases.length)];
        if (line.includes("{container}")) {
            const name = container.name.toLowerCase();
            const article = /^[aeiou]/i.test(name) ? "an" : "a";
            line = line.replaceAll("{container}", `${article} ${name}`);
        }
        result.meta.flavor = line;
    }

    /**
     * Cache-time curse injection for manual cache edits and the Curse Cache action.
     * Delegates to Cursewright when that module is active.
     *
     * @param {Object} result
     * @param {Object} [options]
     * @returns {Promise<boolean>}
     */
    static async applyCacheCurses(result, options = {}) {
        const engine = game.ionrift?.cursewright?.engine;
        if (engine?.applyCacheCurses) {
            return engine.applyCacheCurses(result, options);
        }
        return false;
    }

    /** Remove all coinage from a cache preview without touching items. */
    static clearCacheGold(cacheResult) {
        if (!cacheResult) return;
        cacheResult.gold = 0;
        if (cacheResult.meta) cacheResult.meta.preFloorGold = 0;
        delete cacheResult.coinage;
    }

    /**
     * Reconcile rolled coin with the cache budget floor after the GM changes
     * the budget bracket. Uses {@link meta.preFloorGold} so floor padding can
     * be added or removed without a full regen.
     *
     * @param {Object} cacheResult
     * @param {number} [budgetMin=0]
     * @param {number|null} [budgetMax]
     * @returns {Object}
     */
    static applyBudgetFloor(cacheResult, budgetMin = 0, budgetMax = null) {
        if (!cacheResult) return cacheResult;

        const floor = Math.max(0, Number(budgetMin) || 0);
        const preFloor = cacheResult.meta?.preFloorGold ?? cacheResult.gold ?? 0;
        const itemValue = (cacheResult.items ?? []).reduce(
            (sum, item) => sum + (item.price ?? 0),
            0
        );

        let gold = preFloor;
        if (floor > 0 && preFloor + itemValue < floor) {
            gold = floor - itemValue;
        }

        cacheResult.gold = Math.max(0, Math.round(gold));
        if (cacheResult.meta) {
            cacheResult.meta.budgetMin = floor;
            if (budgetMax !== null && budgetMax !== undefined) {
                cacheResult.meta.budgetMax = budgetMax;
            }
        }
        this._syncCacheCoinage(cacheResult);
        return cacheResult;
    }

    /** Refresh or clear distributed coin breakdown for a cache preview. */
    static _syncCacheCoinage(cacheResult) {
        if (!cacheResult) return;
        if (cacheResult.gold > 0 && game.settings.get("ionrift-quartermaster", "distributeCoins") !== false) {
            cacheResult.coinage = this._distributeCoinage(cacheResult.gold);
        } else {
            delete cacheResult.coinage;
        }
    }

    /**
     * Roll a fresh base gold total for the cache tier and owner theme.
     * Items are unchanged. Uses the same dice and multipliers as initial generation.
     */
    static async rerollCacheGold(cacheResult) {
        if (!cacheResult?.meta) return cacheResult;

        const tables = await this._loadTables();
        const tier = cacheResult.meta.tier ?? 1;
        const ownerTheme = cacheResult.meta.ownerTheme ?? "unspecified";
        const tierData = tables.tiers?.[String(tier)];
        const ownerDef = tables.ownerThemes?.[ownerTheme] ?? tables.ownerThemes?.unspecified;
        if (!tierData) return cacheResult;

        const economy = game.settings.get("ionrift-quartermaster", "lootEconomy") ?? 1.0;
        const rawGold = await this._rollGold(tierData.goldDice);
        cacheResult.gold = Math.max(
            0,
            Math.round(rawGold * (ownerDef?.budgetMultiplier ?? 1.0) * economy)
        );
        if (cacheResult.meta) cacheResult.meta.preFloorGold = cacheResult.gold;
        return this.applyBudgetFloor(
            cacheResult,
            cacheResult.meta?.budgetMin ?? 0,
            cacheResult.meta?.budgetMax ?? null
        );
    }

    /**
     * Returns the list of available owner themes.
     * @returns {Object[]} [{ id, label, desc }]
     */
    static async getOwnerThemes() {
        const tables = await this._loadTables();
        return Object.entries(tables.ownerThemes ?? {}).map(([id, data]) => ({
            id, label: data.label, desc: data.desc
        }));
    }

    /**
     * Returns the list of valid theme keys.
     * @returns {string[]}
     */
    static async getThemes() {
        if (TerrainDataRegistry.isReady) {
            return TerrainDataRegistry.getTerrainList().map(t => t.id);
        }
        // Legacy fallback: read from cache-tables.json
        const tables = await this._loadTables();
        return Object.keys(tables.flavorPhrases ?? {});
    }

    // ── Slot Pool Draw ────────────────────────────────────────────

    /**
     * Draws a single slot type from a weighted pool.
     * Pool is an object like { "scroll": 4, "consumable": 3, "mundane": 1.5 }.
     * Higher weight = more likely to be drawn.
     * @param {Object} pool - Weighted slot pool
     * @returns {string} The drawn slot type
     */
    static _weightedPoolDraw(pool) {
        const entries = Object.entries(pool);
        if (entries.length === 0) return "mundane"; // safety fallback
        const total = entries.reduce((sum, [, w]) => sum + w, 0);
        let roll = Math.random() * total;
        for (const [type, weight] of entries) {
            roll -= weight;
            if (roll <= 0) return type;
        }
        return entries[entries.length - 1][0];
    }

    // ── Data Loading ──────────────────────────────────────────────

    static async _loadTables() {
        if (this._tables) return this._tables;

        try {
            const response = await fetch(`modules/${MODULE_ID}/data/cache-tables.json`);
            this._tables = await response.json();
        } catch (e) {
            Logger.error(MODULE_LABEL, "Failed to load cache-tables.json:", e);
            this._tables = { tiers: {}, ownerThemes: {}, flavorPhrases: {} };
        }

        return this._tables;
    }

    // ── Item Picking ──────────────────────────────────────────────

    /**
     * Picks a random item from the appropriate pool for this slot type.
     * Queries enabled compendiums via ItemPoolResolver.
     */
    static async _pickItem(slotType, theme, tierData, tables, priceCeiling = Infinity, pickOpts = {}) {
        let item;
        switch (slotType) {
            case "scroll": {
                item = await this._pickScroll(tierData, priceCeiling, pickOpts);
                break;
            }
            case "consumable":  item = await this._pickConsumable(theme, tierData, tables, priceCeiling, pickOpts); break;
            case "mundane":     item = await this._pickMundane(theme, tierData, tables, priceCeiling, pickOpts); break;
            case "mastercraft": item = await this._pickMastercraft(theme, tierData, priceCeiling, tables, pickOpts); break;
            case "gemstone":    item = await this._pickGemstone(theme, tierData, priceCeiling); break;
            case "trinket":     item = await this._pickTrinket(theme, tierData, priceCeiling); break;
            case "treasure":    item = await this._pickTreasure(theme, tierData, priceCeiling); break;
            case "ammo":        item = await this._pickAmmo(theme, tierData, tables, priceCeiling, pickOpts); break;
            default:            return null;
        }

        // Enrich with magical identification masking metadata
        if (item) {
            const adapter = getQuartermasterAdapter();
            if (adapter.shouldApplyLatentMasking()) {
                const mask = adapter.detectMagicalForCache(item, { terrainTag: theme });
                if (mask.isMagical) {
                    item._isMagical    = true;
                    item._baseItemName = mask.baseItemName;
                    item._mundaneDesc  = mask.mundaneDesc;
                    if (mask.obscuredImg) {
                        item._maskSourceImg = item.img;
                        item._obscuredImg = mask.obscuredImg;
                        item.img          = mask.obscuredImg;
                    }
                }
            }
        }
        return item;
    }

    /**
     * Pick a cultural/mastercraft weapon or armor from the quartermaster-core compendium.
     * Filters to items priced within the tier's typical range.
     *
     * Stance B policy is enforced via pickOpts.rejectNamedMagical, which is
     * set at the generate() level based on a per-cache probability roll.
     */
    static async _pickMastercraft(theme, tierData, priceCeiling = Infinity, tables = null, pickOpts = {}) {
        const tier = tierData._tier ?? 1;
        const priceMax = Math.min([0, 100, 400, 1500, 5000][tier], priceCeiling);
        const priceMin = [0, 5, 30, 200, 800][tier];

        const preferredMaterials = TerrainDataRegistry.getMaterials(theme);

        // T1: mastercraft sweet spot - always reject magical items.
        // T2+: named magical gated by per-cache roll in generate() via pickOpts.rejectNamedMagical.
        const rejectNamedMagical = pickOpts.rejectNamedMagical ?? true;
        const rejectAllMagical = tier <= 1;

        // Primary: query enabled compendiums via ItemPoolResolver (includes SRD dnd5e.items)
        try {
            const item = await ItemPoolResolver.pickRandom({
                slotType: "mastercraft",
                tier,
                theme,
                priceCeiling,
                priceMin,
                priceMax,
                rarityMax: tierData.rarityMax ?? "uncommon",
                rejectNamedMagical,
                maxGenericBonusTier: ItemPoolResolver.MAX_GENERIC_BONUS_BY_TIER[tier] ?? 0,
                ownerTheme: pickOpts.ownerTheme,
                preferArmor: pickOpts.preferArmor,
                requireArmor: pickOpts.requireArmor,
                maxEffectiveWeight: pickOpts.maxEffectiveWeight,
                effectiveWeightFn: pickOpts.effectiveWeightFn,
            });
            if (item) {
                // T1: reject any magical item (rarity uncommon+ or mgc property)
                if (rejectAllMagical) {
                    const rarity = (item.rarity ?? "").toLowerCase();
                    const isMagical = rarity && rarity !== "common" && rarity !== "none";
                    if (isMagical) {
                        // Fall through to fallback (QM core packs are non-magical)
                    } else {
                        return { ...item, quantity: 1 };
                    }
                } else {
                    return { ...item, quantity: 1 };
                }
            }
        } catch (e) {
            Logger.warn(MODULE_LABEL, "ItemPoolResolver failed for mastercraft:", e.message);
        }

        // Armaments T2+ rely on compiled pools; QM core fallback is mundane steel.
        if (pickOpts.ownerTheme === "armaments" && tier >= 2) {
            return null;
        }

        // Fallback: scan all core-role packs for cultural / mastercraft entries.
        try {
            const packs = resolveQmCorePacks();
            if (packs.length === 0) return null;
            const kindFilter = (e) => {
                const cat = e.flags?.['ionrift-quartermaster']?.coreMeta?.category;
                return ['Cultural Weapons', 'Cultural Armor', 'Mastercraft'].includes(cat);
            };
            const pool = await loadFilteredPoolIndex(packs, kindFilter, "Mastercraft");
            const eligible = pool.filter(e => {
                const price = ItemPoolResolver._extractPrice(e);
                return price >= priceMin && price <= priceMax;
            });

            if (eligible.length === 0) return null;

            const themed = eligible.filter(e => {
                const mat = e.flags?.['ionrift-quartermaster']?.coreMeta?.material ?? '';
                return preferredMaterials.includes(mat);
            });
            const finalPool = themed.length > 0 ? themed : eligible;
            const pick = finalPool[Math.floor(Math.random() * finalPool.length)];
            return {
                name: pick.name,
                type: pick.type ?? 'weapon',
                img: pick.img,
                price: ItemPoolResolver._extractPrice(pick),
                weight: pick.system?.weight?.value ?? 3,
                rarity: pick.system?.rarity ?? 'common',
                _baseItem: pick.system?.type?.baseItem ?? '',
                quantity: 1,
                _compendiumId: pick._id,
                _qmKind: "mastercraft",
                sourceCompendium: pick._sourceCollection
            };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Mastercraft pool query failed:", e.message);
        }
        return null;
    }

    // ── Ammunition Picker ─────────────────────────────────────────

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

    /**
     * Pick a gemstone from the quartermaster-gemstones compendium.
     * Tier gates which quality tier of gemstone is eligible.
     */
    static async _pickGemstone(theme, tierData, priceCeiling = Infinity) {
        const tier = tierData._tier ?? 1;
        // Tier gates which quality bands are eligible per cache tier.
        const eligibleTiers = [
            [],
            ['Chips & Fragments', 'Polished Common'],
            ['Chips & Fragments', 'Polished Common', 'Semi-Precious'],
            ['Polished Common', 'Semi-Precious', 'Precious'],
            ['Semi-Precious', 'Precious', 'Flawless']
        ][tier] ?? ['Polished Common'];

        // Tier-aware tier weights. The picker scales the gem-quality curve
        // with the cache tier so that T1 caches still favour chips and
        // common, but T2+ pushes meaningful weight onto semi-precious and
        // up. Without this, flat weights drowned out the (already rare)
        // mid-tier gems that overlay packs ship.
        const tierWeightsByCacheTier = {
            1: { 'Chips & Fragments': 3, 'Polished Common': 3 },
            2: { 'Chips & Fragments': 1, 'Polished Common': 2, 'Semi-Precious': 3 },
            3: { 'Polished Common': 1, 'Semi-Precious': 3, 'Precious': 2 },
            4: { 'Semi-Precious': 1, 'Precious': 3, 'Flawless': 2 }
        };
        const tierWeights = tierWeightsByCacheTier[tier] ?? { 'Polished Common': 1 };

        try {
            const packs = resolveQmGemPacks();
            if (packs.length === 0) return null;
            const pool = await loadFilteredPoolIndex(packs, isGemEntry, "Gemstone");
            const eligible = pool.filter(e => {
                const gemTier = e.flags?.['ionrift-quartermaster']?.gemMeta?.tier
                    ?? e.flags?.['ionrift-workshop']?.gemMeta?.tier;
                if (!eligibleTiers.includes(gemTier)) return false;
                const price = ItemPoolResolver._extractPrice(e);
                return price <= priceCeiling;
            });
            if (eligible.length === 0) return null;

            const weighted = [];
            for (const e of eligible) {
                const gemTier = e.flags?.['ionrift-quartermaster']?.gemMeta?.tier
                    ?? e.flags?.['ionrift-workshop']?.gemMeta?.tier
                    ?? 'Polished Common';
                const w = tierWeights[gemTier] ?? 1;
                for (let i = 0; i < w; i++) weighted.push(e);
            }

            const pick = this._terrainWeightedPick(weighted, theme);
            if (!pick) return null;

            const pickedTier = pick.flags?.['ionrift-quartermaster']?.gemMeta?.tier
                ?? pick.flags?.['ionrift-workshop']?.gemMeta?.tier
                ?? 'Polished Common';
            const pickPrice = ItemPoolResolver._extractPrice(pick);

            return {
                name: pick.name,
                type: 'loot',
                img: pick.img,
                price: pickPrice,
                weight: pick.system?.weight?.value ?? 0.1,
                rarity: pick.system?.rarity ?? 'common',
                quantity: this._resolveGemQuantity(pickedTier, pickPrice),
                _compendiumId: pick._id,
                _qmKind: "gemstones",
                _gemTier: pickedTier,
                sourceCompendium: pick._sourceCollection
            };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Gemstone pool query failed:", e.message);
        }
        return null;
    }

    /**
     * Stack count for a picked gem.
     *
     * Low-tier damaged variants are routinely scattered finds, so chips and
     * cheap polished common stones can stack into handfuls. Mid- and high-tier
     * gems are individual finds and never stack. Honest pricing is preserved;
     * this only changes the *count* the GM sees.
     *
     * @param {string} tier
     * @param {number} unitPrice
     * @returns {number}
     */
    static _resolveGemQuantity(tier, unitPrice) {
        if (tier === 'Chips & Fragments') {
            return 3 + Math.floor(Math.random() * 4);
        }
        if (tier === 'Polished Common' && unitPrice <= 12) {
            return 2 + Math.floor(Math.random() * 4);
        }
        if (tier === 'Semi-Precious') {
            return 1 + Math.floor(Math.random() * 4);
        }
        return 1 + Math.floor(Math.random() * 2);
    }

    /**
     * Pick an art object or trade good from the quartermaster-treasure compendium.
     * Tier 1 = trade goods + cheap art, Tier 2+ = broader price range.
     */
    static async _pickTreasure(theme, tierData, priceCeiling = Infinity) {
        const tier = tierData._tier ?? 1;
        // Price gates by tier (art objects go up to ~250 gp, trade goods up to 100 gp)
        const priceMax = Math.min([0, 80, 200, 500, 5000][tier] ?? 80, priceCeiling);
        const priceMin = [0, 10,  40, 100,  250][tier] ?? 10;

        try {
            const packs = resolveQmTreasurePacks();
            if (packs.length === 0) return null;
            const pool = await loadFilteredPoolIndex(packs, isTreasureEntry, "Treasure");
            const eligible = pool.filter(e => {
                const price = ItemPoolResolver._extractPrice(e);
                return price >= priceMin && price <= priceMax;
            });
            if (eligible.length === 0) return null;
            const pick = this._terrainWeightedPick([...eligible], theme);
            if (!pick) return null;
            return {
                name: pick.name,
                type: 'loot',
                img: pick.img,
                price: ItemPoolResolver._extractPrice(pick),
                weight: pick.system?.weight?.value ?? 0.5,
                rarity: 'common',
                quantity: 1,
                _compendiumId: pick._id,
                _qmKind: "treasure",
                sourceCompendium: pick._sourceCollection
            };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Treasure pool query failed:", e.message);
        }
        return null;
    }


    static async _pickTrinket(theme, tierData, priceCeiling = Infinity) {
        const tier = tierData._tier ?? 1;
        // Tier-gating: trinkets have a price ceiling per tier
        const trinketCeiling = Math.min([0, 25, 75, 200, 500][tier] ?? 25, priceCeiling);

        try {
            const packs = resolveQmCorePacks();
            if (packs.length === 0) return null;
            const pool = await loadFilteredPoolIndex(packs, isTrinketEntry, "Trinket");
            const eligible = pool.filter(e => {
                const price = ItemPoolResolver._extractPrice(e);
                return price <= trinketCeiling;
            });
            if (eligible.length === 0) return null;
            const pick = this._terrainWeightedPick([...eligible], theme);
            if (!pick) return null;
            return {
                name: pick.name,
                type: pick.type ?? 'loot',
                img: pick.img,
                price: ItemPoolResolver._extractPrice(pick),
                weight: pick.system?.weight?.value ?? 0.1,
                rarity: pick.system?.rarity ?? 'common',
                quantity: 1,
                _compendiumId: pick._id,
                _qmKind: "trinkets",
                sourceCompendium: pick._sourceCollection
            };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Trinket pool query failed:", e.message);
        }
        return null;
    }

    /**
     * Pick a scroll from the forged world scroll compendium at the appropriate level.
     * Falls back to the stub list if the compendium is unavailable.
     */
    static _tierScrollMinLevel(tier) {
        return TIER_SCROLL_MIN_LEVEL[tier] ?? 1;
    }

    static _maxScrollUniques(tier) {
        return TIER_SCROLL_MAX_UNIQUES[tier] ?? 4;
    }

    /**
     * @param {number} tier
     * @param {string} ownerTheme
     * @returns {number}
     */
    static _scrollSlotCap(tier, ownerTheme) {
        const table = SCROLL_SLOT_CAP[ownerTheme] ?? SCROLL_SLOT_CAP.default;
        return table[tier] ?? table[1] ?? 3;
    }

    /**
     * Max stack size for one scroll line at a given spell level.
     *
     * @param {number} spellLevel
     * @param {object} tierData
     * @returns {number}
     */
    static _scrollStackCap(spellLevel, tierData) {
        const tier = tierData._tier ?? 1;
        const minLevel = this._tierScrollMinLevel(tier);
        const maxLevel = tierData.scrollLevelMax ?? 2;
        const lvl = spellLevel ?? minLevel;
        if (lvl >= maxLevel - 1) return 2;
        const mid = minLevel + Math.max(1, Math.floor((maxLevel - minLevel) / 2));
        if (lvl >= mid) return 4;
        return 5;
    }

    /**
     * Replace excess scroll slots with other pool types so Arcana caches
     * do not ship a dozen unique one-offs.
     *
     * @param {string[]} drawnSlots
     * @param {number} tier
     * @param {string} ownerTheme
     * @param {Object} pool
     */
    static _trimExcessScrollSlots(drawnSlots, tier, ownerTheme, pool) {
        const cap = this._scrollSlotCap(tier, ownerTheme);
        let scrollCount = drawnSlots.filter(s => s === "scroll").length;
        if (scrollCount <= cap) return;

        const altPool = { ...pool };
        delete altPool.scroll;
        if (!Object.keys(altPool).length) altPool.consumable = 1;

        while (scrollCount > cap) {
            let replaced = false;
            for (let i = drawnSlots.length - 1; i >= 0; i--) {
                if (drawnSlots[i] !== "scroll") continue;
                drawnSlots[i] = this._weightedPoolDraw(altPool);
                scrollCount--;
                replaced = true;
                break;
            }
            if (!replaced) break;
        }
    }

    /**
     * Quantity for a newly picked scroll (stacks lower circles more often).
     *
     * @param {number} spellLevel
     * @param {object} tierData
     * @param {number} priceCeiling
     * @returns {number}
     */
    static _resolveScrollQuantity(spellLevel, tierData, priceCeiling = Infinity) {
        const stackCap = this._scrollStackCap(spellLevel, tierData);
        const unit = SCROLL_PRICES_BY_LEVEL[spellLevel] ?? 60;
        const maxByBudget = unit > 0 ? Math.max(1, Math.floor(priceCeiling / unit)) : 1;
        const maxLevel = tierData.scrollLevelMax ?? 2;
        const minLevel = this._tierScrollMinLevel(tierData._tier ?? 1);

        if (spellLevel >= maxLevel - 1) {
            const roll = 1 + Math.floor(Math.random() * 2);
            return Math.max(1, Math.min(roll, maxByBudget, stackCap));
        }

        const lowInCohort = spellLevel <= minLevel + 1;
        const minQty = lowInCohort ? 2 : 1;
        const roll = minQty + Math.floor(Math.random() * (stackCap - minQty + 1));
        return Math.max(1, Math.min(stackCap, maxByBudget, roll));
    }

    /**
     * @param {object} scroll
     */
    static _recalcScrollLinePrice(scroll) {
        const qty = Math.max(1, scroll.quantity ?? 1);
        const currentUnit = Number(scroll.unitPrice) > 0
            ? Number(scroll.unitPrice)
            : null;
        const unit = currentUnit
            ?? SCROLL_PRICES_BY_LEVEL[scroll.spellLevel]
            ?? (Number(scroll.price) > 0 ? Number(scroll.price) / qty : 60);
        scroll.quantity = qty;
        scroll.price = Math.round(unit * qty * 100) / 100;
        return scroll;
    }

    /**
     * Merge duplicate scrolls and cap how many unique lines remain.
     *
     * @param {object[]} items
     * @param {object} tierData
     * @returns {object[]}
     */
    static _consolidateScrollStacks(items, tierData) {
        if (!items?.length) return items;

        const scrolls = [];
        const other = [];
        for (const it of items) {
            if (it.spellName) {
                scrolls.push({ ...it, quantity: it.quantity ?? 1 });
            } else {
                other.push(it);
            }
        }
        if (scrolls.length <= 1) return items;

        const byKey = new Map();
        for (const s of scrolls) {
            const key = (s.spellName || s.name || "").toLowerCase().trim();
            if (!key) continue;
            if (byKey.has(key)) {
                const ex = byKey.get(key);
                ex.quantity += s.quantity ?? 1;
            } else {
                byKey.set(key, { ...s });
            }
        }

        const pool = [...byKey.values()].map(s => this._recalcScrollLinePrice(s));

        for (const s of pool) {
            const cap = this._scrollStackCap(s.spellLevel, tierData);
            if ((s.quantity ?? 1) > cap) {
                s.quantity = cap;
                this._recalcScrollLinePrice(s);
            }
        }

        pool.sort((a, b) => (b.spellLevel ?? 0) - (a.spellLevel ?? 0));
        return [...other, ...pool];
    }

    /** @param {...*} args */
    static _cacheDebug(...args) {
        if (game.settings?.get(MODULE_ID, "debug") === true) {
            Logger.log(MODULE_LABEL, ...args);
        }
    }

    /**
     * Spell level for a Scroll Forge / compendium index entry.
     * Forged dnd5e scrolls often keep template system.level at 1; scrollMeta
     * and dnd5e.spellLevel carry the real circle.
     *
     * @param {object} entry
     * @returns {number|null}
     */
    static _resolveScrollLevel(entry) {
        const qm = entry.flags?.["ionrift-quartermaster"]?.scrollMeta?.spellLevel;
        if (Number.isFinite(qm) && qm >= 1) return qm;

        const dnd = entry.flags?.dnd5e?.spellLevel?.value;
        if (Number.isFinite(dnd) && dnd >= 1) return dnd;

        const pf2eLvl = entry.system?.level?.value;
        if (Number.isFinite(pf2eLvl) && pf2eLvl >= 1) return pf2eLvl;

        const sys = entry.system?.level;
        if (typeof sys === "number" && sys >= 1) return sys;

        return null;
    }

    /**
     * Scroll price in gp, preferring the forged item's system data when present.
     *
     * D&D scrolls fall back to Quartermaster's SRD table; PF2e forged scrolls
     * carry PF2e treasure-table prices in system.price.
     *
     * @param {object} entry
     * @param {number} spellLevel
     * @returns {number}
     */
    static _resolveScrollPrice(entry, spellLevel) {
        const price = entry?.system?.price;
        const raw = price?.value ?? price;

        if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
            return raw;
        }

        if (raw && typeof raw === "object") {
            const gp = Number(raw.gp ?? 0);
            const sp = Number(raw.sp ?? 0);
            const cp = Number(raw.cp ?? 0);
            const pp = Number(raw.pp ?? 0);
            const total = (Number.isFinite(pp) ? pp * 10 : 0)
                + (Number.isFinite(gp) ? gp : 0)
                + (Number.isFinite(sp) ? sp / 10 : 0)
                + (Number.isFinite(cp) ? cp / 100 : 0);
            if (total > 0) return total;
        }

        return SCROLL_PRICES_BY_LEVEL[spellLevel] ?? 60;
    }

    /**
     * Effective gp ceiling for one scroll slot. Uses scroll-slot budget share and
     * aims at the upper mid-band of the tier, not only the tier floor price.
     *
     * @param {object} tierData
     * @param {number} slotPriceCeiling
     * @param {object} [opts]
     * @param {number} [opts.scrollSlotsRemaining]
     * @param {number} [opts.remainingBudget]
     * @returns {number}
     */
    static _scrollPriceCeiling(tierData, slotPriceCeiling, opts = {}) {
        const minLevel = this._tierScrollMinLevel(tierData._tier ?? 1);
        const maxLevel = tierData.scrollLevelMax ?? 2;
        const minPrice = SCROLL_PRICES_BY_LEVEL[minLevel] ?? 60;
        const aspireLevel = Math.min(
            maxLevel,
            minLevel + Math.max(1, Math.floor((maxLevel - minLevel) * 0.55))
        );
        const aspirePrice = SCROLL_PRICES_BY_LEVEL[aspireLevel] ?? minPrice;

        if (!Number.isFinite(slotPriceCeiling)) {
            return aspirePrice;
        }

        const scrollShare = Number.isFinite(opts.remainingBudget)
            ? opts.remainingBudget / Math.max(1, opts.scrollSlotsRemaining ?? 1)
            : slotPriceCeiling;

        const band = Math.min(aspirePrice, scrollShare);
        return Math.max(minPrice, band);
    }

    /**
     * Pick a scroll from a compendium index (testable without Foundry packs).
     *
     * @param {object[]|Collection} index
     * @param {object} tierData
     * @param {number} [priceCeiling]
     * @param {object} [opts]
     * @param {number} [opts.scrollSlotsRemaining]
     * @param {number} [opts.remainingBudget]
     * @returns {object|null}
     */
    static _pickScrollFromIndex(index, tierData, priceCeiling = Infinity, opts = {}) {
        const tier = tierData._tier ?? 1;
        const minLevel = this._tierScrollMinLevel(tier);
        let maxLevel = tierData.scrollLevelMax ?? 2;
        maxLevel = Math.max(minLevel, maxLevel);

        const effectiveCeiling = this._scrollPriceCeiling(tierData, priceCeiling, opts);



        const level = this._weightedScrollLevel(maxLevel, minLevel, tier);
        const entries = index?.contents ?? (Array.isArray(index) ? index : Array.from(index ?? []));

        const withinBudget = (e) => {
            const spellLevel = this._resolveScrollLevel(e);
            if (!spellLevel) return false;
            return this._resolveScrollPrice(e, spellLevel) <= effectiveCeiling;
        };

        const bandFilter = (e, targetLevel) => {
            const spellLevel = this._resolveScrollLevel(e);
            return spellLevel
                && spellLevel >= minLevel
                && spellLevel <= targetLevel
                && withinBudget(e);
        };

        let eligible = entries.filter(e => {
            const spellLevel = this._resolveScrollLevel(e);
            return spellLevel === level && spellLevel >= minLevel && withinBudget(e);
        });
        for (let tryLevel = level - 1; eligible.length === 0 && tryLevel >= minLevel; tryLevel--) {
            eligible = entries.filter(e => this._resolveScrollLevel(e) === tryLevel && withinBudget(e));
        }
        if (eligible.length === 0) {
            eligible = entries.filter(e => bandFilter(e, level));
        }

        if (eligible.length === 0) {
            this._cacheDebug("scroll pick failed", {
                tier, minLevel, maxLevel, rolledLevel: level,
                priceCeiling, effectiveCeiling, poolSize: entries.length
            });
            return null;
        }

        const partySpells = this._getPartyKnownSpells();
        const novel = eligible.filter(e => {
            const spellName = e.flags?.["ionrift-quartermaster"]?.scrollMeta?.spellName;
            return spellName && !partySpells.has(spellName.toLowerCase());
        });
        const finalPool = novel.length > 0 ? novel : eligible;

        const pick = this._pickScrollFromEligible(finalPool, level, minLevel);
        if (!pick) return null;

        const scrollMeta = pick.flags?.["ionrift-quartermaster"]?.scrollMeta ?? {};
        const pickedLevel = this._resolveScrollLevel(pick) ?? minLevel;
        const pickedPrice = this._resolveScrollPrice(pick, pickedLevel);
        return {
            name: pick.name,
            type: "consumable",
            img: pick.img ?? ItemMaskingHelper._genericIconFor("scroll"),
            price: pickedPrice,
            weight: 0.1,
            rarity: pickedLevel <= 2 ? "common" : pickedLevel <= 4 ? "uncommon" : "rare",
            quantity: 1,
            unitPrice: pickedPrice,
            spellLevel: pickedLevel,
            spellName: scrollMeta.spellName,
            _compendiumId: pick._id,
            sourceCompendium: pick.sourceCompendium ?? `world.${ScrollForge.WORLD_PACK_NAME}`
        };
    }

    static async _pickScroll(tierData, priceCeiling = Infinity, opts = {}) {
        const tier = tierData._tier ?? 1;
        const minLevel = this._tierScrollMinLevel(tier);

        try {
            const forgedId = `world.${ScrollForge.WORLD_PACK_NAME}`;
            const pack = game.packs.get(forgedId);
            if (pack) {
                const index = await pack.getIndex({
                    fields: ["name", "img", "system.price", "system.level", "flags"]
                });
                const item = this._pickScrollFromIndex(index, tierData, priceCeiling, opts);
                if (item) {
                    item.sourceCompendium = forgedId;
                    return item;
                }
            }
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Scroll compendium query failed:", e.message);
        }

        Logger.warn(MODULE_LABEL,
            `No scroll available (tier ${tier}, min ${minLevel}) - ` +
            `ensure Scroll Forge is compiled with spell sources enabled.`
        );
        return null;
    }

    /**
     * Pick one scroll from a filtered pool, favoring the target level and
     * higher circles when falling back.
     *
     * @param {object[]} eligible
     * @param {number} targetLevel
     * @param {number} [minLevel=1]
     * @returns {object|undefined}
     */
    static _pickScrollFromEligible(eligible, targetLevel, minLevel = 1) {
        if (!eligible.length) return undefined;

        const pool = eligible.filter(e => {
            const lvl = this._resolveScrollLevel(e);
            return lvl && lvl >= minLevel;
        });
        if (!pool.length) return undefined;

        const atTarget = pool.filter(e => this._resolveScrollLevel(e) === targetLevel);
        if (atTarget.length > 0) {
            return atTarget[Math.floor(Math.random() * atTarget.length)];
        }

        const withLevel = pool
            .map(e => ({ entry: e, lvl: this._resolveScrollLevel(e) }))
            .filter(x => x.lvl);
        if (!withLevel.length) return undefined;

        const maxLvl = Math.max(...withLevel.map(x => x.lvl));
        const topTier = withLevel.filter(x => x.lvl === maxLvl);
        if (topTier.length > 0 && Math.random() < 0.7) {
            return topTier[Math.floor(Math.random() * topTier.length)].entry;
        }

        const tickets = [];
        for (const { entry, lvl } of withLevel) {
            const w = Math.max(1, lvl);
            for (let i = 0; i < w; i++) tickets.push(entry);
        }
        return tickets[Math.floor(Math.random() * tickets.length)];
    }

    /**
     * Weighted scroll level selection. Mid-tier scrolls are favored over
     * edge levels (min and max) to produce a more balanced distribution.
     *
     * @param {number} maxLevel
     * @param {number} [minLevel=1]
     * @param {number} [tier=1]
     * @returns {number}
     */
    static _weightedScrollLevel(maxLevel, minLevel = 1, tier = 1) {
        if (maxLevel < 1) return 1;
        minLevel = Math.max(1, Math.min(minLevel, maxLevel));
        if (maxLevel <= minLevel) return maxLevel;

        const upperHalf = minLevel + Math.ceil((maxLevel - minLevel + 1) / 2);
        const weights = {};
        for (let i = minLevel; i <= maxLevel; i++) {
            let w = Math.min(i - minLevel + 1, maxLevel - i + 1);
            if (tier >= 2 && i >= upperHalf) w *= 2;
            if (tier >= 3 && i === maxLevel) w = Math.max(w, 3);
            weights[i] = w;
        }
        const total = Object.values(weights).reduce((a, b) => a + b, 0);
        let roll = Math.random() * total;
        for (const [lvl, w] of Object.entries(weights)) {
            roll -= w;
            if (roll <= 0) return parseInt(lvl, 10);
        }
        return maxLevel;
    }

    /**
     * Collects all known spell names from party characters.
     * Uses SystemAdapter when ionrift-lib is available, with DnD5e fallback.
     */
    static _getPartyKnownSpells() {
        const SA = game.ionrift?.library?.system;
        const known = new Set();
        const actors = game.ionrift?.library?.party?.getMembers()
            ?? game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
        for (const actor of actors) {
            if (SA) {
                for (const spell of SA.getKnownSpells(actor)) known.add(spell);
            } else {
                for (const item of actor.items) {
                    if (item.type === "spell") known.add(item.name.toLowerCase());
                }
            }
        }
        return known;
    }

    /**
     * Terrain-weighted random pick from a pool of compendium index entries.
     *
     * Terrain-bound items (non-empty `terrain` flag) are exclusive: they
     * never appear outside their listed terrains. Items with no terrain flag
     * are universal and eligible everywhere.
     *
     * When both terrain-matched and generic entries are eligible, the picker
     * restricts to the matched subset with {@link FLAVOR_TERRAIN_SPECIFIC_BIAS}
     * probability so overlay kits are not drowned out by the core pool.
     *
     * @param {Object[]} pool - Array of compendium index entries
     * @param {string} theme - Current terrain theme
     * @returns {Object|undefined} The selected item
     */
    static _terrainWeightedPick(pool, theme) {
        if (pool.length === 0) return undefined;
        if (!theme) return pool[Math.floor(Math.random() * pool.length)];

        const eligible = pool.filter(item => flavorEligibleForTheme(item, theme));
        if (eligible.length === 0) return undefined;

        const specific = eligible.filter(item => flavorIsTerrainBound(item));
        const generic = eligible.filter(item => !flavorIsTerrainBound(item));

        let activePool = eligible;
        if (specific.length > 0 && generic.length > 0
            && Math.random() < FLAVOR_TERRAIN_SPECIFIC_BIAS) {
            activePool = specific;
        }

        const weighted = activePool.map(item => ({
            item,
            weight: flavorMatchesTerrain(item, theme) ? FLAVOR_TERRAIN_MATCH_MULTIPLIER : 1
        }));
        const total = weighted.reduce((sum, w) => sum + w.weight, 0);
        let roll = Math.random() * total;
        for (const { item, weight } of weighted) {
            roll -= weight;
            if (roll <= 0) return item;
        }
        return weighted[weighted.length - 1].item;
    }

    /**
     * Pick a consumable, biased toward actual potions and elixirs.
     * Resolves the full pool then splits it: 70% chance to draw from
     * the potion sub-pool, 30% from everything else.
     */
    static async _pickConsumable(theme, tierData, tables, priceCeiling = Infinity, pickOpts = {}) {
        // Gather the full consumable pool
        let pool = [];
        try {
            pool = await ItemPoolResolver.resolve({
                slotType: "consumable",
                tier: tierData._tier ?? 1,
                theme,
                fallbackTables: tables
            });
        } catch (e) {
            Logger.warn(MODULE_LABEL, "ItemPoolResolver failed for consumable:", e.message);
        }

        // If resolver returned nothing, no consumables available for this theme/tier
        // (compendiums are the sole source of truth)

        if (!pool.length) return null;

        // Price ceiling
        const affordable = pool.filter(p => (p.price ?? 0) <= priceCeiling);
        let finalPool = affordable.length > 0 ? affordable : pool;

        if (pickOpts.maxEffectiveWeight !== undefined && pickOpts.maxEffectiveWeight < Infinity) {
            const maxW = pickOpts.maxEffectiveWeight;
            const weightOf = (item) => {
                if (typeof pickOpts.effectiveWeightFn === "function") {
                    return pickOpts.effectiveWeightFn(item.weight, item.type, item.system);
                }
                return item.weight ?? 0;
            };
            const lightPool = finalPool.filter(i => weightOf(i) <= maxW);
            if (lightPool.length > 0) finalPool = lightPool;
        }

        // Split: potions vs everything else
        const isPotionLike = (item) => {
            const n = (item.name ?? "").toLowerCase();
            return n.includes("potion") || n.includes("elixir") || n.includes("philter")
                || n.includes("oil of") || n.includes("antitoxin")
                || (item.subtype ?? "").toLowerCase() === "potion";
        };

        const potions = finalPool.filter(isPotionLike);
        const other   = finalPool.filter(i => !isPotionLike(i));

        // Potion-like vs food/rations; branch weight scales with healing slider.
        const SA = game.ionrift?.library?.system;
        const situational = SA?.getSituationalConsumables?.() ?? new Set();
        const cacheTier = tierData._tier ?? 1;
        const healFreq = game.settings?.get(MODULE_ID, "healingPotionFrequency") ?? 1.0;

        const _toConsumablePick = (pick) => ({
            name: pick.name,
            type: "consumable",
            subtype: pick.subtype ?? "",
            img: pick.img ?? "icons/consumables/potions/potion-bottle-corked-red.webp",
            price: pick.price ?? 0,
            weight: pick.weight || 0.1,
            rarity: pick.rarity ?? "common",
            quantity: 1,
            sourceCompendium: pick.sourceCompendium,
            _compendiumId: pick._compendiumId
        });

        const _baseTickets = (item) =>
            situational.has((item.name ?? "").toLowerCase()) ? 1 : 3;

        const _weightedPickFrom = (arr) => {
            if (!arr.length) return null;
            const tickets = [];
            for (const item of arr) {
                let count = _baseTickets(item);
                if (PotionEnrichment.isHealingPotion(item.name)) {
                    const tierWeight = CacheGenerator._healingPotionTierWeight(
                        item.name, cacheTier, healFreq
                    );
                    count = Math.max(1, Math.round(count * tierWeight));
                }
                for (let i = 0; i < count; i++) tickets.push(item);
            }
            return tickets[Math.floor(Math.random() * tickets.length)];
        };

        /** Healing vs oils/elixirs within the potion-like sub-pool. */
        const _pickFromPotionLikePool = (potionArr) => {
            const healing = potionArr.filter(p => PotionEnrichment.isHealingPotion(p.name));
            const other = potionArr.filter(p => !PotionEnrichment.isHealingPotion(p.name));

            if (!healing.length) return _weightedPickFrom(other);
            if (!other.length) return _weightedPickFrom(healing);

            const share = CacheGenerator._healingPotionShare(healFreq);
            const branch = Math.random() < share ? healing : other;
            return _weightedPickFrom(branch);
        };

        const healingInPool = finalPool.filter(p => PotionEnrichment.isHealingPotion(p.name));

        if (healingInPool.length > 0) {
            const directShare = CacheGenerator._healingPotionDirectShare(healFreq);
            if (Math.random() < directShare) {
                const direct = await CacheGenerator._pickHealingPotionOnly(
                    theme, tierData, tables, priceCeiling, healFreq, healingInPool
                );
                if (direct) return direct;
            }
        }

        const potionBranchChance = Math.min(0.92, 0.55 + 0.10 * Math.max(0, healFreq));

        let pick;
        if (potions.length > 0 && (other.length === 0 || Math.random() < potionBranchChance)) {
            pick = _pickFromPotionLikePool(potions);
        } else {
            pick = _weightedPickFrom(finalPool);
        }

        if (!pick) return null;
        return _toConsumablePick(pick);
    }

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
            ?? await CacheGenerator._resolveHealingPotionPool(theme, tierData, tables, priceCeiling);
        if (!healing.length) return null;

        const cacheTier = tierData._tier ?? 1;
        const freq = healFreq ?? game.settings?.get(MODULE_ID, "healingPotionFrequency") ?? 1.0;
        const SA = game.ionrift?.library?.system;
        const situational = SA?.getSituationalConsumables?.() ?? new Set();

        const pick = CacheGenerator._weightedHealingPick(healing, cacheTier, freq, situational);
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
            const tierWeight = CacheGenerator._healingPotionTierWeight(
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
     * @returns {number} 0–1
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
     * @returns {number} 0–0.95
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
     * a single item.  Detection is name-pattern first so it works against
     * plain SRD index entries that may not expose system.properties.
     *
     * Covered items and their typical 5e unit prices:
     *   dart      0.05 gp  (already stacks via price logic, but qty is too low)
     *   javelin   0.5  gp  (would stack, but slow; we want explicit control)
     *   handaxe   5    gp  (price gate blocks stacking entirely — needs override)
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
     *   darts    4d4  → avg 10, range 4-16  (light, cheap, pocketable by the handful)
     *   javelins 2d4  → avg  5, range 2-8   (5e standard soldier kit)
     *   handaxes 1d3  → avg  2, range 1-3   (valuable enough to carry 1-3)
     *   generic  1d4  → avg  2, range 1-4   (safe default for unknown thrown)
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
     * Pick a mundane/trade goods item from enabled compendiums.
     */
    static async _pickMundane(theme, tierData, tables, priceCeiling = Infinity, pickOpts = {}) {
        try {
            const item = await ItemPoolResolver.pickRandom({
                slotType: "mundane",
                tier: tierData._tier ?? 1,
                theme,
                fallbackTables: tables,
                ownerTheme: pickOpts.ownerTheme,
                maxEffectiveWeight: pickOpts.maxEffectiveWeight,
                effectiveWeightFn: pickOpts.effectiveWeightFn,
            });
            if (item) return { ...item, _qmKind: "mundane", quantity: 1 };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "ItemPoolResolver failed for mundane:", e.message);
        }
        return null;
    }


    /**
     * Check if an item is on the GM ban list and should be excluded from generation.
     *
     * @param {string} itemName
     * @returns {Promise<boolean>}
     */
    static async _isBanned(itemName) {
        if (!itemName) return false;
        try {
            const banSet = await SignatureLedger.getBanSet();
            return banSet.has(itemName.toLowerCase());
        } catch {
            return false; // Never block generation on ledger errors
        }
    }

    // ── Dice Rolling ──────────────────────────────────────────────

    static async _rollGold(formula) {
        try {
            const roll = await new Roll(formula).evaluate();
            return Math.floor(roll.total);
        } catch {
            return 5;
        }
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
    static MODEST_STACK_MAX = 5;

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

    /** Minimum unit weight (lb) treated as a single live animal, never stacked. */
    static LIVESTOCK_WEIGHT_FLOOR = 100;

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
        // (darts 4d4, javelins 2d4, handaxes 1d3).  Checked before the price
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

    // ── Chat Output ───────────────────────────────────────────────

    /** @type {Map<string, Object>} Pending cache results awaiting user action */
    static _pendingCaches = new Map();
    /**
     * Splits a raw GP value into a randomized mix of standard 5e coin denominations.
     */
    static _distributeCoinage(totalGp) {
        if (!totalGp || totalGp <= 0) return null;
        
        let remainingCp = Math.floor(totalGp * 100);
        const coins = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
        
        // 1. PP alloc (only sometimes when large enough)
        if (remainingCp >= 1000 && Math.random() < 0.6) {
            const maxPp = Math.floor(remainingCp / 1000);
            const ppAlloc = Math.floor(maxPp * (0.1 + Math.random() * 0.4));
            coins.pp = ppAlloc;
            remainingCp -= (ppAlloc * 1000);
        }
        
        // 2. EP alloc (rarely, small amounts)
        if (remainingCp >= 50 && Math.random() < 0.2) {
            const epAlloc = Math.floor(Math.random() * 10) + 1;
            const cost = epAlloc * 50;
            if (cost <= remainingCp * 0.2) {
                coins.ep = epAlloc;
                remainingCp -= cost;
            }
        }
        
        // 3. SP and CP (small handfuls)
        const spAlloc = Math.floor(Math.random() * 50);
        if (spAlloc * 10 <= remainingCp * 0.2) {
            coins.sp = spAlloc;
            remainingCp -= spAlloc * 10;
        }
        
        const cpAlloc = Math.floor(Math.random() * 100);
        if (cpAlloc <= remainingCp * 0.1) {
            coins.cp = cpAlloc;
            remainingCp -= cpAlloc;
        }
        
        // 4. GP takes the bulk
        const gpAlloc = Math.floor(remainingCp / 100);
        coins.gp = gpAlloc;
        remainingCp -= (gpAlloc * 100);
        
        // Dump absolute remainder into SP/CP
        if (remainingCp >= 10) {
            const extraSp = Math.floor(remainingCp / 10);
            coins.sp += extraSp;
            remainingCp -= extraSp * 10;
        }
        if (remainingCp > 0) {
            coins.cp += remainingCp;
        }
        
        for (const k of Object.keys(coins)) {
            if (coins[k] === 0) delete coins[k];
        }
        
        return Object.keys(coins).length > 0 ? coins : null;
    }

    static async _postChatCard(result) {
        const cacheId = foundry.utils.randomID();
        this._pendingCaches.set(cacheId, result);

        const { gold, items, meta: metaBase, coinage } = result;
        const meta = {
            ...metaBase,
            themeDisplay: metaBase.theme.charAt(0).toUpperCase() + metaBase.theme.slice(1)
        };
        const coinageRows = coinage
            ? ["pp", "gp", "ep", "sp", "cp"].filter(d => coinage[d]).map(d => ({ denom: d, amount: coinage[d] }))
            : [];

        const signatures  = items.filter(i => i.isSignature);
        const scrolls     = items.filter(i => i.spellName);
        const weapons     = items.filter(i => (i.type === "weapon" || i.type === "equipment") && !i.isSignature);
        const isKind = (i, role) => i._qmKind === role || isQmPackRole(i.sourceCompendium, role);
        const treasures   = items.filter(i => isKind(i, "treasure"));
        const trinkets    = items.filter(i => isKind(i, "trinkets"));
        const consumables = items.filter(i => i.type === "consumable" && !i.spellName && !i.isSignature);
        const mundane     = items.filter(i =>
            !i.isSignature && !i.spellName
            && i.type !== "weapon" && i.type !== "equipment"
            && !isKind(i, "gemstones")
            && !isKind(i, "treasure")
            && !isKind(i, "trinkets")
            && (i.type === "loot" || i.type === "tool" || !i.type)
        );
        const totalValueRaw = gold + items.reduce((s, i) => s + (i.price ?? 0), 0);
        const totalValue = roundCoinGp(totalValueRaw);
        const labelItems = (arr) => arr.map(i => withCoinPriceLabel(i));

        const html = await renderTemplate(
            `modules/ionrift-quartermaster/templates/partials/cache-chat-card.hbs`,
            { meta, gold, coinage, coinageRows, hasCoinage: coinageRows.length > 0,
                showGoldBlock: gold > 0,
                cacheId, totalValue, totalValueLabel: formatCoinPrice(totalValueRaw),
                itemCount: items.length,
                signatures, scrolls, weapons,
                treasures: labelItems(treasures),
                trinkets: labelItems(trinkets),
                consumables: labelItems(consumables),
                mundane: labelItems(mundane) }
        );

        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: "Ionrift Quartermaster" }),
            content: html,
            whisper: game.users.filter(u => u.isGM).map(u => u.id)
        });
    }

    /**
     * Binds click handlers on cache chat card buttons.
     * Called from a renderChatMessage hook in module.js.
     */
    static bindChatListeners(html) {
        html.find(".ionrift-cache-create").on("click", async (event) => {
            const cacheId = event.currentTarget.dataset.cacheId;
            const result = this._pendingCaches.get(cacheId);
            if (!result) {
                ui.notifications.warn("Cache data expired. Generate a new cache.");
                return;
            }
            await this.createCacheItems(result);
            // Disable button after use
            $(event.currentTarget).prop("disabled", true).text("Created");
            this._pendingCaches.delete(cacheId);
        });
    }

    /**
     * Creates all items from a cache result into the world Items directory.
     * Called from the chat card button.
     * @param {Object} cacheResult - Output from generate()
     */
    static async createCacheItems(cacheResult, options = {}) {
        if (!game.user.isGM) {
            ui.notifications.warn("Only the GM can create cache items.");
            return;
        }

        const items = cacheResult.items ?? [];
        const { wrapInContainer = false, containerTerrain = 'any' } = options;

        // Create a folder for this cache
        const folderName = `Cache: ${cacheResult.meta?.cacheLabel ?? "Loot"} (${new Date().toLocaleDateString()})`;
        let folder = game.folders.find(f => f.name === folderName && f.type === "Item");
        if (!folder) {
            folder = await Folder.create({ name: folderName, type: "Item", parent: null });
        }

        // Build item data for all generated items
        const toCreate = items.map(item => {
            const base = {
                name: item.name,
                type: item.type ?? "loot",
                img: item.img ?? "icons/svg/item-bag.svg",
                folder: folder.id,
                system: {
                    quantity: item.quantity ?? 1,
                    price: { value: item.price ?? 0, denomination: "gp" },
                    rarity: item.rarity ?? "common",
                    description: { value: `<p>Generated from a ${cacheResult.meta?.cacheLabel ?? "loot cache"}.</p>` }
                },
                flags: {
                    "ionrift-quartermaster": {
                        ...(item.flags?.["ionrift-quartermaster"] || {}),
                        mintBatch: cacheResult.meta?.mintBatch
                    }
                }
            };

            if (item._isMagical) {
                getQuartermasterAdapter().applyCacheMask(base, {
                    baseItemName: item._baseItemName,
                    mundaneDesc: item._mundaneDesc,
                    obscuredImg: item._obscuredImg,
                    sourceImg: item._maskSourceImg
                });
            }

            return base;
        });

        // Add gold as a loot item
        if (cacheResult.gold > 0) {
            if (cacheResult.coinage) {
                for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                    if (cacheResult.coinage[denom]) {
                        toCreate.push({
                            name: `Coins (${denom.toUpperCase()})`,
                            type: "loot",
                            img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                            folder: folder.id,
                            system: { price: { value: cacheResult.coinage[denom], denomination: denom } }
                        });
                    }
                }
            } else {
                toCreate.push({
                    name: "Coin Purse",
                    type: "loot",
                    img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                    folder: folder.id,
                    system: {
                        quantity: 1,
                        price: { value: cacheResult.gold, denomination: "gp" },
                        description: { value: `<p>${cacheResult.gold} gold pieces.</p>` }
                    }
                });
            }
        }

        if (wrapInContainer && toCreate.length > 0) {
            // Pick a terrain-matched container from quartermaster-containers
            const container = await this._pickContainer(containerTerrain);
            if (container) {
                // Create the container, then place all generated items inside it
                const containerData = [{
                    name: container.name,
                    type: "container",
                    img: container.img,
                    folder: folder.id,
                    system: container.system ?? {}
                }];
                CacheGenerator._guardMintSources(containerData);
                const [containerItem] = await Item.create(containerData);
                // Place all items inside the container using dnd5e container system
                const innerItems = toCreate.map(i => ({ ...i, folder: folder.id, system: { ...i.system, container: containerItem.id } }));
                CacheGenerator._guardMintSources(innerItems);
                await Item.create(innerItems);
                ui.notifications.info(`Created "${container.name}" with ${innerItems.length} items in "${folderName}".`);
                return;
            }
        }

        CacheGenerator._guardMintSources(toCreate);
        const created = await Item.create(toCreate);
        ui.notifications.info(`Created ${created.length} items in "${folderName}".`);
    }

    /**
     * Pick a terrain and owner-theme appropriate container from quartermaster-containers.
     * Accepts ownerTheme for auto-matching and contentWeightLbs for capacity preference.
     * Returns a plain metadata object (not a Foundry document).
     */
    static async _pickContainer(ownerTheme = 'unspecified', theme = 'any', contentWeightLbs = 0, tier = 1) {
        try {
            const pool = await loadContainerPoolIndex();
            if (pool.length === 0) return null;

            const tierMin = this._tierContainerMinLbs(tier);
            const requiredCap = Math.max(contentWeightLbs, tierMin);

            // Primary filter: matches ownerTheme. Entries without an
            // ownerThemes array are treated as universal so the bundled
            // compendium (which has cacheTypes but no ownerThemes) stays
            // eligible alongside overlay entries that do declare it.
            const byTheme = pool.filter(e => containerOwnerThemeMatches(e, ownerTheme));

            // If no theme match, fall back to all containers (only possible
            // when every entry in the pool declares an ownerThemes set that
            // excludes the active theme).
            const activePool = byTheme.length > 0 ? byTheme : pool;

            // Secondary filter: terrain-matched (named or universal "any"),
            // then blend bundled-module entries with overlay-shipped entries
            // to avoid a content overlay shadowing the bundled compendium.
            const byTerrain = activePool.filter(e => containerMatchesTerrain(e, theme));
            const terrainPool = byTerrain.length > 0
                ? selectBlendedContainerPool(byTerrain)
                : activePool;

            // Prefer containers with sufficient capacity for tier and content weight
            const withCapacity = terrainPool.filter(e => {
                const cap = e.flags?.['ionrift-quartermaster']?.containerMeta?.capacityLbs ?? 0;
                return cap >= requiredCap;
            });
            let pickPool = withCapacity.length > 0 ? withCapacity : terrainPool.filter(e => {
                const cap = e.flags?.['ionrift-quartermaster']?.containerMeta?.capacityLbs ?? 0;
                return cap >= contentWeightLbs;
            });
            if (pickPool.length === 0 && terrainPool.length > 0) {
                const ranked = [...terrainPool].sort((a, b) => {
                    const capA = a.flags?.["ionrift-quartermaster"]?.containerMeta?.capacityLbs ?? 0;
                    const capB = b.flags?.["ionrift-quartermaster"]?.containerMeta?.capacityLbs ?? 0;
                    return capB - capA;
                });
                const bestCap = ranked[0].flags?.["ionrift-quartermaster"]?.containerMeta?.capacityLbs ?? 0;
                pickPool = ranked.filter(e =>
                    (e.flags?.["ionrift-quartermaster"]?.containerMeta?.capacityLbs ?? 0) >= bestCap
                );
            }

            if (pickPool.length === 0) return null;

            if (ownerTheme === "armaments") {
                const sturdy = pickPool.filter(e => {
                    const cap = e.flags?.["ionrift-quartermaster"]?.containerMeta?.capacityLbs ?? 0;
                    return cap >= CacheGenerator.CONTAINER_STURDY_MIN_LBS;
                });
                if (sturdy.length > 0) pickPool = sturdy;
            }

            if (pickPool.length === 0) return null;
            const pick = pickPool[Math.floor(Math.random() * pickPool.length)];

            const emptyWeightLbs = ItemPoolResolver._extractWeight(pick);
            const packId = pick._sourceCollection ?? `${MODULE_ID}.${PACK_SUFFIX.containers}`;

            return {
                name: pick.name,
                img: pick.img,
                type: pick.type ?? "container",
                capacityLbs: pick.flags?.['ionrift-quartermaster']?.containerMeta?.capacityLbs ?? 0,
                emptyWeightLbs,
                _compendiumId: pick._id,
                sourceCompendium: packId,
                ...(pick.system
                    ? { system: foundry.utils.deepClone(pick.system) }
                    : {})
            };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Container pick failed:", e.message);
            return null;
        }
    }

    /**
     * Creates all items from a cache result into the world Items directory.
     * Fallback path used when Item Piles is not installed.
     * @param {Object} result - Output from generate()
     */
    static async _addToItems(result) {
        if (!game.user.isGM) {
            ui.notifications.warn("Only the GM can create cache items.");
            return { count: 0 };
        }

        const items = result.items ?? [];
        const folderName = `Cache: ${result.meta?.cacheLabel ?? "Loot"} (${new Date().toLocaleDateString()})`;
        let folder = game.folders.find(f => f.name === folderName && f.type === "Item");
        if (!folder) {
            folder = await Folder.create({ name: folderName, type: "Item", parent: null });
        }

        const toCreate = items.map(item => {
            const data = {
                name: item.name,
                type: item.type ?? "loot",
                img: item.img ?? "icons/svg/item-bag.svg",
                folder: folder.id,
                system: {
                    quantity: item.quantity ?? 1,
                    price: { value: item.price ?? 0, denomination: "gp" },
                    weight: { value: item.weight ?? 0, units: "lb" },
                    rarity: item.rarity ?? "common",
                    description: { value: `<p>Generated from a ${result.meta?.cacheLabel ?? "loot cache"}.</p>` }
                }
            };

            // Apply identification masking for magical items
            if (item._isMagical) {
                getQuartermasterAdapter().applyCacheMask(data, {
                    baseItemName: item._baseItemName,
                    mundaneDesc: item._mundaneDesc,
                    obscuredImg: item._obscuredImg,
                    sourceImg: item._maskSourceImg
                });
            }

            return data;
        });

        // Add gold as loot items
        if (result.gold > 0) {
            if (result.coinage) {
                for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                    if (result.coinage[denom]) {
                        toCreate.push({
                            name: `Coins (${denom.toUpperCase()})`,
                            type: "loot",
                            img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                            folder: folder.id,
                            system: { price: { value: result.coinage[denom], denomination: denom } }
                        });
                    }
                }
            } else {
                toCreate.push({
                    name: "Coin Purse",
                    type: "loot",
                    img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                    folder: folder.id,
                    system: {
                        quantity: 1,
                        price: { value: result.gold, denomination: "gp" },
                        description: { value: `<p>${result.gold} gold pieces.</p>` }
                    }
                });
            }
        }

        CacheGenerator._guardMintSources(toCreate);
        const created = await Item.create(toCreate);

        ui.notifications.info(`Cache added to Items directory: ${created.length} items in "${folderName}".`);
        
        return { count: created.length };
    }
}
