import { describe, it, expect, vi, beforeEach } from "vitest";
import { SrdCurseAdapter } from "../scripts/services/SrdCurseAdapter.js";

// ── _stableHash ──────────────────────────────────────────────────────────────

describe("SrdCurseAdapter._stableHash", () => {

    it("returns a hex string", () => {
        const h = SrdCurseAdapter._stableHash("test");
        expect(h).toMatch(/^[0-9a-f]+$/);
    });

    it("is deterministic: same input gives same hash", () => {
        const a = SrdCurseAdapter._stableHash("manifest:12|dnd5e.items:452");
        const b = SrdCurseAdapter._stableHash("manifest:12|dnd5e.items:452");
        expect(a).toBe(b);
    });

    it("returns different hashes for different inputs", () => {
        const a = SrdCurseAdapter._stableHash("aaa");
        const b = SrdCurseAdapter._stableHash("bbb");
        expect(a).not.toBe(b);
    });

    it("handles empty string without throwing", () => {
        expect(() => SrdCurseAdapter._stableHash("")).not.toThrow();
        expect(SrdCurseAdapter._stableHash("")).toMatch(/^[0-9a-f]+$/);
    });
});

// ── _stampItem ───────────────────────────────────────────────────────────────

describe("SrdCurseAdapter._stampItem", () => {

    function makeSourceItem(overrides = {}) {
        // Minimal item mock with toObject()
        const data = {
            name: "Berserker Axe",
            type: "weapon",
            img: "icons/weapons/axes/axe.webp",
            system: { rarity: "rare", identified: false },
            flags: {},
            ...overrides
        };
        return { toObject: () => structuredClone(data) };
    }

    const ENTRY = { match: "Berserker Axe", tier: 1, curseType: "compulsion" };

    it("sets system.identified to true", () => {
        const result = SrdCurseAdapter._stampItem(makeSourceItem(), ENTRY);
        expect(result.system.identified).toBe(true);
    });

    it("stamps cursedMeta with tier from entry", () => {
        const result = SrdCurseAdapter._stampItem(makeSourceItem(), ENTRY);
        expect(result.flags["ionrift-quartermaster"].cursedMeta.tier).toBe(1);
    });

    it("stamps cursedMeta with curseType from entry", () => {
        const result = SrdCurseAdapter._stampItem(makeSourceItem(), ENTRY);
        expect(result.flags["ionrift-quartermaster"].cursedMeta.curseType).toBe("compulsion");
    });

    it("sets decoyAppearance to empty string", () => {
        const result = SrdCurseAdapter._stampItem(makeSourceItem(), ENTRY);
        expect(result.flags["ionrift-quartermaster"].cursedMeta.decoyAppearance).toBe("");
    });

    it("sets trueNature to empty string", () => {
        const result = SrdCurseAdapter._stampItem(makeSourceItem(), ENTRY);
        expect(result.flags["ionrift-quartermaster"].cursedMeta.trueNature).toBe("");
    });

    it("sets mintBatch slug derived from match string", () => {
        const result = SrdCurseAdapter._stampItem(makeSourceItem(), ENTRY);
        expect(result.flags["ionrift-quartermaster"].mintBatch).toBe("srd-curse-berserker-axe");
    });

    it("does not throw for a minimal item with no flags", () => {
        const item = { toObject: () => ({ name: "Test", system: {}, flags: undefined }) };
        expect(() => SrdCurseAdapter._stampItem(item, ENTRY)).not.toThrow();
    });
});

// ── _applyFallbacks ──────────────────────────────────────────────────────────

describe("SrdCurseAdapter._applyFallbacks", () => {

    it("patches weight and price when zero", () => {
        const data = {
            system: {
                weight: { value: 0, units: "lb" },
                price: { value: 0, denomination: "gp" }
            }
        };
        SrdCurseAdapter._applyFallbacks(data, "Berserker Axe");
        expect(data.system.weight.value).toBe(7);
        expect(data.system.price.value).toBe(9000);
    });

    it("patches legacy number weight when zero", () => {
        const data = { system: { weight: 0, price: { value: 0, denomination: "gp" } } };
        SrdCurseAdapter._applyFallbacks(data, "Berserker Axe");
        expect(data.system.weight).toEqual({ value: 7, units: "lb" });
    });

    it("does NOT override non-zero values", () => {
        const data = {
            system: {
                weight: { value: 5, units: "lb" },
                price: { value: 100, denomination: "gp" }
            }
        };
        SrdCurseAdapter._applyFallbacks(data, "Berserker Axe");
        expect(data.system.weight.value).toBe(5);
        expect(data.system.price.value).toBe(100);
    });

    it("handles missing fallback name without throwing", () => {
        const data = { system: { weight: { value: 0, units: "lb" }, price: { value: 0 } } };
        expect(() => SrdCurseAdapter._applyFallbacks(data, "Unknown Cursed Item")).not.toThrow();
        expect(data.system.weight.value).toBe(0);
    });
});

