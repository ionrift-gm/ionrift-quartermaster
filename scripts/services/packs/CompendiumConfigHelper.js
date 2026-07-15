import { MODULE_ID } from "../../data/moduleId.js";
/**
 * Shared compendium configuration helpers.
 *
 * Consolidates the GM-only ownership enforcement, sidebar folder
 * placement, and pack-clearing patterns used by LootPoolCompiler,
 * ScrollForge, SrdCurseAdapter, ContentPackCompiler, and
 * OverlayItemMaterialiser.
 */

import { Logger, MODULE_LABEL } from "../../utils/Logger.js";


/**
 * Lock a world compendium to GM-only visibility.
 * No-op for non-GM users or if the pack is already correctly configured.
 * @param {CompendiumCollection} pack
 */
export function enforcePackOwnership(pack) {
    if (!game.user.isGM || !pack) return;

    const cfg   = foundry.utils.duplicate(game.settings.get("core", "compendiumConfiguration") ?? {});
    const entry = cfg[pack.collection] ??= {};

    // Foundry ownership role keys.
    const roles = ["PLAYER", "TRUSTED", "ASSISTANT", "GAMEMASTER"];
    const wanted = {};
    for (const r of roles) wanted[r] = r === "GAMEMASTER" ? "OWNER" : "NONE";

    const current = entry.ownership ?? {};
    const needsUpdate = Object.entries(wanted).some(([k, v]) => current[k] !== v);
    if (!needsUpdate) return;

    entry.ownership = wanted;
    game.settings.set("core", "compendiumConfiguration", cfg);
}

/**
 * Place a world compendium under Ionrift > Quartermaster > Compiled.
 * Delegates folder hierarchy creation to LootPoolCompiler._ensureCompiledFolderId().
 * No-op for non-GM users.
 * @param {CompendiumCollection} pack
 */
export async function assignPackToCompiledFolder(pack) {
    if (!game.user.isGM || !pack) return;

    const { LootPoolCompiler } = await import("../loot/LootPoolCompiler.js");
    const folderId = await LootPoolCompiler._ensureCompiledFolderId();
    if (!folderId) return;

    const packId = pack.collection;
    const cfg    = foundry.utils.duplicate(game.settings.get("core", "compendiumConfiguration") ?? {});
    if (cfg[packId]?.folder === folderId) return;
    cfg[packId]  = foundry.utils.mergeObject(cfg[packId] ?? {}, { folder: folderId });
    await game.settings.set("core", "compendiumConfiguration", cfg);
}

/**
 * Delete all documents from a compiled world pack and reset its hash/meta
 * settings to empty strings. Used by ScrollForge and SrdCurseAdapter to
 * clear their compiled output and force a fresh compile on next trigger.
 *
 * @param {string} collectionId  Pack collection id (e.g. "world.quartermaster-scrolls")
 * @param {string} hashSetting   Settings key for the source hash
 * @param {string} metaSetting   Settings key for the compile metadata
 * @param {string} callerLabel   Label for warning messages (e.g. "ScrollForge")
 */
/**
 * Deterministic djb2 hash returning a hex string.
 * Shared by LootPoolCompiler, ScrollForge, SrdCurseAdapter, and
 * ContentPackCompiler for source-change detection.
 * @param {string} str
 * @returns {string}
 */
export function stableHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
}

export async function clearPackAndResetMeta(collectionId, hashSetting, metaSetting, callerLabel) {
    const pack = game.packs.get(collectionId);
    if (pack) {
        try {
            const ItemClass = CONFIG.Item.documentClass;
            const docs = await pack.getDocuments();
            if (docs.length) {
                await ItemClass.deleteDocuments(docs.map(d => d.id), { pack: pack.collection });
            }
        } catch (err) {
            Logger.warn(MODULE_LABEL, `${callerLabel}.clearCompiledPack: partial failure:`, err);
        }
    }
    await game.settings.set(MODULE_ID, hashSetting, "");
    await game.settings.set(MODULE_ID, metaSetting, "");
}
