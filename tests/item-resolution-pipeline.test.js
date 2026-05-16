import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ItemResolutionPipeline } from "../scripts/services/ItemResolutionPipeline.js";
import { PotionEnrichment } from "../scripts/services/PotionEnrichment.js";

const MODULE_ID = "ionrift-quartermaster";

describe("ItemResolutionPipeline.stampQuantity", () => {

    it("stamps system.quantity and assigns a unique _id", () => {
        const itemData = { system: {} };
        ItemResolutionPipeline.stampQuantity(itemData, 3);
        expect(itemData.system.quantity).toBe(3);
        expect(itemData._id).toBeTruthy();
    });

    it("floors invalid qty to 1", () => {
        const itemData = { system: {} };
        ItemResolutionPipeline.stampQuantity(itemData, 0);
        expect(itemData.system.quantity).toBe(1);
    });
});

describe("ItemResolutionPipeline.resolve", () => {

    beforeEach(() => {
        game.packs = new Map();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("uses compendium fallback path when no pack is available", async () => {
        const metaObj = {
            name: "Mystery Trinket",
            type: "loot",
            img: "icons/loot.webp",
            price: 25,
            weight: 0.2,
            _isMagical: false
        };
        const data = await ItemResolutionPipeline.resolve(metaObj, "batch-1");
        expect(data.name).toBe("Mystery Trinket");
        expect(data.type).toBe("loot");
        expect(data.system.price.value).toBe(25);
        expect(data.flags?.[MODULE_ID]?.mintBatch).toBe("batch-1");
    });

    it("stamps mintBatch on resolved items", async () => {
        const data = await ItemResolutionPipeline.resolve({ name: "Coin", type: "loot" }, "mint-abc");
        expect(data.flags?.[MODULE_ID]?.mintBatch).toBe("mint-abc");
    });

    it("clears consumable attunement after compendium fetch", async () => {
        const doc = {
            toObject: () => ({
                name: "Potion of Healing",
                type: "consumable",
                system: {
                    type: { value: "potion" },
                    attunement: "required",
                    identified: true
                },
                flags: {}
            })
        };
        game.packs.set("dnd5e.items", {
            getDocument: vi.fn().mockResolvedValue(doc)
        });
        vi.spyOn(PotionEnrichment, "getHealFormula").mockReturnValue({
            formula: "2d4 + 2",
            weight: 0.5
        });

        const data = await ItemResolutionPipeline.resolve({
            name: "Potion of Healing",
            sourceCompendium: "dnd5e.items",
            _compendiumId: "potion-1",
            _isMagical: false
        }, null);

        expect(data.system.attunement).toBe("");
    });

    it("performs infected flag surgery and applies masking", async () => {
        const doc = {
            toObject: () => ({
                name: "Potion of Healing",
                type: "consumable",
                system: { type: { value: "potion" }, rarity: "common", identified: true },
                flags: {
                    [MODULE_ID]: {
                        cursedMeta: { lure: { name: "Potion of Healing" } },
                        forgedFrom: "recipe-1"
                    },
                    core: { sourceId: "Compendium.dnd5e.items.potion" }
                },
                _stats: { compendiumSource: "Compendium.dnd5e.items.potion" }
            })
        };
        game.packs.set("dnd5e.items", {
            getDocument: vi.fn().mockResolvedValue(doc)
        });
        vi.spyOn(PotionEnrichment, "getHealFormula").mockReturnValue(null);

        const data = await ItemResolutionPipeline.resolve({
            name: "Potion of Healing",
            sourceCompendium: "dnd5e.items",
            _compendiumId: "potion-1",
            _infectedCount: 2,
            _totalQty: 3,
            _isMagical: true,
            _baseItemName: "Stoppered Flask",
            _mundaneDesc: "A plain flask."
        }, "batch-x");

        expect(data.flags?.[MODULE_ID]?.infectedCount).toBe(2);
        expect(data.flags?.[MODULE_ID]?.cursedMeta).toBeUndefined();
        expect(data.flags?.[MODULE_ID]?.forgedFrom).toBeUndefined();
        expect(data.flags?.[MODULE_ID]?.latentMagic).toBeTruthy();
        expect(data.flags?.core?.sourceId).toBeUndefined();
        expect(data._stats?.compendiumSource).toBeUndefined();
        expect(data.flags?.["item-piles"]?.item?.canStack).toBe("yes");
    });

    it("stamps canStack no for masked scrolls", async () => {
        const doc = {
            toObject: () => ({
                name: "Spell Scroll",
                type: "consumable",
                system: { type: { value: "scroll" }, rarity: "uncommon", identified: true },
                flags: {}
            })
        };
        game.packs.set("dnd5e.items", {
            getDocument: vi.fn().mockResolvedValue(doc)
        });

        const data = await ItemResolutionPipeline.resolve({
            name: "Spell Scroll",
            sourceCompendium: "dnd5e.items",
            _compendiumId: "scroll-1",
            _isMagical: true,
            _baseItemName: "Unidentified Scroll",
            _mundaneDesc: "A rolled parchment."
        }, null);

        expect(data.flags?.[MODULE_ID]?.latentMagic).toBeTruthy();
        expect(data.flags?.["item-piles"]?.item?.canStack).toBe("no");
    });

    it("forces identified true for CurseForge compendium items", async () => {
        const doc = {
            toObject: () => ({
                name: "Oathcleaver",
                type: "weapon",
                system: { identified: false },
                flags: {
                    [MODULE_ID]: { forgedFrom: "forge-1", cursedMeta: {} }
                }
            })
        };
        game.packs.set("world.cursed", {
            getDocument: vi.fn().mockResolvedValue(doc)
        });

        const data = await ItemResolutionPipeline.resolve({
            name: "Oathcleaver",
            sourceCompendium: "world.cursed",
            _compendiumId: "oath-1",
            _isMagical: false
        }, null);

        expect(data.system.identified).toBe(true);
    });
});
