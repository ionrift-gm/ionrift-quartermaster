export class WorkshopItemFactory {

    /**
     * Normalizes item data to ensure valid prices, weights, and descriptions.
     * @param {Object} itemData Raw item data (from SRD, RollTable, or other source)
     * @returns {Object} Normalized item data ready for creation
     */
    static normalize(itemData) {
        const data = foundry.utils.deepClone(itemData);
        data.system = data.system || {};

        // Price normalization
        if (data.system.price === undefined || data.system.price === null || (typeof data.system.price === 'object' && !data.system.price.value)) {
            data.system.price = this._inferPrice(data.type, data.system.rarity);
        }

        // Weight normalization
        if (data.system.weight === undefined || data.system.weight === null) {
            data.system.weight = this._inferWeight(data.type);
        }

        // Description normalization
        if (!data.system.description || !data.system.description.value) {
            if (game.system.id === "daggerheart") {
                data.system.description = data.system.description || `A generic ${data.type}.`;
            } else {
                data.system.description = { value: `<p>A generic ${data.type}.</p>`, chat: "", unidentified: "" };
            }
        }

        // Economy adjustment (optional integration)
        const economy = game.modules.get("ionrift-economy");
        if (economy?.active && economy.api?.adjustPrice && data.system.price?.value) {
            data.system.price.value = economy.api.adjustPrice(data.system.price.value);
        }

        return data;
    }

    /**
     * Infers a default price based on type and rarity.
     * @param {string} type Item type
     * @param {string} rarity Item rarity
     * @returns {Object} { value: number, denomination: string }
     */
    static _inferPrice(type, rarity = "common") {
        let value = 0;
        let denomination = "gp";

        switch (type) {
            case "weapon": value = 5; break;
            case "armor": value = 10; break;
            case "consumable": value = 0.5; break;
            case "loot": value = 0.01; break;
            case "backpack": value = 2; break;
            case "equipment": value = 2; break;
            case "tool": value = 5; break;
            case "spell": value = 0; break;
            case "feat": value = 0; break;
            default: value = 0;
        }

        // Rarity multiplier
        const rarityLower = (rarity || "common").toLowerCase();
        switch (rarityLower) {
            case "uncommon": value *= 10; break;
            case "rare": value *= 100; break;
            case "very rare": value *= 1000; break;
            case "legendary": value *= 10000; break;
        }

        return { value, denomination };
    }

    /**
     * Infers a default weight based on type.
     * @param {string} type Item type
     * @returns {number} Weight in lbs
     */
    static _inferWeight(type) {
        switch (type) {
            case "weapon": return 2;
            case "armor": return 10;
            case "consumable": return 0.5;
            case "loot": return 0.1;
            case "backpack": return 5;
            case "equipment": return 2;
            case "tool": return 3;
            case "spell": return 0;
            case "feat": return 0;
            default: return 0;
        }
    }
}
