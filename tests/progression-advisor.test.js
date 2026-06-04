import { describe, it, expect } from "vitest";
import { ProgressionAdvisor } from "../scripts/services/ProgressionAdvisor.js";

// ── Constants ────────────────────────────────────────────────────────────

describe("ProgressionAdvisor constants", () => {

    it("has tier level caps for all 4 tiers", () => {
        expect(ProgressionAdvisor.TIER_LEVEL_CAP[1]).toBe(4);
        expect(ProgressionAdvisor.TIER_LEVEL_CAP[2]).toBe(10);
        expect(ProgressionAdvisor.TIER_LEVEL_CAP[3]).toBe(16);
        expect(ProgressionAdvisor.TIER_LEVEL_CAP[4]).toBe(20);
    });

    it("tier level caps are strictly ascending", () => {
        const caps = ProgressionAdvisor.TIER_LEVEL_CAP;
        expect(caps[1]).toBeLessThan(caps[2]);
        expect(caps[2]).toBeLessThan(caps[3]);
        expect(caps[3]).toBeLessThan(caps[4]);
    });

    it("has a positive score tolerance", () => {
        expect(ProgressionAdvisor.SCORE_TOLERANCE).toBeGreaterThan(0);
        expect(ProgressionAdvisor.SCORE_TOLERANCE).toBeLessThan(1);
    });

    it("has a small visible signature card cap for the cache UI", () => {
        expect(ProgressionAdvisor.VISIBLE_SIGNATURE_CARD_CAP).toBeGreaterThanOrEqual(1);
        expect(ProgressionAdvisor.VISIBLE_SIGNATURE_CARD_CAP).toBeLessThanOrEqual(10);
    });
});

// ── _applyToleranceShuffle ───────────────────────────────────────────────

describe("ProgressionAdvisor._applyToleranceShuffle", () => {

    it("returns empty array for empty input", () => {
        expect(ProgressionAdvisor._applyToleranceShuffle([], 0.05)).toEqual([]);
    });

    it("returns single element unchanged", () => {
        const input = [{ compositeScore: 1.0, id: "a" }];
        const result = ProgressionAdvisor._applyToleranceShuffle(input, 0.05);
        expect(result.length).toBe(1);
        expect(result[0].id).toBe("a");
    });

    it("preserves total count", () => {
        const input = [
            { compositeScore: 1.0 },
            { compositeScore: 0.8 },
            { compositeScore: 0.5 },
            { compositeScore: 0.2 }
        ];
        const result = ProgressionAdvisor._applyToleranceShuffle(input, 0.05);
        expect(result.length).toBe(4);
    });

    it("groups items within tolerance band", () => {
        // Two items within 0.05 of each other
        const input = [
            { compositeScore: 1.0, id: "a" },
            { compositeScore: 0.97, id: "b" },
            { compositeScore: 0.5, id: "c" }
        ];
        const result = ProgressionAdvisor._applyToleranceShuffle(input, 0.05);
        expect(result.length).toBe(3);
        // c should always be last — it's in its own group
        expect(result[2].id).toBe("c");
    });

    it("keeps clearly separated items in order", () => {
        const input = [
            { compositeScore: 1.0, id: "a" },
            { compositeScore: 0.5, id: "b" },
            { compositeScore: 0.1, id: "c" }
        ];
        // With tolerance 0.05, all three are in separate groups => order preserved
        const result = ProgressionAdvisor._applyToleranceShuffle(input, 0.05);
        expect(result[0].id).toBe("a");
        expect(result[1].id).toBe("b");
        expect(result[2].id).toBe("c");
    });

    it("groups all items when tolerance is very large", () => {
        const input = [
            { compositeScore: 1.0, id: "a" },
            { compositeScore: 0.5, id: "b" },
            { compositeScore: 0.3, id: "c" }
        ];
        // If tolerance is 10.0, everything groups together
        const result = ProgressionAdvisor._applyToleranceShuffle(input, 10.0);
        expect(result.length).toBe(3);
        // All items should be present, but order is randomised
        const ids = result.map(r => r.id).sort();
        expect(ids).toEqual(["a", "b", "c"]);
    });
});

// ── _shuffleArray ────────────────────────────────────────────────────────

