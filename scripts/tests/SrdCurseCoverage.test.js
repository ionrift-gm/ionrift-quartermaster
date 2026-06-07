import { describe, expect, it } from "vitest";

globalThis.game = {
    ionrift: { library: {} },
    settings: {
        get: () => "[]",
        set: async () => {}
    },
    packs: new Map(),
    user: { isGM: true },
    system: { id: "dnd5e" }
};

const { isSrdCursedLootName, isSrdCursedTemplateName } = await import("../services/SrdCurseCatalog.js");
const { ItemPoolResolver } = await import("../services/ItemPoolResolver.js");
const { LootPoolCompiler } = await import("../services/LootPoolCompiler.js");

const lootReadyWeapon = (name) => ({
    name,
    type: "weapon",
    system: {
        type: { value: "martialM" },
        weight: { value: 3 },
        price: { value: 6000, denomination: "gp" },
        rarity: "rare",
        description: { value: "" }
    }
});

describe("SRD cursed loot exclusions", () => {
    it("matches canonical manifest template names exactly", () => {
        expect(isSrdCursedTemplateName(" Berserker Axe ")).toBe(true);
        expect(isSrdCursedTemplateName("potion of poison")).toBe(true);
        expect(isSrdCursedTemplateName("Demon Armor")).toBe(true);

        expect(isSrdCursedTemplateName("Berserker Battleaxe +2")).toBe(false);
        expect(isSrdCursedTemplateName("Potion of Healing")).toBe(false);
        expect(isSrdCursedTemplateName("Armor of Resistance")).toBe(false);
    });

    it("matches expanded 2024 cursed loot permutations", () => {
        const cursedNames = [
            "Berserker Battleaxe +2",
            "Plate Armor of Vulnerability",
            "Sword of Vengeance +1",
            "Shield of Missile Attraction +3",
            "Demon Plate Armor"
        ];

        for (const name of cursedNames) {
            expect(isSrdCursedLootName(name), name).toBe(true);
        }
    });

    it("does not match nearby non-cursed loot names", () => {
        const safeNames = [
            "Battleaxe +2",
            "Dancing Sword",
            "Shield +3",
            "Armor of Resistance",
            "Potion of Healing"
        ];

        for (const name of safeNames) {
            expect(isSrdCursedLootName(name), name).toBe(false);
        }
    });

    it("excludes cursed rows through the item pool resolver gate", () => {
        expect(ItemPoolResolver._isExcluded(lootReadyWeapon("Berserker Longsword +1"))).toBe(true);
        expect(ItemPoolResolver._isExcluded(lootReadyWeapon("Sword of Vengeance +2"))).toBe(true);

        expect(ItemPoolResolver._isExcluded(lootReadyWeapon("Dancing Sword"))).toBe(false);
        expect(ItemPoolResolver._isExcluded(lootReadyWeapon("Longsword +2"))).toBe(false);
    });

    it("removes cursed compiled rows while keeping safe loot", () => {
        const input = [
            { name: "Longsword +1" },
            { name: "Berserker Greataxe +2" },
            { name: "Demon Plate Armor" },
            { name: "Potion of Healing" }
        ];

        const kept = LootPoolCompiler._filterCursedFromCompiled(input);

        expect(kept.map(item => item.name)).toEqual([
            "Longsword +1",
            "Potion of Healing"
        ]);
    });
});
