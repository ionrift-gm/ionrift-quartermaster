import { MODULE_ID } from "../../data/moduleId.js";

/**
 * Apply a pre-authored SRD cursed item disguise at pile hand-off.
 *
 * The SRD cursed compendium stores the player-facing lure inside latentMagic
 * while the document itself keeps the true cursed identity. Item Piles needs
 * that shape normalized before players can see or transfer the item.
 *
 * @param {Object} itemData Full Foundry Item data object (mutated)
 * @returns {boolean} True when a disguise was applied
 */
export function applyAuthoredDisguise(itemData) {
    if (!itemData) return false;

    const qmFlags = itemData.flags?.[MODULE_ID] ?? {};
    const authored = qmFlags.latentMagic;
    const cursedMeta = qmFlags.cursedMeta;

    if (!authored || !cursedMeta || cursedMeta.lure || qmFlags.forgedFrom) return false;
    if (authored.promoted) return false;

    const surfaceName = (authored.originalName ?? "").trim();
    const trueName = (itemData.name ?? "").trim();
    if (!surfaceName || !trueName || surfaceName === trueName) return false;

    itemData.system ??= {};
    const system = itemData.system;

    const normalizedLatent = {
        originalName:        trueName,
        originalRarity:      system.rarity ?? authored.originalRarity ?? "",
        originalDescription: system.description?.value ?? "",
        originalImg:         itemData.img ?? "",
        magicalBonus:        authored.magicalBonus ?? "",
        attunement:          authored.attunement ?? "",
        properties:          authored.properties ?? []
    };

    if (system.price?.value !== undefined) {
        normalizedLatent.originalPrice = {
            value:        system.price.value ?? 0,
            denomination: system.price.denomination ?? "gp"
        };
    } else if (authored.originalPrice) {
        normalizedLatent.originalPrice = authored.originalPrice;
    }

    itemData.name = surfaceName;
    if (authored.originalImg) itemData.img = authored.originalImg;
    if (authored.originalRarity) system.rarity = authored.originalRarity;
    if (authored.originalDescription !== undefined) {
        system.description = {
            ...(system.description ?? {}),
            value: authored.originalDescription
        };
    }
    if (authored.originalPrice && system.price) {
        system.price = {
            value:        authored.originalPrice.value ?? system.price.value ?? 0,
            denomination: authored.originalPrice.denomination ?? system.price.denomination ?? "gp"
        };
    }

    itemData.flags ??= {};
    itemData.flags[MODULE_ID] ??= {};
    itemData.flags[MODULE_ID].latentMagic = normalizedLatent;
    system.identified = true;
    return true;
}