describe("ProgressionAdvisor._shuffleArray", () => {

    it("preserves array length", () => {
        const result = ProgressionAdvisor._shuffleArray([1, 2, 3, 4, 5]);
        expect(result.length).toBe(5);
    });

    it("preserves all elements", () => {
        const result = ProgressionAdvisor._shuffleArray([1, 2, 3, 4, 5]);
        expect(result.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it("does not mutate original array", () => {
        const original = [1, 2, 3];
        ProgressionAdvisor._shuffleArray(original);
        expect(original).toEqual([1, 2, 3]);
    });

    it("handles empty array", () => {
        expect(ProgressionAdvisor._shuffleArray([])).toEqual([]);
    });

    it("handles single element", () => {
        expect(ProgressionAdvisor._shuffleArray([42])).toEqual([42]);
    });
});

// ── _buildPartyShelf ─────────────────────────────────────────────────────

describe("ProgressionAdvisor._buildPartyShelf", () => {

    it("returns empty for empty shelf", () => {
        expect(ProgressionAdvisor._buildPartyShelf([], 10, new Set())).toEqual([]);
    });

    it("filters by level cap", () => {
        const shelf = [
            { name: "Shield", level: 5, delivered: false },
            { name: "Helm",   level: 15, delivered: false }
        ];
        const result = ProgressionAdvisor._buildPartyShelf(shelf, 10, new Set());
        expect(result.length).toBe(1);
        expect(result[0].name).toBe("Shield");
    });

    it("excludes delivered items", () => {
        const shelf = [
            { name: "Shield", level: 5, delivered: true },
            { name: "Helm",   level: 5, delivered: false }
        ];
        const result = ProgressionAdvisor._buildPartyShelf(shelf, 10, new Set());
        expect(result.length).toBe(1);
        expect(result[0].name).toBe("Helm");
    });

    it("excludes banned items", () => {
        const shelf = [
            { name: "Banned Sword", level: 5, delivered: false },
            { name: "Helm",         level: 5, delivered: false }
        ];
        const banSet = new Set(["banned sword"]);
        const result = ProgressionAdvisor._buildPartyShelf(shelf, 10, banSet);
        expect(result.length).toBe(1);
        expect(result[0].name).toBe("Helm");
    });

    it("sorts highest level first", () => {
        const shelf = [
            { name: "A", level: 3, delivered: false },
            { name: "B", level: 8, delivered: false },
            { name: "C", level: 5, delivered: false }
        ];
        const result = ProgressionAdvisor._buildPartyShelf(shelf, 10, new Set());
        expect(result[0].name).toBe("B");
        expect(result[1].name).toBe("C");
        expect(result[2].name).toBe("A");
    });
});

// ── _buildScrolls ────────────────────────────────────────────────────────

describe("ProgressionAdvisor._buildScrolls", () => {

    it("returns empty for empty plan", () => {
        expect(ProgressionAdvisor._buildScrolls([], 10, {}, new Set())).toEqual([]);
    });

    it("filters by level cap", () => {
        const plan = [
            { spellName: "A", level: 5, uuid: "u1" },
            { spellName: "B", level: 15, uuid: "u2" }
        ];
        const result = ProgressionAdvisor._buildScrolls(plan, 10, {}, new Set());
        expect(result.length).toBe(1);
        expect(result[0].spellName).toBe("A");
    });

    it("excludes spells already in cache result", () => {
        const plan = [
            { spellName: "Fireball", level: 5, uuid: "u1" }
        ];
        const cacheResult = {
            items: [{ spellName: "fireball" }]
        };
        const result = ProgressionAdvisor._buildScrolls(plan, 10, cacheResult, new Set());
        expect(result.length).toBe(0);
    });

    it("excludes banned spells", () => {
        const plan = [
            { spellName: "Banned Spell", level: 5, uuid: "u1" },
            { spellName: "Fireball", level: 5, uuid: "u2" }
        ];
        const banSet = new Set(["banned spell"]);
        const result = ProgressionAdvisor._buildScrolls(plan, 10, {}, banSet);
        expect(result.length).toBe(1);
        expect(result[0].spellName).toBe("Fireball");
    });

    it("sets canInject based on uuid presence", () => {
        const plan = [
            { spellName: "A", level: 5, uuid: "u1" },
            { spellName: "B", level: 5, uuid: "" }
        ];
        const result = ProgressionAdvisor._buildScrolls(plan, 10, {}, new Set());
        expect(result[0].canInject).toBe(true);
        expect(result[1].canInject).toBe(false);
    });

    it("sorts highest level first", () => {
        const plan = [
            { spellName: "A", level: 3, uuid: "u1" },
            { spellName: "B", level: 8, uuid: "u2" },
            { spellName: "C", level: 5, uuid: "u3" }
        ];
        const result = ProgressionAdvisor._buildScrolls(plan, 10, {}, new Set());
        expect(result[0].spellName).toBe("B");
        expect(result[1].spellName).toBe("C");
        expect(result[2].spellName).toBe("A");
    });
});
