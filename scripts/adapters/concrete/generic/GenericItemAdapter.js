import { QuartermasterItemAdapter } from "../../QuartermasterItemAdapter.js";
import { QM_FEATURES } from "../../../data/QMFeatures.js";

const EXCLUDED_TYPES = new Set([
    "feat", "feature", "class", "spell", "subclass", "background", "race",
    "container", "backpack", "base", "ability", "skill", "effect", "condition",
    "archetype", "archetypes", "asi", "chassis", "fusion", "theme",
    "starshipAction", "starshipAblativeArmor", "starshipArmor", "starshipComputer",
    "starshipCrewQuarter", "starshipDefensiveCountermeasure", "starshipDriftEngine",
    "starshipExpansionBay", "starshipFortifiedHull", "starshipFrame",
    "starshipOtherSystem", "starshipPowerCore", "starshipReinforcedBulkhead",
    "starshipSecuritySystem", "starshipSensor", "starshipShield",
    "starshipSpecialAbility", "starshipThruster", "starshipWeapon",
    "vehicleAttack", "vehicleSystem", "actorResource"
]);

const CONSUMABLE_NAME_RE = /\b(potion|elixir|philter|salve|oil|unguent|vial|draught|brew|ration|rations|food|waterskin|wine|ale|mead|antitoxin|antidote|serum|medpatch|ampoule|capsule|herb|wolfsbane|garlic)\b/i;

const PREFERRED_LOOT_ITEM_TYPES = [
    "loot", "treasure", "item", "goods", "gear", "equipment", "consumable", "weapon", "armor"
];

const PREFERRED_LOOT_ACTOR_TYPES = [
    "loot", "container", "npc", "monster", "character"
];

const DENOM_TO_GP = {
    pp: 10,
    gp: 1,
    ep: 0.5,
    sp: 0.1,
    cp: 0.01
};

/**
 * System-agnostic fallback adapter for Quartermaster.
 *
 * Supports loot cache generation only. Scroll Forge, SRD curses, latent
 * masking, pool compilation, power scores, and the Signature Ledger are
 * disabled because they depend on system-specific item schemas (rarity
 * vocabulary, spell lists, attunement, Active Effects).
 *
 * The GM can select any world or system Item compendium sources in the
 * Loot Pool settings.
 */
export class GenericItemAdapter extends QuartermasterItemAdapter {

    #systemId;

    /** @param {string} systemId  The Foundry system id (e.g. "earthdawn4e") */
    constructor(systemId) {
        super();
        this.#systemId = systemId ?? "unknown";
    }

