/**
 * TerrainDataRegistry — Unit Tests
 *
 * Architectural guard: QM must never make concrete terrain ID assumptions.
 * Category routing must flow from the library spine flags, not from
 * hardcoded sets in module code.
 *
 * Also covers the synchronous accessor surface seeded directly into _terrains.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TerrainDataRegistry } from "../scripts/services/TerrainDataRegistry.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DUNGEON_DATA = {
    id: "dungeon",
    flavorPhrases: ["A torch flickers in the damp corridor."],
    materials: ["Bone", "Obsidian"],
    itemDescriptions: { sword: ["A blade blackened by years underground."] }
};

const FOREST_DATA = {
    id: "forest",
    flavorPhrases: ["Leaves rustle overhead."],
    materials: ["Ironwood", "Leather"],
    itemDescriptions: { generic: ["Worn smooth by the trail."] }
};

// ── Accessors ─────────────────────────────────────────────────────────────────

describe("TerrainDataRegistry accessors", () => {

    beforeEach(() => {
        TerrainDataRegistry._terrains = new Map([
            ["dungeon", structuredClone(DUNGEON_DATA)],
            ["forest",  structuredClone(FOREST_DATA)]
        ]);
        TerrainDataRegistry._ready = true;
    });

    describe("get", () => {
        it("returns terrain data by id", () => {
            expect(TerrainDataRegistry.get("dungeon")?.id).toBe("dungeon");
        });
        it("returns undefined for unknown id", () => {
            expect(TerrainDataRegistry.get("void")).toBeUndefined();
        });
    });

    describe("getAll", () => {
        it("returns all entries sorted by id", () => {
            const all = TerrainDataRegistry.getAll();
            expect(all).toHaveLength(2);
            expect(all[0].id).toBe("dungeon");
            expect(all[1].id).toBe("forest");
        });
    });

    describe("getFlavorPhrases", () => {
        it("returns phrases for known terrain", () => {
            const phrases = TerrainDataRegistry.getFlavorPhrases("dungeon");
            expect(phrases).toHaveLength(1);
            expect(phrases[0]).toContain("torch");
        });
        it("returns empty array for unknown terrain", () => {
            expect(TerrainDataRegistry.getFlavorPhrases("void")).toEqual([]);
        });
    });

    describe("getMaterials", () => {
        it("returns materials for known terrain", () => {
            expect(TerrainDataRegistry.getMaterials("dungeon")).toContain("Obsidian");
        });
        it("returns ['Mastercraft'] fallback for unknown terrain", () => {
            expect(TerrainDataRegistry.getMaterials("void")).toEqual(["Mastercraft"]);
        });
    });

    describe("getItemDescriptions", () => {
        it("returns category-specific descriptions", () => {
            const d = TerrainDataRegistry.getItemDescriptions("dungeon", "sword");
            expect(d[0]).toMatch(/blade/);
        });
        it("returns empty array when terrain has no descriptions", () => {
            expect(TerrainDataRegistry.getItemDescriptions("void", "sword")).toEqual([]);
        });
        it("returns empty array when category not found and no generic key", () => {
            expect(TerrainDataRegistry.getItemDescriptions("dungeon", "nonexistent")).toEqual([]);
        });
        it("falls back to generic when specific category missing", () => {
            const d = TerrainDataRegistry.getItemDescriptions("forest", "sword");
            expect(d).toEqual(["Worn smooth by the trail."]);
        });
    });
});

// ── register — additive merge ─────────────────────────────────────────────────

describe("TerrainDataRegistry.register", () => {

    beforeEach(() => {
        TerrainDataRegistry._terrains = new Map([
            ["dungeon", structuredClone(DUNGEON_DATA)]
        ]);
        TerrainDataRegistry._ready = true;
    });

    it("stores a new terrain directly", () => {
        TerrainDataRegistry.register({ id: "swamp", flavorPhrases: ["Mud everywhere."] });
        expect(TerrainDataRegistry.get("swamp")?.flavorPhrases).toContain("Mud everywhere.");
    });

    it("appends flavorPhrases without duplicates", () => {
        TerrainDataRegistry.register({ id: "dungeon", flavorPhrases: ["New smell.", "A torch flickers in the damp corridor."] });
        const phrases = TerrainDataRegistry.getFlavorPhrases("dungeon");
        expect(phrases).toContain("New smell.");
        expect(phrases.filter(p => p === "A torch flickers in the damp corridor.")).toHaveLength(1);
    });

    it("replaces materials when overlay provides them", () => {
        TerrainDataRegistry.register({ id: "dungeon", materials: ["Mithral"] });
        expect(TerrainDataRegistry.getMaterials("dungeon")).toEqual(["Mithral"]);
    });

    it("merges itemDescriptions per category", () => {
        TerrainDataRegistry.register({ id: "dungeon", itemDescriptions: { sword: ["Etched with runes."] } });
        const descs = TerrainDataRegistry.getItemDescriptions("dungeon", "sword");
        expect(descs).toContain("A blade blackened by years underground.");
        expect(descs).toContain("Etched with runes.");
    });

    it("does nothing and warns for data without id", () => {
        const before = TerrainDataRegistry.getAll().length;
        TerrainDataRegistry.register({ flavorPhrases: ["Orphaned."] });
        expect(TerrainDataRegistry.getAll().length).toBe(before);
    });
});

// ── getTerrainList / getTerrainOptionGroups — spine-driven, no hardcoded IDs ─
//
// Core architectural guard: Quartermaster must never contain hardcoded terrain
// ID lists. Category must come exclusively from the library spine flags.
// An overlay pack terrain with an arbitrary ID must group correctly.

describe("TerrainDataRegistry.getTerrainList — reads spine, not hardcoded IDs", () => {

    function makeSpineTerrain(id, label, category) {
        return { id, label, flags: { category } };
    }

    it("returns empty list when spine is unavailable", () => {
        game.ionrift = {};
        expect(TerrainDataRegistry.getTerrainList()).toEqual([]);
    });

    it("reads category from spine flags, not from hardcoded ID lists", () => {
        game.ionrift = {
            library: {
                terrains: {
                    getAll: () => [
                        makeSpineTerrain("dungeon",  "Dungeon",  "dungeon"),
                        makeSpineTerrain("tavern",   "Tavern",   "safe-haven"),
                        makeSpineTerrain("forest",   "Forest",   "wilderness"),
                        // Overlay terrain — ID unknown to any hardcoded list
                        makeSpineTerrain("sewers",   "Sewers",   "dungeon"),
                        makeSpineTerrain("inn",      "Inn",      "safe-haven")
                    ]
                }
            }
        };

        const list = TerrainDataRegistry.getTerrainList();
        expect(list.find(t => t.id === "dungeon")?.category).toBe("dungeon");
        expect(list.find(t => t.id === "tavern")?.category).toBe("safe-haven");
        expect(list.find(t => t.id === "forest")?.category).toBe("wilderness");
        // Overlay terrains with unknown IDs must categorise via spine data alone
        expect(list.find(t => t.id === "sewers")?.category).toBe("dungeon");
        expect(list.find(t => t.id === "inn")?.category).toBe("safe-haven");
    });

    it("defaults to 'wilderness' when spine entry has no category flag", () => {
        game.ionrift = {
            library: {
                terrains: {
                    getAll: () => [
                        { id: "moor", label: "Moor", flags: {} }
                    ]
                }
            }
        };
        const list = TerrainDataRegistry.getTerrainList();
        expect(list[0].category).toBe("wilderness");
    });
});

describe("TerrainDataRegistry.getTerrainOptionGroups — grouping driven by spine", () => {

    beforeEach(() => {
        game.ionrift = {
            library: {
                terrains: {
                    getAll: () => [
                        { id: "dungeon", label: "Dungeon", flags: { category: "dungeon" } },
                        { id: "tavern",  label: "Tavern",  flags: { category: "safe-haven" } },
                        { id: "forest",  label: "Forest",  flags: { category: "wilderness" } },
                        { id: "sewers",  label: "Sewers",  flags: { category: "dungeon" } }
                    ]
                }
            }
        };
    });

    it("groups terrains into Dungeon, Safe Haven, Wilderness", () => {
        const groups = TerrainDataRegistry.getTerrainOptionGroups();
        const names = groups.map(g => g.group);
        expect(names).toContain("Dungeon");
        expect(names).toContain("Safe Haven");
        expect(names).toContain("Wilderness");
    });

    it("places overlay terrain 'sewers' in Dungeon group via spine category", () => {
        const groups = TerrainDataRegistry.getTerrainOptionGroups();
        const dungeonGroup = groups.find(g => g.group === "Dungeon");
        expect(dungeonGroup?.options.map(o => o.id)).toContain("sewers");
    });

    it("marks selected terrain correctly", () => {
        const groups = TerrainDataRegistry.getTerrainOptionGroups("forest");
        const wilderness = groups.find(g => g.group === "Wilderness");
        const forestOpt = wilderness?.options.find(o => o.id === "forest");
        expect(forestOpt?.selected).toBe(true);
    });

    it("omits a group when no terrains belong to it", () => {
        game.ionrift.library.terrains.getAll = () => [
            { id: "forest", label: "Forest", flags: { category: "wilderness" } }
        ];
        const groups = TerrainDataRegistry.getTerrainOptionGroups();
        expect(groups.find(g => g.group === "Dungeon")).toBeUndefined();
        expect(groups.find(g => g.group === "Safe Haven")).toBeUndefined();
    });
});
