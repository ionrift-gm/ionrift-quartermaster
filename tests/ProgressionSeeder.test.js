import { describe, it, expect } from "vitest";
import { ProgressionSeeder, _testInternals } from "../scripts/services/ProgressionSeeder.js";

const {
    _parseAttunementClasses,
    _isRejectedByProficiency,
    _isRejectedByAttunementRestriction,
    _categoriseItem,
    _isGenericItem,
    _buildMilestoneTables,
    _buildArchetypeTables,
    FOCUS_SUBTYPES,
    ATTUNEMENT_CLASS_RE
} = _testInternals;

function item(partial) {
    return {
        armorType:  "",
        weaponType: "",
        subtype:    "",
        ...partial
    };
}

describe("_parseAttunementClasses", () => {
    it("returns null for null, undefined, and empty string", () => {
        expect(_parseAttunementClasses(null)).toBeNull();
        expect(_parseAttunementClasses(undefined)).toBeNull();
        expect(_parseAttunementClasses("")).toBeNull();
    });

    it("returns null when no attunement clause matches", () => {
        expect(_parseAttunementClasses("A fine blade with no restriction.")).toBeNull();
    });

    it("parses a single recognised class", () => {
        const out = _parseAttunementClasses("Requires attunement by a wizard.");
        expect(out).toEqual(new Set(["wizard"]));
    });

    it("parses multi-class lists with commas and or", () => {
        const out = _parseAttunementClasses(
            "Requires attunement by a cleric, druid, or warlock"
        );
        expect(out).toEqual(new Set(["cleric", "druid", "warlock"]));
    });

    it("strips HTML tags before matching", () => {
        const out = _parseAttunementClasses(
            "<p>Requires attunement by a <strong>bard</strong> or <em>fighter</em>.</p>"
        );
        expect(out).toEqual(new Set(["bard", "fighter"]));
    });

    it("returns null when no recognised class names remain", () => {
        expect(_parseAttunementClasses("Requires attunement by a goblin king.")).toBeNull();
    });

    it("exposes ATTUNEMENT_CLASS_RE as a RegExp", () => {
        expect(ATTUNEMENT_CLASS_RE).toBeInstanceOf(RegExp);
    });
});

describe("_isRejectedByProficiency", () => {
    it("rejects heavy armor for arcane / fragile classes", () => {
        const heavy = item({ armorType: "heavy" });
        expect(_isRejectedByProficiency(heavy, ["wizard"])).toBe(true);
        expect(_isRejectedByProficiency(heavy, ["fighter"])).toBe(false);
    });

    it("rejects medium armor for classes that cannot wear it", () => {
        const medium = item({ armorType: "medium" });
        expect(_isRejectedByProficiency(medium, ["wizard"])).toBe(true);
        expect(_isRejectedByProficiency(medium, ["ranger"])).toBe(false);
    });

    it("rejects shield for classes that cannot use it", () => {
        const shield = item({ armorType: "shield" });
        expect(_isRejectedByProficiency(shield, ["rogue"])).toBe(true);
        expect(_isRejectedByProficiency(shield, ["fighter"])).toBe(false);
    });

    it("rejects martial weapons for wizard and sorcerer", () => {
        const martial = item({ weaponType: "martialM" });
        expect(_isRejectedByProficiency(martial, ["wizard"])).toBe(true);
        expect(_isRejectedByProficiency(martial, ["bard"])).toBe(false);
    });

    it("rejects focus subtypes for non-caster martials", () => {
        expect(_isRejectedByProficiency(item({ subtype: "staff" }), ["fighter"])).toBe(true);
        expect(_isRejectedByProficiency(item({ subtype: "rod" }), ["monk"])).toBe(true);
        expect(_isRejectedByProficiency(item({ subtype: "wand" }), ["rogue"])).toBe(true);
        expect(_isRejectedByProficiency(item({ subtype: "staff" }), ["wizard"])).toBe(false);
    });
});

describe("_isRejectedByAttunementRestriction", () => {
    it("returns false when there is no restriction", () => {
        const itemNoDesc = { description: "" };
        expect(_isRejectedByAttunementRestriction(itemNoDesc, ["wizard"])).toBe(false);
    });

    it("returns false when a class matches the restriction", () => {
        const itm = {
            description: "Requires attunement by a paladin."
        };
        expect(_isRejectedByAttunementRestriction(itm, ["paladin"])).toBe(false);
    });

    it("returns true when no class matches", () => {
        const itm = {
            description: "Requires attunement by a wizard."
        };
        expect(_isRejectedByAttunementRestriction(itm, ["fighter"])).toBe(true);
    });

    it("allows multiclass when any class matches", () => {
        const itm = {
            description: "Requires attunement by a wizard or fighter."
        };
        expect(_isRejectedByAttunementRestriction(itm, ["cleric", "fighter"])).toBe(false);
        expect(_isRejectedByAttunementRestriction(itm, ["cleric", "bard"])).toBe(true);
    });
});