    get id() { return this.#systemId; }

    supports(featureId) {
        return featureId === QM_FEATURES.LOOT_CACHE;
    }

    getDefaultLootPoolSources() { return []; }

    getWorkshopItemTypes() {
        const valid = this._getAvailableItemTypes().filter(t => !EXCLUDED_TYPES.has(t));
        if (valid.length > 0) return valid;
        return [
            "weapon", "armor", "equipment", "consumable",
            "loot", "treasure", "gear", "tool", "backpack"
        ];
    }

    getCompendiumIndexFields() {
        return [
            "name", "type", "img", "flags",
            "system.price", "system.cost", "system.value",
            "system.weight", "system.bulk", "system.quantity",
            "system.description"
        ];
    }

    getRarityFromEntry(_entry) { return "common"; }

    normalizeRarityForTier(_rarity) { return "common"; }

    extractPrice(entry) {
        const price = entry?.system?.price ?? entry?.system?.cost ?? entry?.system?.value;
        if (price == null) return 0;
        if (typeof price === "number") return price;
        if (typeof price === "string") return Number(price) || 0;
        if (typeof price === "object") {
            if (price.value != null && typeof price.value !== "object") {
                return Number(price.value) || 0;
            }
            const coinObj = (price.value && typeof price.value === "object") ? price.value : price;
            const gp  = Number(coinObj.gp  ?? 0) || 0;
            const ep  = Number(coinObj.ep  ?? 0) || 0;
            const sp  = Number(coinObj.sp  ?? 0) || 0;
            const cp  = Number(coinObj.cp  ?? 0) || 0;
            const pp  = Number(coinObj.pp  ?? 0) || 0;
            return pp * 10 + gp + ep * 0.5 + sp * 0.1 + cp * 0.01;
        }
        return 0;
    }

    extractWeight(entry) {
        const w = entry?.system?.weight ?? entry?.system?.bulk;
        if (w == null) return 0;
        if (typeof w === "number") return w;
        if (typeof w === "object") return Number(w.value ?? 0) || 0;
        return Number(w) || 0;
    }

    matchesSlotType(entry, slotType) {
        if (!entry || EXCLUDED_TYPES.has(entry.type)) return false;
        switch (slotType) {
            case "consumable":
                if (entry.type === "consumable") return true;
                if (["item", "goods", "gear"].includes(entry.type) && CONSUMABLE_NAME_RE.test(entry.name || "")) {
                    return true;
                }
                return false;
            case "mundane":
                return !EXCLUDED_TYPES.has(entry.type);
            default:
                return false;
        }
    }

    isExcludedFromPool(entry) {
        if (!entry?.name?.trim()) return true;
        return EXCLUDED_TYPES.has(entry.type);
    }

    normalizePoolEntry(entry, packId) {
        return {
            name:              entry.name,
            type:              entry.type,
            img:               entry.img,
            flags:             entry.flags ?? {},
            price:             this.extractPrice(entry),
            rarity:            "common",
            weight:            this.extractWeight(entry),
            level:             0,
            _baseItem:         "",
            subtype:           "",
            system:            entry.system ? (globalThis.foundry?.utils?.deepClone?.(entry.system) ?? { ...entry.system }) : {},
            sourceCompendium:  packId,
            _compendiumId:     entry._id
        };
    }

    shouldApplyLatentMasking() { return false; }

    detectMagicalForCache(_item, _ctx) { return { isMagical: false }; }

    applyCacheMask(_itemData, _ctx) {}

    canCompileLootPool() { return false; }

    getPowerScoreItemTypes() { return new Set(); }

    getPowerScoreContribution(_item, _weights) { return 0; }

    /**
     * Discover valid non-base Item document types registered by the active system.
     * Returns an empty array in headless unit-test environments that do not populate Item.TYPES.
     * @returns {string[]}
     */
    _getAvailableItemTypes() {
        const raw = Array.isArray(globalThis.Item?.TYPES) && globalThis.Item.TYPES.length > 0
            ? globalThis.Item.TYPES
            : Object.keys(globalThis.CONFIG?.Item?.dataModels ?? {}).length > 0
                ? Object.keys(globalThis.CONFIG.Item.dataModels)
                : Array.isArray(globalThis.game?.system?.documentTypes?.Item)
                    ? globalThis.game.system.documentTypes.Item
                    : globalThis.game?.system?.documentTypes?.Item
                        ? Object.keys(globalThis.game.system.documentTypes.Item)
                        : [];
        return raw.filter(t => t && t !== "base");
    }

    /**
     * Resolve a valid Item document type for the active system.
     * @param {string} [preferredType="loot"]
     * @returns {string}
     */
    resolveValidItemType(preferredType = "loot") {
        const available = this._getAvailableItemTypes();
        if (available.length === 0) return preferredType || "loot";
        if (preferredType && preferredType !== "base" && available.includes(preferredType)) {
            return preferredType;
        }
        for (const candidate of PREFERRED_LOOT_ITEM_TYPES) {
            if (available.includes(candidate)) return candidate;
        }
        return available[0] || preferredType || "loot";
    }

    /**
     * Build a `system` payload tailored to the target Item type's DataModel schema when available.
     * Falls back to the standard `{ quantity, price: { value, denomination }, weight: { value, units } }`
     * shape when no DataModel schema is registered.
     *
     * @param {string} targetType
     * @param {object} opts
     * @returns {object}
     */
    _buildSystemPayloadForType(targetType, {
        quantity = 1,
        priceValue = 0,
        denomination = "gp",
        weight = 0,
        rarity = "common",
        descriptionHtml = "",
        baseSystem = null
    } = {}) {
        const fields = globalThis.CONFIG?.Item?.dataModels?.[targetType]?.schema?.fields;
        const qty = Math.max(1, Math.floor(Number(quantity)) || 1);
        const w = Number.isFinite(Number(weight)) ? Number(weight) : 0;
        const rawPrice = Number(priceValue) || 0;
        const gpEquivalent = Math.round(rawPrice * (DENOM_TO_GP[denomination] ?? 1) * 100) / 100;

        if (!fields) {
            const sys = baseSystem
                ? (globalThis.foundry?.utils?.deepClone?.(baseSystem) ?? { ...baseSystem })
                : {};
            if (sys.quantity && typeof sys.quantity === "object") {
                sys.quantity = { ...sys.quantity, value: qty };
            } else {
                sys.quantity = qty;
            }
            if (typeof sys.price === "number") {
                sys.price = gpEquivalent;
            } else if ("cost" in sys && !("price" in sys)) {
                sys.cost = gpEquivalent;
            } else {
                sys.price = { value: rawPrice, denomination };
            }
            if (typeof sys.weight === "number") {
                sys.weight = w;
            } else {
                sys.weight = { value: w, units: "lb" };
            }
            if (rarity) sys.rarity = rarity;
            if (descriptionHtml) {
                sys.description = typeof sys.description === "string"
                    ? descriptionHtml
                    : { value: descriptionHtml };
            }
            return sys;
        }

        const sys = baseSystem
            ? (globalThis.foundry?.utils?.deepClone?.(baseSystem) ?? { ...baseSystem })
            : {};

        // Quantity
        if (fields.quantity) {
            if (fields.quantity.fields) {
                const prevMax = (sys.quantity && typeof sys.quantity === "object") ? (sys.quantity.max ?? 0) : 0;
                sys.quantity = {
                    ...(sys.quantity && typeof sys.quantity === "object" ? sys.quantity : {}),
                    value: qty,
                    ...(fields.quantity.fields.max ? { max: Math.max(qty, Number(prevMax) || 0) } : {})
                };
            } else {
                sys.quantity = qty;
            }
        }

        // Price or Cost
        if (fields.price) {
            if (fields.price.fields) {
                sys.price = { value: rawPrice, denomination };
            } else {
                sys.price = gpEquivalent;
            }
        } else if (fields.cost) {
            if (fields.cost.fields) {
                sys.cost = { value: gpEquivalent };
            } else {
                sys.cost = gpEquivalent;
            }
        }

        // Weight or Bulk
        if (fields.weight) {
            if (fields.weight.fields) {
                sys.weight = { value: w, units: "lb" };
            } else {
                sys.weight = w;
            }
        } else if (fields.bulk) {
            if (fields.bulk.fields) {
                sys.bulk = { value: w };
            } else {
                sys.bulk = String(w);
            }
        }

        // Rarity
        if (fields.rarity && !fields.rarity.fields) {
            sys.rarity = rarity ?? "common";
        }

        // Description
        if (descriptionHtml && fields.description) {
            if (fields.description.fields) {
                sys.description = {
                    ...(sys.description && typeof sys.description === "object" ? sys.description : {}),
                    value: descriptionHtml
                };
            } else {
                sys.description = descriptionHtml;
            }
        }

        return sys;
    }

    buildCacheItemPayload(item, meta = {}) {
        const targetType = this.resolveValidItemType(item.type ?? "loot");
        const descriptionHtml = `<p>Generated from a ${meta.cacheLabel ?? "loot cache"}.</p>`;
        return {
            name: item.name,
            type: targetType,
            img: item.img,
            system: this._buildSystemPayloadForType(targetType, {
                quantity: item.quantity ?? 1,
                priceValue: item.price ?? 0,
                denomination: "gp",
                weight: item.weight ?? 0,
                rarity: item.rarity ?? "common",
                descriptionHtml,
                baseSystem: item.system
            })
        };
    }

    buildCoinItems(result, _meta = {}) {
        const { gold, coinage } = result ?? {};
        const out = [];
        const img = "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp";
        const targetType = this.resolveValidItemType("loot");
        const fields = globalThis.CONFIG?.Item?.dataModels?.[targetType]?.schema?.fields;

        if (coinage) {
            for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                const count = Number(coinage[denom]) || 0;
                if (count > 0) {
                    const system = fields
                        ? this._buildSystemPayloadForType(targetType, {
                            quantity: count,
                            priceValue: 1,
                            denomination: denom,
                            weight: 0,
                            descriptionHtml: `<p>${count} ${denom.toUpperCase()}.</p>`
                        })
                        : { price: { value: count, denomination: denom } };
                    out.push({
                        name: `Coins (${denom.toUpperCase()})`,
                        type: targetType,
                        img,
                        system
                    });
                }
            }
        } else if (gold > 0) {
            const system = fields
                ? this._buildSystemPayloadForType(targetType, {
                    quantity: 1,
                    priceValue: gold,
                    denomination: "gp",
                    weight: 0,
                    descriptionHtml: `<p>${gold} gold pieces.</p>`
                })
                : {
                    quantity: 1,
                    price: { value: gold, denomination: "gp" },
                    description: { value: `<p>${gold} gold pieces.</p>` }
                };
            out.push({
                name: "Coin Purse",
                type: targetType,
                img,
                system
            });
        }
        return out;
    }

