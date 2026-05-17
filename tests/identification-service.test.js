import { describe, it, expect, vi, beforeEach } from "vitest";
import { ItemMaskingHelper } from "../scripts/services/ItemMaskingHelper.js";
import { IdentificationService } from "../scripts/services/IdentificationService.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock Foundry Item document.
 * Supports getFlag / setFlag / update / flags mirroring.
 */
function mockItem(overrides = {}) {
    const _flags = foundry.utils.deepClone(overrides.flags ?? {});
    const _system = foundry.utils.deepClone(overrides.system ?? {});
    const _updates = [];

    const item = {
        name:   overrides.name ?? "Test Item",
        type:   overrides.type ?? "weapon",
        img:    overrides.img  ?? "icons/svg/item-bag.svg",
        system: _system,
        flags:  _flags,
        parent: overrides.parent ?? { name: "Test Actor", flags: {} },

        getFlag(module, key) {
            return this.flags?.[module]?.[key] ?? null;
        },

        async setFlag(module, key, value) {
            this.flags[module] ??= {};
            this.flags[module][key] = value;
            return this;
        },

        async update(changes, _opts = {}) {
            _updates.push(foundry.utils.deepClone(changes));
            // Apply dot-notation changes to this.system / this.name / this.img
            for (const [dotKey, val] of Object.entries(changes)) {
                if (dotKey === "name")  { this.name  = val; continue; }
                if (dotKey === "img")   { this.img   = val; continue; }
                if (dotKey.startsWith("system.")) {
                    const sub = dotKey.slice("system.".length);
                    const parts = sub.split(".");
                    let obj = this.system;
                    for (let i = 0; i < parts.length - 1; i++) {
                        obj[parts[i]] ??= {};
                        obj = obj[parts[i]];
                    }
                    obj[parts[parts.length - 1]] = val;
                }
            }
            return this;
        },

        get _updates() { return _updates; }
    };

    return item;
}

/**
 * Canonical latentMagic block for a normal +1 Javelin.
 * This is exactly what applyMask / _stripToLatent writes for a weapon.
 */
const NORMAL_LATENT = {
    originalName:        "Javelin +1",
    originalRarity:      "uncommon",
    magicalBonus:        "1",
    properties:          ["mgc"],
    originalPrice:       { value: 100, denomination: "gp" },
    originalImg:         "icons/weapons/thrown/javelin.webp",
    originalDescription: "<p>A finely balanced javelin with a faint blue sheen.</p>"
};

/**
 * Canonical latentMagic block for a CurseForge Oathcleaver.
 * Structurally identical to NORMAL_LATENT — same field shape.
 */
const CURSED_LATENT = {
    originalName:        "Oathcleaver",
    originalRarity:      "uncommon",
    magicalBonus:        "1",
    attunement:          "required",
    properties:          ["mgc"],
    originalPrice:       { value: 500, denomination: "gp" },
    originalImg:         "icons/weapons/axes/axe-battle-black.webp",
    originalDescription: "<p>A battleaxe that seems to hum faintly in combat.</p>"
};

const CURSEFORGE_CURSED_META = {
    curseType: "compulsion",
    tier: 1,
    curse: {
        name: "The Bloodwake",
        description: "On melee hit, compelled to throw at nearest visible creature.",
        effects: []
    },
    latent: {
        trigger: "exposure",
        exposure: { weights: { combat: 3 }, phaseThresholds: [15, 35, 60] },
        escalation: []
    },
    removal: { removeCurseLevel: 3 }
};

// ── buildPromotionPatch ─────────────────────────────────────────────────────