// ── worldCollectionId ────────────────────────────────────────────────────────

describe("SrdCurseAdapter.worldCollectionId", () => {
    it("returns 'world.ionrift-srd-cursed'", () => {
        expect(SrdCurseAdapter.worldCollectionId).toBe("world.ionrift-srd-cursed");
    });
});

// ── _reconcilePack ──────────────────────────────────────────────────────────

describe("SrdCurseAdapter._reconcilePack", () => {

    let mockItemClass;

    function makeMockPack({ existingDocs = [], getDocsThrows = false } = {}) {
        return {
            collection: "world.ionrift-srd-cursed",
            getDocuments: getDocsThrows
                ? vi.fn().mockRejectedValue(new Error("LevelDB locked"))
                : vi.fn().mockResolvedValue(existingDocs),
        };
    }

    function makePendingItem(name) {
        return { name, type: "weapon", system: {}, flags: {} };
    }

    beforeEach(() => {
        mockItemClass = {
            createDocuments: vi.fn().mockResolvedValue([]),
            updateDocuments: vi.fn().mockResolvedValue([]),
            deleteDocuments: vi.fn().mockResolvedValue([]),
        };
        globalThis.CONFIG = { Item: { documentClass: mockItemClass } };
        game.ionrift = { library: {} };
    });

    it("creates all items when pack is empty", async () => {
        const pack = makeMockPack({ existingDocs: [] });
        const pending = [makePendingItem("Berserker Axe"), makePendingItem("Demon Armor")];
        await SrdCurseAdapter._reconcilePack(pack, pending);
        expect(mockItemClass.createDocuments).toHaveBeenCalledWith(
            pending,
            { pack: "world.ionrift-srd-cursed" }
        );
        expect(mockItemClass.updateDocuments).not.toHaveBeenCalled();
    });

    it("updates existing items and does not create duplicates", async () => {
        const existingDocs = [
            { id: "existing-1", name: "Berserker Axe" },
            { id: "existing-2", name: "Demon Armor" },
        ];
        const pack = makeMockPack({ existingDocs });
        const pending = [makePendingItem("Berserker Axe"), makePendingItem("Demon Armor")];

        await SrdCurseAdapter._reconcilePack(pack, pending);

        expect(mockItemClass.createDocuments).not.toHaveBeenCalled();
        expect(mockItemClass.updateDocuments).toHaveBeenCalledTimes(2);
        const firstUpdate = mockItemClass.updateDocuments.mock.calls[0][0][0];
        expect(firstUpdate._id).toBe("existing-1");
        expect(firstUpdate.name).toBe("Berserker Axe");
    });

    it("creates new items and updates existing ones in a mixed set", async () => {
        const existingDocs = [{ id: "existing-1", name: "Berserker Axe" }];
        const pack = makeMockPack({ existingDocs });
        const pending = [makePendingItem("Berserker Axe"), makePendingItem("Demon Armor")];

        await SrdCurseAdapter._reconcilePack(pack, pending);

        expect(mockItemClass.createDocuments).toHaveBeenCalledWith(
            [expect.objectContaining({ name: "Demon Armor" })],
            { pack: "world.ionrift-srd-cursed" }
        );
        expect(mockItemClass.updateDocuments).toHaveBeenCalledTimes(1);
    });

    it("removes items not in the pending manifest", async () => {
        const existingDocs = [
            { id: "existing-1", name: "Berserker Axe" },
            { id: "orphan-1", name: "Old Cursed Sword" },
        ];
        const pack = makeMockPack({ existingDocs });
        const pending = [makePendingItem("Berserker Axe")];

        await SrdCurseAdapter._reconcilePack(pack, pending);

        expect(mockItemClass.deleteDocuments).toHaveBeenCalledWith(
            ["orphan-1"],
            { pack: "world.ionrift-srd-cursed" }
        );
    });

    it("tolerates phantom entries that fail to update", async () => {
        const existingDocs = [{ id: "phantom-1", name: "Berserker Axe" }];
        const pack = makeMockPack({ existingDocs });
        mockItemClass.updateDocuments.mockRejectedValue(new Error("does not exist"));

        const pending = [makePendingItem("Berserker Axe")];
        await expect(SrdCurseAdapter._reconcilePack(pack, pending)).resolves.not.toThrow();
    });

    it("tolerates phantom entries that fail to delete", async () => {
        const existingDocs = [{ id: "phantom-1", name: "Old Cursed Sword" }];
        const pack = makeMockPack({ existingDocs });
        mockItemClass.deleteDocuments.mockRejectedValue(new Error("does not exist"));

        const pending = [];
        await expect(SrdCurseAdapter._reconcilePack(pack, pending)).resolves.not.toThrow();
    });

    it("inserts everything fresh when getDocuments throws (unreadable pack)", async () => {
        const pack = makeMockPack({ getDocsThrows: true });
        const pending = [makePendingItem("Berserker Axe")];

        await SrdCurseAdapter._reconcilePack(pack, pending);

        expect(mockItemClass.createDocuments).toHaveBeenCalledWith(
            [expect.objectContaining({ name: "Berserker Axe" })],
            { pack: "world.ionrift-srd-cursed" }
        );
    });

    it("matches item names case-insensitively", async () => {
        const existingDocs = [{ id: "existing-1", name: "berserker axe" }];
        const pack = makeMockPack({ existingDocs });
        const pending = [makePendingItem("Berserker Axe")];

        await SrdCurseAdapter._reconcilePack(pack, pending);

        expect(mockItemClass.createDocuments).not.toHaveBeenCalled();
        expect(mockItemClass.updateDocuments).toHaveBeenCalledTimes(1);
    });

    it("prunes duplicate entries (keeps first, deletes extras)", async () => {
        const existingDocs = [
            { id: "dup-1", name: "Berserker Axe" },
            { id: "dup-2", name: "Berserker Axe" },
        ];
        const pack = makeMockPack({ existingDocs });
        const pending = [makePendingItem("Berserker Axe")];

        await SrdCurseAdapter._reconcilePack(pack, pending);

        expect(mockItemClass.createDocuments).not.toHaveBeenCalled();
        expect(mockItemClass.updateDocuments).toHaveBeenCalledTimes(1);
        const updateData = mockItemClass.updateDocuments.mock.calls[0][0][0];
        expect(updateData._id).toBe("dup-1");

        expect(mockItemClass.deleteDocuments).toHaveBeenCalledWith(
            ["dup-2"],
            { pack: "world.ionrift-srd-cursed" }
        );
    });

    it("prunes three-way duplicates down to one", async () => {
        const existingDocs = [
            { id: "dup-1", name: "Demon Armor" },
            { id: "dup-2", name: "Demon Armor" },
            { id: "dup-3", name: "Demon Armor" },
        ];
        const pack = makeMockPack({ existingDocs });
        const pending = [makePendingItem("Demon Armor")];

        await SrdCurseAdapter._reconcilePack(pack, pending);

        expect(mockItemClass.updateDocuments).toHaveBeenCalledTimes(1);
        const deletedIds = mockItemClass.deleteDocuments.mock.calls.map(c => c[0][0]);
        expect(deletedIds).toContain("dup-2");
        expect(deletedIds).toContain("dup-3");
        expect(deletedIds).not.toContain("dup-1");
    });
});

