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

export class CachePickerMethods {
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
        const adapter = getQuartermasterAdapter();
        if (!item && slotType !== "mundane" && !adapter.supports(QM_FEATURES.LATENT_MASKING)) {
            item = await this._pickMundane(theme, tierData, tables, priceCeiling, pickOpts);
        }
        if (item) {
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
        if (!getQuartermasterAdapter().supports(QM_FEATURES.SCROLL_FORGE)) {
            return null;
        }
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
                    const tierWeight = this._healingPotionTierWeight(
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

            const share = this._healingPotionShare(healFreq);
            const branch = Math.random() < share ? healing : other;
            return _weightedPickFrom(branch);
        };

        const healingInPool = finalPool.filter(p => PotionEnrichment.isHealingPotion(p.name));

        if (healingInPool.length > 0) {
            const directShare = this._healingPotionDirectShare(healFreq);
            if (Math.random() < directShare) {
                const direct = await this._pickHealingPotionOnly(
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
        this._lastGoldRoll = null;
        try {
            const roll = await new Roll(formula).evaluate();
            this._lastGoldRoll = roll;
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
}

export function applyCachePickerMethods(TargetClass) {
    for (const key of Object.getOwnPropertyNames(CachePickerMethods)) {
        if (key === "length" || key === "name" || key === "prototype") continue;
        const desc = Object.getOwnPropertyDescriptor(CachePickerMethods, key);
        if (desc) Object.defineProperty(TargetClass, key, desc);
    }
}