describe("ItemMaskingHelper.buildPromotionPatch", () => {

    it("restores name from originalName", () => {
        const patch = ItemMaskingHelper.buildPromotionPatch({}, { originalName: "Flame Tongue" });
        expect(patch["name"]).toBe("Flame Tongue");
    });

    it("restores rarity from originalRarity", () => {
        const patch = ItemMaskingHelper.buildPromotionPatch(
            { rarity: "common" },
            { originalRarity: "rare" }
        );
        expect(patch["system.rarity"]).toBe("rare");
    });

    it("restores price from originalPrice", () => {
        const patch = ItemMaskingHelper.buildPromotionPatch(
            {},
            { originalPrice: { value: 500, denomination: "gp" } }
        );
        expect(patch["system.price"]).toEqual({ value: 500, denomination: "gp" });
    });

    it("restores magicalBonus from magicalBonus", () => {
        const patch = ItemMaskingHelper.buildPromotionPatch({}, { magicalBonus: "1" });
        expect(patch["system.magicalBonus"]).toBe("1");
    });

    it("restores img from originalImg", () => {
        const patch = ItemMaskingHelper.buildPromotionPatch(
            {},
            { originalImg: "icons/weapons/polearms/javelin.webp" }
        );
        expect(patch["img"]).toBe("icons/weapons/polearms/javelin.webp");
    });

    it("restores description from originalDescription", () => {
        const patch = ItemMaskingHelper.buildPromotionPatch(
            {},
            { originalDescription: "<p>Magical.</p>" }
        );
        expect(patch["system.description.value"]).toBe("<p>Magical.</p>");
    });

    it("merges mgc into existing properties array", () => {
        const patch = ItemMaskingHelper.buildPromotionPatch(
            { properties: ["fin", "thr"] },
            { properties: ["mgc"] }
        );
        expect(patch["system.properties"]).toEqual(expect.arrayContaining(["fin", "thr", "mgc"]));
    });

    it("omits fields not present in latent block (sparse patch)", () => {
        const patch = ItemMaskingHelper.buildPromotionPatch({}, { originalName: "Sword +1" });
        expect(patch["system.rarity"]).toBeUndefined();
        expect(patch["system.magicalBonus"]).toBeUndefined();
        expect(patch["img"]).toBeUndefined();
    });

    it("produces identical patch shape for normal vs CurseForge latent blocks", () => {
        const normalPatch = ItemMaskingHelper.buildPromotionPatch({}, NORMAL_LATENT);
        const cursedPatch = ItemMaskingHelper.buildPromotionPatch({}, CURSED_LATENT);

        // Both must restore name, rarity, price, magicalBonus, img, description
        const keys = ["name", "system.rarity", "system.price", "system.magicalBonus", "img", "system.description.value"];
        for (const key of keys) {
            expect(normalPatch[key], `key "${key}" must exist in normal patch`).toBeDefined();
            expect(cursedPatch[key], `key "${key}" must exist in cursed patch`).toBeDefined();
        }
    });
});

// ── buildPromotionPatch — originalName integrity ─────────────────────────────

describe("buildPromotionPatch — originalName string integrity", () => {

    it("round-trips a clean name unchanged", () => {
        const patch = ItemMaskingHelper.buildPromotionPatch({}, { originalName: "Pouch of Dust" });
        expect(patch["name"]).toBe("Pouch of Dust");
    });

    it("round-trips a name with internal spaces unchanged", () => {
        const patch = ItemMaskingHelper.buildPromotionPatch({}, { originalName: "Dust of Sneezing and Choking" });
        expect(patch["name"]).toBe("Dust of Sneezing and Choking");
    });

    it("does not truncate or corrupt a 16-character name", () => {
        const name = "Oathcleaver Axe";  // 15 chars — within normal range
        const patch = ItemMaskingHelper.buildPromotionPatch({}, { originalName: name });
        expect(patch["name"]).toBe(name);
        expect(patch["name"].length).toBe(name.length);
    });

    it("restored name is never shorter than 4 characters for valid items", () => {
        const patch = ItemMaskingHelper.buildPromotionPatch({}, { originalName: "Ring" });
        expect(patch["name"].length).toBeGreaterThanOrEqual(4);
    });
});

// ── IdentificationService.identify — decision logic ─────────────────────────

describe("IdentificationService.identify — hasPendingPayload detection", () => {

    it("detects unpromoted latentMagic as pending (normal item)", async () => {
        const item = mockItem({
            name: "Javelin",
            system: { identified: true, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    latentMagic: { ...NORMAL_LATENT }
                }
            }
        });

        const result = await IdentificationService.identify(item);
        expect(result.identified).toBe(true);
        expect(result.kind).toBe("latent-magic");
    });

    it("detects unpromoted latentMagic + forgedFrom as CurseForge pending (cursed item)", async () => {
        const item = mockItem({
            name: "Greataxe",
            system: { identified: false, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom: "Compendium.dnd5e.items.Item.abc123",
                    latentMagic: { ...CURSED_LATENT },
                    cursedMeta: { ...CURSEFORGE_CURSED_META }
                }
            }
        });

        const result = await IdentificationService.identify(item);
        expect(result.identified).toBe(true);
        expect(result.kind).toBe("cursed-lure");
    });

    it("returns already-identified when latentMagic.promoted = true", async () => {
        const item = mockItem({
            name: "Javelin +1",
            system: { identified: true },
            flags: {
                "ionrift-quartermaster": {
                    latentMagic: { ...NORMAL_LATENT, promoted: true }
                }
            }
        });

        const result = await IdentificationService.identify(item);
        expect(result.identified).toBe(false);
        expect(result.reason).toBe("already-identified");
    });

    it("returns already-identified when no flags present (mundane item)", async () => {
        const item = mockItem({
            name: "Club",
            system: { identified: true },
            flags: {}
        });

        const result = await IdentificationService.identify(item);
        expect(result.identified).toBe(false);
        expect(result.reason).toBe("already-identified");
    });

    it("returns not-gm when caller is not GM", async () => {
        game.user.isGM = false;
        const item = mockItem({
            flags: { "ionrift-quartermaster": { latentMagic: { ...NORMAL_LATENT } } }
        });

        const result = await IdentificationService.identify(item);
        expect(result.identified).toBe(false);
        expect(result.reason).toBe("not-gm");
        game.user.isGM = true; // restore
    });
});

