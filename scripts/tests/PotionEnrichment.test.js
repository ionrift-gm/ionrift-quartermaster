import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

async function loadPotionEnrichment() {
    vi.resetModules();
    return import("../services/PotionEnrichment.js");
}

function installFoundryStubs() {
    let id = 0;
    globalThis.foundry = {
        utils: {
            randomID: () => `activity-${String(++id).padStart(3, "0")}`
        }
    };
    globalThis.game = {
        ionrift: {},
        modules: new Map()
    };
}

describe("PotionEnrichment", () => {
    beforeEach(() => {
        installFoundryStubs();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.foundry;
        delete globalThis.game;
    });

    it("resolves healing potion tiers and excludes poison potions", async () => {
        const { PotionEnrichment } = await loadPotionEnrichment();

        expect(PotionEnrichment.getTierData("Potion of Healing")).toMatchObject({
            formula: "2d4 + 2",
            weight: 0.5,
            price: 50,
            rarity: "common"
        });
        expect(PotionEnrichment.getTierData("Potion of Greater Healing")).toMatchObject({
            formula: "4d4 + 4",
            price: 100,
            rarity: "uncommon"
        });
        expect(PotionEnrichment.getTierData("Potion of Poison")).toBeNull();
        expect(PotionEnrichment.getTierData("Healing Draught")).toBeNull();
    });

    it("enriches pile data for healing potions with blank dnd5e type fields", async () => {
        const { PotionEnrichment } = await loadPotionEnrichment();
        const itemData = {
            name: "Potion of Healing",
            type: "consumable",
            system: {
                type: { value: "" },
                weight: 0,
                uses: { max: "", spent: undefined },
                activities: {}
            }
        };

        expect(PotionEnrichment.enrichPileItemData(itemData)).toBe(true);

        expect(itemData.system.type.value).toBe("potion");
        expect(itemData.system.weight).toEqual({ value: 0.5, units: "lb" });
        expect(itemData.system.uses).toMatchObject({
            max: 1,
            spent: 0,
            recovery: []
        });
        const activities = Object.values(itemData.system.activities);
        expect(activities).toHaveLength(1);
        expect(activities[0]).toMatchObject({
            _id: "activity-001",
            type: "heal",
            name: "Consume",
            healing: {
                custom: { enabled: true, formula: "2d4 + 2" },
                types: ["healing"]
            }
        });
    });

    it("does not add a fallback activity when pile data already has one", async () => {
        const { PotionEnrichment } = await loadPotionEnrichment();
        const itemData = {
            name: "Potion of Superior Healing",
            type: "consumable",
            system: {
                type: { value: "potion" },
                weight: { value: 1, units: "lb" },
                uses: { max: 1, spent: 0, recovery: [] },
                activities: {
                    existing: { _id: "existing", type: "heal" }
                }
            }
        };

        expect(PotionEnrichment.enrichPileItemData(itemData)).toBe(true);

        expect(Object.keys(itemData.system.activities)).toEqual(["existing"]);
        expect(itemData.system.weight.value).toBe(0.5);
    });

    it("patches live identified healing potions with authoritative data", async () => {
        const { PotionEnrichment } = await loadPotionEnrichment();
        game.modules.set("midi-qol", { active: true });
        const update = vi.fn().mockResolvedValue(undefined);
        const item = {
            _source: { name: "Potion of Greater Healing" },
            name: "Unidentified Bottle",
            system: {
                weight: { value: 1, units: "lb" },
                price: { value: 0, denomination: "sp" },
                description: { value: "" },
                rarity: "",
                uses: { max: 0, spent: undefined },
                activities: {}
            },
            update
        };

        await PotionEnrichment.enrichIdentifiedItem(item);

        expect(update).toHaveBeenCalledTimes(1);
        const [patch, options] = update.mock.calls[0];
        expect(options).toEqual({ curseBypass: true });
        expect(patch).toMatchObject({
            "system.attunement": "",
            "system.weight.value": 0.5,
            "system.price": { value: 100, denomination: "gp" },
            "system.rarity": "uncommon",
            "system.uses.max": 1,
            "system.uses.spent": 0
        });
        expect(patch["system.description.value"]).toContain("vivid red liquid");
        const activityPatchKey = Object.keys(patch).find(k => k.startsWith("system.activities."));
        expect(activityPatchKey).toBe("system.activities.activity-001");
        expect(patch[activityPatchKey].healing.custom.formula).toBe("4d4 + 4");
    });

    it("does not duplicate live activities represented as a Collection", async () => {
        const { PotionEnrichment } = await loadPotionEnrichment();
        game.modules.set("midi-qol", { active: true });
        const update = vi.fn().mockResolvedValue(undefined);
        const item = {
            _source: { name: "Potion of Healing" },
            name: "Potion of Healing",
            system: {
                attunement: "",
                weight: { value: 0.5, units: "lb" },
                price: { value: 50, denomination: "gp" },
                description: { value: "<p>Already described.</p>" },
                rarity: "common",
                uses: { max: 1, spent: 0, recovery: [] },
                activities: new Map([["existing", { _id: "existing", type: "heal" }]])
            },
            update
        };

        await PotionEnrichment.enrichIdentifiedItem(item);

        expect(update).not.toHaveBeenCalled();
    });
});
