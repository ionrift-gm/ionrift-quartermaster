import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { formatCoinPrice, roundCoinGp, withCoinPriceLabel } from "../services/CoinFormat.js";
import { AmmoTypeRegistry } from "../services/AmmoTypeRegistry.js";
import { ItemClassifier } from "../services/ItemClassifier.js";

describe("CoinFormat", () => {
    it("renders coin values in the cleanest denomination", () => {
        expect(formatCoinPrice(0)).toBe("0 gp");
        expect(formatCoinPrice(-2)).toBe("0 gp");
        expect(formatCoinPrice(0.03)).toBe("3 cp");
        expect(formatCoinPrice(0.1)).toBe("1 sp");
        expect(formatCoinPrice(0.25)).toBe("25 cp");
        expect(formatCoinPrice(1)).toBe("1 gp");
        expect(formatCoinPrice(12.5)).toBe("12.5 gp");
    });

    it("rounds to copper precision without floating point tails", () => {
        expect(roundCoinGp(2.599999999)).toBe(2.6);
        expect(formatCoinPrice(2.599999999)).toBe("2.6 gp");
        expect(withCoinPriceLabel({ name: "coin pouch", price: 0.099999999 })).toMatchObject({
            name: "coin pouch",
            price: 0.1,
            priceLabel: "1 sp"
        });
    });
});

describe("AmmoTypeRegistry", () => {
    beforeEach(() => {
        globalThis.foundry = {
            utils: {
                deepClone: (value) => structuredClone(value),
                randomID: () => "test-id"
            }
        };
        globalThis.game = {};
    });

    afterEach(() => {
        delete globalThis.foundry;
        delete globalThis.game;
    });

    it("normalizes saved config while preserving builtins and fallback order", () => {
        const config = AmmoTypeRegistry.normalize({
            types: [
                { id: "arrows", label: "Renamed arrows", weight: 9 },
                { id: "other", weight: -3 },
                {
                    id: "arcane-darts",
                    label: " Arcane Darts ",
                    patterns: "\\bdarts?\\b, [",
                    weight: 0.26
                }
            ]
        });

        expect(config.types.map(t => t.id)).toEqual([
            "arrows",
            "bolts",
            "needles",
            "sling",
            "arcane-darts",
            "other"
        ]);
        expect(config.types.find(t => t.id === "arrows")).toMatchObject({
            label: "Renamed arrows",
            builtin: true,
            weight: 3
        });
        expect(config.types.find(t => t.id === "arcane-darts")).toMatchObject({
            label: "Arcane Darts",
            builtin: false,
            patterns: ["\\bdarts?\\b", "["],
            weight: 0.25
        });
        expect(config.types.at(-1)).toMatchObject({ id: "other", fallback: true, weight: 0 });
    });

    it("detects custom ammo types and ignores invalid custom regexes", () => {
        const config = AmmoTypeRegistry.normalize({
            types: [{
                id: "arcane-darts",
                label: "Arcane Darts",
                patterns: ["[", "\\bdarts?\\b"],
                weight: 1
            }]
        });

        expect(AmmoTypeRegistry.detectType({ name: "Arcane Dart +1" }, config)).toBe("arcane-darts");
        expect(AmmoTypeRegistry.detectType({ name: "Unusual Shot" }, config)).toBe("other");
    });

    it("round-trips built-in tilt presets", () => {
        const config = AmmoTypeRegistry.applyPreset("bolts");

        expect(AmmoTypeRegistry.detectPreset(config)).toBe("bolts");
        expect(AmmoTypeRegistry.getWeightMap(config)).toMatchObject({
            arrows: 1,
            bolts: 3,
            needles: 1,
            sling: 1,
            other: 1
        });
    });
});

describe("ItemClassifier", () => {
    beforeEach(() => {
        globalThis.game = {};
    });

    afterEach(() => {
        delete globalThis.game;
    });

    it("classifies ammunition before generic consumables", () => {
        expect(ItemClassifier.classify({
            name: "Arrows +1",
            type: "consumable",
            system: { type: { value: "ammo" }, rarity: "uncommon" }
        })).toBe(ItemClassifier.CATEGORY.AMMO);

        expect(ItemClassifier.classify({
            name: "Bolts +2",
            type: "consumable",
            system: { type: { value: "" }, rarity: "rare" }
        })).toBe(ItemClassifier.CATEGORY.AMMO);
    });

    it("distinguishes mundane, generic magic, named magic, and consumables", () => {
        expect(ItemClassifier.classify({ name: "Rope", rarity: "common" }))
            .toBe(ItemClassifier.CATEGORY.MUNDANE);
        expect(ItemClassifier.classify({ name: "Longsword +2", rarity: "rare" }))
            .toBe(ItemClassifier.CATEGORY.GENERIC_MAGIC);
        expect(ItemClassifier.classify({
            name: "Plain Shield",
            rarity: "rare",
            flags: { "ionrift-quartermaster": { compiledFrom: { tier: 1 } } }
        })).toBe(ItemClassifier.CATEGORY.GENERIC_MAGIC);
        expect(ItemClassifier.classify({ name: "Javelin of Lightning", rarity: "uncommon" }))
            .toBe(ItemClassifier.CATEGORY.NAMED_MAGIC);
        expect(ItemClassifier.classify({ name: "Potion of Healing", type: "consumable" }))
            .toBe(ItemClassifier.CATEGORY.CONSUMABLE);
    });
});
