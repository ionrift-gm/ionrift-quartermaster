import { describe, it, expect } from "vitest";
import { SignatureLedger } from "../scripts/services/SignatureLedger.js";

// ── Constants ────────────────────────────────────────────────────────────

describe("SignatureLedger constants", () => {

    it("has 6 milestones", () => {
        expect(SignatureLedger.MILESTONES).toEqual([3, 5, 8, 12, 16, 20]);
    });

    it("milestones are sorted ascending", () => {
        const ms = SignatureLedger.MILESTONES;
        for (let i = 1; i < ms.length; i++) {
            expect(ms[i]).toBeGreaterThan(ms[i - 1]);
        }
    });

    it("has power weight categories", () => {
        const pw = SignatureLedger.POWER_WEIGHTS;
        expect(pw.rarity.common).toBe(1);
        expect(pw.rarity.legendary).toBe(25);
        expect(pw.attunement).toBe(1.5);
        expect(pw.charges).toBe(0.3);
        expect(pw.flatBonus).toBe(2.0);
    });

    it("rarity weights are strictly ascending", () => {
        const r = SignatureLedger.POWER_WEIGHTS.rarity;
        expect(r.common).toBeLessThan(r.uncommon);
        expect(r.uncommon).toBeLessThan(r.rare);
        expect(r.rare).toBeLessThan(r.veryRare);
        expect(r.veryRare).toBeLessThan(r.legendary);
    });
});

// ── sanitizePlannedItems ─────────────────────────────────────────────────

describe("SignatureLedger.sanitizePlannedItems", () => {

    it("returns empty array for null input", () => {
        expect(SignatureLedger.sanitizePlannedItems(null)).toEqual([]);
    });

    it("returns empty array for non-array input", () => {
        expect(SignatureLedger.sanitizePlannedItems("hello")).toEqual([]);
    });

    it("returns empty array for empty array", () => {
        expect(SignatureLedger.sanitizePlannedItems([])).toEqual([]);
    });

    it("preserves valid items up to budget", () => {
        const items = [
            { level: 3, name: "Sword", img: "a.png", uuid: "uuid-1", rarity: "uncommon" },
            { level: 5, name: "Shield", img: "b.png", uuid: "uuid-2", rarity: "rare" }
        ];
        const result = SignatureLedger.sanitizePlannedItems(items);
        expect(result.length).toBe(2);
        expect(result[0].level).toBe(3);
        expect(result[1].level).toBe(5);
    });

    it("caps at budget (default 4)", () => {
        const items = SignatureLedger.MILESTONES.map((ms, i) => ({
            level: ms, name: `Item ${i}`, img: "", uuid: `uuid-${i}`, rarity: "common"
        }));
        const result = SignatureLedger.sanitizePlannedItems(items);
        expect(result.length).toBe(4);
    });

    it("respects custom budget", () => {
        const items = SignatureLedger.MILESTONES.map((ms, i) => ({
            level: ms, name: `Item ${i}`, img: "", uuid: `uuid-${i}`, rarity: "common"
        }));
        const result = SignatureLedger.sanitizePlannedItems(items, { budget: 2 });
        expect(result.length).toBe(2);
    });

    it("skips items without uuid", () => {
        const items = [
            { level: 3, name: "Sword", uuid: "" },
            { level: 5, name: "Shield", uuid: "uuid-2" }
        ];
        const result = SignatureLedger.sanitizePlannedItems(items);
        expect(result.length).toBe(1);
        expect(result[0].name).toBe("Shield");
    });

    it("deduplicates by uuid (case-insensitive)", () => {
        const items = [
            { level: 3, name: "Sword", uuid: "UUID-1" },
            { level: 5, name: "Sword Copy", uuid: "uuid-1" }
        ];
        const result = SignatureLedger.sanitizePlannedItems(items);
        expect(result.length).toBe(1);
    });

    it("only allows one item per milestone", () => {
        const items = [
            { level: 3, name: "A", uuid: "uuid-1" },
            { level: 3, name: "B", uuid: "uuid-2" }
        ];
        const result = SignatureLedger.sanitizePlannedItems(items);
        expect(result.length).toBe(1);
    });

    it("normalizes field presence", () => {
        const items = [{ level: 3, uuid: "uuid-1" }];
        const result = SignatureLedger.sanitizePlannedItems(items);
        expect(result[0]).toEqual({
            level: 3,
            name: "",
            img: "",
            uuid: "uuid-1",
            rarity: "",
            source: "",
            delivered: false,
            locked: false
        });
    });
});