// ── IdentificationService.identify — normal item promotion ───────────────────

describe("IdentificationService.identify — normal item (latent-magic) promotion", () => {

    it("restores name to originalName", async () => {
        const item = mockItem({
            name: "Javelin",
            system: { identified: true, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    latentMagic: { ...NORMAL_LATENT }
                }
            }
        });

        await IdentificationService.identify(item, { silent: true });
        expect(item.name).toBe("Javelin +1");
    });

    it("restores rarity to originalRarity", async () => {
        const item = mockItem({
            name: "Javelin",
            system: { identified: true, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    latentMagic: { ...NORMAL_LATENT }
                }
            }
        });

        await IdentificationService.identify(item, { silent: true });
        expect(item.system.rarity).toBe("uncommon");
    });

    it("restores price to originalPrice", async () => {
        const item = mockItem({
            name: "Javelin",
            system: { identified: true, rarity: "common", price: { value: 5, denomination: "gp" } },
            flags: {
                "ionrift-quartermaster": {
                    latentMagic: { ...NORMAL_LATENT }
                }
            }
        });

        await IdentificationService.identify(item, { silent: true });
        expect(item.system.price).toEqual({ value: 100, denomination: "gp" });
    });

    it("marks latentMagic.promoted = true after identification", async () => {
        const item = mockItem({
            name: "Javelin",
            system: { identified: true, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    latentMagic: { ...NORMAL_LATENT }
                }
            }
        });

        await IdentificationService.identify(item, { silent: true });
        expect(item.flags["ionrift-quartermaster"].latentMagic.promoted).toBe(true);
    });

    it("fires the itemIdentified hook", async () => {
        const hookSpy = vi.fn();
        Hooks.on("ionrift-quartermaster.itemIdentified", hookSpy);

        const item = mockItem({
            name: "Javelin",
            system: { identified: true, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    latentMagic: { ...NORMAL_LATENT }
                }
            }
        });

        await IdentificationService.identify(item, { silent: true });
        expect(hookSpy).toHaveBeenCalledOnce();
        Hooks.off("ionrift-quartermaster.itemIdentified", hookSpy);
    });
});

// ── IdentificationService.identify — CurseForge item promotion ──────────────

