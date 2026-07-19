import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let CacheQuantityLogic;

describe("CacheQuantityLogic", () => {
    beforeAll(async () => {
        globalThis.game = { ionrift: {} };
        ({ CacheQuantityLogic } = await import("../services/cache/CacheQuantityLogic.js"));
    });

    afterAll(() => {
        delete globalThis.game;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps signatures and trinkets as single finds", () => {
        expect(CacheQuantityLogic._resolveQuantity({
            name: "Party Heirloom",
            type: "loot",
            isSignature: true,
            price: 0.01
        })).toBe(1);

        expect(CacheQuantityLogic._resolveQuantity({
            name: "Bent Copper Token",
            type: "loot",
            _qmKind: "trinkets",
            price: 0.01
        })).toBe(1);
    });

    it("uses modest, capacity-aware stacks for treasure and tools", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        expect(CacheQuantityLogic._resolveQuantity({
            name: "Loose Trade Beads",
            type: "loot",
            _qmKind: "treasure",
            weight: 2,
            rarity: "common"
        }, { remainingWeight: 8 })).toBe(2);

        expect(CacheQuantityLogic._resolveQuantity({
            name: "Chalk",
            type: "tool",
            weight: 0.1,
            rarity: "common"
        })).toBe(CacheQuantityLogic.MODEST_STACK_MAX);
    });

    it("keeps livestock singular even when sourced from trade goods", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        expect(CacheQuantityLogic._resolveQuantity({
            name: "Ox",
            type: "loot",
            price: 15,
            weight: CacheQuantityLogic.LIVESTOCK_WEIGHT_FLOOR,
            rarity: "common",
            sourceCompendium: "dnd5e.tradegoods"
        })).toBe(1);
    });

    it("stacks cheap trade goods without exceeding the weight allowance", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        expect(CacheQuantityLogic._resolveQuantity({
            name: "Sack of Flour",
            type: "loot",
            price: 0.02,
            weight: 2,
            rarity: "common",
            sourceCompendium: "dnd5e.tradegoods"
        }, { remainingWeight: 12 })).toBe(3);
    });

    it("uses modest stacks for rations and water instead of ammo-scale bulk", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        const rations = {
            name: "Rations",
            type: "consumable",
            subtype: "food",
            price: 0.5,
            weight: 2,
            rarity: "common"
        };

        expect(CacheQuantityLogic._isBulkFillerItem(rations)).toBe(false);
        expect(CacheQuantityLogic._resolveQuantity(rations, { remainingWeight: 6 })).toBe(3);

        expect(CacheQuantityLogic._resolveQuantity({
            name: "Waterskin",
            type: "consumable",
            subtype: "drink",
            price: 0.2,
            weight: 1,
            rarity: "common"
        })).toBe(10);
    });

    it("recognises thrown weapons from names and system property shapes", () => {
        expect(CacheQuantityLogic._isThrownWeapon({
            name: "Hand Axe",
            type: "weapon"
        })).toBe(true);
        expect(CacheQuantityLogic._isThrownWeapon({
            name: "Custom Spear",
            type: "weapon",
            system: { properties: new Set(["thr"]) }
        })).toBe(true);
        expect(CacheQuantityLogic._isThrownWeapon({
            name: "Custom Knife",
            type: "weapon",
            system: { properties: ["thrown"] }
        })).toBe(true);
        expect(CacheQuantityLogic._isThrownWeapon({
            name: "Custom Hammer",
            type: "weapon",
            system: { properties: { thr: true } }
        })).toBe(true);
        expect(CacheQuantityLogic._isThrownWeapon({
            name: "Longsword",
            type: "weapon"
        })).toBe(false);
    });

    it("stacks valuable handaxes despite the normal price gate", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        expect(CacheQuantityLogic._resolveQuantity({
            name: "Handaxe",
            type: "weapon",
            price: 5,
            weight: 2,
            rarity: "common"
        })).toBe(3);
    });

    it("caps thrown weapon stacks at half the remaining capacity", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        expect(CacheQuantityLogic._resolveQuantity({
            name: "Javelin",
            type: "weapon",
            price: 0.5,
            weight: 2,
            rarity: "common"
        }, { remainingWeight: 12 })).toBe(3);
    });

    it("keeps rare non-thrown items singular", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        expect(CacheQuantityLogic._resolveQuantity({
            name: "Rare Alchemical Flask",
            type: "consumable",
            subtype: "potion",
            price: 0.01,
            rarity: "rare"
        })).toBe(1);
    });

    it("rolls kindling as 3d4 before generic rarity and price rules", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.99);

        expect(CacheQuantityLogic._resolveQuantity({
            name: "Kindling",
            type: "loot",
            price: 0,
            rarity: "rare"
        })).toBe(12);
    });
});