describe("_categoriseItem", () => {
    it('returns "weapon" when itemType is weapon', () => {
        expect(_categoriseItem(item({ itemType: "weapon" }))).toBe("weapon");
    });

    it('returns "armor" when armorType is set', () => {
        expect(_categoriseItem(item({ itemType: "equipment", armorType: "heavy" }))).toBe("armor");
    });

    it('returns "focus" for staff, rod, and wand subtypes', () => {
        expect(_categoriseItem(item({ itemType: "equipment", subtype: "staff" }))).toBe("focus");
        expect(_categoriseItem(item({ itemType: "equipment", subtype: "rod" }))).toBe("focus");
        expect(_categoriseItem(item({ itemType: "equipment", subtype: "wand" }))).toBe("focus");
    });

    it('returns "wondrous" for generic equipment', () => {
        expect(_categoriseItem(item({ itemType: "equipment", subtype: "ring" }))).toBe("wondrous");
    });
});

describe("_isGenericItem", () => {
    it("treats +N suffix items as generic", () => {
        expect(_isGenericItem("Longsword +1")).toBe(true);
        expect(_isGenericItem("Chain Mail +2")).toBe(true);
    });

    it("does not flag named items without a +N bonus token", () => {
        expect(_isGenericItem("Flame Tongue")).toBe(false);
        expect(_isGenericItem("Vorpal Sword")).toBe(false);
    });
});

describe("ProgressionSeeder._detectRole", () => {
    it('returns "martial" for a pure martial class', () => {
        const actor = { classes: { a: { name: "Fighter" } } };
        expect(ProgressionSeeder._detectRole(actor)).toBe("martial");
    });

    it('returns "caster" for a full caster only', () => {
        const actor = { classes: { a: { name: "Wizard" } } };
        expect(ProgressionSeeder._detectRole(actor)).toBe("caster");
    });

    it('returns "divine" for cleric or druid', () => {
        expect(ProgressionSeeder._detectRole({ classes: { a: { name: "Cleric" } } })).toBe("divine");
        expect(ProgressionSeeder._detectRole({ classes: { a: { name: "Druid" } } })).toBe("divine");
    });

    it('returns "half-caster" for paladin, ranger, or artificer alone', () => {
        expect(ProgressionSeeder._detectRole({ classes: { a: { name: "Paladin" } } })).toBe("half-caster");
        expect(ProgressionSeeder._detectRole({ classes: { a: { name: "Ranger" } } })).toBe("half-caster");
        expect(ProgressionSeeder._detectRole({ classes: { a: { name: "Artificer" } } })).toBe("half-caster");
    });

    it('returns "monk" when monk is present', () => {
        const actor = {
            classes: {
                a: { name: "Monk" },
                b: { name: "Fighter" }
            }
        };
        expect(ProgressionSeeder._detectRole(actor)).toBe("monk");
    });

    it('returns "hybrid" for martial plus full caster', () => {
        const actor = {
            classes: {
                a: { name: "Fighter" },
                b: { name: "Wizard" }
            }
        };
        expect(ProgressionSeeder._detectRole(actor)).toBe("hybrid");
    });

    it('returns "martial" when there are no classes', () => {
        expect(ProgressionSeeder._detectRole({ classes: {} })).toBe("martial");
        expect(ProgressionSeeder._detectRole({})).toBe("martial");
    });
});

describe("ProgressionSeeder._rarityToMilestone", () => {
    it("maps each rarity without attunement to the natural floor", () => {
        expect(ProgressionSeeder._rarityToMilestone("common", false)).toBe(3);
        expect(ProgressionSeeder._rarityToMilestone("uncommon", false)).toBe(3);
        expect(ProgressionSeeder._rarityToMilestone("rare", false)).toBe(5);
        expect(ProgressionSeeder._rarityToMilestone("veryRare", false)).toBe(12);
        expect(ProgressionSeeder._rarityToMilestone("legendary", false)).toBe(16);
    });

    it("bumps one milestone index when attuned", () => {
        expect(ProgressionSeeder._rarityToMilestone("common", true)).toBe(5);
        expect(ProgressionSeeder._rarityToMilestone("uncommon", true)).toBe(5);
        expect(ProgressionSeeder._rarityToMilestone("rare", true)).toBe(8);
        expect(ProgressionSeeder._rarityToMilestone("veryRare", true)).toBe(16);
    });

    it("legendary + attuned caps at milestone 20", () => {
        expect(ProgressionSeeder._rarityToMilestone("legendary", true)).toBe(20);
    });

    it("falls back to floor 3 for unknown rarity", () => {
        expect(ProgressionSeeder._rarityToMilestone("artifact", false)).toBe(3);
        expect(ProgressionSeeder._rarityToMilestone("bogus", true)).toBe(5);
    });
});

describe("exported constants sanity", () => {
    it("exports milestone data used by the seeder", () => {
        const { milestones, rarity } = _buildMilestoneTables();
        const SLOT_ARCHETYPES = _buildArchetypeTables();
        expect(milestones).toEqual([3, 5, 8, 12, 16, 20]);
        expect(rarity[3]).toContain("common");
        expect(SLOT_ARCHETYPES.martial[20]).toEqual(["weapon", "armor"]);
        expect(FOCUS_SUBTYPES.has("staff")).toBe(true);
    });
});
