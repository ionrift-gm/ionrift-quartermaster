import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TerrainDataRegistry } from "../../services/loot/TerrainDataRegistry.js";
import { resetTranslations, installFoundryI18nMock } from "../setup/foundryI18nMock.js";

describe("TerrainDataRegistry i18n", () => {
    beforeEach(() => {
        installFoundryI18nMock();
        resetTranslations({
            "IONRIFT.LIBRARY.TERRAIN.Forest": "Лес",
            "IONRIFT.LIBRARY.TERRAIN.Dungeon": "Подземелье",
            "IONRIFT.QUARTERMASTER.TERRAIN.CategoryBuilt": "Постройки",
            "IONRIFT.QUARTERMASTER.TERRAIN.CategoryWilderness": "Дикая местность",
            "IONRIFT.QUARTERMASTER.TERRAIN.CategorySafeHaven": "Убежище"
        });
        TerrainDataRegistry._terrains.clear();
        TerrainDataRegistry._ready = false;

        globalThis.game.ionrift = {
            library: {
                terrains: {
                    getBase() {
                        return [
                            { id: "forest", labelKey: "IONRIFT.LIBRARY.TERRAIN.Forest", category: "wilderness" },
                            { id: "dungeon", labelKey: "IONRIFT.LIBRARY.TERRAIN.Dungeon", category: "built" }
                        ];
                    }
                },
                normalizeTerrainCategory(category) {
                    const aliases = { dungeon: "built", urban: "built" };
                    const resolved = aliases[category] ?? category;
                    if (resolved === "built" || resolved === "safe-haven" || resolved === "wilderness") {
                        return resolved;
                    }
                    return null;
                }
            }
        };

        TerrainDataRegistry.register({
            id: "forest",
            labelKey: "IONRIFT.LIBRARY.TERRAIN.Forest"
        });
        TerrainDataRegistry.register({
            id: "dungeon",
            labelKey: "IONRIFT.LIBRARY.TERRAIN.Dungeon"
        });
        TerrainDataRegistry.register({
            id: "ruins",
            labelKey: null,
            category: "built"
        });
        TerrainDataRegistry._ready = true;
    });

    afterEach(() => {
        TerrainDataRegistry._terrains.clear();
        TerrainDataRegistry._ready = false;
    });

    it("resolves shared base terrains via Library labelKeys", () => {
        expect(TerrainDataRegistry.resolveLabel("forest")).toBe("Лес");
        expect(TerrainDataRegistry.resolveLabel("dungeon")).toBe("Подземелье");
    });

    it("getTerrainList localizes labels at render", () => {
        const list = TerrainDataRegistry.getTerrainList();
        const forest = list.find(t => t.id === "forest");
        expect(forest.label).toBe("Лес");
        expect(forest.labelKey).toBe("IONRIFT.LIBRARY.TERRAIN.Forest");
    });

    it("localizes category group headers", () => {
        const groups = TerrainDataRegistry.getTerrainOptionGroups("forest");
        const labels = groups.map(g => g.group);
        expect(labels).toContain("Постройки");
        expect(labels).toContain("Дикая местность");
    });

    it("falls back to Title-Case for QM-only terrains without labelKey", () => {
        expect(TerrainDataRegistry.resolveLabel("ruins")).toBe("Ruins");
    });
});
