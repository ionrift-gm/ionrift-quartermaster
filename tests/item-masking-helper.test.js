import { describe, it, expect } from "vitest";
import { ItemMaskingHelper } from "../scripts/services/ItemMaskingHelper.js";

// ── detectMagical ────────────────────────────────────────────────────────

describe("ItemMaskingHelper.detectMagical", () => {

    it("returns not magical for null input", () => {
        const r = ItemMaskingHelper.detectMagical(null);
        expect(r.isMagical).toBe(false);
        expect(r.baseItemName).toBeNull();
    });

    it("returns not magical for common rarity", () => {
        const r = ItemMaskingHelper.detectMagical({ rarity: "common", name: "Sword" });
        expect(r.isMagical).toBe(false);
    });

    it("returns not magical for empty rarity", () => {
        const r = ItemMaskingHelper.detectMagical({ rarity: "", name: "Sword" });
        expect(r.isMagical).toBe(false);
    });

    it("returns not magical for 'none' rarity", () => {
        const r = ItemMaskingHelper.detectMagical({ rarity: "none", name: "Sword" });
        expect(r.isMagical).toBe(false);
    });

    it("detects uncommon items as magical", () => {
        const r = ItemMaskingHelper.detectMagical({ rarity: "uncommon", name: "Longsword +1", type: "weapon", _baseItem: "longsword" });
        expect(r.isMagical).toBe(true);
        expect(r.baseItemName).toBeTruthy();
        expect(r.mundaneDesc).toBeTruthy();
    });

    it("detects rare items as magical", () => {
        const r = ItemMaskingHelper.detectMagical({ rarity: "rare", name: "Flame Tongue", type: "weapon" });
        expect(r.isMagical).toBe(true);
    });

    it("does not treat common food consumables as obscurable loot", () => {
        const r = ItemMaskingHelper.detectMagical({ name: "Feed", type: "consumable", rarity: "common", subtype: "food" });
        expect(r.isMagical).toBe(false);
        expect(r.obscuredImg).toBeNull();
    });

    it("rare food stays magical by rarity but gets no obscured consumable icon", () => {
        const r = ItemMaskingHelper.detectMagical({ name: "Feed", type: "consumable", rarity: "rare", subtype: "food" });
        expect(r.isMagical).toBe(true);
        expect(r.obscuredImg).toBeNull();
    });

    it("treats subtype potion as obscurable at common rarity", () => {
        const r = ItemMaskingHelper.detectMagical({ name: "Potion of Healing", type: "consumable", rarity: "common", subtype: "potion" });
        expect(r.isMagical).toBe(true);
        expect(r.obscuredImg).toBeTruthy();
    });

    it("does not obscure acid or other labeled adventuring vials (even if subtype is potion)", () => {
        const acid = ItemMaskingHelper.detectMagical({ name: "Acid (vial)", type: "consumable", rarity: "common", subtype: "potion" });
        expect(acid.isMagical).toBe(false);
        expect(acid.obscuredImg).toBeNull();

        const holy = ItemMaskingHelper.detectMagical({ name: "Holy Water (flask)", type: "consumable", rarity: "common", subtype: "potion" });
        expect(holy.isMagical).toBe(false);
    });

    it("does not give antitoxin mystery-vial name or icon when rarity is magical but subtype is potion", () => {
        const r = ItemMaskingHelper.detectMagical({
            name: "Antitoxin",
            type: "consumable",
            rarity: "uncommon",
            subtype: "potion"
        });
        expect(r.isMagical).toBe(true);
        expect(r.obscuredImg).toBeNull();
        expect(r.baseItemName).toBe("Antitoxin");
    });

    it("does not obscure feed when subtype is wrongly potion", () => {
        const r = ItemMaskingHelper.detectMagical({
            name: "Feed",
            type: "consumable",
            rarity: "common",
            subtype: "potion"
        });
        expect(r.isMagical).toBe(false);
        expect(r.obscuredImg).toBeNull();
    });
});

// ── _deriveBaseItemName ──────────────────────────────────────────────────

