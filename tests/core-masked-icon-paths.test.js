import { describe, it, expect } from "vitest";
import { ItemMaskingHelper } from "../scripts/services/ItemMaskingHelper.js";
import { dnd5eIconMigrationTargets } from "./helpers/icon-migration-targets.js";

describe("ItemMaskingHelper masked icon paths", () => {

    const migrationTargets = dnd5eIconMigrationTargets();

    it("returns core-relative webp paths for scroll and consumable default", () => {
        expect(ItemMaskingHelper._genericIconFor("scroll")).toBe(
            "icons/sundries/scrolls/scroll-worn-beige.webp"
        );
        expect(ItemMaskingHelper._genericIconFor("consumable")).toBe(
            "icons/consumables/potions/potion-tube-corked-red.webp"
        );
    });

    it("maps masked consumable labels to distinct icons", () => {
        expect(ItemMaskingHelper.obscuredConsumableIconForMaskedLabel("Corked Bottle")).toBe(
            "icons/consumables/potions/bottle-round-corked-red.webp"
        );
        expect(ItemMaskingHelper.obscuredConsumableIconForMaskedLabel("Flask of Oil")).toBe(
            "icons/consumables/potions/potion-flask-corked-orange.webp"
        );
        expect(ItemMaskingHelper.obscuredConsumableIconForMaskedLabel("Small Phial")).toBe(
            "icons/consumables/potions/potion-tube-corked-blue.webp"
        );
        expect(ItemMaskingHelper.obscuredConsumableIconForMaskedLabel("Tallow Candle")).toBe(
            "icons/sundries/lights/candle-unlit-white.webp"
        );
        expect(ItemMaskingHelper.obscuredConsumableIconForMaskedLabel("Unknown Label")).toBe(
            ItemMaskingHelper._genericIconFor("consumable")
        );
    });

    it("OBSCURED getters match _genericIconFor", () => {
        expect(ItemMaskingHelper.OBSCURED_SCROLL_IMG).toBe(ItemMaskingHelper._genericIconFor("scroll"));
        expect(ItemMaskingHelper.OBSCURED_CONSUMABLE_IMG).toBe(ItemMaskingHelper._genericIconFor("consumable"));
    });

    it.skipIf(migrationTargets === null)(
        "masked icons appear in dnd5e icon-migration.json",
        () => {
            expect(migrationTargets.has(ItemMaskingHelper._genericIconFor("scroll"))).toBe(true);
            for (const p of ItemMaskingHelper.MASKED_CONSUMABLE_ICON_PATHS) {
                expect(migrationTargets.has(p), `${p} missing from dnd5e icon-migration`).toBe(true);
            }
        }
    );
});
