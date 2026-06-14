import { describe, expect, it } from "vitest";

import { applyAuthoredDisguise } from "../services/AuthoredDisguise.js";

const MODULE_ID = "ionrift-quartermaster";

function buildSrdCursedItem(overrides = {}) {
    return {
        name: "Potion of Poison",
        type: "consumable",
        img: "icons/true-poison.webp",
        system: {
            rarity: "uncommon",
            identified: false,
            description: {
                value: "<p>The true poisonous item text.</p>"
            },
            price: {
                value: 100,
                denomination: "gp"
            }
        },
        flags: {
            [MODULE_ID]: {
                cursedMeta: {
                    source: "srd-cursed",
                    curseType: "deceptive"
                },
                latentMagic: {
                    originalName: "Potion of Healing",
                    originalRarity: "common",
                    originalDescription: "<p>A red liquid that glimmers when agitated.</p>",
                    originalImg: "icons/surface-healing.webp",
                    originalPrice: {
                        value: 50,
                        denomination: "gp"
                    },
                    magicalBonus: "",
                    attunement: "",
                    properties: ["mgc"]
                }
            }
        },
        ...overrides
    };
}

describe("applyAuthoredDisguise", () => {
    it("normalizes SRD cursed items to show the authored lure while preserving true promotion data", () => {
        const itemData = buildSrdCursedItem();

        const applied = applyAuthoredDisguise(itemData);

        expect(applied).toBe(true);
        expect(itemData.name).toBe("Potion of Healing");
        expect(itemData.img).toBe("icons/surface-healing.webp");
        expect(itemData.system).toMatchObject({
            rarity: "common",
            identified: true,
            description: {
                value: "<p>A red liquid that glimmers when agitated.</p>"
            },
            price: {
                value: 50,
                denomination: "gp"
            }
        });
        expect(itemData.flags[MODULE_ID].latentMagic).toEqual({
            originalName: "Potion of Poison",
            originalRarity: "uncommon",
            originalDescription: "<p>The true poisonous item text.</p>",
            originalImg: "icons/true-poison.webp",
            originalPrice: {
                value: 100,
                denomination: "gp"
            },
            magicalBonus: "",
            attunement: "",
            properties: ["mgc"]
        });
    });

    it("does not rewrite rows owned by a lure, Curse Forge, or a prior promotion", () => {
        const examples = [
            buildSrdCursedItem({
                flags: {
                    [MODULE_ID]: {
                        cursedMeta: { lure: { name: "Authored Lure" } },
                        latentMagic: { originalName: "Potion of Healing" }
                    }
                }
            }),
            buildSrdCursedItem({
                flags: {
                    [MODULE_ID]: {
                        cursedMeta: { curseType: "deceptive" },
                        forgedFrom: "Compendium.world.ionrift-cursewright-forged.Item.abc123",
                        latentMagic: { originalName: "Potion of Healing" }
                    }
                }
            }),
            buildSrdCursedItem({
                flags: {
                    [MODULE_ID]: {
                        cursedMeta: { curseType: "deceptive" },
                        latentMagic: {
                            originalName: "Potion of Healing",
                            promoted: true
                        }
                    }
                }
            })
        ];

        for (const itemData of examples) {
            const before = structuredClone(itemData);

            expect(applyAuthoredDisguise(itemData)).toBe(false);
            expect(itemData).toEqual(before);
        }
    });
});
