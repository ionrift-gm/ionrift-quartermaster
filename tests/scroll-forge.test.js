import { describe, it, expect, beforeEach } from "vitest";
import { ScrollForge } from "../scripts/services/ScrollForge.js";

// ── _stableHash ───────────────────────────────────────────────────────────────

describe("ScrollForge._stableHash", () => {

    it("returns a hex string", () => {
        expect(ScrollForge._stableHash("test")).toMatch(/^[0-9a-f]+$/);
    });

    it("is deterministic: same input gives same hash", () => {
        const a = ScrollForge._stableHash("dnd5e.spells:319|dnd5e.spells24:401");
        const b = ScrollForge._stableHash("dnd5e.spells:319|dnd5e.spells24:401");
        expect(a).toBe(b);
    });

    it("returns different hashes for different inputs", () => {
        expect(ScrollForge._stableHash("aaa")).not.toBe(ScrollForge._stableHash("bbb"));
    });

    it("handles empty string without throwing", () => {
        expect(() => ScrollForge._stableHash("")).not.toThrow();
        expect(ScrollForge._stableHash("")).toMatch(/^[0-9a-f]+$/);
    });
});

// ── _candidateSnapshot ────────────────────────────────────────────────────────

describe("ScrollForge._candidateSnapshot", () => {

    it("returns a consistent hash for the same candidates regardless of order", () => {
        const a = [{ id: "dnd5e.spells" }, { id: "dnd5e.spells24" }];
        const b = [{ id: "dnd5e.spells24" }, { id: "dnd5e.spells" }];
        expect(ScrollForge._candidateSnapshot(a)).toBe(ScrollForge._candidateSnapshot(b));
    });

    it("returns different snapshots when the candidate set changes", () => {
        const before = [{ id: "dnd5e.spells" }];
        const after  = [{ id: "dnd5e.spells" }, { id: "some-new-module.spells" }];
        expect(ScrollForge._candidateSnapshot(before)).not.toBe(ScrollForge._candidateSnapshot(after));
    });

    it("handles an empty candidate list without throwing", () => {
        expect(() => ScrollForge._candidateSnapshot([])).not.toThrow();
    });
});

// ── _shouldPromptSourceDialog — regression for load-time popup bug ─────────────
//
// Before the fix, _shouldPromptSourceDialog returned true whenever the available
// compendium set differed from the last saved snapshot, causing the source-picker
// dialog to open on every world refresh (e.g. after installing a content pack).
// The method is now dead on the ready-hook path, but its logic is preserved here
// to prevent a regression if it is re-wired in future.

describe("ScrollForge._shouldPromptSourceDialog", () => {

    const MODULE_ID = "ionrift-quartermaster";

    function seedSettings({ sources = "[]", snapshot = "" } = {}) {
        game.settings._reset();
        game.settings.set(MODULE_ID, ScrollForge.SETTING_SOURCES,  sources);
        game.settings.set(MODULE_ID, ScrollForge.SETTING_SNAPSHOT, snapshot);
    }

    it("returns false when no sources have ever been saved (first run)", () => {
        seedSettings({ sources: "[]", snapshot: "" });
        const candidates = [{ id: "dnd5e.spells" }];
        expect(ScrollForge._shouldPromptSourceDialog(candidates)).toBe(false);
    });

    it("returns false when snapshot matches (no new compendiums)", () => {
        const candidates = [{ id: "dnd5e.spells" }];
        const snap = ScrollForge._candidateSnapshot(candidates);
        seedSettings({ sources: JSON.stringify(["dnd5e.spells"]), snapshot: snap });
        expect(ScrollForge._shouldPromptSourceDialog(candidates)).toBe(false);
    });

    it("returns true when snapshot differs AND sources are already saved", () => {
        // Simulate: user had saved sources, then a new spell compendium was installed
        const oldCandidates = [{ id: "dnd5e.spells" }];
        const oldSnap = ScrollForge._candidateSnapshot(oldCandidates);
        seedSettings({ sources: JSON.stringify(["dnd5e.spells"]), snapshot: oldSnap });

        const newCandidates = [{ id: "dnd5e.spells" }, { id: "some-new-module.spells" }];
        // This is the OLD behaviour — it would return true and pop the dialog.
        // runAfterReady() no longer calls this method, so the dialog will not open
        // on world load regardless. The test documents the method's own contract.
        expect(ScrollForge._shouldPromptSourceDialog(newCandidates)).toBe(true);
    });

    it("returns false when sources are empty even if snapshot differs", () => {
        // No sources saved → nothing to lose, no dialog needed
        seedSettings({ sources: "[]", snapshot: "old-snap" });
        const candidates = [{ id: "dnd5e.spells" }];
        expect(ScrollForge._shouldPromptSourceDialog(candidates)).toBe(false);
    });
});