// ── sanitizeScrollPinned ─────────────────────────────────────────────────

describe("SignatureLedger.sanitizeScrollPinned", () => {

    it("returns empty for empty input", () => {
        expect(SignatureLedger.sanitizeScrollPinned([])).toEqual([]);
    });

    it("caps at 3 per milestone", () => {
        const pinned = [
            { level: 3, spellName: "Magic Missile", uuid: "u1", slotOrder: 0 },
            { level: 3, spellName: "Shield",         uuid: "u2", slotOrder: 1 },
            { level: 3, spellName: "Burning Hands",  uuid: "u3", slotOrder: 2 }
        ];
        const result = SignatureLedger.sanitizeScrollPinned(pinned);
        const lvl3 = result.filter(r => r.level === 3);
        expect(lvl3.length).toBe(3);
    });

    it("deduplicates by spellName (case-insensitive)", () => {
        const pinned = [
            { level: 3, spellName: "Magic Missile", uuid: "u1", slotOrder: 0 },
            { level: 3, spellName: "magic missile", uuid: "u2", slotOrder: 1 }
        ];
        const result = SignatureLedger.sanitizeScrollPinned(pinned);
        expect(result.length).toBe(1);
    });

    it("skips entries without uuid", () => {
        const pinned = [
            { level: 3, spellName: "Shield", uuid: "", slotOrder: 0 }
        ];
        const result = SignatureLedger.sanitizeScrollPinned(pinned);
        expect(result.length).toBe(0);
    });

    it("preserves slotOrder assignment", () => {
        const pinned = [
            { level: 5, spellName: "Fireball", uuid: "u1", slotOrder: 0 },
            { level: 5, spellName: "Counterspell", uuid: "u2", slotOrder: 1 }
        ];
        const result = SignatureLedger.sanitizeScrollPinned(pinned);
        expect(result[0].slotOrder).toBe(0);
        expect(result[1].slotOrder).toBe(1);
    });
});

// ── sanitizeCursedPlanned ────────────────────────────────────────────────

describe("SignatureLedger.sanitizeCursedPlanned", () => {

    it("returns empty for empty input", () => {
        expect(SignatureLedger.sanitizeCursedPlanned([])).toEqual([]);
    });

    it("returns input unchanged (stub; cursed plan sanitization lives in cursewright)", () => {
        const planned = [
            { level: 3, uuid: "u1", slotOrder: 0 },
            { level: 3, uuid: "u2", slotOrder: 1 },
            { level: 3, uuid: "u3", slotOrder: 0 }
        ];
        expect(SignatureLedger.sanitizeCursedPlanned(planned)).toEqual(planned);
    });

    it("preserves duplicate uuids (stub pass-through)", () => {
        const planned = [
            { level: 3, uuid: "UUID-1", slotOrder: 0 },
            { level: 3, uuid: "uuid-1", slotOrder: 1 }
        ];
        const result = SignatureLedger.sanitizeCursedPlanned(planned);
        expect(result.length).toBe(2);
    });
});

// ── _cursedPlannedProjectionKey ──────────────────────────────────────────