describe("ItemMaskingHelper._deriveBaseItemName", () => {

    // Named item overrides
    it("maps Flame Tongue to Longsword", () => {
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Flame Tongue", type: "weapon" })).toBe("Longsword");
    });

    it("maps Sun Blade to Longsword", () => {
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Sun Blade", type: "weapon" })).toBe("Longsword");
    });

    it("maps Oathbow to Longbow", () => {
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Oathbow", type: "weapon" })).toBe("Longbow");
    });

    it("maps Dagger of Venom to Dagger", () => {
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Dagger of Venom", type: "weapon" })).toBe("Dagger");
    });

    it("maps Berserker Axe to Greataxe", () => {
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Berserker Axe", type: "weapon" })).toBe("Greataxe");
    });

    // Consumable masking
    it("masks potions to a generic vial name", () => {
        const name = ItemMaskingHelper._deriveBaseItemName({ name: "Potion of Healing", type: "consumable" });
        expect(["Sealed Vial", "Stoppered Flask", "Corked Bottle", "Small Phial"]).toContain(name);
    });

    it("masks elixirs to a generic vial name", () => {
        const name = ItemMaskingHelper._deriveBaseItemName({ name: "Elixir of Health", type: "consumable" });
        expect(["Sealed Vial", "Stoppered Flask", "Corked Bottle", "Small Phial"]).toContain(name);
    });

    it("masks scrolls to a generic scroll name", () => {
        const name = ItemMaskingHelper._deriveBaseItemName({ name: "Scroll of Fireball", type: "consumable" });
        expect(name).toBe("Unidentified Scroll");
    });

    it("masks oils to a generic oil name", () => {
        const name = ItemMaskingHelper._deriveBaseItemName({ name: "Oil of Slipperiness", type: "consumable" });
        expect(["Flask of Oil", "Sealed Oil Jar", "Stoppered Oil Flask"]).toContain(name);
    });

    it("does not map antitoxin to generic vial names when subtype is potion", () => {
        const name = ItemMaskingHelper._deriveBaseItemName({
            name: "Antitoxin",
            type: "consumable",
            subtype: "potion"
        });
        expect(name).toBe("Antitoxin");
    });

    // Focus masking
    it("masks wand items to generic stick name", () => {
        const name = ItemMaskingHelper._deriveBaseItemName({ name: "Wand of Fireballs", type: "equipment" });
        expect(["Carved Stick", "Thin Wooden Rod", "Tapered Stick"]).toContain(name);
    });

    it("masks rod items to generic rod name", () => {
        const name = ItemMaskingHelper._deriveBaseItemName({ name: "Rod of the Pact Keeper", type: "equipment" });
        expect(["Ornate Rod", "Heavy Short Rod", "Metal Rod"]).toContain(name);
    });

    // baseItem field
    it("expands terse baseItem identifiers", () => {
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Chain Mail +1", _baseItem: "chainmail" })).toBe("Chain Mail");
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Plate +1", _baseItem: "plate" })).toBe("Plate Armor");
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Scale +1", _baseItem: "scalemail" })).toBe("Scale Mail");
    });

    it("capitalises unknown baseItem strings", () => {
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Custom +1", _baseItem: "customWeapon" })).toBe("Custom Weapon");
    });

    // Wondrous type map
    it("maps Cloak of Protection to Cloak", () => {
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Cloak of Protection", type: "equipment" })).toBe("Cloak");
    });

    it("maps Ring of Protection to Ring", () => {
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Ring of Protection", type: "equipment" })).toBe("Ring");
    });

    it("maps Boots of Speed to Boots", () => {
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Boots of Speed", type: "equipment" })).toBe("Boots");
    });

    it("maps Bag of Holding to Leather Bag", () => {
        expect(ItemMaskingHelper._deriveBaseItemName({ name: "Bag of Holding", type: "equipment" })).toBe("Leather Bag");
    });

    it("keeps concealed wearables aligned with the item type", () => {
        const cases = [
            ["Gloves of Missile Snaring", "equipment", "Gloves"],
            ["Robe of Eyes", "equipment", "Robe"],
            ["Helm of Teleportation", "equipment", "Helm"],
            ["Headband of Intellect", "equipment", "Headband"],
            ["Circlet of Blasting", "equipment", "Circlet"],
            ["Eyes of the Eagle", "equipment", "Goggles"],
            ["Ring of Protection", "equipment", "Ring"],
            ["Ring Mail", "armor", "Ring Mail"],
            ["Cloak of Displacement", "equipment", "Cloak"],
            ["Bracers of Defense", "equipment", "Bracers"],
            ["Amulet of Health", "equipment", "Pendant"],
            ["Necklace of Fireballs", "equipment", "Necklace"],
            ["Bag of Holding", "equipment", "Leather Bag"],
            ["Carpet of Flying", "equipment", "Woven Rug"],
            ["Orb of Dragonkind", "equipment", "Glass Sphere"]
        ];

        for (const [name, type, expected] of cases) {
            expect(
                ItemMaskingHelper._deriveBaseItemName({ name, type }),
                name
            ).toBe(expected);
        }
    });

    // Stripping
    it("strips +N suffix", () => {
        const name = ItemMaskingHelper._deriveBaseItemName({ name: "Longsword +2", type: "weapon" });
        // Should end up stripping to "Longsword" or using baseItem
        expect(name).not.toContain("+2");
    });

    it("strips 'of X' suffix", () => {
        const name = ItemMaskingHelper._deriveBaseItemName({ name: "Shield of Missile Attraction", type: "equipment" });
        // Should match wondrous map for shield → "Shield"
        expect(name).toBe("Shield");
    });
});

