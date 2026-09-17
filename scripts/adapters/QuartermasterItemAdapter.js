/**
 * Abstract system adapter for Quartermaster item pipelines.
 * Core QM services call through game.ionrift.quartermaster.adapter
 * instead of reading item.system or game.system.id directly.
 *
 * @abstract
 */
export class QuartermasterItemAdapter {

    /** @returns {string} Foundry system id, e.g. "dnd5e", "pf2e" */
    get id() { throw new Error("QuartermasterItemAdapter.id not implemented"); }

    /**
     * @param {string} featureId  {@link QM_FEATURES} or library feature id
     * @returns {boolean}
     */
    supports(featureId) { return false; }

    /**
     * Compendium pack ids suggested on first run when lootPoolSources is still
     * at factory defaults from another system.
     * @returns {string[]}
     */
    getDefaultLootPoolSources() { return []; }

    /**
     * @returns {string[]}
     */
    getWorkshopItemTypes() {
        return ["weapon", "equipment", "consumable", "loot", "tool", "backpack", "spell", "feat"];
    }

    /**
     * Fields passed to compendium getIndex() for pool queries.
     * @returns {string[]}
     */
    getCompendiumIndexFields() {
        return [
            "name", "type", "img", "flags", "system.price", "system.rarity",
            "system.type", "system.weight", "system.description", "system.magicalBonus"
        ];
    }

    /**
     * @param {object} entry  Compendium index row
     * @returns {string}
     */
    getRarityFromEntry(entry) {
        return (entry.system?.rarity ?? "common").toLowerCase().trim();
    }

    /**
     * Map native rarity to the tier-ceiling vocabulary used by ItemPoolResolver.
     * @param {string} rarity
     * @returns {string}
     */
    normalizeRarityForTier(rarity) {
        const r = (rarity ?? "").toLowerCase().trim();
        return r || "common";
    }

