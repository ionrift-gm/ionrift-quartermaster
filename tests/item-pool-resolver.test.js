import { describe, it, expect } from "vitest";
import { ItemPoolResolver } from "../scripts/services/ItemPoolResolver.js";

// ── _matchesSlotType ─────────────────────────────────────────────────────

describe("ItemPoolResolver._matchesSlotType", () => {

    it("accepts consumable potions", () => {
        const entry = { type: "consumable", system: { type: { value: "potion" } } };
        expect(ItemPoolResolver._matchesSlotType(entry, "consumable")).toBe(true);
    });

    it("accepts consumable food", () => {
        const entry = { type: "consumable", system: { type: { value: "food" } } };
        expect(ItemPoolResolver._matchesSlotType(entry, "consumable")).toBe(true);
    });

    it("accepts consumable poison", () => {
        const entry = { type: "consumable", system: { type: { value: "poison" } } };
        expect(ItemPoolResolver._matchesSlotType(entry, "consumable")).toBe(true);
    });

    it("rejects scrolls from consumable slot", () => {
        const entry = { type: "consumable", system: { type: { value: "scroll" } } };
        expect(ItemPoolResolver._matchesSlotType(entry, "consumable")).toBe(false);
    });

    it("rejects weapons from consumable slot", () => {
        const entry = { type: "weapon", system: {} };
        expect(ItemPoolResolver._matchesSlotType(entry, "consumable")).toBe(false);
    });

    it("accepts scrolls for scroll slot", () => {
        const entry = { type: "consumable", system: { type: { value: "scroll" } } };
        expect(ItemPoolResolver._matchesSlotType(entry, "scroll")).toBe(true);
    });

    it("rejects potions for scroll slot", () => {
        const entry = { type: "consumable", system: { type: { value: "potion" } } };
        expect(ItemPoolResolver._matchesSlotType(entry, "scroll")).toBe(false);
    });

    it("accepts loot for mundane slot", () => {
        expect(ItemPoolResolver._matchesSlotType({ type: "loot" }, "mundane")).toBe(true);
    });

    it("accepts tools for mundane slot", () => {
        expect(ItemPoolResolver._matchesSlotType({ type: "tool" }, "mundane")).toBe(true);
    });

    it("accepts common equipment for mundane slot", () => {
        const entry = { type: "equipment", system: { rarity: "common" } };
        expect(ItemPoolResolver._matchesSlotType(entry, "mundane")).toBe(true);
    });

    it("accepts equipment with no rarity for mundane slot", () => {
        const entry = { type: "equipment", system: {} };
        expect(ItemPoolResolver._matchesSlotType(entry, "mundane")).toBe(true);
    });

    it("rejects uncommon equipment from mundane slot", () => {
        const entry = { type: "equipment", system: { rarity: "uncommon" } };
        expect(ItemPoolResolver._matchesSlotType(entry, "mundane")).toBe(false);
    });

    it("accepts weapons for mastercraft slot", () => {
        expect(ItemPoolResolver._matchesSlotType({ type: "weapon" }, "mastercraft")).toBe(true);
    });

    it("accepts armor for mastercraft slot", () => {
        expect(ItemPoolResolver._matchesSlotType({ type: "armor" }, "mastercraft")).toBe(true);
    });

    it("returns false for unknown slot type", () => {
        expect(ItemPoolResolver._matchesSlotType({ type: "weapon" }, "unknown")).toBe(false);
    });
});

// ── _matchesRarity ───────────────────────────────────────────────────────

describe("ItemPoolResolver._matchesRarity", () => {
    const upToUncommon = new Set(["common", "uncommon"]);

    it("accepts common items", () => {
        const entry = { system: { rarity: "common" } };
        expect(ItemPoolResolver._matchesRarity(entry, upToUncommon)).toBe(true);
    });

    it("accepts uncommon items within range", () => {
        const entry = { system: { rarity: "uncommon" } };
        expect(ItemPoolResolver._matchesRarity(entry, upToUncommon)).toBe(true);
    });

    it("rejects rare items outside range", () => {
        const entry = { system: { rarity: "rare" } };
        expect(ItemPoolResolver._matchesRarity(entry, upToUncommon)).toBe(false);
    });

    it("accepts items with no rarity (treated as common)", () => {
        const entry = { system: {} };
        expect(ItemPoolResolver._matchesRarity(entry, upToUncommon)).toBe(true);
    });

    it("accepts items with empty string rarity", () => {
        const entry = { system: { rarity: "" } };
        expect(ItemPoolResolver._matchesRarity(entry, upToUncommon)).toBe(true);
    });
});

// ── _isExcluded ──────────────────────────────────────────────────────────