// ── _createWorldPack ────────────────────────────────────────────────────────

describe("SrdCurseAdapter._createWorldPack", () => {

    beforeEach(() => {
        game.system = { id: "dnd5e" };
        game.packs = new Map();
        globalThis.CONST = {
            ...(globalThis.CONST ?? {}),
            COMPENDIUM_PACKAGE_TYPES: undefined,
        };
        globalThis.foundry.documents = {
            collections: {
                CompendiumCollection: {
                    createCompendium: vi.fn(),
                }
            }
        };
    });

    it("returns existing pack if already registered in game.packs", async () => {
        const existing = { collection: "world.ionrift-srd-cursed", label: "existing" };
        game.packs.set("world.ionrift-srd-cursed", existing);

        const result = await SrdCurseAdapter._createWorldPack();
        expect(result).toBe(existing);
        expect(foundry.documents.collections.CompendiumCollection.createCompendium).not.toHaveBeenCalled();
    });

    it("recovers from 'already exists' error by rechecking game.packs", async () => {
        const latePack = { collection: "world.ionrift-srd-cursed", label: "late" };
        foundry.documents.collections.CompendiumCollection.createCompendium
            .mockImplementation(() => {
                game.packs.set("world.ionrift-srd-cursed", latePack);
                throw new Error("already exists");
            });

        const result = await SrdCurseAdapter._createWorldPack();
        expect(result).toBe(latePack);
    });

    it("returns null and shows notification when creation fails completely", async () => {
        foundry.documents.collections.CompendiumCollection.createCompendium
            .mockRejectedValue(new Error("unknown error"));

        const errorSpy = vi.spyOn(ui.notifications, "error");
        const result = await SrdCurseAdapter._createWorldPack();
        expect(result).toBeNull();
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});
