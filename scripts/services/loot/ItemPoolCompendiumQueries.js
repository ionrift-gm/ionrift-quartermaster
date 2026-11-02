import { MODULE_ID } from "../../data/moduleId.js";
/**
 * ItemPoolResolver
 *
 * Resolves loot pool items from multiple sources at runtime:
 *   1. User-selected compendiums (configured in module settings)
 *   2. Static fallback tables (cache-tables.json)
 *
 * Results are cached per session to avoid repeated compendium queries.
 */

import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { ItemClassifier } from "../workshop/ItemClassifier.js";
import { GenericArmorBonusRegistry } from "../workshop/GenericArmorBonusRegistry.js";
import { isSrdCursedLootName } from "../curse/SrdCurseCatalog.js";
import { getQuartermasterAdapter } from "../../adapters/getAdapter.js";
import * as DnD5ePool from "../../adapters/concrete/dnd/DnD5ePoolRules.js";


export class ItemPoolCompendiumQueries {
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
            try { return game.settings.get(MODULE_ID, "compiledLootPoolHash"); }
            catch { return ""; }
        })();
        if (compiledPack && compiledHash && getQuartermasterAdapter().canCompileLootPool()) {
            sourceIds = ["world.quartermaster-compiled-pool", ...sourceIds];
        }
        const allowedRarities = this._raritiesUpTo(rarityMax);
        const adapter = getQuartermasterAdapter();

        for (const packId of sourceIds) {
            const cacheKey = `${packId}:${slotType}:${rarityMax}`;

            // Check cache
            if (this._cache.has(cacheKey) && !this._isCacheExpired()) {
                results.push(...this._cache.get(cacheKey));
                continue;
            }

            if (packId === "world.items") {
                const worldItems = game.items?.contents ?? (game.items ? [...game.items.values()] : []);
                const filtered = [];
                for (const entry of worldItems) {
                    if (!this._matchesSlotType(entry, slotType)) continue;
                    if (!this._matchesRarity(entry, allowedRarities)) continue;
                    if (this._isExcluded(entry)) continue;
                    filtered.push(adapter.normalizePoolEntry(entry, packId));
                }
                this._cache.set(cacheKey, filtered);
                if (!this._cacheExpiry) {
                    this._cacheExpiry = Date.now() + this.CACHE_TTL_MS;
                }
                results.push(...filtered);
                continue;
            }

            const pack = game.packs.get(packId);
            if (!pack) continue;
            if (pack.documentName !== "Item") continue;

            try {
                // Use getIndex for lightweight query
                const index = await pack.getIndex({ fields: adapter.getCompendiumIndexFields() });

                const filtered = [];
                for (const entry of index) {
                    if (!this._matchesSlotType(entry, slotType)) continue;
                    if (!this._matchesRarity(entry, allowedRarities)) continue;
                    if (this._isExcluded(entry)) continue;

                    filtered.push(adapter.normalizePoolEntry(entry, packId));
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
        return entry.flags?.[MODULE_ID]?.terrain ?? [];
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
        return DnD5ePool.isArmorEntry(entry);
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
        return DnD5ePool.isQmDedicatedPickerItem(entry);
    }

    /**
     * Map slotType to Foundry item type filters.
     */
    static _matchesSlotType(entry, slotType) {
        return getQuartermasterAdapter().matchesSlotType(entry, slotType);
    }

    /**
     * Check if item rarity is within allowed range.
     */
    static _matchesRarity(entry, allowedRarities) {
        const adapter = getQuartermasterAdapter();
        const rarity = adapter.normalizeRarityForTier(adapter.getRarityFromEntry(entry));
        const effective = rarity || "common";
        return allowedRarities.has(effective);
    }

    /**
     * Exclude problematic items (cursed, artifacts, class-specific features).
     */
    static _isExcluded(entry) {
        return getQuartermasterAdapter().isExcludedFromPool(entry);
    }

    static _isSlayingTemplateShell(entry, nameLower) {
        return DnD5ePool.isSlayingTemplateShell(entry, nameLower);
    }

    static _isNarrativeReserveLoot(entry) {
        return DnD5ePool.isNarrativeReserveLoot(entry);
    }

    static _isBulkAmmoCollection(entry, nameLower) {
        return DnD5ePool.isBulkAmmoCollection(entry, nameLower);
    }

    static _isGmPlacedPoison(entry, nameLower) {
        return DnD5ePool.isGmPlacedPoison(entry, nameLower);
    }

    static _isPlaceholderPoolEntry(entry, nameLower) {
        return DnD5ePool.isPlaceholderPoolEntry(entry, nameLower);
    }

    static _isZeroDataPlaceholder(entry) {
        return DnD5ePool.isZeroDataPlaceholder(entry);
    }

    static _isEconomyPendingLoot(entry) {
        return DnD5ePool.isEconomyPendingLoot(entry);
    }

    static _isZeroWeightWeaponTemplate(entry) {
        return DnD5ePool.isZeroWeightWeaponTemplate(entry);
    }

    static _isZeroWeightArmorTemplate(entry) {
        return DnD5ePool.isZeroWeightArmorTemplate(entry);
    }

    static _isTrapOrHazard(entry) {
        return DnD5ePool.isTrapOrHazard(entry);
    }

    static _isContainerContentOnly(entry, nameLower) {
        return DnD5ePool.isContainerContentOnly(entry, nameLower);
    }

    static _isLegacyRenamedItem(entry, nameLower) {
        return DnD5ePool.isLegacyRenamedItem(entry, nameLower);
    }

    static _entryDescriptionText(entry) {
        return DnD5ePool.entryDescriptionText(entry);
    }

    /**
     * Extract item weight from various dnd5e system formats.
     * Old dnd5e: system.weight is a plain number.
     * New dnd5e (v4+): system.weight is { value, units }.
     */
    static _extractWeight(entry) {
        return getQuartermasterAdapter().extractWeight(entry);
    }

    /**
     * Extract gold price from various system formats.
     */
    static _extractPrice(entry) {
        return getQuartermasterAdapter().extractPrice(entry);
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
    static _getFallbackItems(_slotType, _theme, _tables) {
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
        const adapter = getQuartermasterAdapter();
        const LOOT_TYPES = new Set([
            "loot", "equipment", "weapon", "tool", "consumable", "backpack",
            "item", "armor", "shield", "treasure", "gear", "goods", "ammunition",
            "technological", "augmentation", "hybrid", "magic", "upgrade", "mod", "weaponAccessory"
        ]);

        const EXCLUDED_PACK_SUFFIXES = new Set([
            "spells", "spells24",
            "classfeatures", "classfeatures24",
            "classes", "classes24",
            "subclasses", "subclasses24",
            "monsterfeatures", "monsterfeatures24",
            "backgrounds", "backgrounds24",
            "races", "races24",
            "rules",
            "quartermaster-containers",
            "item-piles-item-backup-do-not-delete"
        ]);

        const EXCLUDED_PACK_NAME_RE = /(?:^|[-_])(spells?|class-?features?|archetype-?features?|racial-?features?|species-?features?|creature-?features?|monster-?features?|universal-?creature-?rules?|classes|subclasses|backgrounds|races|ancestries|heritages|feats|themes|abilities|skills|conditions|effects|starship|vehicles?|rules|macros|tables)(?:24)?$/i;

        // Cursewright manages injection of cursed items into caches via its
        // own pipeline -- these packs must never appear as manual loot sources.
        const CURSEWRIGHT_MANAGED_PACKS = new Set([
            "ionrift-cursewright-forged",
            "ionrift-srd-cursed"
        ]);

        // Respite activity items (forage, hunt, meals) are not cache loot.
        const LOOT_POOL_EXCLUDED_PACKS = this.LOOT_POOL_EXCLUDED_PACKS;

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
            "sfrpg.equipment",
        ]);

        // Packs that contain 2024 weapon templates requiring compilation.
        const NEEDS_COMPILE_PACKS = new Set([
            "dnd5e.equipment24",
        ]);

        const packs = (game.packs ?? [])
            .filter(p => {
                if (p.documentName !== "Item") return false;
                if (QM_PIPELINE_OUTPUTS.has(p.collection) || game.ionrift?.library?.CompendiumSourceService?.isPipelineOutput?.(p.collection)) return false;
                if (LOOT_POOL_EXCLUDED_PACKS.has(p.collection)) return false;

                const packName = p.collection.split(".").pop() ?? "";
                if (EXCLUDED_PACK_SUFFIXES.has(packName)) return false;
                if (EXCLUDED_PACK_NAME_RE.test(packName)) return false;
                if (CURSEWRIGHT_MANAGED_PACKS.has(packName)) return false;

                if (p.index?.size > 0) {
                    return [...p.index.values()].some(e =>
                        LOOT_TYPES.has(e.type)
                        && !adapter.isExcludedFromPool({ name: e.name || "item", type: e.type })
                    );
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

        const worldItems = game.items?.contents ?? (game.items ? [...game.items.values()] : []);
        const hasLootableWorldItems = worldItems.some(e => !adapter.isExcludedFromPool(e));
        const isGenericAdapter = !adapter.canCompileLootPool() && adapter.id !== "pf2e";
        if (hasLootableWorldItems || isGenericAdapter || enabled.has("world.items")) {
            packs.unshift({
                id:           "world.items",
                label:        game.i18n.localize("ionrift-quartermaster.pool.worldItemsDirectory"),
                system:       game.system?.id ?? null,
                enabled:      enabled.has("world.items"),
                recommended:  false,
                needsCompile: false,
            });
        }

        return packs;
    }
}

export function applyItemPoolCompendiumQueries(TargetClass) {
    for (const key of Object.getOwnPropertyNames(ItemPoolCompendiumQueries)) {
        if (key === "length" || key === "name" || key === "prototype") continue;
        const desc = Object.getOwnPropertyDescriptor(ItemPoolCompendiumQueries, key);
        if (desc) Object.defineProperty(TargetClass, key, desc);
    }
}
