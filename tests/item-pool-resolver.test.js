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

    it("rejects QM gemstones from mundane slot", () => {
        const entry = {
            type: "loot",
            system: { type: { value: "gem" } },
            flags: {
                "ionrift-quartermaster": {
                    terrain: ["catacombs"],
                    gemMeta: { tier: "Chips & Fragments" }
                }
            }
        };
        expect(ItemPoolResolver._matchesSlotType(entry, "mundane")).toBe(false);
    });

    it("rejects QM trinkets from mundane slot", () => {
        const entry = {
            type: "loot",
            flags: {
                "ionrift-quartermaster": {
                    terrain: ["ruins"],
                    coreMeta: { category: "Trinkets" }
                }
            }
        };
        expect(ItemPoolResolver._matchesSlotType(entry, "mundane")).toBe(false);
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

    it("accepts dnd5e equipment armor for mastercraft slot", () => {
        const entry = {
            type: "equipment",
            system: { armor: { type: "medium" }, type: { value: "medium" } }
        };
        expect(ItemPoolResolver._matchesSlotType(entry, "mastercraft")).toBe(true);
    });

    it("rejects wondrous equipment from mastercraft slot", () => {
        const entry = { type: "equipment", system: { type: { value: "wondrous" }, rarity: "uncommon" } };
        expect(ItemPoolResolver._matchesSlotType(entry, "mastercraft")).toBe(false);
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
        expect(ItemPoolResolver._isExcluded({
            type: "loot",
            name: "Gold Coin",
            system: { price: 1, weight: 0.02, rarity: "common" }
        })).toBe(false);
    });

    it("passes normal equipment", () => {
        expect(ItemPoolResolver._isExcluded({
            type: "equipment",
            name: "Chain Mail",
            system: { price: 75, weight: 55, rarity: "common" }
        })).toBe(false);
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

// ── _isBulkAmmoCollection ─────────────────────────────────────────────────

describe("ItemPoolResolver._isBulkAmmoCollection", () => {

    it("flags Arrows (2024 20-pack bundle)", () => {
        const entry = { type: "consumable", name: "Arrows", system: { type: { value: "ammo" } } };
        expect(ItemPoolResolver._isBulkAmmoCollection(entry)).toBe(true);
    });

    it("flags Bolts", () => {
        const entry = { type: "consumable", name: "Bolts", system: { type: { value: "ammo" } } };
        expect(ItemPoolResolver._isBulkAmmoCollection(entry)).toBe(true);
    });

    it("flags Bullets, Sling", () => {
        const entry = { type: "consumable", name: "Bullets, Sling", system: { type: { value: "ammo" } } };
        expect(ItemPoolResolver._isBulkAmmoCollection(entry)).toBe(true);
    });

    it("flags Bullets, Firearm", () => {
        const entry = { type: "consumable", name: "Bullets, Firearm", system: { type: { value: "ammo" } } };
        expect(ItemPoolResolver._isBulkAmmoCollection(entry)).toBe(true);
    });

    it("flags Needles", () => {
        const entry = { type: "consumable", name: "Needles", system: { type: { value: "ammo" } } };
        expect(ItemPoolResolver._isBulkAmmoCollection(entry)).toBe(true);
    });

    it("does NOT flag singular Arrow", () => {
        const entry = { type: "consumable", name: "Arrow", system: { type: { value: "ammo" } } };
        expect(ItemPoolResolver._isBulkAmmoCollection(entry)).toBe(false);
    });

    it("does NOT flag Arrow +1 (magic ammo)", () => {
        const entry = { type: "consumable", name: "Arrow +1", system: { type: { value: "ammo" } } };
        expect(ItemPoolResolver._isBulkAmmoCollection(entry)).toBe(false);
    });

    it("does NOT flag Arrow of Slaying", () => {
        const entry = { type: "consumable", name: "Arrow of Slaying", system: { type: { value: "ammo" } } };
        expect(ItemPoolResolver._isBulkAmmoCollection(entry)).toBe(false);
    });

    it("does NOT flag non-ammo items named Arrows", () => {
        const entry = { type: "loot", name: "Arrows", system: { type: { value: "gear" } } };
        expect(ItemPoolResolver._isBulkAmmoCollection(entry)).toBe(false);
    });

    it("excludes Arrows via _isExcluded integration", () => {
        const entry = { type: "consumable", name: "Arrows", system: { type: { value: "ammo" } } };
        expect(ItemPoolResolver._isExcluded(entry)).toBe(true);
    });

    it("allows singular Arrow through _isExcluded", () => {
        const entry = {
            type: "consumable",
            name: "Arrow",
            system: { type: { value: "ammo" }, price: 0.05, weight: 0.05, rarity: "" }
        };
        expect(ItemPoolResolver._isExcluded(entry)).toBe(false);
    });
});

// ── _isGmPlacedPoison ────────────────────────────────────────────────────

describe("ItemPoolResolver._isGmPlacedPoison", () => {

    it("flags standard and tiered poison potions", () => {
        expect(ItemPoolResolver._isGmPlacedPoison({ name: "Potion of Poison" })).toBe(true);
        expect(ItemPoolResolver._isGmPlacedPoison({ name: "Potion of Greater Poison" })).toBe(true);
        expect(ItemPoolResolver._isGmPlacedPoison({ name: "Potion of Superior Poison" })).toBe(true);
        expect(ItemPoolResolver._isGmPlacedPoison({ name: "Potion of Supreme Poison" })).toBe(true);
    });

    it("allows healing potions and other consumables", () => {
        expect(ItemPoolResolver._isGmPlacedPoison({ name: "Potion of Healing" })).toBe(false);
        expect(ItemPoolResolver._isGmPlacedPoison({ name: "Potion of Greater Healing" })).toBe(false);
        expect(ItemPoolResolver._isGmPlacedPoison({ name: "Basic Poison (vial)" })).toBe(false);
    });

    it("excludes poison potions from the loot pool via _isExcluded", () => {
        const entry = {
            type: "consumable",
            name: "Potion of Poison",
            system: { type: { value: "poison" }, price: 100, weight: 0.5, rarity: "uncommon" }
        };
        expect(ItemPoolResolver._isExcluded(entry)).toBe(true);
    });
});

// ── _isZeroDataPlaceholder ───────────────────────────────────────────────

describe("ItemPoolResolver._isZeroDataPlaceholder", () => {

    it("flags Belt of Giant Strength equipment24 stub", () => {
        const entry = {
            name: "Belt of Giant Strength",
            type: "equipment",
            system: { price: 0, weight: 0, rarity: "" }
        };
        expect(ItemPoolResolver._isZeroDataPlaceholder(entry)).toBe(true);
    });

    it("does not flag Headband of Intellect when rarity is set (2024: subtype=wondrous)", () => {
        const entry = {
            name: "Headband of Intellect",
            type: "equipment",
            // 2024 correctly classifies wondrous items with subtype="wondrous";
            // _isZeroWeightArmorTemplate must NOT catch wondrous items.
            system: { price: 0, weight: 0, rarity: "uncommon", type: { value: "wondrous" } }
        };
        expect(ItemPoolResolver._isZeroDataPlaceholder(entry)).toBe(false);
    });

    it("does not flag Deck of Many Things with populated economy fields", () => {
        const entry = {
            name: "Deck of Many Things",
            type: "consumable",
            system: {
                price: { value: 6120, denomination: "gp" },
                weight: { value: 0.1, units: "lb" },
                rarity: "legendary"
            }
        };
        expect(ItemPoolResolver._isZeroDataPlaceholder(entry)).toBe(false);
    });

    it("does not flag items with a nonzero price", () => {
        const entry = {
            name: "Torch",
            type: "equipment",
            system: { price: 1, weight: 0, rarity: "" }
        };
        expect(ItemPoolResolver._isZeroDataPlaceholder(entry)).toBe(false);
    });

    it("does not flag items with a nonzero weight", () => {
        const entry = {
            name: "Weighted Item",
            type: "equipment",
            system: { price: 0, weight: 1, rarity: "" }
        };
        expect(ItemPoolResolver._isZeroDataPlaceholder(entry)).toBe(false);
    });

    it("treats whitespace-only rarity as empty", () => {
        const entry = {
            name: "Odd Stub",
            type: "equipment",
            system: { price: 0, weight: 0, rarity: "   " }
        };
        expect(ItemPoolResolver._isZeroDataPlaceholder(entry)).toBe(true);
    });

    it("excludes Belt via _isExcluded but keeps Headband and Deck", () => {
        const belt = {
            type: "equipment",
            name: "Belt of Giant Strength",
            system: { price: 0, weight: 0, rarity: "" }
        };
        const headband = {
            type: "equipment",
            name: "Headband of Intellect",
            system: { price: 0, weight: 0, rarity: "uncommon", type: { value: "wondrous" } }
        };
        const deck = {
            type: "consumable",
            name: "Deck of Many Things",
            system: {
                price: { value: 6120, denomination: "gp" },
                weight: { value: 0.1, units: "lb" },
                rarity: "legendary"
            }
        };
        expect(ItemPoolResolver._isExcluded(belt)).toBe(true);
        // Headband in 2024 has subtype="wondrous" — must NOT be caught by armor template filter
        expect(ItemPoolResolver._isExcluded(headband)).toBe(false);
        expect(ItemPoolResolver._isExcluded(deck)).toBe(false);
    });
});

// ── _isZeroWeightWeaponTemplate ──────────────────────────────────────────

describe("ItemPoolResolver._isZeroWeightWeaponTemplate", () => {

    it("flags Dragon Slayer — named weapon template with no subtype", () => {
        const entry = {
            type: "weapon",
            name: "Dragon Slayer",
            system: { weight: 0, price: { value: 4000, denomination: "gp" }, rarity: "rare", type: { value: "" } }
        };
        expect(ItemPoolResolver._isZeroWeightWeaponTemplate(entry)).toBe(true);
    });

    it("flags Holy Avenger — subtype is literal dash", () => {
        const entry = {
            type: "weapon",
            name: "Holy Avenger",
            system: { weight: 0, price: { value: 200000, denomination: "gp" }, rarity: "legendary", type: { value: "-" } }
        };
        expect(ItemPoolResolver._isZeroWeightWeaponTemplate(entry)).toBe(true);
    });

    it("flags Vorpal Sword — blank subtype, has rarity", () => {
        const entry = {
            type: "weapon",
            name: "Vorpal Sword",
            system: { weight: 0, rarity: "legendary", type: {} }
        };
        expect(ItemPoolResolver._isZeroWeightWeaponTemplate(entry)).toBe(true);
    });

    it("does NOT flag Sling +1 — has a real subtype (simpleR)", () => {
        const entry = {
            type: "weapon",
            name: "Sling +1",
            system: { weight: 0, price: { value: 400, denomination: "gp" }, rarity: "uncommon", type: { value: "simpleR" } }
        };
        expect(ItemPoolResolver._isZeroWeightWeaponTemplate(entry)).toBe(false);
    });

    it("does NOT flag a Longsword with real weight", () => {
        const entry = {
            type: "weapon",
            name: "Longsword",
            system: { weight: 3, rarity: "common", type: { value: "martialM" } }
        };
        expect(ItemPoolResolver._isZeroWeightWeaponTemplate(entry)).toBe(false);
    });

    it("does NOT flag non-weapon items", () => {
        const ring = {
            type: "equipment",
            name: "Ring of Protection",
            system: { weight: 0, rarity: "rare", type: { value: "ring" } }
        };
        expect(ItemPoolResolver._isZeroWeightWeaponTemplate(ring)).toBe(false);
    });

    it("excludes Dragon Slayer via _isExcluded integration", () => {
        const entry = {
            type: "weapon",
            name: "Dragon Slayer",
            system: { weight: 0, price: { value: 4000, denomination: "gp" }, rarity: "rare", type: { value: "" } }
        };
        expect(ItemPoolResolver._isExcluded(entry)).toBe(true);
    });

    it("allows Sling +1 through _isExcluded integration", () => {
        const entry = {
            type: "weapon",
            name: "Sling +1",
            system: { weight: 0, price: { value: 400, denomination: "gp" }, rarity: "uncommon", type: { value: "simpleR" } }
        };
        expect(ItemPoolResolver._isExcluded(entry)).toBe(false);
    });
});

// ── _isZeroWeightArmorTemplate ────────────────────────────────────────────

describe("ItemPoolResolver._isZeroWeightArmorTemplate", () => {

    it("flags Adamantine Armor — blank subtype, weight=0, has rarity+price", () => {
        const entry = {
            type: "equipment",
            name: "Adamantine Armor",
            system: { weight: 0, price: { value: 400, denomination: "gp" }, rarity: "uncommon", type: { value: "" } }
        };
        expect(ItemPoolResolver._isZeroWeightArmorTemplate(entry)).toBe(true);
    });

    it("flags Mithral Armor", () => {
        const entry = {
            type: "equipment",
            name: "Mithral Armor",
            system: { weight: 0, price: { value: 400, denomination: "gp" }, rarity: "uncommon", type: { value: "" } }
        };
        expect(ItemPoolResolver._isZeroWeightArmorTemplate(entry)).toBe(true);
    });

    it("flags Armor of Resistance — literal dash subtype", () => {
        const entry = {
            type: "equipment",
            name: "Armor of Resistance",
            system: { weight: 0, price: { value: 4000, denomination: "gp" }, rarity: "rare", type: { value: "-" } }
        };
        expect(ItemPoolResolver._isZeroWeightArmorTemplate(entry)).toBe(true);
    });

    it("flags Demon Armor", () => {
        const entry = {
            type: "equipment",
            name: "Demon Armor",
            system: { weight: 0, price: { value: 40000, denomination: "gp" }, rarity: "veryRare", type: { value: "" } }
        };
        expect(ItemPoolResolver._isZeroWeightArmorTemplate(entry)).toBe(true);
    });

    it("flags Efreeti Chain", () => {
        const entry = {
            type: "equipment",
            name: "Efreeti Chain",
            system: { weight: 0, price: { value: 200000, denomination: "gp" }, rarity: "legendary", type: { value: "" } }
        };
        expect(ItemPoolResolver._isZeroWeightArmorTemplate(entry)).toBe(true);
    });

    it("does NOT flag Chain Mail +1 — has real subtype (heavy)", () => {
        const entry = {
            type: "equipment",
            name: "Chain Mail +1",
            system: { weight: 55, price: { value: 4000, denomination: "gp" }, rarity: "rare", type: { value: "heavy" } }
        };
        expect(ItemPoolResolver._isZeroWeightArmorTemplate(entry)).toBe(false);
    });

    it("does NOT flag Ring of Protection — wondrous/ring subtype, weight=0", () => {
        const entry = {
            type: "equipment",
            name: "Ring of Protection",
            system: { weight: 0, price: { value: 4000, denomination: "gp" }, rarity: "rare", type: { value: "ring" } }
        };
        expect(ItemPoolResolver._isZeroWeightArmorTemplate(entry)).toBe(false);
    });

    it("does NOT flag Boots of Speed — clothing subtype, weight=0", () => {
        const entry = {
            type: "equipment",
            name: "Boots of Speed",
            system: { weight: 0, price: { value: 4000, denomination: "gp" }, rarity: "rare", type: { value: "clothing" } }
        };
        expect(ItemPoolResolver._isZeroWeightArmorTemplate(entry)).toBe(false);
    });

    it("does NOT flag Amulet of Health — wondrous subtype", () => {
        const entry = {
            type: "equipment",
            name: "Amulet of Health",
            system: { weight: 0, price: { value: 4000, denomination: "gp" }, rarity: "rare", type: { value: "wondrous" } }
        };
        expect(ItemPoolResolver._isZeroWeightArmorTemplate(entry)).toBe(false);
    });

    it("does NOT flag weapons — wrong item type", () => {
        const entry = {
            type: "weapon",
            name: "Dragon Slayer",
            system: { weight: 0, price: { value: 4000, denomination: "gp" }, rarity: "rare", type: { value: "" } }
        };
        expect(ItemPoolResolver._isZeroWeightArmorTemplate(entry)).toBe(false);
    });

    it("excludes Adamantine Armor via _isExcluded integration", () => {
        const entry = {
            type: "equipment",
            name: "Adamantine Armor",
            system: { weight: 0, price: { value: 400, denomination: "gp" }, rarity: "uncommon", type: { value: "" } }
        };
        expect(ItemPoolResolver._isExcluded(entry)).toBe(true);
    });

    it("allows Chain Mail +1 through _isExcluded", () => {
        const entry = {
            type: "equipment",
            name: "Chain Mail +1",
            system: { weight: 55, price: { value: 4000, denomination: "gp" }, rarity: "rare", type: { value: "heavy" } }
        };
        expect(ItemPoolResolver._isExcluded(entry)).toBe(false);
    });
});



// ── _eligibleForTheme ────────────────────────────────────────────────────

describe("ItemPoolResolver._eligibleForTheme", () => {

    it("allows universal items in any terrain", () => {
        const entry = { name: "Torch", flags: {} };
        expect(ItemPoolResolver._eligibleForTheme(entry, "dungeon")).toBe(true);
        expect(ItemPoolResolver._eligibleForTheme(entry, "catacombs")).toBe(true);
    });

    it("allows terrain-bound items only in matching terrain", () => {
        const entry = {
            name: "Bone-White Calcite Shard",
            flags: { "ionrift-quartermaster": { terrain: ["catacombs"] } }
        };
        expect(ItemPoolResolver._eligibleForTheme(entry, "catacombs")).toBe(true);
        expect(ItemPoolResolver._eligibleForTheme(entry, "dungeon")).toBe(false);
        expect(ItemPoolResolver._eligibleForTheme(entry, "ruins")).toBe(false);
    });

    it("excludes ruins items from forest caches", () => {
        const entry = {
            name: "Weathered Feldspar Crystal",
            flags: { "ionrift-quartermaster": { terrain: ["ruins"] } }
        };
        expect(ItemPoolResolver._eligibleForTheme(entry, "ruins")).toBe(true);
        expect(ItemPoolResolver._eligibleForTheme(entry, "forest")).toBe(false);
        expect(ItemPoolResolver._eligibleForTheme(entry, "desert")).toBe(false);
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