describe("ItemPoolResolver._isExcluded", () => {

    it("excludes feats", () => {
        expect(ItemPoolResolver._isExcluded({ type: "feat", name: "Extra Attack" })).toBe(true);
    });

    it("excludes classes", () => {
        expect(ItemPoolResolver._isExcluded({ type: "class", name: "Fighter" })).toBe(true);
    });

    it("excludes spells", () => {
        expect(ItemPoolResolver._isExcluded({ type: "spell", name: "Fireball" })).toBe(true);
    });

    it("excludes nameless items", () => {
        expect(ItemPoolResolver._isExcluded({ type: "loot", name: "" })).toBe(true);
    });

    it("excludes null-named items", () => {
        expect(ItemPoolResolver._isExcluded({ type: "loot" })).toBe(true);
    });

    it("passes normal loot", () => {
        expect(ItemPoolResolver._isExcluded({ type: "loot", name: "Gold Coin" })).toBe(false);
    });

    it("passes normal equipment", () => {
        expect(ItemPoolResolver._isExcluded({ type: "equipment", name: "Chain Mail" })).toBe(false);
    });

    it("excludes the SRD trinket table placeholder", () => {
        expect(ItemPoolResolver._isExcluded({
            type: "loot",
            name: "Trinket",
            system: {
                description: {
                    value: "<p>A placeholder for the non-SRD items introduced on pg. 159, with the d100 table on 160-161.</p>"
                }
            }
        })).toBe(true);
    });

    it("excludes compendium rows whose description is only a table pointer", () => {
        expect(ItemPoolResolver._isExcluded({
            type: "loot",
            name: "Curio",
            system: {
                description: {
                    value: "<p>A placeholder for the non-SRD items introduced on pg. 159.</p>"
                }
            }
        })).toBe(true);
    });
});

// ── _extractWeight ───────────────────────────────────────────────────────

describe("ItemPoolResolver._extractWeight", () => {

    it("returns 0 for null weight", () => {
        expect(ItemPoolResolver._extractWeight({ system: { weight: null } })).toBe(0);
    });

    it("returns 0 for undefined weight", () => {
        expect(ItemPoolResolver._extractWeight({ system: {} })).toBe(0);
    });

    it("handles plain number weight (old dnd5e)", () => {
        expect(ItemPoolResolver._extractWeight({ system: { weight: 5 } })).toBe(5);
    });

    it("handles object weight (new dnd5e v4+)", () => {
        expect(ItemPoolResolver._extractWeight({ system: { weight: { value: 3, units: "lb" } } })).toBe(3);
    });

    it("handles string weight", () => {
        expect(ItemPoolResolver._extractWeight({ system: { weight: "10" } })).toBe(10);
    });

    it("handles NaN gracefully", () => {
        expect(ItemPoolResolver._extractWeight({ system: { weight: "abc" } })).toBe(0);
    });
});

// ── _extractPrice ────────────────────────────────────────────────────────

describe("ItemPoolResolver._extractPrice", () => {

    it("returns 0 for no price", () => {
        expect(ItemPoolResolver._extractPrice({ system: {} })).toBe(0);
    });

    it("returns 0 for null price", () => {
        expect(ItemPoolResolver._extractPrice({ system: { price: null } })).toBe(0);
    });

    it("handles plain number price", () => {
        expect(ItemPoolResolver._extractPrice({ system: { price: 50 } })).toBe(50);
    });

    it("handles gp denomination (default)", () => {
        expect(ItemPoolResolver._extractPrice({ system: { price: { value: 100, denomination: "gp" } } })).toBe(100);
    });

    it("converts sp to gp", () => {
        expect(ItemPoolResolver._extractPrice({ system: { price: { value: 50, denomination: "sp" } } })).toBe(5);
    });

    it("converts cp to gp", () => {
        expect(ItemPoolResolver._extractPrice({ system: { price: { value: 100, denomination: "cp" } } })).toBe(1);
    });

    it("converts ep to gp", () => {
        expect(ItemPoolResolver._extractPrice({ system: { price: { value: 10, denomination: "ep" } } })).toBe(5);
    });

    it("converts pp to gp", () => {
        expect(ItemPoolResolver._extractPrice({ system: { price: { value: 5, denomination: "pp" } } })).toBe(50);
    });

    it("defaults to gp when denomination is missing", () => {
        expect(ItemPoolResolver._extractPrice({ system: { price: { value: 25 } } })).toBe(25);
    });
});

// ── _raritiesUpTo ────────────────────────────────────────────────────────