// ── _capitalise ──────────────────────────────────────────────────────────

describe("ItemMaskingHelper._capitalise", () => {

    it("capitalises simple word", () => {
        expect(ItemMaskingHelper._capitalise("longsword")).toBe("Longsword");
    });

    it("splits camelCase", () => {
        expect(ItemMaskingHelper._capitalise("chainMail")).toBe("Chain Mail");
    });

    it("replaces hyphens with spaces", () => {
        expect(ItemMaskingHelper._capitalise("half-plate")).toBe("Half Plate");
    });

    it("replaces underscores with spaces", () => {
        expect(ItemMaskingHelper._capitalise("studded_leather")).toBe("Studded Leather");
    });
});

// ── _categorise ──────────────────────────────────────────────────────────

describe("ItemMaskingHelper._categorise", () => {

    it("categorises swords correctly", () => {
        expect(ItemMaskingHelper._categorise("weapon", "longsword")).toBe("sword");
        expect(ItemMaskingHelper._categorise("weapon", "rapier")).toBe("sword");
        expect(ItemMaskingHelper._categorise("weapon", "scimitar")).toBe("sword");
    });

    it("categorises axes correctly", () => {
        expect(ItemMaskingHelper._categorise("weapon", "greataxe")).toBe("axe");
        expect(ItemMaskingHelper._categorise("weapon", "battleaxe")).toBe("axe");
    });

    it("categorises ranged weapons correctly", () => {
        expect(ItemMaskingHelper._categorise("weapon", "longbow")).toBe("ranged");
        expect(ItemMaskingHelper._categorise("weapon", "heavycrossbow")).toBe("ranged");
    });

    it("categorises bludgeoning weapons", () => {
        expect(ItemMaskingHelper._categorise("weapon", "mace")).toBe("bludgeon");
        expect(ItemMaskingHelper._categorise("weapon", "warhammer")).toBe("bludgeon");
    });

    it("categorises daggers", () => {
        expect(ItemMaskingHelper._categorise("weapon", "dagger")).toBe("dagger");
    });

    it("categorises polearms", () => {
        expect(ItemMaskingHelper._categorise("weapon", "glaive")).toBe("polearm");
        expect(ItemMaskingHelper._categorise("weapon", "halberd")).toBe("polearm");
        expect(ItemMaskingHelper._categorise("weapon", "pike")).toBe("polearm");
    });

    it("categorises heavy armor", () => {
        expect(ItemMaskingHelper._categorise("equipment", "plate")).toBe("heavy_armor");
        expect(ItemMaskingHelper._categorise("equipment", "chainmail")).toBe("heavy_armor");
    });

    it("categorises light armor", () => {
        expect(ItemMaskingHelper._categorise("equipment", "leather")).toBe("light_armor");
        expect(ItemMaskingHelper._categorise("equipment", "studdedleather")).toBe("light_armor");
    });

    it("categorises shields", () => {
        expect(ItemMaskingHelper._categorise("equipment", "shield")).toBe("shield");
    });

    it("categorises wondrous items by name keyword", () => {
        expect(ItemMaskingHelper._categorise("equipment", "", "Cloak of Protection")).toBe("cloak");
        expect(ItemMaskingHelper._categorise("equipment", "", "Ring of Protection")).toBe("ring");
        expect(ItemMaskingHelper._categorise("equipment", "", "Boots of Speed")).toBe("boots");
    });

    it("falls back to generic for unknown weapon", () => {
        expect(ItemMaskingHelper._categorise("weapon", "")).toBe("weapon_generic");
    });

    it("falls back to generic for unknown equipment", () => {
        expect(ItemMaskingHelper._categorise("equipment", "")).toBe("armor_generic");
    });

    it("categorises consumable potions", () => {
        expect(ItemMaskingHelper._categorise("consumable", "", "Potion of Healing")).toBe("potion");
    });

    it("falls back to generic for unknown type", () => {
        expect(ItemMaskingHelper._categorise("loot", "")).toBe("generic");
    });
});

// ── _selectHints ──────────────────────────────────────────────────────────