    resolvePileItemData(data) {
        if (!data) return data;
        const targetType = this.resolveValidItemType(data.type ?? "loot");
        if (targetType !== data.type) {
            data.type = targetType;
        }
        return data;
    }

    buildFallbackPileItem(metaObj) {
        const w = Number(metaObj.weight);
        const safeW = Number.isFinite(w) ? w : 0;
        const targetType = this.resolveValidItemType(metaObj.type ?? "loot");
        const fields = globalThis.CONFIG?.Item?.dataModels?.[targetType]?.schema?.fields;

        if (fields) {
            return {
                name: metaObj.name,
                type: targetType,
                img: metaObj.img,
                system: this._buildSystemPayloadForType(targetType, {
                    quantity: metaObj.quantity ?? 1,
                    priceValue: metaObj.price ?? 0,
                    denomination: "gp",
                    weight: safeW,
                    baseSystem: metaObj.system
                })
            };
        }

        return {
            name:  metaObj.name,
            type:  targetType,
            img:   metaObj.img,
            system: {
                price:  { value: metaObj.price ?? 0 },
                weight: { value: safeW }
            }
        };
    }

    /**
     * Discover valid non-base Actor document types registered by the active system.
     * @returns {string[]}
     */
    _getAvailableActorTypes() {
        const raw = Array.isArray(globalThis.Actor?.TYPES) && globalThis.Actor.TYPES.length > 0
            ? globalThis.Actor.TYPES
            : Object.keys(globalThis.CONFIG?.Actor?.dataModels ?? {}).length > 0
                ? Object.keys(globalThis.CONFIG.Actor.dataModels)
                : Array.isArray(globalThis.game?.system?.documentTypes?.Actor)
                    ? globalThis.game.system.documentTypes.Actor
                    : globalThis.game?.system?.documentTypes?.Actor
                        ? Object.keys(globalThis.game.system.documentTypes.Actor)
                        : [];
        return raw.filter(t => t && t !== "base");
    }

