import { describe, it, expect } from "vitest";
import { StandalonePoolRegistry } from "../scripts/services/StandalonePoolRegistry.js";

// ── _indexDocId ──────────────────────────────────────────────────────────────

describe("StandalonePoolRegistry._indexDocId", () => {

    it("returns _id when present", () => {
        expect(StandalonePoolRegistry._indexDocId({ _id: "abc123" })).toBe("abc123");
    });

    it("returns id when _id absent", () => {
        expect(StandalonePoolRegistry._indexDocId({ id: "xyz789" })).toBe("xyz789");
    });

    it("prefers _id over id", () => {
        expect(StandalonePoolRegistry._indexDocId({ _id: "pref", id: "other" })).toBe("pref");
    });

    it("returns empty string for null", () => {
        expect(StandalonePoolRegistry._indexDocId(null)).toBe("");
    });

    it("returns empty string for undefined", () => {
        expect(StandalonePoolRegistry._indexDocId(undefined)).toBe("");
    });

    it("returns empty string for entry with no id fields", () => {
        expect(StandalonePoolRegistry._indexDocId({ name: "no id here" })).toBe("");
    });
});

// ── _mapDocRow ─────────────────────────────────────────────────────────────

describe("StandalonePoolRegistry._mapDocRow", () => {
    const PACK_ID = "world.ionrift-srd-cursed";

    function makeEntry(overrides = {}) {
        return {
            _id: "item001",
            name: "Berserker Axe",
            img: "icons/weapons/axes/axe-battle-black.webp",
            flags: {
                "ionrift-quartermaster": {
                    cursedMeta: {
                        tier: 1,
                        curseType: "compulsion",
                        decoyAppearance: "",
                        trueNature: ""
                    }
                }
            },
            ...overrides
        };
    }

    it("returns null for entry with no _id or id", () => {
        const row = StandalonePoolRegistry._mapDocRow({ name: "Bad", flags: {} }, PACK_ID);
        expect(row).toBeNull();
    });

    it("returns null for entry without cursedMeta flag", () => {
        const entry = makeEntry({ flags: { "ionrift-quartermaster": {} } });
        expect(StandalonePoolRegistry._mapDocRow(entry, PACK_ID)).toBeNull();
    });

    it("returns null when cursedMeta is not an object", () => {
        const entry = makeEntry({
            flags: { "ionrift-quartermaster": { cursedMeta: "wrong" } }
        });
        expect(StandalonePoolRegistry._mapDocRow(entry, PACK_ID)).toBeNull();
    });

    it("maps a valid entry to a pool row with correct fields", () => {
        const row = StandalonePoolRegistry._mapDocRow(makeEntry(), PACK_ID);
        expect(row).not.toBeNull();
        expect(row.uuid).toBe(`Compendium.${PACK_ID}.Item.item001`);
        expect(row.name).toBe("Berserker Axe");
        expect(row.curseType).toBe("compulsion");
        expect(row.tier).toBe(1);
    });

    it("uses fallback img when entry.img is absent", () => {
        const entry = makeEntry({ img: undefined });
        const row = StandalonePoolRegistry._mapDocRow(entry, PACK_ID);
        expect(row.img).toBe("icons/svg/item-bag.svg");
    });

    it("defaults tier to 1 when meta.tier is absent", () => {
        const entry = makeEntry();
        entry.flags["ionrift-quartermaster"].cursedMeta = { curseType: "binding" };
        const row = StandalonePoolRegistry._mapDocRow(entry, PACK_ID);
        expect(row.tier).toBe(1);
    });
});