describe("ItemMaskingHelper._selectHints", () => {

    it("returns 1 hint for uncommon", () => {
        const hints = ItemMaskingHelper._selectHints("uncommon");
        expect(hints.length).toBe(1);
    });

    it("returns 2 hints for rare", () => {
        const hints = ItemMaskingHelper._selectHints("rare");
        expect(hints.length).toBe(2);
    });

    it("returns 2 hints for very rare", () => {
        const hints = ItemMaskingHelper._selectHints("very rare");
        expect(hints.length).toBe(2);
    });

    it("returns 2 hints for legendary", () => {
        const hints = ItemMaskingHelper._selectHints("legendary");
        expect(hints.length).toBe(2);
    });

    it("returns 2 hints for artifact", () => {
        const hints = ItemMaskingHelper._selectHints("artifact");
        expect(hints.length).toBe(2);
    });

    it("returns 1 hint for unknown rarity (fallback)", () => {
        const hints = ItemMaskingHelper._selectHints("mythic");
        expect(hints.length).toBe(1);
    });

    it("all hints are non-empty strings", () => {
        for (const rarity of ["uncommon", "rare", "very rare", "legendary", "artifact"]) {
            for (let i = 0; i < 20; i++) {
                const hints = ItemMaskingHelper._selectHints(rarity);
                for (const h of hints) {
                    expect(typeof h).toBe("string");
                    expect(h.length).toBeGreaterThan(0);
                }
            }
        }
    });
});

// ── applyMask ────────────────────────────────────────────────────────────

describe("ItemMaskingHelper.applyMask", () => {

    it("sets identified to true (Option B pseudo-identified presentation)", () => {
        const itemData = { system: {} };
        ItemMaskingHelper.applyMask(itemData, { baseItemName: "Longsword", mundaneDesc: "A sword." });
        expect(itemData.system.identified).toBe(true);
    });

    it("mutates name to baseItemName (Option B surface masking)", () => {
        const itemData = { name: "Flame Tongue", system: {} };
        ItemMaskingHelper.applyMask(itemData, { baseItemName: "Longsword", mundaneDesc: "A fine blade." });
        expect(itemData.name).toBe("Longsword");
    });

    it("does nothing when baseItemName is missing", () => {
        const itemData = { system: {} };
        ItemMaskingHelper.applyMask(itemData, {});
        expect(itemData.system.identified).toBeUndefined();
    });

    it("does nothing for null itemData", () => {
        expect(() => ItemMaskingHelper.applyMask(null, { baseItemName: "X" })).not.toThrow();
    });

    it("creates system object if missing and sets identified", () => {
        const itemData = {};
        ItemMaskingHelper.applyMask(itemData, { baseItemName: "Shield", mundaneDesc: "desc" });
        expect(itemData.system.identified).toBe(true);
    });

    it("masks SRD cursed stamps (cursedMeta without lure)", () => {
        const itemData = {
            name: "Berserker Axe",
            system: { rarity: "rare", identified: true },
            flags: {
                "ionrift-quartermaster": {
                    cursedMeta: { tier: 2, curseType: "weapon", decoyAppearance: "", trueNature: "" }
                }
            }
        };
        ItemMaskingHelper.applyMask(itemData, { baseItemName: "Greataxe", mundaneDesc: "<p>Heavy axe.</p>" });
        expect(itemData.name).toBe("Greataxe");
        expect(itemData.flags["ionrift-quartermaster"].latentMagic?.originalName).toBe("Berserker Axe");
        expect(itemData.flags["ionrift-quartermaster"].cursedMeta.tier).toBe(2);
    });

    it("skips masking when cursedMeta.lure is present", () => {
        const itemData = {
            name: "Rusty Blade",
            system: {},
            flags: {
                "ionrift-quartermaster": {
                    cursedMeta: { lure: { name: "Old Sword" } }
                }
            }
        };
        ItemMaskingHelper.applyMask(itemData, { baseItemName: "Longsword", mundaneDesc: "<p>Plain.</p>" });
        expect(itemData.name).toBe("Rusty Blade");
        expect(itemData.flags["ionrift-quartermaster"].latentMagic).toBeUndefined();
    });
});

// ── Static array sanity ──────────────────────────────────────────────────

describe("ItemMaskingHelper static arrays", () => {

    it("all physical description categories have entries", () => {
        const descs = ItemMaskingHelper._PHYSICAL_DESCRIPTIONS;
        for (const [cat, arr] of Object.entries(descs)) {
            expect(arr.length, `${cat} should have entries`).toBeGreaterThan(0);
        }
    });

    it("all hint arrays have entries", () => {
        expect(ItemMaskingHelper._HINTS_SUBTLE.length).toBeGreaterThan(0);
        expect(ItemMaskingHelper._HINTS_MODERATE.length).toBeGreaterThan(0);
        expect(ItemMaskingHelper._HINTS_NOTABLE.length).toBeGreaterThan(0);
        expect(ItemMaskingHelper._HINTS_NOTABLE_ALT.length).toBeGreaterThan(0);
        expect(ItemMaskingHelper._HINTS_SENSORY.length).toBeGreaterThan(0);
    });

    it("named item overrides all have regex patterns and string values", () => {
        for (const [pattern, base] of ItemMaskingHelper._NAMED_ITEM_OVERRIDES) {
            expect(pattern).toBeInstanceOf(RegExp);
            expect(typeof base).toBe("string");
            expect(base.length).toBeGreaterThan(0);
        }
    });
});