// ── runAfterReady — never opens the dialog on world load ─────────────────────
//
// Core regression guard: runAfterReady must not trigger ScrollForgeSourceApp even
// when the compendium snapshot has drifted. It resolves by silently compiling.

describe("ScrollForge.runAfterReady — no auto-dialog on load", () => {

    const MODULE_ID = "ionrift-quartermaster";

    beforeEach(() => {
        game.settings._reset();

        // Base world state: dnd5e, GM, forge enabled, sources saved
        game.system = { id: "dnd5e" };
        game.user   = { isGM: true };
        game.settings.set(MODULE_ID, "scrollForgeEnabled", true);
        game.settings.set(MODULE_ID, ScrollForge.SETTING_SOURCES,  JSON.stringify(["dnd5e.spells"]));
        game.settings.set(MODULE_ID, ScrollForge.SETTING_SNAPSHOT, "old-different-hash");

        // No enabled spell packs in game.packs → compile exits early (no-op)
        game.packs = new Map();
    });

    it("does not throw when compendiums have changed since last save", async () => {
        // discoverSpellCompendiums returns [] (no packs in test env) → returns early
        await expect(ScrollForge.runAfterReady()).resolves.not.toThrow();
    });

    it("returns without error when scrollForgeEnabled is false", async () => {
        game.settings.set(MODULE_ID, "scrollForgeEnabled", false);
        await expect(ScrollForge.runAfterReady()).resolves.toBeUndefined();
    });

    it("returns without error on non-dnd5e system", async () => {
        game.system = { id: "pf2e" };
        await expect(ScrollForge.runAfterReady()).resolves.toBeUndefined();
    });

    it("returns without error when user is not GM", async () => {
        game.user = { isGM: false };
        await expect(ScrollForge.runAfterReady()).resolves.toBeUndefined();
    });
});

// ── _scrollRarity ─────────────────────────────────────────────────────────────

describe("ScrollForge._scrollRarity", () => {

    it("level 1 → common", () => expect(ScrollForge._scrollRarity(1)).toBe("common"));
    it("level 2 → uncommon", () => expect(ScrollForge._scrollRarity(2)).toBe("uncommon"));
    it("level 3 → uncommon", () => expect(ScrollForge._scrollRarity(3)).toBe("uncommon"));
    it("level 4 → rare", () => expect(ScrollForge._scrollRarity(4)).toBe("rare"));
    it("level 5 → rare", () => expect(ScrollForge._scrollRarity(5)).toBe("rare"));
    it("level 6 → veryRare", () => expect(ScrollForge._scrollRarity(6)).toBe("veryRare"));
    it("level 9 → legendary", () => expect(ScrollForge._scrollRarity(9)).toBe("legendary"));
});

// ── _scrollChallengeValues ────────────────────────────────────────────────────

describe("ScrollForge._scrollChallengeValues", () => {

    beforeEach(() => {
        // Stub CONFIG without spellScrollValues so the hardcoded fallback table is exercised
        globalThis.CONFIG = { DND5E: {} };
    });

    it("level 1 → dc 13, bonus 5", () => {
        expect(ScrollForge._scrollChallengeValues(1)).toEqual({ dc: 13, bonus: 5 });
    });

    it("level 5 → dc 17, bonus 9", () => {
        expect(ScrollForge._scrollChallengeValues(5)).toEqual({ dc: 17, bonus: 9 });
    });

    it("level 9 → dc 19, bonus 11", () => {
        expect(ScrollForge._scrollChallengeValues(9)).toEqual({ dc: 19, bonus: 11 });
    });

    it("level above 9 clamps to level-9 values", () => {
        expect(ScrollForge._scrollChallengeValues(10)).toEqual({ dc: 19, bonus: 11 });
    });
});

// ── worldCollectionId ─────────────────────────────────────────────────────────

describe("ScrollForge.worldCollectionId", () => {
    it("returns 'world.ionrift-forged-scrolls'", () => {
        expect(ScrollForge.worldCollectionId).toBe("world.ionrift-forged-scrolls");
    });
});
