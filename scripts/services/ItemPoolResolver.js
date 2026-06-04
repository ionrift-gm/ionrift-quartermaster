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

    // Per-item price ceiling by tier. Rejects individual items that cost more
    // than a tier's loot table should reasonably contain as a random drop.
    static TIER_PRICE_CEILING = {
        1: 100,     // T1: mundane and cheap magic only
        2: 500,     // T2: mid-range magic
        3: 5000,    // T3: high magic
        4: Infinity  // T4: no ceiling
    };

    /**
     * Compendium IDs that must never feed Quartermaster loot pools or compilation.
     * Activity items (forage, hunt, cooking) stay in Respite; use respite-cache-utility instead.
     */
    static LOOT_POOL_EXCLUDED_PACKS = new Set([
        "ionrift-respite.respite-items",
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
        const uncursed = cursedNames.size > 0
            ? deduped.filter(item => !cursedNames.has(item.name.trim().toLowerCase()))
            : deduped;

        if (!theme) return uncursed;
        return uncursed.filter(item => this._eligibleForTheme(item, theme));
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

        // Named-magical filtering (Stance B policy): when requested, strip
        // named magical items from the draw bag so only generic +N and
        // mundane items remain eligible.
        if (opts.rejectNamedMagical) {
            const filtered = pool.filter(i => !ItemClassifier.isNamedMagical(i));
            if (filtered.length > 0) pool = filtered;
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
                        flags: entry.flags ?? {},
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
     * QM overlay gems, treasure, and trinkets belong in dedicated cache slots.
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
        if (this._isContainerContentOnly(entry, nameLower)) return true;
        if (this._isTrapOrHazard(entry)) return true;
        if (this._isZeroDataPlaceholder(entry)) return true;
        if (this._isZeroWeightWeaponTemplate(entry)) return true;
        if (this._isBulkAmmoCollection(entry, nameLower)) return true;
        if (this._isGmPlacedPoisonPotion(entry, nameLower)) return true;
        return false;
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
     * Poison potions are Cursewright-only. They must never surface from random
     * cache pool rolls; the GM places them via the cursed pool or recipes.
     *
     * @param {object} entry
     * @param {string} [nameLower]
     */
    static _isGmPlacedPoisonPotion(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
        return /^potion of (?:greater |superior |supreme )?poison$/i.test(nameLower);
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
        const price = this._extractPrice(entry);
        const weight = this._extractWeight(entry);
        const rarity = (entry.system?.rarity ?? "").trim();
        return price === 0 && weight === 0 && rarity === "";
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
