import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";

import { ItemPoolResolver } from "../loot/ItemPoolResolver.js";
import { ItemClassifier } from "../workshop/ItemClassifier.js";
import { SignatureLedger } from "../progression/SignatureLedger.js";
import { TerrainDataRegistry } from "../loot/TerrainDataRegistry.js";
import { PotionEnrichment } from "../scroll/PotionEnrichment.js";
import { roundCoinGp, formatCoinPrice, withCoinPriceLabel } from "../workshop/CoinFormat.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { getQuartermasterAdapter } from "../../adapters/getAdapter.js";
import { QM_FEATURES } from "../../data/QMFeatures.js";
import { SquashMerger } from "../packs/SquashMerger.js";
import { ItemResolutionPipeline } from "../workshop/ItemResolutionPipeline.js";
import {
    CacheScrollLogic,
    SCROLL_PRICES_BY_LEVEL,
    TIER_SCROLL_MIN_LEVEL,
    TIER_SCROLL_MAX_UNIQUES
} from "./logic/CacheScrollLogic.js";
import { CacheAmmoLogic } from "./logic/CacheAmmoLogic.js";
import { CacheHealingLogic } from "./logic/CacheHealingLogic.js";
import { CacheQuantityLogic } from "./logic/CacheQuantityLogic.js";
import { CacheCoinageLogic } from "./logic/CacheCoinageLogic.js";
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
} from "./logic/CachePackIndex.js";
import { applyCachePhaseAndMintMethods } from "./logic/CachePhaseAndMintMethods.js";
import { applyCachePickerMethods } from "./logic/CachePickerMethods.js";
import { applyCacheDeploymentMethods } from "./logic/CacheDeploymentMethods.js";



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
        if (this._lastGoldRoll) {
            Object.defineProperty(result, "_goldRoll", {
                value: this._lastGoldRoll,
                enumerable: false,
                configurable: true,
                writable: true
            });
        }
        result.gold = Math.max(0, Math.round(rawGold * (ownerDef.budgetMultiplier ?? 1.0) * economy));
        if (hardCap && effectiveBudget > 0) {
            const share = this.COIN_ROLL_BUDGET_SHARE[tier] ?? 0.25;
            result.gold = Math.min(result.gold, Math.round(effectiveBudget * share));
        }
        result.meta.budgetMin = options.budgetMin ?? 0;
        if (options.budgetMax !== null && options.budgetMax !== undefined) {
            result.meta.budgetMax = options.budgetMax;
        }

        // ── Signature: check the Progression Registry when supported ──
        const activeAdapter = getQuartermasterAdapter();
        if (activeAdapter.supports(QM_FEATURES.SIGNATURE_LEDGER)) {
            const partyActors = game.ionrift?.library?.party?.getMembers()
                ?? game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
            const sugg = await SignatureLedger.getSuggestedRecipient(partyActors);
            if (sugg && !sugg.isSuppressed && sugg.actorId) {
                result.signatureOpportunity = sugg;
            }
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
        const supportsScrolls = activeAdapter.supports(QM_FEATURES.SCROLL_FORGE);
        if (!supportsScrolls) {
            delete pool.scroll;
        }

        // Expand guaranteed entries into a flat list of slot types.
        // Entries can be plain strings ("scroll") or range objects ({ type, min, max }).
        // Range min/max are scaled by tier.
        const guaranteed = [];
        for (const entry of (ownerDef.guaranteed ?? [])) {
            if (typeof entry === "string") {
                guaranteed.push(!supportsScrolls && entry === "scroll" ? "mundane" : entry);
            } else if (entry?.type) {
                const slotType = !supportsScrolls && entry.type === "scroll" ? "mundane" : entry.type;
                const min = Math.round((entry.min ?? 1) * tierScale);
                const max = Math.round((entry.max ?? min) * tierScale);
                let count = Math.floor(Math.random() * (max - min + 1)) + min;
                if (slotType === "scroll") {
                    count = Math.min(count, this._scrollSlotCap(tier, ownerTheme));
                }
                for (let j = 0; j < count; j++) guaranteed.push(slotType);
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

}

applyCachePhaseAndMintMethods(CacheGenerator);
applyCachePickerMethods(CacheGenerator);
applyCacheDeploymentMethods(CacheGenerator);
