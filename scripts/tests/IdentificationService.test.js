import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

const MODULE_ID = "ionrift-quartermaster";
let IdentificationService;

vi.mock("../services/TerrainDataRegistry.js", () => ({
    TerrainDataRegistry: {
        getItemDescriptions: () => []
    }
}));

function makeSf2eMaskedItem(latent) {
    let lastUpdate = null;
    let lastFlag = null;

    return {
        name: "Unidentified Weapon",
        type: "weapon",
        system: {
            identified: true,
            identification: { status: "unidentified" },
            traits: { rarity: "common", value: ["visible"] },
            price: { value: { gp: 0 } },
            description: { value: "<p>Masked.</p>" }
        },
        flags: { [MODULE_ID]: { latentMagic: latent } },
        getFlag(moduleId, key) {
            return this.flags?.[moduleId]?.[key];
        },
        async setFlag(moduleId, key, value) {
            this.flags[moduleId] ??= {};
            this.flags[moduleId][key] = value;
            lastFlag = { moduleId, key, value };
        },
        async update(update, options) {
            lastUpdate = { update, options };
        },
        get lastUpdate() {
            return lastUpdate;
        },
        get lastFlag() {
            return lastFlag;
        }
    };
}

describe("IdentificationService", () => {
    beforeAll(async () => {
        globalThis.game = {
            system: { id: "sf2e" },
            user: { isGM: true },
            ionrift: {}
        };
        globalThis.foundry = {
            utils: {
                deepClone: value => JSON.parse(JSON.stringify(value))
            }
        };
        ({ IdentificationService } = await import("../services/IdentificationService.js"));
    });

    beforeEach(() => {
        globalThis.game.system.id = "sf2e";
        globalThis.game.user.isGM = true;
    });

    afterAll(() => {
        delete globalThis.game;
        delete globalThis.foundry;
    });

    it("restores PF2e-family identification fields for SF2e latent magic", async () => {
        const latent = {
            originalName: "Starforged Blade",
            originalDescription: "<p>A brilliant blade.</p>",
            originalRarity: "uncommon",
            originalTraits: ["magical", "tech"],
            originalPrice: { value: { gp: 75, sp: 0 } }
        };
        const item = makeSf2eMaskedItem(latent);

        const result = await IdentificationService.identify(item, { silent: true });

        expect(result).toEqual({ identified: true, kind: "latent-magic" });
        expect(item.lastUpdate.options).toEqual({ curseBypass: true });
        expect(item.lastUpdate.update).toMatchObject({
            name: "Starforged Blade",
            "system.identified": true,
            "system.identification.status": "identified",
            "system.traits.rarity": "uncommon",
            "system.traits.value": ["visible", "magical", "tech"],
            "system.price": { value: { gp: 75, sp: 0 } }
        });
        expect(item.lastFlag).toEqual({
            moduleId: MODULE_ID,
            key: "latentMagic",
            value: { ...latent, promoted: true }
        });
    });
});