    canCreateLootActor() {
        return Boolean(this.getLootActorType());
    }

    getLootActorType() {
        const available = this._getAvailableActorTypes();
        if (available.length === 0) return "loot";
        for (const candidate of PREFERRED_LOOT_ACTOR_TYPES) {
            if (available.includes(candidate)) return candidate;
        }
        return available[0] || "loot";
    }

    buildLootActorPayload(result, meta = {}) {
        const label = meta.cacheLabel ?? "Loot Cache";
        const containerName = result?.container?.name ?? label;
        const containerImg = result?.container?.img
            ?? "icons/containers/chest/chest-reinforced-steel.webp";
        const actorType = this.getLootActorType();
        const ownerPerm = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

        return {
            name: `Cache: ${label}`,
            type: actorType,
            img: containerImg,
            ownership: { default: ownerPerm },
            flags: {
                "ionrift-quartermaster": {
                    isQuartermasterCache: true
                }
            },
            prototypeToken: {
                name: containerName,
                texture: { src: containerImg },
                actorLink: false,
                displayName: 50,
                lockRotation: true,
                sight: { enabled: false }
            }
        };
    }

    async depositLootActorCurrency(actor, result) {
        if (!actor || !result) return;
        const hasGold = (Number(result.gold) || 0) > 0
            || (result.coinage && Object.values(result.coinage).some(v => (Number(v) || 0) > 0));
        if (!hasGold) return;

        // If the actor has a native system.currency object with denomination keys, populate it
        const cur = actor.system?.currency;
        if (cur && typeof cur === "object" && typeof actor.update === "function") {
            const updates = {};
            if (result.coinage) {
                for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                    const amount = Number(result.coinage[denom]) || 0;
                    if (amount > 0 && denom in cur) {
                        const existing = typeof cur[denom] === "object" ? (Number(cur[denom]?.value) || 0) : (Number(cur[denom]) || 0);
                        if (typeof cur[denom] === "object" && cur[denom] !== null) {
                            updates[`system.currency.${denom}.value`] = existing + amount;
                        } else {
                            updates[`system.currency.${denom}`] = existing + amount;
                        }
                    }
                }
            } else if ((Number(result.gold) || 0) > 0 && "gp" in cur) {
                const existing = typeof cur.gp === "object" ? (Number(cur.gp?.value) || 0) : (Number(cur.gp) || 0);
                if (typeof cur.gp === "object" && cur.gp !== null) {
                    updates["system.currency.gp.value"] = existing + Number(result.gold);
                } else {
                    updates["system.currency.gp"] = existing + Number(result.gold);
                }
            }
            if (Object.keys(updates).length > 0) {
                await actor.update(updates);
                return;
            }
        }

        // Fallback: embed coin items directly into the actor inventory
        await super.depositLootActorCurrency(actor, result);
    }

    getScrollForgeRules() { return null; }
}
