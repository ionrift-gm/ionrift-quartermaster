import { Logger, MODULE_LABEL } from "../../utils/Logger.js";

const MODULE_ID = "ionrift-quartermaster";

/**
 * Client-side trace for GM identification routing. Enable in module settings
 * or from the console: game.settings.set("ionrift-quartermaster", "identifyTrace", true)
 *
 * @param {string} step
 * @param {object} [detail]
 */
export function traceIdentify(step, detail = {}) {
    if (!game?.settings?.get?.(MODULE_ID, "identifyTrace")) return;
    Logger.info(MODULE_LABEL, `[Identify] ${step}`, detail);
}

/**
 * @param {Item} item
 * @returns {object}
 */
export function traceItemFlags(item) {
    const qm = item?.flags?.[MODULE_ID] ?? {};
    const latent = qm.latentMagic ?? null;
    return {
        itemId: item?.id,
        itemName: item?.name,
        itemType: item?.type,
        parentName: item?.parent?.name ?? null,
        isItemPile: !!item?.parent?.flags?.["item-piles"]?.data?.enabled,
        systemIdentified: item?.system?.identified,
        forgedFrom: qm.forgedFrom ?? null,
        latentPromoted: latent?.promoted ?? null,
        latentOriginalName: latent?.originalName ?? null,
        hasCursedMeta: !!qm.cursedMeta,
        cursedGmRevealed: qm.cursedMeta?.gmRevealed ?? null
    };
}
