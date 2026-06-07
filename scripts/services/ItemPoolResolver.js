/**
 * ItemPoolResolver
 *
 * Resolves loot pool items from multiple sources at runtime:
 *   1. User-selected compendiums (configured in module settings)
 *   2. Static fallback tables (cache-tables.json)
 *
 * Results are cached per session to avoid repeated compendium queries.
 */

import { Logger, MODULE_LABEL } from "../_logger.js";
import { ItemClassifier } from "./ItemClassifier.js";
import { GenericArmorBonusRegistry } from "./GenericArmorBonusRegistry.js";
import { PotionEnrichment } from "./PotionEnrichment.js";
import { isSrdCursedLootName } from "./SrdCurseCatalog.js";

const MODULE_ID = "ionrift-quartermaster";

export class ItemPoolResolver {
    // Session cache: compendiumId -> filtered items[]
    static _cache = new Map();
    static _cacheExpiry = null;
    static CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

    // Cursed-item blocklist: Set<string> of lowercase item names that must
    // never appear in random pool draws. Built lazily from cursedItemSources
    // and the compiled SRD cursed world pack. Invalidated on settings change.
    static _cursedBlocklist = null;

    /** When set, resolve() returns filtered entries from this pool (balance simulators). */
    static _simulationPool = null;

    // Per-item price ceiling by tier. Rejects individual items that cost more
    // than a tier's loot table should reasonably contain as a random drop.
    static TIER_PRICE_CEILING = {
        1: 100,     // T1: mundane and cheap magic only
        2: 500,     // T2: mid-range magic
        3: 5000,    // T3: high magic
        4: Infinity  // T4: no ceiling
    };

    /** Mastercraft draw weight toward body armor when ownerTheme is armaments (C1). */
    static MASTERCRAFT_BODY_ARMOR_DRAW_WEIGHT = 0.70;

    /** Secondary weight toward shields before weapons on armaments mastercraft slots. */
    static MASTERCRAFT_SHIELD_DRAW_WEIGHT = 0.22;

    /**
     * Imputed gp value for generic +N items when filtering mastercraft bands.
     * Compiled armor keeps mundane base gp on the document; bonus tier carries
     * the real loot value for tier band checks.
     */
    static GENERIC_BONUS_VALUE_FLOOR = { 1: 200, 2: 800, 3: 3000 };

    /**
     * Minimum generic +N bonus for mastercraft cache picks by tier.
     * T4 expects +2 masterwork, not leftover +1 filler.
     */
    static MIN_GENERIC_BONUS_BY_TIER = { 1: 0, 2: 1, 3: 1, 4: 2 };

    /**
     * Target generic +N band for mastercraft price ceilings and aspire filtering.
     * Soft pressure only; MIN_GENERIC_BONUS_BY_TIER remains the hard floor at T4.
     */
    static ASPIRATIONAL_GENERIC_BONUS_BY_TIER = { 1: 0, 2: 1, 3: 2, 4: 2 };

    /**
     * Generic +N mastercraft pick weights by tier. T4 leans toward +2.
     */
    static MASTERCRAFT_BONUS_WEIGHTS = {
        1: { 1: 1, 2: 0, 3: 0 },
        2: { 1: 10, 2: 1, 3: 0 },
        3: { 1: 0, 2: 8, 3: 1 },
        4: { 1: 0, 2: 9, 3: 2 }
    };

    /**
     * Maximum generic +N bonus allowed in mastercraft cache picks by tier.
     * Named magical items use the separate Stance B throttle.
     */
    static MAX_GENERIC_BONUS_BY_TIER = {
        1: 0,
        2: 1,
        3: 2,
        4: 3
    };

    /**
     * Compendium IDs that must never feed Quartermaster loot pools or compilation.
     * Activity items (forage, hunt, cooking) stay in Respite; use respite-cache-utility instead.
     */
    static LOOT_POOL_EXCLUDED_PACKS = new Set([
        "ionrift-respite.respite-items",
    ]);

    /**
     * Packs that use the 2024 architecture where consumables were renamed
     * to include their container type. Used by _isLegacyRenamedItem.
     */
    static EQUIPMENT24_PACKS = new Set(["dnd5e.equipment24"]);

    /**
     * Items renamed in SRD 5.2 / 2024 to include their container type.
     * Key = legacy lowercase name to suppress when a 2024 pack is enabled.
     * Value = 2024 replacement name (documentation only).
     *
     * Suppression is one-directional: the legacy entry is hidden so only
     * the 2024 form appears in the pool. The 2024 form is never touched.
     */
    static LEGACY_2024_RENAMED = new Map([
        ["holy water",  "Flask of Holy Water"],
        ["acid",        "Acid (vial)"],
        ["antitoxin",   "Antitoxin (vial)"],
    ]);

    /**
     * Get enabled compendium source IDs from module settings.
     * @returns {string[]}
     */
    static getEnabledSources() {
        try {
            const raw = JSON.parse(game.settings.get(MODULE_ID, "lootPoolSources"));
            if (!Array.isArray(raw)) return [];
            return raw.filter(id => !this.LOOT_POOL_EXCLUDED_PACKS.has(id));
        } catch {
            return ["dnd5e.items", "dnd5e.tradegoods"]
                .filter(id => !this.LOOT_POOL_EXCLUDED_PACKS.has(id));
        }
    }

    /** Invalidate both the item cache and the cursed blocklist. */
    static clearCache() {
        this._cache.clear();
        this._cacheExpiry = null;
        this._cursedBlocklist = null;
    }

    /**
     * Inject a flat pool for Monte Carlo balance runs (Vitest / harness).
     * @param {object[]|null} pool
     */
    static setSimulationPool(pool) {
        this._simulationPool = pool;
        this.clearCache();
    }

    /** Clear simulation pool injection. */
    static clearSimulationPool() {
        this._simulationPool = null;
        this.clearCache();
    }

    /**
     * Build (or return cached) a Set of lowercase item names that should never
     * appear as random pool drops because they are designated cursed items.
     *
     * Sources:
     *   1. world.ionrift-srd-cursed - the compiled SRD curse pack
     *   2. Any additional packs listed in the cursedItemSources setting
     *
     * @returns {Promise<Set<string>>}
     */
    static async _getCursedBlocklist() {
        if (this._cursedBlocklist !== null) return this._cursedBlocklist;

        const names = new Set();

        // 1. Read the compiled SRD curse world pack
        const srdPack = game.packs?.get("world.ionrift-srd-cursed");
        if (srdPack) {
            try {
                const index = await srdPack.getIndex();
                for (const entry of index) {
                    if (entry.name) names.add(entry.name.trim().toLowerCase());
                }
            } catch (e) {
                Logger.warn(MODULE_LABEL, "ItemPoolResolver: could not index cursed pack:", e.message);
            }
        }

        // 2. Read any additional cursedItemSources packs the GM has configured
        let cursedSources = [];
        try {
            cursedSources = JSON.parse(game.settings.get(MODULE_ID, "cursedItemSources") ?? "[]");
        } catch { /* ignore */ }

        for (const packId of cursedSources) {
            if (packId === "world.ionrift-srd-cursed") continue; // already handled
            const pack = game.packs?.get(packId);
            if (!pack) continue;
            try {
                const index = await pack.getIndex();
                for (const entry of index) {
                    if (entry.name) names.add(entry.name.trim().toLowerCase());
                }
            } catch (e) {
                Logger.warn(MODULE_LABEL, `ItemPoolResolver: could not index cursed source "${packId}":`, e.message);
            }
        }

        this._cursedBlocklist = names;
        return names;
    }

