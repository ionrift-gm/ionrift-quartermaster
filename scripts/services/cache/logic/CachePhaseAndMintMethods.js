import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../../data/moduleId.js";

import { ItemPoolResolver } from "../../loot/ItemPoolResolver.js";
import { ItemClassifier } from "../../workshop/ItemClassifier.js";
import { SignatureLedger } from "../../progression/SignatureLedger.js";
import { TerrainDataRegistry } from "../../loot/TerrainDataRegistry.js";
import { PotionEnrichment } from "../../scroll/PotionEnrichment.js";
import { roundCoinGp, formatCoinPrice, withCoinPriceLabel } from "../../workshop/CoinFormat.js";
import { Logger, MODULE_LABEL } from "../../../utils/Logger.js";
import { getQuartermasterAdapter } from "../../../adapters/getAdapter.js";
import { QM_FEATURES } from "../../../data/QMFeatures.js";
import { SquashMerger } from "../../packs/SquashMerger.js";
import { ItemResolutionPipeline } from "../../workshop/ItemResolutionPipeline.js";
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

export class CachePhaseAndMintMethods {
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
            const item = await this._pickItem(slotType, theme, tierData, tables, perItemCap, { ownerTheme });
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
}

export function applyCachePhaseAndMintMethods(TargetClass) {
    for (const key of Object.getOwnPropertyNames(CachePhaseAndMintMethods)) {
        if (key === "length" || key === "name" || key === "prototype") continue;
        const desc = Object.getOwnPropertyDescriptor(CachePhaseAndMintMethods, key);
        if (desc) Object.defineProperty(TargetClass, key, desc);
    }
}
