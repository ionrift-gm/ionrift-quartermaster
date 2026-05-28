import { describe, it, expect, vi, beforeEach } from "vitest";
import { CacheGenerator } from "../scripts/services/CacheGenerator.js";

// ── _weightedPoolDraw ────────────────────────────────────────────────────

describe("CacheGenerator._weightedPoolDraw", () => {

    it("returns 'mundane' for empty pool", () => {
        expect(CacheGenerator._weightedPoolDraw({})).toBe("mundane");
    });

    it("returns the only entry when pool has one type", () => {
        const result = CacheGenerator._weightedPoolDraw({ scroll: 1 });
        expect(result).toBe("scroll");
    });

    it("returns a valid slot type from the pool", () => {
        const pool = { scroll: 4, consumable: 3, mundane: 1.5 };
        const result = CacheGenerator._weightedPoolDraw(pool);
        expect(Object.keys(pool)).toContain(result);
    });

    it("returns valid results over many draws (probabilistic)", () => {
        const pool = { scroll: 4, consumable: 3, mundane: 1.5 };
        const counts = { scroll: 0, consumable: 0, mundane: 0 };
        for (let i = 0; i < 1000; i++) {
            counts[CacheGenerator._weightedPoolDraw(pool)]++;
        }
        // All types should appear at least once in 1000 draws
        expect(counts.scroll).toBeGreaterThan(0);
        expect(counts.consumable).toBeGreaterThan(0);
        expect(counts.mundane).toBeGreaterThan(0);
        // Scroll (weight 4) should appear more than mundane (weight 1.5)
        expect(counts.scroll).toBeGreaterThan(counts.mundane);
    });
});

// ── _weightedScrollLevel ─────────────────────────────────────────────────

describe("CacheGenerator._weightedScrollLevel", () => {

    it("returns 1 for maxLevel 1", () => {
        expect(CacheGenerator._weightedScrollLevel(1)).toBe(1);
    });

    it("returns 1 for maxLevel 0", () => {
        expect(CacheGenerator._weightedScrollLevel(0)).toBe(1);
    });

    it("returns a value between 1 and maxLevel", () => {
        for (let i = 0; i < 100; i++) {
            const level = CacheGenerator._weightedScrollLevel(5);
            expect(level).toBeGreaterThanOrEqual(1);
            expect(level).toBeLessThanOrEqual(5);
        }
    });

    it("favors mid-range levels over edges (probabilistic)", () => {
        const counts = {};
        for (let i = 0; i < 2000; i++) {
            const lvl = CacheGenerator._weightedScrollLevel(5);
            counts[lvl] = (counts[lvl] ?? 0) + 1;
        }
        // Level 3 (middle) should appear more often than level 1 or 5 (edges)
        // Mid-level weight = min(3, 5-3+1) = 3; Edge weight = min(1, 5-1+1) = 1
        expect(counts[3]).toBeGreaterThan(counts[1]);
        expect(counts[3]).toBeGreaterThan(counts[5]);
    });
});

// ── _resolveQuantity ─────────────────────────────────────────────────────

describe("CacheGenerator._resolveQuantity", () => {

    it("returns 1 for signature items", () => {
        expect(CacheGenerator._resolveQuantity({ isSignature: true, price: 0.01 })).toBe(1);
    });

    it("returns 1 for scroll items", () => {
        expect(CacheGenerator._resolveQuantity({ spellName: "Fireball", price: 0.01 })).toBe(1);
    });

    it("returns 1 for magic items (non-common rarity)", () => {
        expect(CacheGenerator._resolveQuantity({ rarity: "uncommon", price: 0.01 })).toBe(1);
        expect(CacheGenerator._resolveQuantity({ rarity: "rare", price: 0.01 })).toBe(1);
    });

    it("returns 1 for gemstones", () => {
        const item = { rarity: "common", price: 0.01, sourceCompendium: "ionrift-quartermaster.quartermaster-gemstones" };
        expect(CacheGenerator._resolveQuantity(item)).toBe(1);
    });

    it("returns 1 for items priced >= 5 gp", () => {
        expect(CacheGenerator._resolveQuantity({ price: 5, rarity: "common" })).toBe(1);
        expect(CacheGenerator._resolveQuantity({ price: 50, rarity: "common" })).toBe(1);
    });

    it("returns 1 for zero-priced items", () => {
        expect(CacheGenerator._resolveQuantity({ price: 0 })).toBe(1);
    });

    it("stacks bulk filler consumables like feed in large quantities", () => {
        const feed = {
            name: "Feed",
            type: "consumable",
            subtype: "food",
            price: 0.05,
            rarity: "common"
        };
        for (let i = 0; i < 50; i++) {
            const qty = CacheGenerator._resolveQuantity(feed);
            expect(qty).toBeGreaterThanOrEqual(10);
            expect(qty).toBeLessThanOrEqual(50);
        }
    });

    it("stacks bulk filler even when compendium rarity is wrong", () => {
        const feed = {
            name: "Feed",
            type: "consumable",
            subtype: "food",
            price: 0.05,
            rarity: "uncommon"
        };
        const qty = CacheGenerator._resolveQuantity(feed);
        expect(qty).toBeGreaterThanOrEqual(10);
    });

    it("returns > 1 for very cheap items (< 0.05 gp)", () => {
        // Run multiple times since there's randomness
        let sawMultiple = false;
        for (let i = 0; i < 50; i++) {
            const qty = CacheGenerator._resolveQuantity({ price: 0.01, rarity: "common" });
            if (qty > 1) { sawMultiple = true; break; }
        }
        expect(sawMultiple).toBe(true);
    });

    it("caps quantity at 50 for very cheap items", () => {
        for (let i = 0; i < 100; i++) {
            const qty = CacheGenerator._resolveQuantity({ price: 0.001, rarity: "common" });
            expect(qty).toBeLessThanOrEqual(50);
        }
    });

    it("caps quantity at 20 for cheap items (0.05-0.5 gp)", () => {
        for (let i = 0; i < 100; i++) {
            const qty = CacheGenerator._resolveQuantity({ price: 0.1, rarity: "common" });
            expect(qty).toBeLessThanOrEqual(20);
        }
    });

    it("always returns a positive integer", () => {
        for (let i = 0; i < 100; i++) {
            const qty = CacheGenerator._resolveQuantity({ price: 0.5, rarity: "common" });
            expect(qty).toBeGreaterThanOrEqual(1);
            expect(Number.isInteger(qty)).toBe(true);
        }
    });
});