describe("ItemPoolResolver._raritiesUpTo", () => {

    it("returns only common for 'common'", () => {
        const set = ItemPoolResolver._raritiesUpTo("common");
        expect(set.has("common")).toBe(true);
        expect(set.has("uncommon")).toBe(false);
        expect(set.size).toBe(1);
    });

    it("returns common and uncommon for 'uncommon'", () => {
        const set = ItemPoolResolver._raritiesUpTo("uncommon");
        expect(set.has("common")).toBe(true);
        expect(set.has("uncommon")).toBe(true);
        expect(set.has("rare")).toBe(false);
    });

    it("includes all rarities up to rare", () => {
        const set = ItemPoolResolver._raritiesUpTo("rare");
        expect(set.has("common")).toBe(true);
        expect(set.has("uncommon")).toBe(true);
        expect(set.has("rare")).toBe(true);
        expect(set.has("very rare")).toBe(false);
    });

    it("handles 'very rare' (space-separated)", () => {
        const set = ItemPoolResolver._raritiesUpTo("very rare");
        expect(set.has("rare")).toBe(true);
        expect(set.has("veryrare")).toBe(true);
    });

    it("includes everything up to legendary", () => {
        const set = ItemPoolResolver._raritiesUpTo("legendary");
        expect(set.size).toBe(6); // common through legendary
    });

    it("defaults to uncommon for unknown rarity", () => {
        const set = ItemPoolResolver._raritiesUpTo("mythic");
        expect(set.has("common")).toBe(true);
        expect(set.has("uncommon")).toBe(true);
        expect(set.size).toBe(2);
    });
});

// ── _getFallbackItems ────────────────────────────────────────────────────

describe("ItemPoolResolver._getFallbackItems", () => {

    const tables = {
        themeItems: {
            dungeon: {
                consumable: [{ name: "Potion of Healing", price: 50 }],
                mundane: [{ name: "Torch", price: 1 }]
            }
        },
        sharedConsumables: {
            common: [{ name: "Healing Potion", price: 50 }],
            uncommon: [{ name: "Greater Healing", price: 150 }]
        }
    };

    it("returns empty array (embedded fallback tables retired)", () => {
        expect(ItemPoolResolver._getFallbackItems("consumable", "dungeon", tables)).toEqual([]);
        expect(ItemPoolResolver._getFallbackItems("mundane", "dungeon", tables)).toEqual([]);
        expect(ItemPoolResolver._getFallbackItems("consumable", "swamp", tables)).toEqual([]);
    });

    it("returns empty for unknown slot type", () => {
        const items = ItemPoolResolver._getFallbackItems("artifact", "dungeon", tables);
        expect(items).toEqual([]);
    });

    it("returns empty when tables is null", () => {
        const items = ItemPoolResolver._getFallbackItems("consumable", "dungeon", null);
        expect(items).toEqual([]);
    });
});

// ── _isContainerContentOnly ──────────────────────────────────────────────

describe("ItemPoolResolver._isContainerContentOnly", () => {

    it("accepts Water (Pint)", () => {
        const entry = {
            name: "Water (Pint)",
            type: "consumable",
            system: { type: { value: "drink" } }
        };
        expect(ItemPoolResolver._isContainerContentOnly(entry)).toBe(true);
    });

    it("accepts Ale (Gallon)", () => {
        const entry = {
            name: "Ale (Gallon)",
            type: "consumable",
            system: { type: { value: "food" } }
        };
        expect(ItemPoolResolver._isContainerContentOnly(entry)).toBe(true);
    });

    it("rejects Potion of Healing", () => {
        const entry = {
            name: "Potion of Healing",
            type: "consumable",
            system: { type: { value: "potion" } }
        };
        expect(ItemPoolResolver._isContainerContentOnly(entry)).toBe(false);
    });

    it("rejects weapons", () => {
        const entry = { name: "Longsword (Pint)", type: "weapon", system: {} };
        expect(ItemPoolResolver._isContainerContentOnly(entry)).toBe(false);
    });
});

// ── _isPlaceholderPoolEntry ──────────────────────────────────────────────

describe("ItemPoolResolver._isPlaceholderPoolEntry", () => {

    it("accepts ammunition aggregator stubs", () => {
        const entry = { name: "Ammunition, +1, +2, or +3", system: {} };
        expect(ItemPoolResolver._isPlaceholderPoolEntry(entry)).toBe(true);
    });

    it("accepts trinket placeholder", () => {
        const entry = { name: "Trinket", system: {} };
        expect(ItemPoolResolver._isPlaceholderPoolEntry(entry)).toBe(true);
    });

    it("rejects real loot items", () => {
        const entry = { name: "Longsword", system: {} };
        expect(ItemPoolResolver._isPlaceholderPoolEntry(entry)).toBe(false);
    });
});

// ── Constants ────────────────────────────────────────────────────────────

describe("ItemPoolResolver constants", () => {

    it("has price ceilings for all 4 tiers", () => {
        expect(ItemPoolResolver.TIER_PRICE_CEILING[1]).toBe(100);
        expect(ItemPoolResolver.TIER_PRICE_CEILING[2]).toBe(500);
        expect(ItemPoolResolver.TIER_PRICE_CEILING[3]).toBe(5000);
        expect(ItemPoolResolver.TIER_PRICE_CEILING[4]).toBe(Infinity);
    });

    it("T1 ceiling is stricter than T2", () => {
        expect(ItemPoolResolver.TIER_PRICE_CEILING[1]).toBeLessThan(ItemPoolResolver.TIER_PRICE_CEILING[2]);
    });
});