    /**
     * Query enabled compendiums for items matching the given filters.
     *
     * @param {Object} opts
     * @param {string} opts.slotType - 'consumable' | 'mundane' | 'scroll'
     * @param {number} opts.tier - Party tier 1-4
     * @param {string} opts.theme - Terrain theme
     * @param {Object} opts.fallbackTables - Static cache-tables.json data
     * @returns {Object[]} Merged array of { name, type, img, price, rarity, ... }
     */
    static async resolve(opts) {
        const { slotType, tier, theme, fallbackTables, rarityMax: rarityMaxOverride } = opts;
        const tierData = fallbackTables?.tiers?.[String(tier)];
        const rarityMax = rarityMaxOverride ?? tierData?.rarityMax ?? "uncommon";

        if (this._simulationPool) {
            const sim = this._simulationPool.filter(entry =>
                this._matchesSlotType(entry, slotType)
            );
            if (!theme) return sim;
            return sim.filter(item => this._eligibleForTheme(item, theme));
        }

        const sources = this.getEnabledSources();
        const compendiumItems = await this._queryCompendiums(sources, slotType, rarityMax);

        // Get fallback items from static tables
        const fallbackItems = this._getFallbackItems(slotType, theme, fallbackTables) ?? [];

        // Merge: compendium items first, then fallback
        const merged = [...compendiumItems, ...fallbackItems];

        // Deduplicate by name (prefer compendium version)
        const seen = new Set();
        const deduped = merged.filter(item => {
            const key = item.name.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Cursed-item blocklist: remove items that exist in any cursedItemSources
        // compendium so they can never appear as random cache drops. These items
        // are only ever placed through the deliberate curse mechanic.
        const cursedNames = await this._getCursedBlocklist();
        const uncursed = deduped.filter(item => {
            const nameLower = item.name.trim().toLowerCase();
            if (isSrdCursedLootName(item.name)) return false;
            if (cursedNames.has(nameLower)) return false;
            return true;
        });

        if (!theme) return uncursed;
        return uncursed.filter(item => this._eligibleForTheme(item, theme));
    }

    /**
     * Combined per-item price cap: tier table plus optional slot budget ceiling
     * from {@link CacheGenerator._computeSlotPriceCeiling}.
     *
     * @param {number} tier
     * @param {number} [slotCeiling=Infinity]
     * @returns {number}
     */
    static _effectivePriceCeiling(tier, slotCeiling = Infinity) {
        const tierCeiling = this.TIER_PRICE_CEILING[tier] ?? Infinity;
        const slotCap = slotCeiling ?? Infinity;
        return Math.min(tierCeiling, slotCap);
    }

    /**
     * Pick a random item from the resolved pool.
     */
    static async pickRandom(opts) {
        let pool = await this.resolve(opts);
        if (!pool.length) return null;

        const tier = opts.tier ?? 1;
        let priceCeiling = this._effectivePriceCeiling(tier, opts.priceCeiling);
        if (opts.priceMax !== undefined && opts.priceMax < priceCeiling) {
            priceCeiling = opts.priceMax;
        }
        const priceMin = opts.priceMin ?? 0;
        if (opts.slotType === "mastercraft") {
            pool = this._filterMastercraftPricePool(pool, priceCeiling, opts.priceMax, priceMin);
        } else {
            if (priceCeiling < Infinity) {
                const pricedPool = pool.filter(i => (i.price ?? 0) <= priceCeiling);
                if (pricedPool.length > 0) pool = pricedPool;
            }
            if (priceMin > 0) {
                const floored = pool.filter(i => (i.price ?? 0) >= priceMin);
                if (floored.length > 0) pool = floored;
            }
        }

        // Mastercraft repick logic in CacheGenerator handles weight with type
        // floors. Pre-filtering the pool by raw weight here collapses armor to
        // helms-only in small containers (2 lb helms survive, 6 lb shields do not).
        if (opts.slotType !== "mastercraft"
            && opts.maxEffectiveWeight !== undefined
            && opts.maxEffectiveWeight < Infinity) {
            const maxW = opts.maxEffectiveWeight;
            const weightOf = (item) => {
                if (typeof opts.effectiveWeightFn === "function") {
                    return opts.effectiveWeightFn(item.weight, item.type, item.system);
                }
                return item.weight ?? 0;
            };
            const lightPool = pool.filter(i => weightOf(i) <= maxW);
            if (lightPool.length > 0) pool = lightPool;
        }

        if (opts.slotType === "mundane" && opts.ownerTheme === "armaments") {
            const gearPool = pool.filter(i => this._isArmamentsMundaneEligible(i));
            if (gearPool.length > 0) pool = gearPool;
        }

        if (opts.slotType === "mastercraft") {
            const magicForStrip = game.settings?.get(MODULE_ID, "magicFrequency") ?? 1.0;
            if (magicForStrip >= 1.0) {
                pool = this._stripArmamentsMundaneWhenMagicalExists(pool, tier, opts);
            }
            pool = this._applyMastercraftAspireBias(pool, tier, opts, priceCeiling);
        }

        if (opts.slotType === "mastercraft") {
            const { armor, shields, weapons } = this._splitMastercraftPool(pool);
            if (opts.requireArmor) {
                if (armor.length > 0) pool = armor;
                else if (shields.length > 0) pool = shields;
                else return null;
            } else if (opts.preferArmor && opts.ownerTheme === "armaments") {
                const weightOf = (item) => {
                    if (typeof opts.effectiveWeightFn === "function") {
                        return opts.effectiveWeightFn(item.weight, item.type, item.system);
                    }
                    return item.weight ?? 0;
                };
                const maxW = opts.maxEffectiveWeight;
                const fitsWeight = (item) => maxW === undefined
                    || maxW >= Infinity
                    || weightOf(item) <= maxW;

                const fitArmor = armor.filter(fitsWeight);
                const fitShields = shields.filter(fitsWeight);
                const fitWeapons = weapons.filter(fitsWeight);
                const aspireBonus = this.ASPIRATIONAL_GENERIC_BONUS_BY_TIER[tier] ?? 0;
                const armorAspireCap = GenericArmorBonusRegistry.getMaxBonus(tier);
                const effectiveArmorAspire = Math.min(aspireBonus, armorAspireCap);
                const genericAtLeast = (item, minBonus) => {
                    if (!ItemClassifier.isGenericMagic(item)) return false;
                    const bonus = ItemClassifier.detectBonusTier(item);
                    if (bonus < minBonus) return false;
                    if (this._isArmorPoolItem(item)) {
                        return GenericArmorBonusRegistry.allowsBonus(bonus, tier);
                    }
                    return bonus <= (this.MAX_GENERIC_BONUS_BY_TIER[tier] ?? 3);
                };
                const armorHasAspire = effectiveArmorAspire > 0 && (
                    fitArmor.some(item => genericAtLeast(item, effectiveArmorAspire))
                    || fitShields.some(item => genericAtLeast(item, effectiveArmorAspire))
                );
                const weaponAspire = aspireBonus > 0
                    ? fitWeapons.filter(item => genericAtLeast(item, aspireBonus))
                    : [];

                if (!armorHasAspire && weaponAspire.length > 0) {
                    pool = weaponAspire;
                } else {
                    const bodyPool = fitArmor.length > 0 ? fitArmor : [];
                    const shieldPool = fitShields.length > 0 ? fitShields : [];
                    const weaponPool = fitWeapons.length > 0 ? fitWeapons : weapons;

                    const roll = Math.random();
                    if (roll < this.MASTERCRAFT_BODY_ARMOR_DRAW_WEIGHT && bodyPool.length > 0) {
                        pool = bodyPool;
                    } else if (
                        roll < this.MASTERCRAFT_BODY_ARMOR_DRAW_WEIGHT + this.MASTERCRAFT_SHIELD_DRAW_WEIGHT
                        && shieldPool.length > 0
                    ) {
                        pool = shieldPool;
                    } else if (weaponPool.length > 0) {
                        pool = weaponPool;
                    } else if (shieldPool.length > 0) {
                        pool = shieldPool;
                    } else if (bodyPool.length > 0) {
                        pool = bodyPool;
                    } else if (armor.length > 0) {
                        pool = armor;
                    } else if (shields.length > 0) {
                        pool = shields;
                    }
                }
            }
        }

        // Named-magical filtering (Stance B policy): when requested, strip
        // named magical items from the draw bag so only generic +N and
        // mundane items remain eligible.
        if (opts.rejectNamedMagical) {
            const filtered = pool.filter(i => !ItemClassifier.isNamedMagical(i));
            if (filtered.length > 0) pool = filtered;
        }

        if (opts.slotType === "mastercraft") {
            pool = this._filterMastercraftGenericBonusPolicy(
                pool,
                tier,
                opts.maxGenericBonusTier ?? this.MAX_GENERIC_BONUS_BY_TIER[tier] ?? 0
            );
        }

        pool = pool.filter(item => !ItemClassifier.isSlayingAmmo(item));

        const magicSetting = game.settings?.get(MODULE_ID, "magicFrequency") ?? 1.0;

        if (magicSetting !== 1.0) {
            const isMagical = (item) => {
                const r = (item.rarity || "common").toLowerCase();
                return r !== "common" && r !== "none" && r !== "";
            };

            const tunedPool = [];

            if (magicSetting < 1.0) {
                // Low magic: probabilistically skip magical items
                for (const item of pool) {
                    if (!isMagical(item) || Math.random() <= magicSetting) {
                        tunedPool.push(item);
                    }
                }
                if (tunedPool.length > 0) {
                    pool = tunedPool;
                } else {
                    const mundaneOnly = pool.filter(item => !isMagical(item));
                    if (mundaneOnly.length > 0) pool = mundaneOnly;
                }
            } else {
                const extraCopies = Math.floor(magicSetting) - 1;
                const chance = magicSetting % 1;

                // High magic: duplicate at class level so large template families
                // are not overweighted within a single equivalence class.
                const classBuckets = new Map();
                for (const item of pool) {
                    const key = this._poolClassKey(item);
                    if (!classBuckets.has(key)) classBuckets.set(key, []);
                    classBuckets.get(key).push(item);
                }

                for (const [, items] of classBuckets) {
                    tunedPool.push(items[0]);
                    const sample = items[0];
                    const isMagical = (() => {
                        const r = (sample.rarity || "common").toLowerCase();
                        return r !== "common" && r !== "none" && r !== "";
                    })();
                    if (isMagical) {
                        for (let i = 0; i < extraCopies; i++) {
                            tunedPool.push(items[Math.floor(Math.random() * items.length)]);
                        }
                        if (Math.random() <= chance) {
                            tunedPool.push(items[Math.floor(Math.random() * items.length)]);
                        }
                    }
                }
                pool = tunedPool;
            }
        }

        if (opts.slotType === "mastercraft") {
            const magicSetting = game.settings?.get(MODULE_ID, "magicFrequency") ?? 1.0;
            if (magicSetting >= 1.0) {
                pool = this._applyMastercraftGenericFloor(pool, tier, opts, priceCeiling);
            }
        }

        const useClassPick = opts.pickByClass !== false
            && ["mastercraft", "ammo"].includes(opts.slotType);
        if (useClassPick) {
            if (opts.slotType === "mastercraft") {
                return this._pickMastercraftByBonusWeights(pool, tier, {
                    ...opts,
                    priceCeiling
                });
            }
            return this._pickUniformByClass(pool);
        }

        return pool[Math.floor(Math.random() * pool.length)];
    }

    /**
     * Mastercraft pick with tier-weighted +N bias (mirrors magical ammo curve).
     *
     * @param {object[]} pool
     * @param {number} tier
     * @param {object} [opts]
     * @returns {object|null}
     */
    static _pickMastercraftByBonusWeights(pool, tier, opts = {}) {
        const armorOnly = pool.length > 0 && pool.every(item => this._isArmorPoolItem(item));
        const weights = armorOnly
            ? GenericArmorBonusRegistry.getPickWeights(tier)
            : (this.MASTERCRAFT_BONUS_WEIGHTS[tier] ?? this.MASTERCRAFT_BONUS_WEIGHTS[1]);
        const byBonus = { 1: [], 2: [], 3: [], named: [], mundane: [] };

        for (const item of pool) {
            if (ItemClassifier.isNamedMagical(item)) {
                byBonus.named.push(item);
                continue;
            }
            if (ItemClassifier.isGenericMagic(item)) {
                const bonus = ItemClassifier.detectBonusTier(item);
                if (bonus >= 1 && bonus <= 3) {
                    byBonus[bonus].push(item);
                }
                continue;
            }
            byBonus.mundane.push(item);
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
            const picked = this._pickUniformByClass(byBonus[chosenBonus]);
            if (picked) return picked;
        }

        if (!opts.rejectNamedMagical && byBonus.named.length > 0) {
            return this._pickUniformByClass(byBonus.named);
        }

        const minBonus = this.MIN_GENERIC_BONUS_BY_TIER[tier] ?? 0;
        const aspireBonus = this.ASPIRATIONAL_GENERIC_BONUS_BY_TIER[tier] ?? 0;
        const aspireFloor = aspireBonus > 0 ? (this.GENERIC_BONUS_VALUE_FLOOR[aspireBonus] ?? 0) : 0;
        const priceCeiling = opts.priceCeiling ?? Infinity;
        const canAspire = !priceCeiling || priceCeiling >= aspireFloor;

        if (
            opts.ownerTheme === "armaments"
            && canAspire
            && aspireBonus >= 2
            && byBonus[aspireBonus].length > 0
        ) {
            return this._pickUniformByClass(byBonus[aspireBonus]);
        }

        const anyGeneric = [1, 2, 3]
            .filter(bonus => bonus >= minBonus)
            .flatMap(bonus => byBonus[bonus]);
        if (anyGeneric.length > 0 && tier >= 2) {
            return this._pickUniformByClass(anyGeneric);
        }

        if (byBonus.mundane.length > 0 && opts.ownerTheme !== "armaments") {
            return this._pickUniformByClass(byBonus.mundane);
        }

        return null;
    }

    /**
     * Armaments mastercraft should not draw mundane SRD steel when compiled +N
     * gear survives upstream filters. Runs before armor/weapon split.
     *
     * @param {object[]} pool
     * @param {number} tier
     * @param {object} opts
     * @returns {object[]}
     */
    static _stripArmamentsMundaneWhenMagicalExists(pool, tier, opts) {
        if (opts.ownerTheme !== "armaments" || tier < 2) return pool;

        const generic = pool.filter(item => ItemClassifier.isGenericMagic(item));
        if (generic.length > 0) return generic;

        const named = pool.filter(item => ItemClassifier.isNamedMagical(item) && !opts.rejectNamedMagical);
        if (named.length > 0) return named;

        return pool;
    }

    /**
     * Armaments aspire +N band before armor/weapon split so +2 gear is not
     * crowded out by +1 rows in the weapon bucket after preferArmor.
     *
     * @param {object[]} pool
     * @param {number} tier
     * @param {object} opts
     * @param {number} priceCeiling
     * @returns {object[]}
     */
    static _genericAspireFloorForItem(item, tier, aspireBonus, weaponMax) {
        if (this._isArmorPoolItem(item)) {
            const armorMax = GenericArmorBonusRegistry.getMaxBonus(tier);
            if (armorMax <= 0) return Infinity;
            return Math.min(aspireBonus, armorMax);
        }
        return aspireBonus;
    }

    static _applyMastercraftAspireBias(pool, tier, opts, priceCeiling) {
        const aspireBonus = this.ASPIRATIONAL_GENERIC_BONUS_BY_TIER[tier] ?? 0;
        if (aspireBonus <= 0 || opts.ownerTheme !== "armaments") return pool;

        const aspireFloor = this.GENERIC_BONUS_VALUE_FLOOR[aspireBonus] ?? 0;
        if (priceCeiling > 0 && priceCeiling < aspireFloor) return pool;

        const weaponMax = this.MAX_GENERIC_BONUS_BY_TIER[tier] ?? 3;
        const bonusOf = (item) => ItemClassifier.detectBonusTier(item);
        const atAspire = pool.filter(item => {
            if (ItemClassifier.isNamedMagical(item)) return !opts.rejectNamedMagical;
            if (!ItemClassifier.isGenericMagic(item)) return false;
            const bonus = bonusOf(item);
            const floor = this._genericAspireFloorForItem(item, tier, aspireBonus, weaponMax);
            if (!Number.isFinite(floor) || floor <= 0 || bonus < floor) return false;
            if (this._isArmorPoolItem(item)) {
                return GenericArmorBonusRegistry.allowsBonus(bonus, tier);
            }
            return bonus <= weaponMax;
        });
        return atAspire.length > 0 ? atAspire : pool;
    }

    /**
     * Imputed price floor for armaments mastercraft when the slot budget fits.
     * @param {number} tier
     * @param {number} priceCeiling
     * @param {string} [ownerTheme]
     * @returns {number}
     */
    static armamentsMastercraftPriceMin(tier, priceCeiling, ownerTheme) {
        const tableMin = [0, 5, 30, 200, 800][tier] ?? 0;
        if (ownerTheme !== "armaments") return tableMin;

        const aspireBonus = this.ASPIRATIONAL_GENERIC_BONUS_BY_TIER[tier] ?? 0;
        if (aspireBonus <= 0) return tableMin;

        const aspireMin = this.GENERIC_BONUS_VALUE_FLOOR[aspireBonus] ?? 0;
        if (aspireMin > 0 && priceCeiling >= aspireMin) {
            return Math.max(tableMin, aspireMin);
        }
        return tableMin;
    }

    /**
     * Tier floor and aspire filtering for mastercraft generic +N picks.
     * Runs after magicFrequency tuning so low-magic profiles can stay mundane.
     *
     * @param {object[]} pool
     * @param {number} tier
     * @param {object} opts
     * @param {number} priceCeiling
     * @returns {object[]}
     */
    static _applyMastercraftGenericFloor(pool, tier, opts, priceCeiling) {
        const minGenericBonus = this.MIN_GENERIC_BONUS_BY_TIER[tier] ?? 0;
        const aspireBonus = this.ASPIRATIONAL_GENERIC_BONUS_BY_TIER[tier] ?? 0;
        if (minGenericBonus <= 0 && aspireBonus <= 0) return pool;

        const bonusOf = (item) => ItemClassifier.detectBonusTier(item);
        const genericAtLeast = (item, minBonus) => {
            if (!ItemClassifier.isGenericMagic(item)) return false;
            return bonusOf(item) >= minBonus;
        };
        const namedOk = (item) => ItemClassifier.isNamedMagical(item) && !opts.rejectNamedMagical;

        const aspireFloor = aspireBonus > 0 ? (this.GENERIC_BONUS_VALUE_FLOOR[aspireBonus] ?? 0) : 0;
        const canAspire = !priceCeiling || priceCeiling >= aspireFloor;

        if (aspireBonus > minGenericBonus && canAspire) {
            const atAspire = pool.filter(item => genericAtLeast(item, aspireBonus) || namedOk(item));
            if (atAspire.length > 0) return atAspire;
        }

        if (minGenericBonus > 0) {
            const atFloor = pool.filter(item => genericAtLeast(item, minGenericBonus) || namedOk(item));
            if (atFloor.length > 0) return atFloor;

            const minFloor = this.GENERIC_BONUS_VALUE_FLOOR[minGenericBonus] ?? 0;
            const budgetBlocksFloor = priceCeiling > 0 && priceCeiling < minFloor;
            if (budgetBlocksFloor && tier < 4) {
                const subTier = pool.filter(item => {
                    if (namedOk(item)) return true;
                    return ItemClassifier.isGenericMagic(item);
                });
                if (subTier.length > 0) return subTier;
            }
        }

        return pool;
    }

    /**
     * Equivalence class for fair pool draws. Template families share one class;
     * generic +N group by base name; named items are singleton classes.
     *
     * @param {object} item
     * @returns {string}
     */
    static _poolClassKey(item) {
        const compiled = item.flags?.[MODULE_ID]?.compiledFrom;
        if (compiled?.template) {
            const tpl = compiled.template.toLowerCase();
            if (compiled.base) return `tpl:${tpl}:${compiled.base.toLowerCase()}`;
            if (compiled.variant) return `tpl:${tpl}:${String(compiled.variant).toLowerCase()}`;
            return `tpl:${tpl}`;
        }
        if (compiled?.creatureType) return `slaying:${compiled.creatureType.toLowerCase()}`;
        if (compiled?.enrichment) return `named:${(item.name ?? "").toLowerCase()}`;

        const name = (item.name ?? "").trim();
        const nameLc = name.toLowerCase();

        if (ItemClassifier.isGenericMagic(item)) {
            const bonus = ItemClassifier.detectBonusTier(item);
            const base = name.replace(/\s*\+\d\b.*$/i, "").trim().toLowerCase();
            return `gen:+${bonus || 0}:${base}`;
        }
        if (ItemClassifier.isNamedMagical(item)) return `named:${nameLc}`;

        const baseItem = (item._baseItem ?? "").trim().toLowerCase();
        return `mund:${baseItem || nameLc}`;
    }

    /**
     * Pick uniformly among equivalence classes, then uniformly within the class.
     *
     * @param {object[]} pool
     * @returns {object|null}
     */
    static _pickUniformByClass(pool) {
        if (!pool?.length) return null;
        if (pool.length === 1) return pool[0];

        const classes = new Map();
        for (const item of pool) {
            const key = this._poolClassKey(item);
            if (!classes.has(key)) classes.set(key, []);
            classes.get(key).push(item);
        }

        const keys = [...classes.keys()];
        const chosenKey = keys[Math.floor(Math.random() * keys.length)];
        const bucket = classes.get(chosenKey);
        return bucket[Math.floor(Math.random() * bucket.length)];
    }

    /**
     * Query compendiums and return filtered items.
     */
    static async _queryCompendiums(sourceIds, slotType, rarityMax) {
        const results = [];

        // Inject the compiled loot pool as the first source when it has been compiled.
        // The compiled pool already has collision resolution baked in (2024 wins price/type,
        // legacy weight preserved). First-seen deduplication below ensures compiled items
        // shadow any raw SRD entries of the same name.
        const compiledPack = game.packs.get("world.quartermaster-compiled-pool");
        const compiledHash = (() => {
            try { return game.settings.get("ionrift-quartermaster", "compiledLootPoolHash"); }
            catch { return ""; }
        })();
        if (compiledPack && compiledHash) {
            sourceIds = ["world.quartermaster-compiled-pool", ...sourceIds];
        }
        const allowedRarities = this._raritiesUpTo(rarityMax);

        for (const packId of sourceIds) {
            const cacheKey = `${packId}:${slotType}:${rarityMax}`;

            // Check cache
            if (this._cache.has(cacheKey) && !this._isCacheExpired()) {
                results.push(...this._cache.get(cacheKey));
                continue;
            }

            const pack = game.packs.get(packId);
            if (!pack) continue;
            if (pack.documentName !== "Item") continue;

            try {
                // Use getIndex for lightweight query
                const index = await pack.getIndex({ fields: [
                    "name", "type", "img", "flags", "system.price", "system.rarity",
                    "system.type", "system.weight", "system.description", "system.magicalBonus"
                ]});

                const filtered = [];
                for (const entry of index) {
                    if (!this._matchesSlotType(entry, slotType)) continue;
                    if (!this._matchesRarity(entry, allowedRarities)) continue;
                    if (this._isExcluded(entry)) continue;

                    filtered.push({
                        name: entry.name,
                        type: entry.type,
                        img: entry.img,
                        flags: entry.flags ?? {},
                        price: this._extractPrice(entry),
                        rarity: entry.system?.rarity ?? "common",
                        weight: this._extractWeight(entry),
                        _baseItem: entry.system?.type?.baseItem ?? "",
                        subtype: (entry.system?.type?.value ?? "").toString().toLowerCase(),
                        system: {
                            rarity: entry.system?.rarity,
                            type: entry.system?.type,
                            weight: entry.system?.weight,
                            magicalBonus: entry.system?.magicalBonus
                        },
                        sourceCompendium: packId,
                        _compendiumId: entry._id
                    });
                }

                this._cache.set(cacheKey, filtered);
                if (!this._cacheExpiry) {
                    this._cacheExpiry = Date.now() + this.CACHE_TTL_MS;
                }
                results.push(...filtered);
            } catch (e) {
                Logger.warn(MODULE_LABEL, `ItemPoolResolver failed to query ${packId}:`, e.message);
            }
        }

        return results;
    }

    /** @param {object} entry */
    static _terrainTags(entry) {
        return entry.flags?.["ionrift-quartermaster"]?.terrain ?? [];
    }

    /** @param {object} entry */
    static _isTerrainBound(entry) {
        return this._terrainTags(entry).length > 0;
    }

    /**
     * Terrain-bound items are exclusive to their listed terrains. Items with
     * no terrain flag are universal and eligible everywhere.
     *
     * @param {object} entry
     * @param {string} theme
     */
    static _eligibleForTheme(entry, theme) {
        if (!theme) return true;
        if (!this._isTerrainBound(entry)) return true;
        return this._terrainTags(entry).includes(theme);
    }

    /**
     * Split generic +N caps: weapons follow maxGenericBonusTier; armor and shields
     * follow {@link GenericArmorBonusRegistry}.
     *
     * @param {object[]} pool
     * @param {number} tier
     * @param {number} weaponMaxBonus
     * @returns {object[]}
     */
    static _filterMastercraftGenericBonusPolicy(pool, tier, weaponMaxBonus) {
        const capped = pool.filter(item => {
            if (!ItemClassifier.isGenericMagic(item)) return true;
            const bonus = ItemClassifier.detectBonusTier(item);
            if (!bonus || bonus <= 0) return false;
            if (this._isArmorPoolItem(item)) {
                return GenericArmorBonusRegistry.allowsBonus(bonus, tier);
            }
            if ((item.type ?? "") === "weapon") {
                return bonus <= weaponMaxBonus;
            }
            return bonus <= Math.max(weaponMaxBonus, GenericArmorBonusRegistry.getMaxBonus(tier));
        });
        if (capped.length > 0) return capped;
        return pool.filter(item => !ItemClassifier.isGenericMagic(item));
    }

    /**
     * dnd5e armor is usually type "equipment" with system.armor.type or an
     * armor-like system.type.value, not document type "armor".
     *
     * @param {object} entry
     * @returns {boolean}
     */
    static _isArmorEntry(entry) {
        if (entry.type === "armor") return true;
        if (entry.type !== "equipment") return false;
        const armorType = (entry.system?.armor?.type ?? "").trim();
        if (armorType) return true;
        const subtype = (entry.subtype ?? entry.system?.type?.value ?? "").trim();
        return ["light", "medium", "heavy", "shield"].includes(subtype);
    }

    /** @param {object} item - Resolved pool item (flat shape with optional subtype). */
    static _isArmorPoolItem(item) {
        return this._isArmorEntry(item);
    }

    /**
     * Split a mastercraft pool into armor and weapon buckets.
     * @param {object[]} pool
     * @returns {{ armor: object[], weapons: object[] }}
     */
    static _splitMastercraftPool(pool) {
        const armor   = [];
        const shields = [];
        const weapons = [];
        for (const item of pool) {
            if (this._isArmorPoolItem(item)) {
                const subtype = (item.subtype ?? item.system?.type?.value ?? "").trim().toLowerCase();
                if (subtype === "shield") shields.push(item);
                else armor.push(item);
            } else {
                weapons.push(item);
            }
        }
        return { armor, shields, weapons };
    }

    /**
     * Imputed gp for mastercraft band filtering on generic +N items.
     * @param {object} item
     * @returns {number}
     */
    static _mastercraftEffectivePrice(item) {
        if (ItemClassifier.isGenericMagic(item)) {
            const bonus = ItemClassifier.detectBonusTier(item) || 1;
            const floor = this.GENERIC_BONUS_VALUE_FLOOR[bonus] ?? 0;
            return Math.max(item.price ?? 0, floor);
        }
        return item.price ?? 0;
    }

    /**
     * Apply tier price bands to mastercraft pools using imputed generic +N values.
     * @param {object[]} pool
     * @param {number} priceCeiling
     * @param {number|undefined} priceMax
     * @param {number} priceMin
     * @returns {object[]}
     */
    static _filterMastercraftPricePool(pool, priceCeiling, priceMax, priceMin) {
        const effective = (item) => this._mastercraftEffectivePrice(item);
        let filtered = pool;

        const applyCap = (cap) => {
            if (cap === undefined || cap >= Infinity) return;
            const capped = filtered.filter(i => effective(i) <= cap);
            if (capped.length > 0) filtered = capped;
        };

        applyCap(priceCeiling);
        applyCap(priceMax);

        if (priceMin > 0) {
            const floored = filtered.filter(i => effective(i) >= priceMin);
            if (floored.length > 0) filtered = floored;
        }

        return filtered;
    }

    /**
     * Armaments mundane slots skip clothing and wondrous wearables.
     * @param {object} item
     * @returns {boolean}
     */
    static _isArmamentsMundaneEligible(item) {
        if (item.type === "loot" || item.type === "tool") return true;
        if (item.type !== "equipment") return false;
        const subtype = (item.subtype ?? item.system?.type?.value ?? "").toLowerCase();
        if (subtype === "clothing") return false;
        if (["wondrous", "ring", "trinket"].includes(subtype)) return false;
        return true;
    }

    /**
     * When overlay packs are enabled in lootPoolSources they must not leak into
     * the generic mundane/trade-goods pool.
     *
     * @param {object} entry
     */
    static _isQmDedicatedPickerItem(entry) {
        const qm = entry.flags?.["ionrift-quartermaster"];
        if (!qm) return false;
        if (qm.gemMeta?.tier) return true;
        const cat = qm.coreMeta?.category;
        if (cat === "Treasure" || cat === "Trinkets") return true;
        if ((entry.system?.type?.value ?? "") === "gem") return true;
        return false;
    }

    /**
     * Map slotType to Foundry item type filters.
     */
    static _matchesSlotType(entry, slotType) {
        const type = entry.type;
        const subtype = (entry.system?.type?.value ?? "").toLowerCase();

        switch (slotType) {
            case "consumable": {
                if (type !== "consumable") return false;
                if (PotionEnrichment.isHealingPotion(entry.name)) return true;
                if (subtype === "scroll") return false;
                // Ammunition now has its own dedicated slot type - exclude
                // ammo subtypes from the consumable pool to prevent
                // double-counting between consumable and ammo slots.
                if (subtype === "ammo" || subtype === "ammunition") return false;
                const n = (entry.name ?? "").toLowerCase();
                if (/^(arrows?|bolts?|needles?|sling bullets?)\b/i.test(n)) return false;
                // Only actual potions, poisons, and food - not mundane gear
                // (rod, wand, trinket) that dnd5e classifies as consumable.
                const potionSubtypes = ["potion", "poison", "food", ""];
                return potionSubtypes.includes(subtype);
            }
            case "ammo": {
                // Dedicated ammunition slot: subtypes 'ammo'/'ammunition'
                // plus name-based detection for compendiums that leave
                // the subtype blank.
                if (type !== "consumable") return false;
                if (subtype === "ammo" || subtype === "ammunition") return true;
                const n = (entry.name ?? "").toLowerCase();
                return /^(arrows?|bolts?|needles?|sling bullets?)\b/i.test(n);
            }
            case "scroll":
                return type === "consumable" && subtype === "scroll";
            case "mundane": {
                // Mundane pool: loot and tools always qualify.
                // Equipment only qualifies if it has NO rarity (common/empty)
                // to prevent wondrous items like Decanter of Endless Water
                // from appearing in the mundane loot pool.
                if (type === "loot" || type === "tool") {
                    if (this._isQmDedicatedPickerItem(entry)) return false;
                    return true;
                }
                if (type === "equipment") {
                    const rarity = (entry.system?.rarity ?? "").toLowerCase();
                    return !rarity || rarity === "common" || rarity === "none";
                }
                return false;
            }
            case "mastercraft":
                // Weapons and armor of any rarity. SRD armor is usually equipment, not armor.
                return type === "weapon" || this._isArmorEntry(entry);
            default:
                return false;
        }
    }

    /**
     * Check if item rarity is within allowed range.
     */
    static _matchesRarity(entry, allowedRarities) {
        const rarity = (entry.system?.rarity ?? "").toLowerCase().trim();
        // No rarity field: treat as common, still subject to the tier ceiling
        const effective = rarity || "common";
        return allowedRarities.has(effective);
    }

    /**
     * Exclude problematic items (cursed, artifacts, class-specific features).
     */
    static _isExcluded(entry) {
        const name = entry.name?.trim() ?? "";
        const nameLower = name.toLowerCase();
        // Skip class features, spells, feats masquerading as items
        if (entry.type === "feat" || entry.type === "class" || entry.type === "spell") return true;
        // Skip items with no name
        if (!name) return true;
        if (this._isPlaceholderPoolEntry(entry, nameLower)) return true;
        if (this._isContainerContentOnly(entry, nameLower)) return true;
        if (this._isTrapOrHazard(entry)) return true;
        if (this._isZeroDataPlaceholder(entry)) return true;
        if (this._isZeroWeightWeaponTemplate(entry)) return true;
        if (this._isZeroWeightArmorTemplate(entry)) return true;
        if (this._isEconomyPendingLoot(entry)) return true;
        if (this._isSlayingTemplateShell(entry, nameLower)) return true;
        if (this._isNarrativeReserveLoot(entry)) return true;
        if (this._isBulkAmmoCollection(entry, nameLower)) return true;
        if (this._isGmPlacedPoison(entry, nameLower)) return true;
        if (this._isLegacyRenamedItem(entry, nameLower)) return true;
        if (isSrdCursedLootName(name)) return true;
        return false;
    }

    /**
     * 2024 slaying ammo template shell and enchantment rider documents.
     * Compiled output replaces these in the loot pool.
     */
    static _isSlayingTemplateShell(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
        if (nameLower === "ammunition of slaying") return true;
        if (nameLower.startsWith("ammunition of slaying ")) return true;
        if (entry.type === "enchantment" && /^ammunition of slaying /i.test(entry.name ?? "")) return true;
        return false;
    }

    /**
     * Single-use narrative ammunition reserved for deliberate placement.
     */
    static _isNarrativeReserveLoot(entry) {
        return ItemClassifier.isSlayingAmmo(entry);
    }

    /**
     * Bulk ammo bundles (2024 SRD pack-of-N entries). The 2024 compendium ships
     * both a singular form ("Arrow") and a plural bundle form ("Arrows", qty 20).
     * The loot generator uses the singular and stacks via the quantity resolver;
     * including the plural bundle alongside it would create duplicate pool entries
     * that double the probability of ammo landing and produce misleading qty math.
     *
     * Filter list is a closed set - only the known SRD bundle names are excluded.
     * Any new plural ammo added by future content should be evaluated and added here.
     */
    static _isBulkAmmoCollection(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
        if (entry.type !== "consumable") return false;
        const subtype = (entry.system?.type?.value ?? "").trim();
        if (subtype !== "ammo") return false;
        const BULK_BUNDLES = new Set(["arrows", "bolts", "bullets, sling", "bullets, firearm", "needles"]);
        return BULK_BUNDLES.has(nameLower);
    }

    /**
     * Combat poisons and poison potions are GM-placed only (Cursewright, deliberate
     * placement). Random caches must not roll DMG sample poisons (Malice, Wyvern
     * Poison, etc.) or Potion of Poison variants.
     *
     * Basic Poison and Antitoxin remain eligible as mundane adventuring gear.
     *
     * @param {object} entry
     * @param {string} [nameLower]
     */
    static _isGmPlacedPoison(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
        if (/^potion of (?:greater |superior |supreme )?poison$/i.test(nameLower)) return true;

        const subtype = (entry.system?.type?.value ?? "").toString().toLowerCase();
        if (subtype !== "poison") return false;

        if (/^basic poison$/i.test(nameLower)) return false;
        if (/antitoxin/i.test(nameLower)) return false;

        return true;
    }

    /**
     * SRD compendium stubs that are not real loot rows (table pointers, empty shells).
     */
    static _isPlaceholderPoolEntry(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
        if (nameLower === "trinket") return true;

        // SRD table-aggregator stubs: entries like "Ammunition, +1, +2, or +3" list a
        // bonus range rather than naming a specific item. No real loot item has ", or +"
        // in its name, so this pattern reliably identifies roll-table pointers.
        if (/, or \+\d/.test(nameLower)) return true;

        const desc = this._entryDescriptionText(entry);
        if (!desc) return false;
        if (desc.includes("placeholder for the non-srd")) return true;
        if (desc.includes("placeholder") && desc.includes("d100 table")) return true;
        return false;
    }

    /**
     * SRD compendium rows with no economy or rarity data (table pointers, variant
     * shells). dnd5e.equipment24 ships many magic items at price 0, weight 0,
     * rarity "" until a specific variant is chosen.
     */
    static _isZeroDataPlaceholder(entry) {
        if (PotionEnrichment.isHealingPotion(entry.name)) return false;
        const price = this._extractPrice(entry);
        const weight = this._extractWeight(entry);
        const rarity = (entry.system?.rarity ?? "").trim();
        return price === 0 && weight === 0 && rarity === "";
    }

    /**
     * Named magic rows with zero price and zero weight. These are not loot-ready
     * until LootPoolCompiler enrichment emits a compiled counterpart.
     */
    static _isEconomyPendingLoot(entry) {
        if (PotionEnrichment.isHealingPotion(entry.name)) return false;
        const price = this._extractPrice(entry);
        const weight = this._extractWeight(entry);
        if (price !== 0 || weight !== 0) return false;
        const rarity = (entry.system?.rarity ?? "").trim().toLowerCase();
        if (!rarity || rarity === "common" || rarity === "none") return false;
        return true;
    }

    /**
     * 2024 SRD named weapon templates (Dragon Slayer, Holy Avenger, Vorpal Sword,
     * etc.). The dnd5e.equipment24 pack ships these as GM-application shells - the
     * GM attaches one to a real base weapon rather than dropping it as loot.
     *
     * Fingerprint: weapon type + weight=0 + no base item subtype. All real loot
     * weapons carry a subtype (martialM, simpleR, martialR, etc.). A blank or
     * literal "-" subtype combined with zero weight is the reliable signal.
     *
     * This does NOT affect mundane zero-weight weapons like Sling (which have a
     * subtype), only shell entries that lack one.
     */
    static _isZeroWeightWeaponTemplate(entry) {
        if (entry.type !== "weapon") return false;
        const weight = this._extractWeight(entry);
        if (weight !== 0) return false;
        const subtype = (entry.system?.type?.value ?? "").trim();
        return !subtype || subtype === "-";
    }

    /**
     * 2024 SRD named armor template shells (Adamantine Armor, Mithral Armor,
     * Armor of Resistance, Armor of Vulnerability, Demon Armor, Efreeti Chain,
     * Elven Chain, Plate Armor of Etherealness).
     *
     * Identical pattern to weapon templates: the 2024 pack ships these as
     * GM-application overlays. A GM attaches "Adamantine Armor" to a Chain Mail
     * or Plate Armor — it is not a standalone loot item. The shell has no base
     * armor subtype (heavy/medium/light/shield is left blank) and weight=0.
     *
     * Fingerprint: type=equipment + weight=0 + subtype is blank/dash, and NOT
     * one of the known non-armor equipment subtypes (wondrous, ring, trinket,
     * clothing, wand, rod, gear). Full stubs (price=0, rarity="") are already
     * removed by _isZeroDataPlaceholder; traps are removed by _isTrapOrHazard.
     * This catches only the template shells that have rarity and price set.
     */
    static _isZeroWeightArmorTemplate(entry) {
        if (entry.type !== "equipment") return false;
        const weight = this._extractWeight(entry);
        if (weight !== 0) return false;
        const subtype = (entry.system?.type?.value ?? "").trim();
        // Known non-armor equipment subtypes — these are NOT armor templates
        const WONDROUS_SUBTYPES = new Set([
            "wondrous", "ring", "trinket", "clothing", "wand", "rod", "gear"
        ]);
        if (WONDROUS_SUBTYPES.has(subtype)) return false;
        // Armor subtypes that are real items (already have proper data)
        const ARMOR_SUBTYPES = new Set(["heavy", "medium", "light", "shield"]);
        if (ARMOR_SUBTYPES.has(subtype)) return false;
        // Blank or literal dash = no base armor type assigned = template shell
        return !subtype || subtype === "-";
    }

    /**
     * Items that only exist as contents of a container and should never appear
     * as standalone loot drops. Bulk liquids measured in pints (water, common
     * wine, etc.) arrive in waterskins or flasks - they have no meaning as a
     * loose item in a cache.
     *
     * Rule: consumable food/drink items whose name ends with a parenthesised
     * unit of measure such as "(Pint)", "(Gallon)", "(Ounce)", or "(Portion)"
     * are treated as container-content stubs.
     */
    /**
     * Trap and hazard items from SRD 5.2 (Hidden Pit, Falling Net, etc.) are
     * classified as equipment with no rarity, so they pass the mundane filter.
     * Every trap stat block has a "Trigger:" line in its description - no real
     * loot item uses that keyword - making it a safe, targeted rejection signal.
     */
    static _isTrapOrHazard(entry) {
        const desc = this._entryDescriptionText(entry);
        if (!desc) return false;
        // "trigger:" is the canonical trap stat-block header in SRD 5.2
        if (desc.includes("trigger:")) return true;
        // Belt-and-suspenders: also catch "nuisance trap" and "setpiece trap" headers
        if (/\b(?:nuisance|setpiece)\s+trap\b/.test(desc)) return true;
        return false;
    }

    static _isContainerContentOnly(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
        // Only applies to consumable food/drink items
        const subtype = (entry.system?.type?.value ?? "").toLowerCase();
        if (entry.type !== "consumable" || (subtype !== "food" && subtype !== "drink" && subtype !== "")) return false;

        // Reject anything whose display name ends with a liquid/bulk unit in parentheses
        if (/\(pint(?:s)?\)$/i.test(nameLower)) return true;
        if (/\(gallon(?:s)?\)$/i.test(nameLower)) return true;
        if (/\(ounce(?:s)?\)$/i.test(nameLower)) return true;
        if (/\(portion(?:s)?\)$/i.test(nameLower)) return true;

        return false;
    }

    /**
     * Items renamed in SRD 5.2 to include their container type
     * (e.g. "Holy Water" became "Flask of Holy Water", "Acid" became
     * "Acid (vial)"). When a 2024-architecture pack is an enabled source,
     * suppress the legacy name so only the 2024 form appears in the pool.
     *
     * Suppression is one-directional: the legacy entry is rejected here;
     * the 2024 entry is unaffected and passes through normally.
     *
     * @param {object} entry
     * @param {string} [nameLower]
     */
    static _isLegacyRenamedItem(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
        if (!this.LEGACY_2024_RENAMED.has(nameLower)) return false;
        const sources = this.getEnabledSources();
        return sources.some(id => this.EQUIPMENT24_PACKS.has(id));
    }

    static _entryDescriptionText(entry) {
        const raw = entry.system?.description?.value
            ?? entry.system?.description
            ?? "";
        if (typeof raw !== "string") return "";
        return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    }

    /**
     * Extract item weight from various dnd5e system formats.
     * Old dnd5e: system.weight is a plain number.
     * New dnd5e (v4+): system.weight is { value, units }.
     */
    static _extractWeight(entry) {
        const w = entry.system?.weight;
        if (w === null || w === undefined) return 0;
        if (typeof w === "number") return w;
        if (typeof w === "object") return Number(w.value ?? 0) || 0;
        return Number(w) || 0;
    }

    /**
     * Extract gold price from various system formats.
     */
    static _extractPrice(entry) {
        const price = entry.system?.price;
        if (!price) return 0;
        if (typeof price === "number") return price;
        if (typeof price === "object") {
            const val = price.value ?? 0;
            const denom = price.denomination ?? "gp";
            // Convert to gp
            if (denom === "sp") return val / 10;
            if (denom === "cp") return val / 100;
            if (denom === "ep") return val / 2;
            if (denom === "pp") return val * 10;
            return val;
        }
        return 0;
    }

    /**
     * Get rarity set up to a given max.
     */
    static _raritiesUpTo(maxRarity) {
        const order = ["common", "uncommon", "rare", "very rare", "veryrare", "legendary", "artifact"];
        const maxIdx = order.indexOf(maxRarity.toLowerCase().replace(/\s+/g, ''));
        const effectiveMax = maxIdx >= 0 ? maxIdx : 1;
        return new Set(order.slice(0, effectiveMax + 1));
    }

    /**
     * Fallback items from static cache-tables.json.
     * Removed: compendiums are the sole source of truth for all items.
     */
    static _getFallbackItems(slotType, theme, tables) {
        return [];
    }

    static _isCacheExpired() {
        if (!this._cacheExpiry) return true;
        return Date.now() > this._cacheExpiry;
    }


    /**
     * List compendiums that contain lootable item types for the config UI.
     * Filters to Item-type packs that actually hold loot, equipment, weapons,
     * tools, consumables, or backpacks -- not spells, classes, or backgrounds.
     * @returns {{ id: string, label: string, enabled: boolean }[]}
     */
    static listAvailableCompendiums() {
        const enabled = new Set(this.getEnabledSources());
        const LOOT_TYPES = new Set(["loot", "equipment", "weapon", "tool", "consumable", "backpack"]);

        const EXCLUDED_PACK_SUFFIXES = new Set([
            "spells", "spells24",
            "classfeatures", "classfeatures24",
            "classes", "classes24",
            "subclasses", "subclasses24",
            "monsterfeatures", "monsterfeatures24",
            "backgrounds", "backgrounds24",
            "races", "races24",
            "rules"
        ]);

        // Cursewright manages injection of cursed items into caches via its
        // own pipeline -- these packs must never appear as manual loot sources.
        const CURSEWRIGHT_MANAGED_PACKS = new Set([
            "ionrift-cursewright-forged",
            "ionrift-srd-cursed"
        ]);

        // Respite activity items (forage, hunt, meals) are not cache loot.
        const LOOT_POOL_EXCLUDED_PACKS = ItemPoolResolver.LOOT_POOL_EXCLUDED_PACKS;

        // Quartermaster pipeline outputs -- these are compiled products, not
        // source inputs. Showing them as selectable sources would create a
        // circular dependency (output fed back into its own compiler).
        const QM_PIPELINE_OUTPUTS = new Set([
            "world.quartermaster-compiled-pool",  // LootPoolCompiler output
            "world.ionrift-forged-scrolls",        // ScrollForge output
            "world.ionrift-srd-cursed",            // SrdCurseAdapter output
            "world.ionrift-cursewright-forged",    // Cursewright output
        ]);

        // Packs we know are good loot sources and recommend to the GM.
        // Checked by full collection ID.
        const RECOMMENDED_PACKS = new Set([
            "dnd5e.equipment",
            "dnd5e.equipment24",
            "dnd5e.items",
            "ionrift-respite.respite-cache-utility",
        ]);

        // Packs that contain 2024 weapon templates requiring compilation.
        const NEEDS_COMPILE_PACKS = new Set([
            "dnd5e.equipment24",
        ]);

        return game.packs
            .filter(p => {
                if (p.documentName !== "Item") return false;
                if (QM_PIPELINE_OUTPUTS.has(p.collection)) return false;
                if (LOOT_POOL_EXCLUDED_PACKS.has(p.collection)) return false;

                const packName = p.collection.split(".").pop() ?? "";
                if (EXCLUDED_PACK_SUFFIXES.has(packName)) return false;
                if (CURSEWRIGHT_MANAGED_PACKS.has(packName)) return false;

                if (p.index?.size > 0) {
                    return [...p.index.values()].some(e => LOOT_TYPES.has(e.type));
                }
                return true;
            })
            .map(p => {
                // QM content packs (world.quartermaster-*) are always recommended
                // as valid loot sources since they're curated for this workflow.
                const isQmContent = p.collection.startsWith("world.quartermaster-");
                const recommended = isQmContent || RECOMMENDED_PACKS.has(p.collection);
                const needsCompile = NEEDS_COMPILE_PACKS.has(p.collection);

                return {
                    id:          p.collection,
                    label:       p.title ?? p.metadata?.label ?? p.collection,
                    system:      p.metadata?.system ?? null,
                    enabled:     enabled.has(p.collection),
                    recommended,
                    needsCompile,
                };
            });
    }
}
