import { describe, it, expect } from "vitest";
import { ItemMaskingHelper } from "../scripts/services/ItemMaskingHelper.js";

const WAND_LABELS = ["Carved Stick", "Thin Wooden Rod", "Tapered Stick"];
const ROD_LABELS = ["Ornate Rod", "Heavy Short Rod", "Metal Rod"];
const STAFF_LABELS = ["Walking Staff", "Worn Wooden Staff", "Tall Staff"];
const POTION_LABELS = ["Sealed Vial", "Stoppered Flask", "Corked Bottle", "Small Phial"];
const OIL_LABELS = ["Flask of Oil", "Sealed Oil Jar", "Stoppered Oil Flask"];

/**
 * First-match wearable keyword expectations for SRD-style names.
 * Order mirrors ItemMaskingHelper._WONDROUS_MAP priority.
 */
function expectedWearableLabel(name) {
    const nameLower = name.toLowerCase();

    if (/\bcrystal\s*ball\b/.test(nameLower)) return "Glass Sphere";
    if (/\bioun\s*stone\b|\bioun\b/.test(nameLower)) return "Polished Stone";
    if (/\b(?:cloak|mantle|cape)s?\b/.test(nameLower)) return "Cloak";
    if (/\b(?:gloves|gauntlets)\b/.test(nameLower)) return "Gloves";
    if (/\b(?:bracers|vambrace)s?\b/.test(nameLower)) return "Bracers";
    if (/\b(?:boots|slippers)\b/.test(nameLower)) return "Boots";
    if (/\b(?:belt|girdle)s?\b/.test(nameLower)) return "Belt";
    if (/\b(?:amulet|periapt|pendant|medallion|brooch)s?\b/.test(nameLower)) return "Pendant";
    if (/\bnecklace\b/.test(nameLower)) return "Necklace";
    if (/\bring\s+mail\b/.test(nameLower)) return "Ring Mail";
    if (/\bring\b/.test(nameLower)) return "Ring";
    if (/\b(?:robe|vestment)s?\b/.test(nameLower)) return "Robe";
    if (/\b(?:hat|cap|hood)s?\b/.test(nameLower)) return "Hat";
    if (/\bhelms?\b/.test(nameLower)) return "Helm";
    if (/\bheadbands?\b/.test(nameLower)) return "Headband";
    if (/\bcirclets?\b/.test(nameLower)) return "Circlet";
    if (/\b(?:goggles|lenses)\b/.test(nameLower)) return "Goggles";
    if (/^eyes\b/.test(nameLower)) return "Goggles";
    if (/\bhaversack\b|\bbag\b|\bsack\b/.test(nameLower)) return "Leather Bag";
    if (/\b(?:tome|manual|libram)s?\b|\bbook\b/.test(nameLower)) return "Old Book";
    if (/\borb\b/.test(nameLower)) return "Glass Sphere";
    if (/\bfigurine\b/.test(nameLower)) return "Small Figurine";
    if (/\bmirror\b/.test(nameLower)) return "Hand Mirror";
    if (/\b(?:carpet|rug)\b/.test(nameLower)) return "Woven Rug";
    if (/\bbroom\b/.test(nameLower)) return "Broom";
    if (/\b(?:deck|cards)\b/.test(nameLower)) return "Card Deck";
    if (/\brope\b/.test(nameLower)) return "Coil of Rope";
    if (/\b(?:lantern|lamp)\b/.test(nameLower)) return "Lantern";
    if (/\bhorn\b/.test(nameLower)) return "Horn";
    if (/\b(?:bottle|flask|decanter)\b/.test(nameLower)) return "Sealed Bottle";
    if (/\bquiver\b/.test(nameLower)) return "Quiver";
    if (/\bshield\b/.test(nameLower)) return "Shield";

    return null;
}

function deriveConcealedName(itemMeta) {
    return ItemMaskingHelper._deriveBaseItemName(itemMeta);
}