describe("IdentificationService.identify — CurseForge item (cursed-lure) promotion", () => {

    it("restores name from latentMagic.originalName (not from cursedMeta)", async () => {
        const item = mockItem({
            name: "Greataxe",
            system: { identified: false, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom: "Compendium.dnd5e.items.Item.abc",
                    latentMagic: { ...CURSED_LATENT },
                    cursedMeta:  { ...CURSEFORGE_CURSED_META }
                }
            }
        });

        await IdentificationService.identify(item, { silent: true });
        expect(item.name).toBe("Oathcleaver");
    });

    it("sets system.identified = true after identification", async () => {
        const item = mockItem({
            name: "Greataxe",
            system: { identified: false, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom: "Compendium.dnd5e.items.Item.abc",
                    latentMagic: { ...CURSED_LATENT },
                    cursedMeta:  { ...CURSEFORGE_CURSED_META }
                }
            }
        });

        await IdentificationService.identify(item, { silent: true });
        expect(item.system.identified).toBe(true);
    });

    it("preserves cursedMeta after identification (curse arc not stripped)", async () => {
        const item = mockItem({
            name: "Greataxe",
            system: { identified: false, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom: "Compendium.dnd5e.items.Item.abc",
                    latentMagic: { ...CURSED_LATENT },
                    cursedMeta:  { ...CURSEFORGE_CURSED_META }
                }
            }
        });

        await IdentificationService.identify(item, { silent: true });
        // cursedMeta must survive — the curse arc is NOT part of identification
        expect(item.flags["ionrift-quartermaster"].cursedMeta).toBeDefined();
        expect(item.flags["ionrift-quartermaster"].cursedMeta.tier).toBe(1);
        expect(item.flags["ionrift-quartermaster"].cursedMeta.curse.name).toBe("The Bloodwake");
    });

    it("marks latentMagic.promoted = true after identification", async () => {
        const item = mockItem({
            name: "Greataxe",
            system: { identified: false, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom: "Compendium.dnd5e.items.Item.abc",
                    latentMagic: { ...CURSED_LATENT },
                    cursedMeta:  { ...CURSEFORGE_CURSED_META }
                }
            }
        });

        await IdentificationService.identify(item, { silent: true });
        expect(item.flags["ionrift-quartermaster"].latentMagic.promoted).toBe(true);
    });

    it("restores rarity from latentMagic.originalRarity", async () => {
        const item = mockItem({
            name: "Greataxe",
            system: { identified: false, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom: "Compendium.dnd5e.items.Item.abc",
                    latentMagic: { ...CURSED_LATENT },
                    cursedMeta:  { ...CURSEFORGE_CURSED_META }
                }
            }
        });

        await IdentificationService.identify(item, { silent: true });
        expect(item.system.rarity).toBe("uncommon");
    });
});

// ── Parity: normal item vs CurseForge item ───────────────────────────────────

describe("IdentificationService — parity: normal magical item vs CurseForge lure", () => {

    /**
     * This is the headline test for the design contract from CURSE_ENGINE_DESIGN.md §3a:
     * "Non-cursed magic items follow the same shape… uses the same strip-and-promote
     *  rhythm… the same IdentificationService promotes them back."
     *
     * A normal +1 Javelin and a CurseForge Oathcleaver must produce the same
     * identification OUTCOMES (name restored, rarity restored, price restored,
     * latentMagic.promoted=true) — even though they differ in kind.
     */

    it("both items have their name restored from latentMagic.originalName", async () => {
        const normalItem = mockItem({
            name: "Javelin",
            system: { identified: true, rarity: "common" },
            flags: { "ionrift-quartermaster": { latentMagic: { ...NORMAL_LATENT } } }
        });

        const cursedItem = mockItem({
            name: "Greataxe",
            system: { identified: false, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom:  "Compendium.dnd5e.items.Item.abc",
                    latentMagic: { ...CURSED_LATENT },
                    cursedMeta:  { ...CURSEFORGE_CURSED_META }
                }
            }
        });

        await IdentificationService.identify(normalItem, { silent: true });
        await IdentificationService.identify(cursedItem, { silent: true });

        expect(normalItem.name).toBe("Javelin +1");
        expect(cursedItem.name).toBe("Oathcleaver");
    });

    it("both items have system.identified = true after identification", async () => {
        const normalItem = mockItem({
            name: "Javelin",
            system: { identified: true, rarity: "common" },
            flags: { "ionrift-quartermaster": { latentMagic: { ...NORMAL_LATENT } } }
        });

        const cursedItem = mockItem({
            name: "Greataxe",
            system: { identified: false, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom:  "Compendium.dnd5e.items.Item.abc",
                    latentMagic: { ...CURSED_LATENT },
                    cursedMeta:  { ...CURSEFORGE_CURSED_META }
                }
            }
        });

        await IdentificationService.identify(normalItem, { silent: true });
        await IdentificationService.identify(cursedItem, { silent: true });

        expect(normalItem.system.identified).toBe(true);
        expect(cursedItem.system.identified).toBe(true);
    });

    it("both items have latentMagic.promoted = true after identification", async () => {
        const normalItem = mockItem({
            name: "Javelin",
            system: { identified: true, rarity: "common" },
            flags: { "ionrift-quartermaster": { latentMagic: { ...NORMAL_LATENT } } }
        });

        const cursedItem = mockItem({
            name: "Greataxe",
            system: { identified: false, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom:  "Compendium.dnd5e.items.Item.abc",
                    latentMagic: { ...CURSED_LATENT },
                    cursedMeta:  { ...CURSEFORGE_CURSED_META }
                }
            }
        });

        await IdentificationService.identify(normalItem, { silent: true });
        await IdentificationService.identify(cursedItem, { silent: true });

        expect(normalItem.flags["ionrift-quartermaster"].latentMagic.promoted).toBe(true);
        expect(cursedItem.flags["ionrift-quartermaster"].latentMagic.promoted).toBe(true);
    });

    it("both items have rarity restored from latentMagic.originalRarity", async () => {
        const normalItem = mockItem({
            name: "Javelin",
            system: { identified: true, rarity: "common" },
            flags: { "ionrift-quartermaster": { latentMagic: { ...NORMAL_LATENT } } }
        });

        const cursedItem = mockItem({
            name: "Greataxe",
            system: { identified: false, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom:  "Compendium.dnd5e.items.Item.abc",
                    latentMagic: { ...CURSED_LATENT },
                    cursedMeta:  { ...CURSEFORGE_CURSED_META }
                }
            }
        });

        await IdentificationService.identify(normalItem, { silent: true });
        await IdentificationService.identify(cursedItem, { silent: true });

        expect(normalItem.system.rarity).toBe("uncommon");
        expect(cursedItem.system.rarity).toBe("uncommon");
    });

    it("kinds differ (latent-magic vs cursed-lure) but both return identified:true", async () => {
        const normalItem = mockItem({
            name: "Javelin",
            system: { identified: true, rarity: "common" },
            flags: { "ionrift-quartermaster": { latentMagic: { ...NORMAL_LATENT } } }
        });

        const cursedItem = mockItem({
            name: "Greataxe",
            system: { identified: false, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom:  "Compendium.dnd5e.items.Item.abc",
                    latentMagic: { ...CURSED_LATENT },
                    cursedMeta:  { ...CURSEFORGE_CURSED_META }
                }
            }
        });

        const normalResult = await IdentificationService.identify(normalItem, { silent: true });
        const cursedResult = await IdentificationService.identify(cursedItem, { silent: true });

        expect(normalResult.identified).toBe(true);
        expect(cursedResult.identified).toBe(true);
        expect(normalResult.kind).toBe("latent-magic");
        expect(cursedResult.kind).toBe("cursed-lure");
    });
});

