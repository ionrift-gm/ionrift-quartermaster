import { describe, it, expect } from "vitest";
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