describe("SignatureLedger._cursedPlannedProjectionKey", () => {

    it("returns empty string for empty array", () => {
        expect(SignatureLedger._cursedPlannedProjectionKey([])).toBe("");
    });

    it("produces stable keys regardless of input order", () => {
        const a = [
            { level: 5, slotOrder: 0, uuid: "u1", used: false },
            { level: 3, slotOrder: 0, uuid: "u2", used: true }
        ];
        const b = [
            { level: 3, slotOrder: 0, uuid: "u2", used: true },
            { level: 5, slotOrder: 0, uuid: "u1", used: false }
        ];
        expect(SignatureLedger._cursedPlannedProjectionKey(a))
            .toBe(SignatureLedger._cursedPlannedProjectionKey(b));
    });

    it("returns empty string for non-empty input (stub)", () => {
        const a = [{ level: 3, uuid: "u1", used: false }];
        const b = [{ level: 3, uuid: "u1", used: true }];
        expect(SignatureLedger._cursedPlannedProjectionKey(a)).toBe("");
        expect(SignatureLedger._cursedPlannedProjectionKey(b)).toBe("");
    });
});

// ── computePowerScore ────────────────────────────────────────────────────

describe("SignatureLedger.computePowerScore", () => {

    it("returns 0 for null actor", () => {
        expect(SignatureLedger.computePowerScore(null)).toBe(0);
    });

    it("returns 0 for actor with no magic items", () => {
        const actor = {
            items: [
                { type: "weapon", system: { rarity: "common" } },
                { type: "equipment", system: { rarity: "common" } }
            ]
        };
        expect(SignatureLedger.computePowerScore(actor)).toBe(0);
    });

    it("scores uncommon item correctly", () => {
        const actor = {
            items: [
                { type: "weapon", system: { rarity: "uncommon" } }
            ]
        };
        expect(SignatureLedger.computePowerScore(actor)).toBe(3);
    });

    it("applies attunement multiplier", () => {
        const actor = {
            items: [
                { type: "weapon", system: { rarity: "uncommon", attunement: true } }
            ]
        };
        // 3 (uncommon) * 1.5 (attunement) = 4.5
        expect(SignatureLedger.computePowerScore(actor)).toBe(4.5);
    });

    it("adds charges bonus", () => {
        const actor = {
            items: [
                { type: "weapon", system: { rarity: "uncommon", uses: { max: 10 } } }
            ]
        };
        // 3 (uncommon) + (10 * 0.3) = 6
        expect(SignatureLedger.computePowerScore(actor)).toBe(6);
    });

    it("adds flat attack bonus", () => {
        const actor = {
            items: [
                { type: "weapon", system: { rarity: "rare", attackBonus: "2" } }
            ]
        };
        // 8 (rare) + (2 * 2.0) = 12
        expect(SignatureLedger.computePowerScore(actor)).toBe(12);
    });

    it("combines all modifiers", () => {
        const actor = {
            items: [
                {
                    type: "weapon",
                    system: {
                        rarity: "rare",
                        attunement: true,
                        uses: { max: 5 },
                        attackBonus: "1"
                    }
                }
            ]
        };
        // (8 * 1.5) + (5 * 0.3) + (1 * 2.0) = 12 + 1.5 + 2 = 15.5
        expect(SignatureLedger.computePowerScore(actor)).toBe(15.5);
    });

    it("sums across multiple magic items", () => {
        const actor = {
            items: [
                { type: "weapon", system: { rarity: "uncommon" } },
                { type: "equipment", system: { rarity: "rare" } }
            ]
        };
        // 3 + 8 = 11
        expect(SignatureLedger.computePowerScore(actor)).toBe(11);
    });

    it("ignores non-weapon/equipment items", () => {
        const actor = {
            items: [
                { type: "consumable", system: { rarity: "uncommon" } },
                { type: "weapon", system: { rarity: "rare" } }
            ]
        };
        // Only the weapon counts: 8
        expect(SignatureLedger.computePowerScore(actor)).toBe(8);
    });

    it("rounds to one decimal place", () => {
        const actor = {
            items: [
                { type: "weapon", system: { rarity: "uncommon", uses: { max: 1 } } }
            ]
        };
        // 3 + 0.3 = 3.3
        expect(SignatureLedger.computePowerScore(actor)).toBe(3.3);
    });
});

// ── Image remap table ────────────────────────────────────────────────────

describe("SignatureLedger._CURSED_IMG_REMAP", () => {

    it("is undefined (remap table removed with cursewright split)", () => {
        expect(SignatureLedger._CURSED_IMG_REMAP).toBeUndefined();
    });
});
