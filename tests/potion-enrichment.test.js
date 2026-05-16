import { describe, it, expect } from "vitest";
import { PotionEnrichment } from "../scripts/services/PotionEnrichment.js";

// ── getTierData ──────────────────────────────────────────────────────────

describe("PotionEnrichment.getTierData", () => {

    it("returns base tier for 'Potion of Healing'", () => {
        const t = PotionEnrichment.getTierData("Potion of Healing");
        expect(t.formula).toBe("2d4 + 2");
        expect(t.weight).toBe(0.5);
        expect(t.price).toBe(50);
        expect(t.rarity).toBe("common");
    });

    it("returns greater tier", () => {
        const t = PotionEnrichment.getTierData("Potion of Greater Healing");
        expect(t.formula).toBe("4d4 + 4");
        expect(t.price).toBe(100);
        expect(t.rarity).toBe("uncommon");
    });

    it("returns superior tier", () => {
        const t = PotionEnrichment.getTierData("Potion of Superior Healing");
        expect(t.formula).toBe("8d4 + 8");
        expect(t.price).toBe(250);
        expect(t.rarity).toBe("rare");
    });

    it("returns supreme tier", () => {
        const t = PotionEnrichment.getTierData("Potion of Supreme Healing");
        expect(t.formula).toBe("10d4 + 20");
        expect(t.price).toBe(500);
        expect(t.rarity).toBe("legendary");
    });

    it("returns null for non-potion", () => {
        expect(PotionEnrichment.getTierData("Longsword")).toBeNull();
    });

    it("returns null for empty string", () => {
        expect(PotionEnrichment.getTierData("")).toBeNull();
    });

    it("is case insensitive", () => {
        expect(PotionEnrichment.getTierData("POTION OF HEALING")).not.toBeNull();
        expect(PotionEnrichment.getTierData("potion of greater healing").formula).toBe("4d4 + 4");
    });
});

// ── correctWeight ────────────────────────────────────────────────────────

describe("PotionEnrichment.correctWeight", () => {

    it("patches object { value, units } format", () => {
        const itemData = { system: { weight: { value: 0, units: "lb" } } };
        PotionEnrichment.correctWeight(itemData, 0.5);
        expect(itemData.system.weight).toEqual({ value: 0.5, units: "lb" });
    });

    it("replaces legacy number format with object", () => {
        const itemData = { system: { weight: 0 } };
        PotionEnrichment.correctWeight(itemData, 0.5);
        expect(itemData.system.weight).toEqual({ value: 0.5, units: "lb" });
    });

    it("creates weight object when absent", () => {
        const itemData = { system: {} };
        PotionEnrichment.correctWeight(itemData, 0.5);
        expect(itemData.system.weight).toEqual({ value: 0.5, units: "lb" });
    });
});

// ── injectHealActivity ───────────────────────────────────────────────────

describe("PotionEnrichment.injectHealActivity", () => {

    it("injects activity matching SRD Consume spec", () => {
        const itemData = { system: {} };
        PotionEnrichment.injectHealActivity(itemData, "2d4 + 2");

        const activities = Object.values(itemData.system.activities);
        expect(activities).toHaveLength(1);

        const act = activities[0];
        expect(act.name).toBe("Consume");
        expect(act.identifier).toBe("consume");
        expect(act.type).toBe("heal");
        expect(act.activation.type).toBe("bonus");
        expect(act.range.units).toBe("self");
        expect(act.target.affects.type).toBe("self");
        expect(act.healing.custom.formula).toBe("2d4 + 2");
    });

    it("_buildHealActivityData produces the same shape", () => {
        const act = PotionEnrichment._buildHealActivityData("4d4 + 4");
        expect(act.name).toBe("Consume");
        expect(act.identifier).toBe("consume");
        expect(act.type).toBe("heal");
        expect(act.activation.type).toBe("bonus");
        expect(act.range.units).toBe("self");
        expect(act.target.affects.type).toBe("self");
        expect(act.healing.custom.formula).toBe("4d4 + 4");
        expect(act._id).toBeTruthy();
    });
});