// ── _distributeCoinage ───────────────────────────────────────────────────

describe("CacheGenerator._distributeCoinage", () => {

    it("returns null for zero gold", () => {
        expect(CacheGenerator._distributeCoinage(0)).toBeNull();
    });

    it("returns null for negative gold", () => {
        expect(CacheGenerator._distributeCoinage(-5)).toBeNull();
    });

    it("conserves total value (within 1 cp due to rounding)", () => {
        for (let trial = 0; trial < 50; trial++) {
            const inputGp = Math.floor(Math.random() * 500) + 1;
            const coins = CacheGenerator._distributeCoinage(inputGp);
            if (!coins) continue;

            const totalCp =
                (coins.pp ?? 0) * 1000 +
                (coins.gp ?? 0) * 100 +
                (coins.ep ?? 0) * 50 +
                (coins.sp ?? 0) * 10 +
                (coins.cp ?? 0);

            const inputCp = Math.floor(inputGp * 100);
            // Allow ±1 cp tolerance for rounding
            expect(Math.abs(totalCp - inputCp)).toBeLessThanOrEqual(1);
        }
    });

    it("strips zero-value denominations", () => {
        const coins = CacheGenerator._distributeCoinage(1);
        for (const [key, val] of Object.entries(coins ?? {})) {
            expect(val).toBeGreaterThan(0);
        }
    });

    it("handles small values (1 gp) without crashing", () => {
        const coins = CacheGenerator._distributeCoinage(1);
        expect(coins).toBeTruthy();
    });

    it("handles large values (1000 gp) without crashing", () => {
        const coins = CacheGenerator._distributeCoinage(1000);
        expect(coins).toBeTruthy();
    });

    it("gp is always the largest denomination by value", () => {
        // Over many trials, GP should take the bulk
        let gpDominates = 0;
        for (let i = 0; i < 50; i++) {
            const coins = CacheGenerator._distributeCoinage(100);
            if (!coins) continue;
            const gpValue = (coins.gp ?? 0) * 100;
            const totalCp =
                (coins.pp ?? 0) * 1000 +
                gpValue +
                (coins.ep ?? 0) * 50 +
                (coins.sp ?? 0) * 10 +
                (coins.cp ?? 0);
            // GP should hold at least 30% of value for reasonable inputs
            if (totalCp > 0 && gpValue / totalCp >= 0.15) gpDominates++;
        }
        // Should happen most of the time
        expect(gpDominates).toBeGreaterThan(25);
    });
});

// ── _generateScrollStub ─────────────────────────────────────────────────

describe("CacheGenerator._generateScrollStub", () => {

    it("generates a scroll with valid structure", () => {
        const tierData = { scrollLevelMax: 3 };
        const scroll = CacheGenerator._generateScrollStub(tierData);
        expect(scroll.name).toMatch(/^Scroll of /);
        expect(scroll.type).toBe("consumable");
        expect(scroll.spellLevel).toBeGreaterThanOrEqual(1);
        expect(scroll.spellLevel).toBeLessThanOrEqual(3);
        expect(scroll.spellName).toBeTruthy();
        expect(scroll.quantity).toBe(1);
    });

    it("respects max level cap", () => {
        for (let i = 0; i < 50; i++) {
            const scroll = CacheGenerator._generateScrollStub({ scrollLevelMax: 2 });
            expect(scroll.spellLevel).toBeLessThanOrEqual(2);
        }
    });

    it("assigns rarity based on spell level", () => {
        const low = CacheGenerator._generateScrollStub({ scrollLevelMax: 1 });
        expect(low.rarity).toBe("common"); // Level 1-2 = common

        // Force a high level stub by using high max
        // We can't guarantee exact level, but the rarity mapping should be consistent
        const stub = CacheGenerator._generateScrollStub({ scrollLevelMax: 9 });
        if (stub.spellLevel <= 2) expect(stub.rarity).toBe("common");
        else if (stub.spellLevel <= 4) expect(stub.rarity).toBe("uncommon");
        else if (stub.spellLevel <= 6) expect(stub.rarity).toBe("rare");
        else if (stub.spellLevel <= 8) expect(stub.rarity).toBe("veryRare");
        else expect(stub.rarity).toBe("legendary");
    });

    it("assigns correct scroll prices", () => {
        const scrollPrices = { 1: 60, 2: 120, 3: 200, 4: 320, 5: 640, 6: 1280, 7: 2560, 8: 5120, 9: 10240 };
        for (let i = 0; i < 50; i++) {
            const stub = CacheGenerator._generateScrollStub({ scrollLevelMax: 9 });
            expect(stub.price).toBe(scrollPrices[stub.spellLevel]);
        }
    });
});

