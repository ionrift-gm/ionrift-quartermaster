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

const MODULE_ID = "ionrift-quartermaster";

export class ItemPoolResolver {
    // Session cache: compendiumId -> filtered items[]
    static _cache = new Map();
    static _cacheExpiry = null;
    static CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

    // Per-item price ceiling by tier. Rejects individual items that cost more
    // than a tier's loot table should reasonably contain as a random drop.
    static TIER_PRICE_CEILING = {
        1: 100,     // T1: mundane and cheap magic only
        2: 500,     // T2: mid-range magic
        3: 5000,    // T3: high magic
        4: Infinity  // T4: no ceiling
    };

    /**
     * Get enabled compendium source IDs from module settings.
     * @returns {string[]}
     */
    static getEnabledSources() {
        try {
            const raw = game.settings.get(MODULE_ID, "lootPoolSources");
            return JSON.parse(raw);
        } catch {
            return ["dnd5e.items", "dnd5e.tradegoods"];
        }
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
        const { slotType, tier, theme, fallbackTables } = opts;
        const tierData = fallbackTables?.tiers?.[String(tier)];
        const rarityMax = tierData?.rarityMax ?? "uncommon";

        const sources = this.getEnabledSources();
        const compendiumItems = await this._queryCompendiums(sources, slotType, rarityMax);

        // Get fallback items from static tables
        const fallbackItems = this._getFallbackItems(slotType, theme, fallbackTables) ?? [];

        // Merge: compendium items first, then fallback
        const merged = [...compendiumItems, ...fallbackItems];

        // Deduplicate by name (prefer compendium version)
        const seen = new Set();
        return merged.filter(item => {
            const key = item.name.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    /**
     * Pick a random item from the resolved pool.
     */
    static async pickRandom(opts) {
        let pool = await this.resolve(opts);
        if (!pool.length) return null;

        // Apply per-item price ceiling for the tier
        const tier = opts.tier ?? 1;
        const priceCeiling = this.TIER_PRICE_CEILING[tier] ?? Infinity;
        if (priceCeiling < Infinity) {
            const pricedPool = pool.filter(i => (i.price ?? 0) <= priceCeiling);
            if (pricedPool.length > 0) pool = pricedPool;
        }

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
                // Safety net: if we purged everything, fall back to the raw pool
                if (tunedPool.length > 0) pool = tunedPool;
            } else {
                // High magic: artificially inflate the number of magical items in the draw bag
                const extraCopies = Math.floor(magicSetting) - 1;
                const chance = magicSetting % 1;
                
                for (const item of pool) {
                    tunedPool.push(item); // The guaranteed copy
                    if (isMagical(item)) {
                        for (let i = 0; i < extraCopies; i++) tunedPool.push(item);
                        if (Math.random() <= chance) tunedPool.push(item);
                    }
                }
                pool = tunedPool;
            }
        }

        return pool[Math.floor(Math.random() * pool.length)];
    }

    /**
     * Query compendiums and return filtered items.
     */
    static async _queryCompendiums(sourceIds, slotType, rarityMax) {
        const results = [];
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
                    "name", "type", "img", "system.price", "system.rarity",
                    "system.type", "system.weight", "system.description"
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
                        price: this._extractPrice(entry),
                        rarity: entry.system?.rarity ?? "common",
                        weight: this._extractWeight(entry),
                        _baseItem: entry.system?.type?.baseItem ?? "",
                        subtype: (entry.system?.type?.value ?? "").toString().toLowerCase(),
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

    /**
     * Map slotType to Foundry item type filters.
     */
    static _matchesSlotType(entry, slotType) {
        const type = entry.type;
        const subtype = entry.system?.type?.value ?? "";

        switch (slotType) {
            case "consumable": {
                if (type !== "consumable") return false;
                if (subtype === "scroll") return false;
                // Only actual potions, poisons, food, and ammunition -- not mundane gear (rod, wand,
                // trinket) that dnd5e happens to classify as consumable. Ammunition subtypes vary
                // by compendium: 'ammo', 'ammunition', or empty string on some packs.
                const potionSubtypes = ["potion", "poison", "food", "ammo", "ammunition", ""];
                return potionSubtypes.includes(subtype);
            }
            case "scroll":
                return type === "consumable" && subtype === "scroll";
            case "mundane": {
                // Mundane pool: loot and tools always qualify.
                // Equipment only qualifies if it has NO rarity (common/empty)
                // to prevent wondrous items like Decanter of Endless Water
                // from appearing in the mundane loot pool.
                if (type === "loot" || type === "tool") return true;
                if (type === "equipment") {
                    const rarity = (entry.system?.rarity ?? "").toLowerCase();
                    return !rarity || rarity === "common" || rarity === "none";
                }
                return false;
            }
            case "mastercraft":
                // Weapons and armor of any rarity -- includes SRD items & workshop cultural weapons
                return type === "weapon" || type === "armor";
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
        return false;
    }

    /**
     * SRD compendium stubs that are not real loot rows (table pointers, empty shells).
     */
    static _isPlaceholderPoolEntry(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
        if (nameLower === "trinket") return true;

        const desc = this._entryDescriptionText(entry);
        if (!desc) return false;
        if (desc.includes("placeholder for the non-srd")) return true;
        if (desc.includes("placeholder") && desc.includes("d100 table")) return true;
        return false;
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
     * Clear the session cache. Call when compendium sources change.
     */
    static clearCache() {
        this._cache.clear();
        this._cacheExpiry = Date.now() + this.CACHE_TTL_MS;
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
            "feats", "feats24",
            "rules"
        ]);

        return game.packs
            .filter(p => {
                if (p.documentName !== "Item") return false;

                const packName = p.collection.split(".").pop() ?? "";
                if (EXCLUDED_PACK_SUFFIXES.has(packName)) return false;

                if (p.index?.size > 0) {
                    return [...p.index.values()].some(e => LOOT_TYPES.has(e.type));
                }
                return true;
            })
            .map(p => ({
                id: p.collection,
                label: p.title ?? p.metadata?.label ?? p.collection,
                system: p.metadata?.system ?? null,
                enabled: enabled.has(p.collection)
            }));
    }
}
