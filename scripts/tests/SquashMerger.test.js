import { describe, it, expect } from "vitest";

import { SquashMerger } from "../services/SquashMerger.js";

describe("SquashMerger", () => {
    it("recognizes poisoned healing stacks by flag, name, or lure surface", () => {
        expect(SquashMerger.isPoisonStackMergeSource({ isInfectedStack: true })).toBe(true);
        expect(SquashMerger.isPoisonStackMergeSource({ name: "Potion of Greater Healing" })).toBe(true);
        expect(SquashMerger.isPoisonStackMergeSource({
            name: "Potion of Poison (Greater)",
            _lureSurfaceName: "Potion of Superior Healing"
        })).toBe(true);
        expect(SquashMerger.isPoisonStackMergeSource({
            name: "Dust of Sneezing and Choking",
            _lureSurfaceName: "Pouch of Dust"
        })).toBe(false);
    });

    it("folds cursed healing decoys into matching clean potion stacks without replacing the clean compendium ref", () => {
        const result = SquashMerger.merge([
            {
                name: "Potion of Healing (Common)",
                quantity: 2,
                sourceCompendium: "dnd5e.equipment24",
                _compendiumId: "clean-potion"
            },
            {
                name: "Potion of Poison",
                quantity: 1,
                _specialSection: true,
                _specialType: "cursed",
                _lureSurfaceName: "Potion of Healing",
                sourceCompendium: "world.ionrift-curses",
                _compendiumId: "cursed-potion"
            }
        ]);

        expect([...result.keys()]).toEqual(["dnd5e.equipment24::clean-potion"]);
        expect(result.get("dnd5e.equipment24::clean-potion")).toMatchObject({
            name: "Potion of Healing (Common)",
            sourceCompendium: "dnd5e.equipment24",
            _compendiumId: "clean-potion",
            _totalQty: 3,
            _infectedCount: 1
        });
    });

    it("keeps standalone cursed healing stacks resolvable as clean lures", () => {
        const result = SquashMerger.merge([
            {
                name: "Potion of Poison (Greater)",
                quantity: 2,
                _uid: "poison-stack",
                _specialSection: true,
                _specialType: "cursed",
                _lureSurfaceName: "Potion of Greater Healing",
                sourceCompendium: "world.ionrift-curses",
                _compendiumId: "curse-doc"
            }
        ]);

        expect(result.get("cursed::poison-stack")).toMatchObject({
            name: "Potion of Greater Healing",
            sourceCompendium: null,
            _compendiumId: null,
            _totalQty: 2,
            _infectedCount: 2
        });
    });

    it("merges non-healing cursed items by quantity without stamping infected counts", () => {
        const result = SquashMerger.merge([
            { name: "Dust of Sneezing and Choking", quantity: 1 },
            {
                name: "Dust of Sneezing and Choking",
                quantity: 1,
                _uid: "dust-curse",
                _specialSection: true,
                _specialType: "cursed"
            }
        ]);

        expect(result.get("Dust of Sneezing and Choking")).toMatchObject({
            name: "Dust of Sneezing and Choking",
            _totalQty: 2
        });
        expect(result.get("Dust of Sneezing and Choking")._infectedCount).toBeUndefined();
    });
});
