import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";

import { ItemPoolResolver } from "../loot/ItemPoolResolver.js";
import { ItemMaskingHelper } from "../identify/ItemMaskingHelper.js";
import { ItemClassifier } from "../workshop/ItemClassifier.js";
import { AmmoTypeRegistry } from "../workshop/AmmoTypeRegistry.js";
import { SignatureLedger } from "../progression/SignatureLedger.js";
import { ScrollForge } from "../scroll/ScrollForge.js";
import { TerrainDataRegistry } from "../loot/TerrainDataRegistry.js";
import { PotionEnrichment } from "../scroll/PotionEnrichment.js";
import { roundCoinGp, formatCoinPrice, withCoinPriceLabel } from "../workshop/CoinFormat.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { getQuartermasterAdapter } from "../../adapters/getAdapter.js";
import {
    CacheScrollLogic,
    SCROLL_PRICES_BY_LEVEL,
    TIER_SCROLL_MIN_LEVEL,
    TIER_SCROLL_MAX_UNIQUES
} from "./CacheScrollLogic.js";
import { CacheAmmoLogic } from "./CacheAmmoLogic.js";
import { CacheHealingLogic } from "./CacheHealingLogic.js";
import { CacheQuantityLogic } from "./CacheQuantityLogic.js";
import { CacheCoinageLogic } from "./CacheCoinageLogic.js";
import {
    PACK_SUFFIX,
    isQmPackRole,
    resolveQmAnyPacks,
    resolveQmContainerPacks,
    resolveQmTreasurePacks,
    resolveQmGemPacks,
    resolveQmCorePacks,
    parseDiscoveryPhrases,
    containerMatchesTerrain,
    containerIsTerrainSpecific,
    isBundledContainerEntry,
    containerOwnerThemeMatches,
    CONTAINER_BUNDLED_BIAS,
    FLAVOR_TERRAIN_MATCH_MULTIPLIER,
    FLAVOR_TERRAIN_SPECIFIC_BIAS,
    flavorMatchesTerrain,
    flavorIsTerrainBound,
    flavorEligibleForTheme,
    selectBlendedContainerPool,
    loadContainerPoolIndex,
    loadFilteredPoolIndex,
    isTreasureEntry,
    isTrinketEntry,
    isGemEntry
} from "./CachePackIndex.js";



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
 * Compendium suffixes that identify Quartermaster pack roles regardless of
 * delivery (module manifest packs vs world packs materialised from overlays).
 */
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
        const defaultTier = game.settings?.get(MODULE_ID, "defaultCacheTier") ?? 1;
        const defaultTheme = game.settings?.get(MODULE_ID, "defaultCacheTheme") ?? "dungeon";

        const tier = Math.clamp(options.tier ?? defaultTier, 1, 4);
        const theme = options.theme ?? defaultTheme;
        const ownerTheme = options.ownerTheme ?? "unspecified";

        // Economy multiplier (GM configurable, default 1.0)
        const economy = game.settings?.get(MODULE_ID, "lootEconomy") ?? 1.0;
        const magicMult = game.settings?.get(MODULE_ID, "magicFrequency") ?? 1.0;

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

    static clearCacheGold(cacheResult) { return CacheCoinageLogic.clearCacheGold(cacheResult); }
    static applyBudgetFloor(cacheResult, budgetMin = 0, budgetMax = null) {
        return CacheCoinageLogic.applyBudgetFloor(cacheResult, budgetMin, budgetMax);
    }
    static _syncCacheCoinage(cacheResult) { return CacheCoinageLogic._syncCacheCoinage(cacheResult); }

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

        const economy = game.settings.get(MODULE_ID, "lootEconomy") ?? 1.0;
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
                const cat = e.flags?.[MODULE_ID]?.coreMeta?.category;
                return ['Cultural Weapons', 'Cultural Armor', 'Mastercraft'].includes(cat);
            };
            const pool = await loadFilteredPoolIndex(packs, kindFilter, "Mastercraft");
            const eligible = pool.filter(e => {
                const price = ItemPoolResolver._extractPrice(e);
                return price >= priceMin && price <= priceMax;
            });

            if (eligible.length === 0) return null;

            const themed = eligible.filter(e => {
                const mat = e.flags?.[MODULE_ID]?.coreMeta?.material ?? '';
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

    static MAGIC_AMMO_CHANCE = CacheAmmoLogic.MAGIC_AMMO_CHANCE;
    static MAGIC_AMMO_BONUS_WEIGHTS = CacheAmmoLogic.MAGIC_AMMO_BONUS_WEIGHTS;
    static MAGIC_AMMO_QTY_DICE = CacheAmmoLogic.MAGIC_AMMO_QTY_DICE;


    static async _pickAmmo(theme, tierData, tables, priceCeiling = Infinity, pickOpts = {}) {
        return CacheAmmoLogic._pickAmmo(theme, tierData, tables, priceCeiling, pickOpts);
    }

    static _pickMagicalAmmo(magicalPool, tier, pickOpts = {}) {
        return CacheAmmoLogic._pickMagicalAmmo(magicalPool, tier, pickOpts);
    }

    static _magicalAmmoQuantity(pick, tier) {
        return CacheAmmoLogic._magicalAmmoQuantity(pick, tier);
    }

    static _tiltedAmmoPick(pool, ammoConfig) {
        return CacheAmmoLogic._tiltedAmmoPick(pool, ammoConfig);
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
                const gemTier = e.flags?.[MODULE_ID]?.gemMeta?.tier
                    ?? e.flags?.['ionrift-workshop']?.gemMeta?.tier;
                if (!eligibleTiers.includes(gemTier)) return false;
                const price = ItemPoolResolver._extractPrice(e);
                return price <= priceCeiling;
            });
            if (eligible.length === 0) return null;

            const weighted = [];
            for (const e of eligible) {
                const gemTier = e.flags?.[MODULE_ID]?.gemMeta?.tier
                    ?? e.flags?.['ionrift-workshop']?.gemMeta?.tier
                    ?? 'Polished Common';
                const w = tierWeights[gemTier] ?? 1;
                for (let i = 0; i < w; i++) weighted.push(e);
            }

            const pick = this._terrainWeightedPick(weighted, theme);
            if (!pick) return null;

            const pickedTier = pick.flags?.[MODULE_ID]?.gemMeta?.tier
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

    static _tierScrollMinLevel(tier) { return CacheScrollLogic._tierScrollMinLevel(tier); }
    static _maxScrollUniques(tier) { return CacheScrollLogic._maxScrollUniques(tier); }
    static _scrollSlotCap(tier, ownerTheme) { return CacheScrollLogic._scrollSlotCap(tier, ownerTheme); }
    static _scrollStackCap(spellLevel, tierData) { return CacheScrollLogic._scrollStackCap(spellLevel, tierData); }
    static _trimExcessScrollSlots(drawnSlots, tier, ownerTheme, pool) {
        return CacheScrollLogic._trimExcessScrollSlots(drawnSlots, tier, ownerTheme, pool, this);
    }
    static _resolveScrollQuantity(spellLevel, tierData, priceCeiling = Infinity) {
        return CacheScrollLogic._resolveScrollQuantity(spellLevel, tierData, priceCeiling);
    }
    static _recalcScrollLinePrice(scroll) { return CacheScrollLogic._recalcScrollLinePrice(scroll); }
    static _consolidateScrollStacks(items, tierData) { return CacheScrollLogic._consolidateScrollStacks(items, tierData); }

    /** @param {...*} args */
    static _cacheDebug(...args) {
        if (game.settings?.get(MODULE_ID, "debug") === true) {
            Logger.log(MODULE_LABEL, ...args);
        }
    }

    static _resolveScrollLevel(entry) { return CacheScrollLogic._resolveScrollLevel(entry); }
    static _resolveScrollPrice(entry, spellLevel) { return CacheScrollLogic._resolveScrollPrice(entry, spellLevel); }
    static _scrollPriceCeiling(tierData, slotPriceCeiling, opts = {}) {
        return CacheScrollLogic._scrollPriceCeiling(tierData, slotPriceCeiling, opts);
    }
    static _pickScrollFromIndex(index, tierData, priceCeiling = Infinity, opts = {}) {
        return CacheScrollLogic._pickScrollFromIndex(index, tierData, priceCeiling, opts);
    }
    static async _pickScroll(tierData, priceCeiling = Infinity, opts = {}) {
        return CacheScrollLogic._pickScroll(tierData, priceCeiling, opts);
    }
    static _pickScrollFromEligible(eligible, targetLevel, minLevel = 1) {
        return CacheScrollLogic._pickScrollFromEligible(eligible, targetLevel, minLevel);
    }
    static _weightedScrollLevel(maxLevel, minLevel = 1, tier = 1) {
        return CacheScrollLogic._weightedScrollLevel(maxLevel, minLevel, tier);
    }
    static _getPartyKnownSpells() { return CacheScrollLogic._getPartyKnownSpells(); }

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

    static _scaleOwnerSlotPool(basePool, healFreq) { return CacheHealingLogic._scaleOwnerSlotPool(basePool, healFreq); }
    static _healingBonusRollCount(freq) { return CacheHealingLogic._healingBonusRollCount(freq); }
    static async _resolveHealingPotionPool(theme, tierData, tables, priceCeiling = Infinity) {
        return CacheHealingLogic._resolveHealingPotionPool(theme, tierData, tables, priceCeiling);
    }
    static async _pickHealingPotionOnly(theme, tierData, tables, priceCeiling = Infinity, healFreq, prefetchedPool = null) {
        return CacheHealingLogic._pickHealingPotionOnly(theme, tierData, tables, priceCeiling, healFreq, prefetchedPool);
    }
    static _weightedHealingPick(healingRows, cacheTier, healFreq, situational = new Set()) {
        return CacheHealingLogic._weightedHealingPick(healingRows, cacheTier, healFreq, situational);
    }
    static _healingPotionDirectShare(freq) { return CacheHealingLogic._healingPotionDirectShare(freq); }
    static _healingPotionShare(freq) { return CacheHealingLogic._healingPotionShare(freq); }
    static _healingPotionTierWeight(name, cacheTier, freq) { return CacheHealingLogic._healingPotionTierWeight(name, cacheTier, freq); }

    static _isRationOrWaterItem(item) { return CacheQuantityLogic._isRationOrWaterItem(item); }
    static _isBulkFillerItem(item) { return CacheQuantityLogic._isBulkFillerItem(item); }
    static _isThrownWeapon(item) { return CacheQuantityLogic._isThrownWeapon(item); }
    static _resolveThrownWeaponQuantity(item, opts = {}) { return CacheQuantityLogic._resolveThrownWeaponQuantity(item, opts); }
    static _resolveRationWaterQuantity(item, opts = {}) { return CacheQuantityLogic._resolveRationWaterQuantity(item, opts); }

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

    static MODEST_STACK_MAX = CacheQuantityLogic.MODEST_STACK_MAX;
    static LIVESTOCK_WEIGHT_FLOOR = CacheQuantityLogic.LIVESTOCK_WEIGHT_FLOOR;

    static _resolveModestStackQuantity(opts = {}) { return CacheQuantityLogic._resolveModestStackQuantity(opts); }
    static _isTradeGoodsSource(compendiumId) { return CacheQuantityLogic._isTradeGoodsSource(compendiumId); }
    static _isLivestockUnit(item) { return CacheQuantityLogic._isLivestockUnit(item); }
    static _isBulkCommodityLoot(item) { return CacheQuantityLogic._isBulkCommodityLoot(item); }
    static _resolvePriceBandQuantity(item, opts = {}) { return CacheQuantityLogic._resolvePriceBandQuantity(item, opts); }
    static _resolveKindlingQuantity() { return CacheQuantityLogic._resolveKindlingQuantity(); }
    static _isKindlingItem(item) { return CacheQuantityLogic._isKindlingItem(item); }
    static _resolveQuantity(item, opts = {}) { return CacheQuantityLogic._resolveQuantity(item, opts); }

    // ── Chat Output ───────────────────────────────────────────────

    /** @type {Map<string, Object>} Pending cache results awaiting user action */
    static _pendingCaches = new Map();
    static _distributeCoinage(totalGp) { return CacheCoinageLogic._distributeCoinage(totalGp); }

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
                img: item.img ?? DEFAULT_ITEM_ICON,
                folder: folder.id,
                system: {
                    quantity: item.quantity ?? 1,
                    price: { value: item.price ?? 0, denomination: "gp" },
                    rarity: item.rarity ?? "common",
                    description: { value: `<p>Generated from a ${cacheResult.meta?.cacheLabel ?? "loot cache"}.</p>` }
                },
                flags: {
                    [MODULE_ID]: {
                        ...(item.flags?.[MODULE_ID] || {}),
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
                const cap = e.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0;
                return cap >= requiredCap;
            });
            let pickPool = withCapacity.length > 0 ? withCapacity : terrainPool.filter(e => {
                const cap = e.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0;
                return cap >= contentWeightLbs;
            });
            if (pickPool.length === 0 && terrainPool.length > 0) {
                const ranked = [...terrainPool].sort((a, b) => {
                    const capA = a.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0;
                    const capB = b.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0;
                    return capB - capA;
                });
                const bestCap = ranked[0].flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0;
                pickPool = ranked.filter(e =>
                    (e.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0) >= bestCap
                );
            }

            if (pickPool.length === 0) return null;

            if (ownerTheme === "armaments") {
                const sturdy = pickPool.filter(e => {
                    const cap = e.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0;
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
                capacityLbs: pick.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0,
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
                img: item.img ?? DEFAULT_ITEM_ICON,
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
