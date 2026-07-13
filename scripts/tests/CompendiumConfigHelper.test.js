import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("CompendiumConfigHelper", () => {
    let helper;
    let settingsStore;
    let deleteDocuments;

    beforeEach(async () => {
        vi.resetModules();

        settingsStore = new Map();
        deleteDocuments = vi.fn(async () => {});

        globalThis.game = {
            user: { isGM: true },
            ionrift: {},
            packs: new Map(),
            settings: {
                get: vi.fn((namespace, key) => settingsStore.get(`${namespace}.${key}`)),
                set: vi.fn(async (namespace, key, value) => {
                    settingsStore.set(`${namespace}.${key}`, value);
                    return value;
                })
            }
        };

        globalThis.foundry = {
            utils: {
                duplicate: (value) => JSON.parse(JSON.stringify(value)),
                mergeObject: (target, source) => ({ ...target, ...source })
            }
        };

        globalThis.CONFIG = {
            Item: {
                documentClass: { deleteDocuments }
            }
        };

        helper = await import("../services/CompendiumConfigHelper.js");
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.CONFIG;
        delete globalThis.foundry;
        delete globalThis.game;
    });

    it("computes stable source hashes shared by compiled pack services", () => {
        expect(helper.stableHash("Quartermaster")).toBe("7094ae4d");
        expect(helper.stableHash("manifest:12|dnd5e.items:400")).toBe("d41bfb57");
        expect(helper.stableHash("manifest:12|dnd5e.items:401")).not.toBe("d41bfb57");
    });

    it("locks a pack to GM-only ownership without disturbing other config", () => {
        settingsStore.set("core.compendiumConfiguration", {
            "world.quartermaster-scrolls": {
                folder: "compiled-folder",
                ownership: { PLAYER: "OBSERVER", GAMEMASTER: "OWNER" }
            },
            "world.other-pack": { folder: "untouched" }
        });

        helper.enforcePackOwnership({ collection: "world.quartermaster-scrolls" });

        expect(game.settings.set).toHaveBeenCalledTimes(1);
        expect(settingsStore.get("core.compendiumConfiguration")).toEqual({
            "world.quartermaster-scrolls": {
                folder: "compiled-folder",
                ownership: {
                    PLAYER: "NONE",
                    TRUSTED: "NONE",
                    ASSISTANT: "NONE",
                    GAMEMASTER: "OWNER"
                }
            },
            "world.other-pack": { folder: "untouched" }
        });
    });

    it("does not rewrite pack ownership for non-GM users or already locked packs", () => {
        const lockedOwnership = {
            PLAYER: "NONE",
            TRUSTED: "NONE",
            ASSISTANT: "NONE",
            GAMEMASTER: "OWNER"
        };
        settingsStore.set("core.compendiumConfiguration", {
            "world.locked": { ownership: lockedOwnership }
        });

        helper.enforcePackOwnership({ collection: "world.locked" });
        expect(game.settings.set).not.toHaveBeenCalled();

        game.user.isGM = false;
        helper.enforcePackOwnership({ collection: "world.new-pack" });
        expect(game.settings.set).not.toHaveBeenCalled();
    });

    it("deletes compiled pack documents and clears hash metadata", async () => {
        const pack = {
            collection: "world.quartermaster-scrolls",
            getDocuments: vi.fn(async () => [{ id: "a" }, { id: "b" }])
        };
        game.packs.set("world.quartermaster-scrolls", pack);

        await helper.clearPackAndResetMeta(
            "world.quartermaster-scrolls",
            "compiledScrollHash",
            "compiledScrollMeta",
            "ScrollForge"
        );

        expect(pack.getDocuments).toHaveBeenCalledTimes(1);
        expect(deleteDocuments).toHaveBeenCalledWith(["a", "b"], { pack: "world.quartermaster-scrolls" });
        expect(game.settings.set).toHaveBeenCalledWith("ionrift-quartermaster", "compiledScrollHash", "");
        expect(game.settings.set).toHaveBeenCalledWith("ionrift-quartermaster", "compiledScrollMeta", "");
    });

    it("still clears metadata when pack deletion has a partial failure", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        deleteDocuments.mockRejectedValueOnce(new Error("phantom entry"));
        game.packs.set("world.ionrift-srd-cursed", {
            collection: "world.ionrift-srd-cursed",
            getDocuments: vi.fn(async () => [{ id: "ghost" }])
        });

        await helper.clearPackAndResetMeta(
            "world.ionrift-srd-cursed",
            "srdCurseHash",
            "srdCurseMeta",
            "SrdCurseAdapter"
        );

        expect(warn).toHaveBeenCalledWith(
            "Ionrift Quartermaster |",
            "SrdCurseAdapter.clearCompiledPack: partial failure:",
            expect.any(Error)
        );
        expect(game.settings.set).toHaveBeenCalledWith("ionrift-quartermaster", "srdCurseHash", "");
        expect(game.settings.set).toHaveBeenCalledWith("ionrift-quartermaster", "srdCurseMeta", "");
    });
});