    /**
     * @param {object} entry
     * @returns {number} Price in gp
     */
    extractPrice(entry) {
        const price = entry.system?.price;
        if (!price) return 0;
        if (typeof price === "number") return price;
        if (typeof price === "object") {
            const val = price.value ?? 0;
            const denom = price.denomination ?? "gp";
            const toGp = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 };
            return val * (toGp[denom] ?? 1);
        }
        return 0;
    }

    /**
     * @param {object} entry
     * @returns {number}
     */
    extractWeight(entry) {
        const w = entry.system?.weight;
        if (w === null || w === undefined) return 0;
        if (typeof w === "number") return w;
        if (typeof w === "object") return Number(w.value ?? 0) || 0;
        return Number(w) || 0;
    }

    /**
     * @param {object} entry
     * @param {string} slotType
     * @returns {boolean}
     */
    matchesSlotType(entry, slotType) { return false; }

    /**
     * System-specific pool exclusions beyond universal checks in ItemPoolResolver.
     * @param {object} entry
     * @returns {boolean} true when the entry must be skipped
     */
    isExcludedFromPool(entry) { return false; }

    /**
     * @param {object} entry
     * @param {string} packId
     * @returns {object} Flat pool row for ItemPoolResolver
     */
    normalizePoolEntry(entry, packId) {
        return {
            name: entry.name,
            type: entry.type,
            img: entry.img,
            flags: entry.flags ?? {},
            price: this.extractPrice(entry),
            rarity: this.getRarityFromEntry(entry),
            weight: this.extractWeight(entry),
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
        };
    }

    /** @returns {boolean} */
    shouldApplyLatentMasking() { return false; }

    /**
     * @param {object} item
     * @param {object} [ctx]
     * @returns {{ isMagical: boolean, baseItemName?: string, mundaneDesc?: string, obscuredImg?: string }}
     */
    detectMagicalForCache(item, ctx = {}) {
        return { isMagical: false };
    }

    /**
     * @param {object} itemData
     * @param {object} ctx
     */
    applyCacheMask(itemData, ctx) {}

    /**
     * Post-process compendium item data before Item Piles placement.
     * @param {object} data
     * @returns {object}
     */
    resolvePileItemData(data) { return data; }

    /**
     * Build an Item document payload for the "Add to Items" fallback path,
     * used when Item Piles is not installed. Different from
     * {@link buildFallbackPileItem} which targets pile inventories.
     *
     * Default shape matches dnd5e. System adapters override for PF2E, SF2E, etc.
     *
     * @param {object} item  Resolved cache item entry
     * @param {object} [meta]  Cache result meta (cacheLabel used in description)
     * @returns {object} Foundry Item document data
     */
    buildCacheItemPayload(item, meta = {}) {
        return {
            name: item.name,
            type: item.type ?? "loot",
            img: item.img,
            system: {
                quantity: item.quantity ?? 1,
                price: { value: item.price ?? 0, denomination: "gp" },
                weight: { value: item.weight ?? 0, units: "lb" },
                rarity: item.rarity ?? "common",
                description: {
                    value: `<p>Generated from a ${meta.cacheLabel ?? "loot cache"}.</p>`
                }
            }
        };
    }

    /**
     * Build coin item payloads for the "Add to Items" fallback path.
     * Base implementation (dnd5e) returns one item per denomination when
     * coinage is provided, or a single Coin Purse otherwise.
     *
     * @param {{ gold: number, coinage?: Record<string, number> }} result
     * @param {object} [_meta]
     * @returns {object[]} Array of Foundry Item document data
     */
    buildCoinItems(result, _meta = {}) {
        const { gold, coinage } = result;
        const out = [];
        const img = "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp";

        if (coinage) {
            for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                if (coinage[denom]) {
                    out.push({
                        name: `Coins (${denom.toUpperCase()})`,
                        type: "loot",
                        img,
                        system: { price: { value: coinage[denom], denomination: denom } }
                    });
                }
            }
        } else if (gold > 0) {
            out.push({
                name: "Coin Purse",
                type: "loot",
                img,
                system: {
                    quantity: 1,
                    price: { value: gold, denomination: "gp" },
                    description: { value: `<p>${gold} gold pieces.</p>` }
                }
            });
        }
        return out;
    }

    /**
     * Whether this system supports the "Create Loot Actor" deployment path.
     * When true and Item Piles is not installed, the Cache Generator surfaces
     * a Create Loot Actor button instead of Add to Items. Default: false.
     * @returns {boolean}
     */
    canCreateLootActor() { return false; }

    /**
     * The actor `type` string used by {@link buildLootActorPayload}. Systems
     * that override {@link canCreateLootActor} must also supply this.
     * @returns {string|null}
     */
    getLootActorType() { return null; }

    /**
     * Build the Actor.create payload for a cache deployed as a loot actor.
     * Items are attached separately via createEmbeddedDocuments; currency is
     * deposited via {@link depositLootActorCurrency} after the actor exists.
     *
     * @param {object} result  Cache result from generate()
     * @param {object} [meta]  Cache result meta
     * @returns {object|null}
     */
    buildLootActorPayload(_result, _meta = {}) { return null; }

    /**
     * Deposit cache currency into an already-created loot actor. Systems that
     * have a native currency API (PF2E: actor.inventory.addCoins) use it;
     * others fall back to adding a Coin Purse item.
     *
     * @param {Actor} actor
     * @param {object} result
     * @returns {Promise<void>}
     */
    async depositLootActorCurrency(actor, result) {
        const coinItems = this.buildCoinItems(result, {});
        if (coinItems.length > 0) {
            await actor.createEmbeddedDocuments("Item", coinItems);
        }
    }

    /**
     * @param {object} metaObj
     * @returns {object}
     */
    buildFallbackPileItem(metaObj) {
        const w = Number(metaObj.weight);
        const data = {
            name: metaObj.name,
            type: metaObj.type ?? "loot",
            img: metaObj.img,
            system: {
                price: { value: metaObj.price ?? 0, denomination: "gp" },
                weight: { value: Number.isFinite(w) ? w : 0, units: "lb" }
            }
        };
        if (metaObj.capacityLbs !== undefined) {
            data.type = "backpack";
            data.system.capacity = { type: "weight", value: metaObj.capacityLbs };
        }
        return data;
    }

    /** @returns {boolean} */
    canCompileLootPool() { return false; }

    /** Item types eligible for power-score computation (persistent gear, not consumables). */
    getPowerScoreItemTypes() {
        return new Set(["weapon", "equipment", "tool", "container"]);
    }

    /**
     * @param {Item|object} item
     * @param {object} [weights]
     * @returns {number}
     */
    getPowerScoreContribution(item, weights) {
        const lib = game.ionrift?.library?.system;
        if (lib?.getPowerScoreContribution) {
            return lib.getPowerScoreContribution(item, weights);
        }
        return super.getPowerScoreContribution(item, weights);
    }

    /**
     * @param {object} itemData
     * @returns {object}
     */
    normalizeItemData(itemData) { return itemData; }

    /**
     * Scroll Forge rules for this system, or null when unsupported.
     * @returns {object|null}
     */
    getScrollForgeRules() { return null; }
}
