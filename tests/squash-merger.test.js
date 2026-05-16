import { describe, it, expect } from "vitest";
import { SquashMerger } from "../scripts/services/SquashMerger.js";

const MODULE_ID = "ionrift-quartermaster";

// ── isPoisonStackMergeSource ─────────────────────────────────────────────

describe("SquashMerger.isPoisonStackMergeSource", () => {

    it("returns false for null", () => {
        expect(SquashMerger.isPoisonStackMergeSource(null)).toBe(false);
    });

    it("returns true when isInfectedStack is set", () => {
        expect(SquashMerger.isPoisonStackMergeSource({ isInfectedStack: true, name: "Other" })).toBe(true);
    });

    it("matches Potion of Healing by name", () => {
        expect(SquashMerger.isPoisonStackMergeSource({ name: "Potion of Healing" })).toBe(true);
    });

    it("matches lure surface name when GM name is poison identity", () => {
        expect(SquashMerger.isPoisonStackMergeSource({
            name: "Potion of Poison (Greater)",
            _lureSurfaceName: "Potion of Greater Healing"
        })).toBe(true);
    });

    it("rejects non-healing cursed items", () => {
        expect(SquashMerger.isPoisonStackMergeSource({ name: "Berserker Axe" })).toBe(false);
    });
});

// ── merge Pass A ─────────────────────────────────────────────────────────

describe("SquashMerger.merge Pass A", () => {

    it("groups identical items by compendium key", () => {
        const items = [
            { name: "Longsword", sourceCompendium: "dnd5e.items", _compendiumId: "abc", quantity: 1 },
            { name: "Longsword", sourceCompendium: "dnd5e.items", _compendiumId: "abc", quantity: 2 }
        ];
        const map = SquashMerger.merge(items);
        expect(map.size).toBe(1);
        expect([...map.values()][0]._totalQty).toBe(3);
    });

    it("groups items without compendium by display name", () => {
        const items = [
            { name: "Gold Nugget", quantity: 1 },
            { name: "Gold Nugget", quantity: 4 }
        ];
        const map = SquashMerger.merge(items);
        expect(map.size).toBe(1);
        expect([...map.values()][0]._totalQty).toBe(5);
    });

    it("does not fold cursed quantity into Pass A compendium grouping", () => {
        const items = [
            { name: "Longsword", sourceCompendium: "dnd5e.items", _compendiumId: "sword", quantity: 1 },
            {
                name: "Berserker Axe",
                _specialSection: true,
                _specialType: "cursed",
                _uid: "axe-cursed",
                quantity: 9
            }
        ];
        const map = SquashMerger.merge(items);
        const clean = [...map.values()].find(e => e.name === "Longsword");
        expect(clean._totalQty).toBe(1);
        expect(map.size).toBe(2);
    });
});

// ── merge Pass B ─────────────────────────────────────────────────────────

describe("SquashMerger.merge Pass B", () => {

    it("merges cursed healing potion into clean counterpart via _lureSurfaceName", () => {
        const items = [
            { name: "Potion of Healing", sourceCompendium: "dnd5e.items", _compendiumId: "heal1", quantity: 2 },
            {
                name: "Potion of Poison",
                _lureSurfaceName: "Potion of Healing",
                _specialSection: true,
                _specialType: "cursed",
                quantity: 1
            }
        ];
        const map = SquashMerger.merge(items);
        expect(map.size).toBe(1);
        const entry = [...map.values()][0];
        expect(entry._totalQty).toBe(3);
        expect(entry._infectedCount).toBe(1);
        expect(entry.sourceCompendium).toBe("dnd5e.items");
    });

    it("creates standalone infected entry when no clean counterpart", () => {
        const items = [
            {
                name: "Potion of Poison (Greater)",
                _lureSurfaceName: "Potion of Greater Healing",
                _specialSection: true,
                _specialType: "cursed",
                _uid: "poison-1",
                sourceCompendium: "world.cursed",
                _compendiumId: "cf-1",
                quantity: 2
            }
        ];
        const map = SquashMerger.merge(items);
        expect(map.size).toBe(1);
        const entry = [...map.values()][0];
        expect(entry.name).toBe("Potion of Greater Healing");
        expect(entry.sourceCompendium).toBeNull();
        expect(entry._compendiumId).toBeNull();
        expect(entry._totalQty).toBe(2);
        expect(entry._infectedCount).toBe(2);
    });

    it("merges non-poison cursed items without infectedCount", () => {
        const items = [
            {
                name: "Berserker Axe",
                _specialSection: true,
                _specialType: "cursed",
                _uid: "axe-1",
                quantity: 1
            }
        ];
        const map = SquashMerger.merge(items);
        expect(map.size).toBe(1);
        const entry = [...map.values()][0];
        expect(entry._totalQty).toBe(1);
        expect(entry._infectedCount).toBeUndefined();
    });
});