describe("concealed name alignment audit", () => {

    const wearableCases = [
        ["Gloves of Missile Snaring", "equipment", "Gloves"],
        ["Gloves of Swimming and Climbing", "equipment", "Gloves"],
        ["Gloves of Thievery", "equipment", "Gloves"],
        ["Gauntlets of Ogre Power", "equipment", "Gloves"],
        ["Robe of Eyes", "equipment", "Robe"],
        ["Robe of Scintillating Colors", "equipment", "Robe"],
        ["Robe of Stars", "equipment", "Robe"],
        ["Robe of the Archmagi", "equipment", "Robe"],
        ["Robe of Useful Items", "equipment", "Robe"],
        ["Helm of Teleportation", "equipment", "Helm"],
        ["Helm of Brilliance", "equipment", "Helm"],
        ["Helm of Comprehending Languages", "equipment", "Helm"],
        ["Helm of Telepathy", "equipment", "Helm"],
        ["Headband of Intellect", "equipment", "Headband"],
        ["Circlet of Blasting", "equipment", "Circlet"],
        ["Eyes of the Eagle", "equipment", "Goggles"],
        ["Eyes of Charming", "equipment", "Goggles"],
        ["Eyes of Minute Seeing", "equipment", "Goggles"],
        ["Goggles of Night", "equipment", "Goggles"],
        ["Ring of Protection", "equipment", "Ring"],
        ["Ring of Spell Storing", "equipment", "Ring"],
        ["Ring of Warmth", "equipment", "Ring"],
        ["Ring Mail", "armor", "Ring Mail"],
        ["Cloak of Displacement", "equipment", "Cloak"],
        ["Cloak of Protection", "equipment", "Cloak"],
        ["Cloak of Elvenkind", "equipment", "Cloak"],
        ["Mantle of Spell Resistance", "equipment", "Cloak"],
        ["Cape of the Mountebank", "equipment", "Cloak"],
        ["Bracers of Defense", "equipment", "Bracers"],
        ["Bracers of Archery", "equipment", "Bracers"],
        ["Amulet of Health", "equipment", "Pendant"],
        ["Periapt of Wound Closure", "equipment", "Pendant"],
        ["Medallion of Thoughts", "equipment", "Pendant"],
        ["Brooch of Shielding", "equipment", "Pendant"],
        ["Necklace of Fireballs", "equipment", "Necklace"],
        ["Necklace of Prayer Beads", "equipment", "Necklace"],
        ["Bag of Holding", "equipment", "Leather Bag"],
        ["Bag of Tricks", "equipment", "Leather Bag"],
        ["Carpet of Flying", "equipment", "Woven Rug"],
        ["Orb of Dragonkind", "equipment", "Glass Sphere"],
        ["Crystal Ball", "equipment", "Glass Sphere"],
        ["Boots of Speed", "equipment", "Boots"],
        ["Boots of Elvenkind", "equipment", "Boots"],
        ["Slippers of Spider Climbing", "equipment", "Boots"],
        ["Winged Boots", "equipment", "Boots"],
        ["Belt of Giant Strength", "equipment", "Belt"],
        ["Belt of Dwarvenkind", "equipment", "Belt"],
        ["Hat of Disguise", "equipment", "Hat"],
        ["Broom of Flying", "equipment", "Broom"],
        ["Rope of Climbing", "equipment", "Coil of Rope"],
        ["Lantern of Revealing", "equipment", "Lantern"],
        ["Horn of Blasting", "equipment", "Horn"],
        ["Decanter of Endless Water", "equipment", "Sealed Bottle"],
        ["Eversmoking Bottle", "equipment", "Sealed Bottle"],
        ["Mirror of Life Trapping", "equipment", "Hand Mirror"],
        ["Figurine of Wondrous Power", "equipment", "Small Figurine"],
        ["Manual of Bodily Health", "equipment", "Old Book"],
        ["Tome of Clear Thought", "equipment", "Old Book"],
        ["Animated Shield", "equipment", "Shield"],
        ["Spellguard Shield", "equipment", "Shield"]
    ];

    it("keeps wearable and container SRD names aligned with their concealed labels", () => {
        const mismatches = [];

        for (const [name, type, expected] of wearableCases) {
            const concealed = deriveConcealedName({ name, type });
            if (concealed !== expected) {
                mismatches.push({ name, expected, concealed });
            }
        }

        expect(mismatches, JSON.stringify(mismatches, null, 2)).toEqual([]);
    });

    it("matches keyword-derived expectations for every audited wearable name", () => {
        const mismatches = [];

        for (const [name, type, expected] of wearableCases) {
            const inferred = expectedWearableLabel(name);
            if (inferred !== expected) {
                mismatches.push({ name, expected, inferred });
            }
        }

        expect(mismatches, JSON.stringify(mismatches, null, 2)).toEqual([]);
    });

    it("does not map ring-mail armor to a finger ring", () => {
        expect(deriveConcealedName({ name: "Ring Mail", type: "armor" })).toBe("Ring Mail");
        expect(deriveConcealedName({ name: "Ring Mail +1", type: "armor", _baseItem: "ringmail" })).toBe("Ring Mail");
    });

    it("does not treat snaring as a ring", () => {
        expect(deriveConcealedName({ name: "Gloves of Missile Snaring", type: "equipment" })).toBe("Gloves");
    });

    it("masks focus items to generic labels", () => {
        expect(WAND_LABELS).toContain(deriveConcealedName({ name: "Wand of Fireballs", type: "equipment" }));
        expect(ROD_LABELS).toContain(deriveConcealedName({ name: "Rod of the Pact Keeper", type: "equipment" }));
        expect(STAFF_LABELS).toContain(deriveConcealedName({ name: "Staff of Power", type: "equipment" }));
    });

    it("masks consumable tropes without leaking the spell name", () => {
        expect(POTION_LABELS).toContain(deriveConcealedName({ name: "Potion of Healing", type: "consumable" }));
        expect(OIL_LABELS).toContain(deriveConcealedName({ name: "Oil of Slipperiness", type: "consumable" }));
        expect(deriveConcealedName({ name: "Scroll of Fireball", type: "consumable" })).toBe("Unidentified Scroll");
    });

    it("keeps named weapon overrides on the correct base weapon", () => {
        const weaponCases = [
            ["Flame Tongue", "weapon", "Longsword"],
            ["Sun Blade", "weapon", "Longsword"],
            ["Oathbow", "weapon", "Longbow"],
            ["Berserker Axe", "weapon", "Greataxe"],
            ["Dagger of Venom", "weapon", "Dagger"],
            ["Vorpal Sword", "weapon", "Greatsword"]
        ];

        for (const [name, type, expected] of weaponCases) {
            expect(deriveConcealedName({ name, type }), name).toBe(expected);
        }
    });
});
