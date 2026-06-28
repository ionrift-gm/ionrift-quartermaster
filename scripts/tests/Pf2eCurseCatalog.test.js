import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
    inferPf2eCurseMeta,
    isPf2eCursedLootEntry,
    itemHasPf2eCursedTrait,
    lookupPf2eCurseCatalogEntry,
    normalizePf2eCurseName
} from "../services/Pf2eCurseCatalog.js";

describe("Pf2eCurseCatalog", () => {
    it("normalizes PF2e type suffix variants for catalog matching", () => {
        expect(normalizePf2eCurseName("  Poisonous Cloak, Type III  ")).toBe("poisonous cloak (type iii)");
        expect(normalizePf2eCurseName("Bag of Devouring ( TYPE 2 )")).toBe("bag of devouring (type 2)");
    });

    it("resolves exact and normalized GMG manifest names", () => {
        expect(lookupPf2eCurseCatalogEntry("Poisonous Cloak, Type III")?.match).toBe("Poisonous Cloak (Type III)");
        expect(lookupPf2eCurseCatalogEntry("Monkey's Paw")?.tier).toBe(4);
    });

    it("infers catalog metadata before falling back to level tiers", () => {
        expect(inferPf2eCurseMeta({
            name: "Bag of Devouring, Type III",
            system: { level: { value: 13 } }
        })).toEqual({
            tier: 3,
            curseType: "physical",
            catalogMatch: "Bag of Devouring (Type III)"
        });

        expect(inferPf2eCurseMeta({
            name: "Uncatalogued Doom Trinket",
            system: { level: { value: 18 } }
        })).toEqual({
            tier: 4,
            curseType: "deceptive",
            catalogMatch: null
        });
    });

    it("detects cursed traits on item documents without matching unrelated traits", () => {
        expect(itemHasPf2eCursedTrait({ system: { traits: { value: ["magical", "cursed"] } } })).toBe(true);
        expect(itemHasPf2eCursedTrait({ system: { traits: { value: ["magical"] } } })).toBe(false);
        expect(itemHasPf2eCursedTrait({ system: {} })).toBe(false);
    });

    it("excludes PF2e cursed loot by trait or known GMG curse name", () => {
        expect(isPf2eCursedLootEntry({
            name: "Harmless Looking Pebble",
            system: { traits: { value: ["cursed"] } }
        })).toBe(true);

        expect(isPf2eCursedLootEntry({
            name: "Bag of Weasels (Greater)",
            system: { traits: { value: [] } }
        })).toBe(true);

        expect(isPf2eCursedLootEntry({
            name: "Bag of Holding (Type I)",
            system: { traits: { value: [] } }
        })).toBe(false);
    });
});

describe("Pf2eCurseAdapter", () => {
    let Pf2eCurseAdapter;

    beforeAll(async () => {
        globalThis.game = { ionrift: {} };
        ({ Pf2eCurseAdapter } = await import("../services/Pf2eCurseAdapter.js"));
    });

    afterAll(() => {
        delete globalThis.game;
    });

    it("stamps compiled PF2e cursed items with faithful metadata and stable batch ids", () => {
        const sourceItem = {
            name: "Bag of Devouring (Type II)",
            toObject: () => ({
                name: "Bag of Devouring (Type II)",
                type: "equipment",
                system: {},
                flags: { existing: { preserved: true } }
            })
        };

        const stamped = Pf2eCurseAdapter._stampItem(sourceItem, {
            tier: 3,
            curseType: "physical",
            catalogMatch: "Bag of Devouring (Type II)"
        });

        expect(stamped.flags.existing).toEqual({ preserved: true });
        expect(stamped.flags["ionrift-quartermaster"].cursedMeta).toEqual({
            tier: 3,
            curseType: "physical",
            category: "physical",
            tags: ["physical", "tier-3"],
            decoyAppearance: "",
            trueNature: "",
            pf2eFaithful: true,
            catalogMatch: "Bag of Devouring (Type II)"
        });
        expect(stamped.flags["ionrift-quartermaster"].mintBatch).toBe("pf2e-curse-bag-of-devouring-type-ii");
    });
});