// ── Consumable: originalName integrity (Pouch of Dust regression test) ───────

describe("IdentificationService.identify — consumable originalName integrity", () => {

    it("restores full originalName for Pouch of Dust (regression: was truncated to 'puch f dust')", async () => {
        const item = mockItem({
            name: "Leather Pouch",
            type: "consumable",
            system: { identified: false, rarity: "common" },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom: "Compendium.dnd5e.items.Item.dust001",
                    latentMagic: {
                        originalName:        "Pouch of Dust",
                        originalRarity:      "uncommon",
                        originalDescription: "<p>A small leather pouch filled with fine grey powder.</p>",
                        originalImg:         "icons/containers/bags/pouch-leather-tan.webp",
                        originalPrice:       { value: 120, denomination: "gp" }
                    },
                    cursedMeta: {
                        curseType: "deceptive",
                        tier: 1,
                        curse: { name: "Dust of Sneezing and Choking", description: ".", effects: [] },
                        latent: { trigger: "uses", threshold: 1, escalation: [] },
                        removal: { removeCurseLevel: 3 }
                    }
                }
            }
        });

        await IdentificationService.identify(item, { silent: true });

        // Regression guard: the full 13-character name must survive intact
        expect(item.name).toBe("Pouch of Dust");
        expect(item.name.length).toBe(13);
        expect(item.name).not.toMatch(/^puch/); // catch the truncation pattern
    });

    it("Pouch of Dust: system.identified is true after identification", async () => {
        const item = mockItem({
            name: "Leather Pouch",
            type: "consumable",
            system: { identified: false },
            flags: {
                "ionrift-quartermaster": {
                    forgedFrom: "Compendium.dnd5e.items.Item.dust001",
                    latentMagic: {
                        originalName:  "Pouch of Dust",
                        originalRarity: "uncommon",
                        originalPrice:  { value: 120, denomination: "gp" }
                    },
                    cursedMeta: {
                        curseType: "deceptive", tier: 1,
                        curse: { name: "Dust of Sneezing and Choking", effects: [] },
                        latent: { trigger: "uses", threshold: 1, escalation: [] },
                        removal: { removeCurseLevel: 3 }
                    }
                }
            }
        });

        await IdentificationService.identify(item, { silent: true });
        expect(item.system.identified).toBe(true);
    });
});