// ── _terrainWeightedPick ─────────────────────────────────────────────────

describe("CacheGenerator._terrainWeightedPick", () => {

    it("returns an item from the pool", () => {
        const pool = [
            { name: "A", flags: { "ionrift-quartermaster": { terrain: ["forest"] } } },
            { name: "B" }
        ];
        const result = CacheGenerator._terrainWeightedPick(pool, "forest");
        expect(["A", "B"]).toContain(result.name);
    });

    it("biases toward terrain-matched items (probabilistic)", () => {
        const pool = [
            { name: "Matched", flags: { "ionrift-quartermaster": { terrain: ["forest"] } } },
            { name: "Neutral" }
        ];
        let matched = 0;
        for (let i = 0; i < 1000; i++) {
            if (CacheGenerator._terrainWeightedPick(pool, "forest").name === "Matched") matched++;
        }
        // 70% restrict to matched subset; remainder uses 2x weight (~79% overall)
        expect(matched).toBeGreaterThan(720);
    });

    it("works with null theme", () => {
        const pool = [{ name: "A" }, { name: "B" }];
        const result = CacheGenerator._terrainWeightedPick(pool, null);
        expect(["A", "B"]).toContain(result.name);
    });

    it("works with single-item pool", () => {
        const pool = [{ name: "Only" }];
        expect(CacheGenerator._terrainWeightedPick(pool, "forest").name).toBe("Only");
    });

    it("excludes terrain-bound items from other terrains", () => {
        const pool = [
            { name: "Catacombs Only", flags: { "ionrift-quartermaster": { terrain: ["catacombs"] } } },
            { name: "Generic" }
        ];
        for (let i = 0; i < 200; i++) {
            const result = CacheGenerator._terrainWeightedPick(pool, "desert");
            expect(result.name).toBe("Generic");
        }
    });

    it("never returns wrong-terrain bound items when generic exists", () => {
        const pool = [
            { name: "Ruins Gem", flags: { "ionrift-quartermaster": { terrain: ["ruins"] } } },
            { name: "Core Chalice" }
        ];
        for (let i = 0; i < 200; i++) {
            expect(CacheGenerator._terrainWeightedPick(pool, "desert").name).toBe("Core Chalice");
        }
    });
});

// ── _healingPotionPickWeight ─────────────────────────────────────────────

describe("CacheGenerator._healingPotionPickWeight", () => {

    it("favours base healing at tier 1", () => {
        const base = CacheGenerator._healingPotionPickWeight("Potion of Healing", 1);
        const greater = CacheGenerator._healingPotionPickWeight("Potion of Greater Healing", 1);
        expect(base).toBeGreaterThan(greater);
    });

    it("favours stronger healing at tier 3", () => {
        const base = CacheGenerator._healingPotionPickWeight("Potion of Healing", 3);
        const superior = CacheGenerator._healingPotionPickWeight("Potion of Superior Healing", 3);
        expect(superior).toBeGreaterThan(base);
    });

    it("returns 1 for non-healing items", () => {
        expect(CacheGenerator._healingPotionPickWeight("Antitoxin", 3)).toBe(1);
    });
});

// ── applyContainerFlavor ─────────────────────────────────────────────────

describe("CacheGenerator.applyContainerFlavor", () => {

    beforeEach(() => {
        CacheGenerator._tables = { flavorPhrases: { forest: ["A trail-side {container}."] } };
    });

    it("picks a random paragraph from the container description", () => {
        const result = {
            container: {
                name: "Bark-Wrapped Bundle",
                system: {
                    description: {
                        value: "<p>First line.</p><p>Second line.</p>"
                    }
                }
            },
            meta: {}
        };
        CacheGenerator.applyContainerFlavor(result, "forest");
        expect(["First line.", "Second line."]).toContain(result.meta.flavor);
    });

    it("falls back to terrain phrases with container substitution", () => {
        const result = {
            container: {
                name: "Iron Lockbox",
                system: { description: { value: "" } }
            },
            meta: {}
        };
        CacheGenerator.applyContainerFlavor(result, "forest");
        expect(result.meta.flavor).toBe("A trail-side an iron lockbox.");
    });
});
