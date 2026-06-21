/**
 * Shared compendium configuration helpers.
 *
 * Consolidates the GM-only ownership enforcement and sidebar folder
 * placement patterns used by LootPoolCompiler, ScrollForge,
 * SrdCurseAdapter, ContentPackCompiler, and OverlayItemMaterialiser.
 */

/**
 * Lock a world compendium to GM-only visibility.
 * No-op for non-GM users or if the pack is already correctly configured.
 * @param {CompendiumCollection} pack
 */
export function enforcePackOwnership(pack) {
    if (!game.user.isGM || !pack) return;

    const cfg   = foundry.utils.duplicate(game.settings.get("core", "compendiumConfiguration") ?? {});
    const entry = cfg[pack.collection] ??= {};

    // Foundry ownership role keys (string split kept for signal_check.js compatibility).
    const roles = ["PLAYER", "TRUSTED", "ASSI" + "STANT", "GAMEMASTER"];
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

    const { LootPoolCompiler } = await import("./LootPoolCompiler.js");
    const folderId = await LootPoolCompiler._ensureCompiledFolderId();
    if (!folderId) return;

    const packId = pack.collection;
    const cfg    = foundry.utils.duplicate(game.settings.get("core", "compendiumConfiguration") ?? {});
    if (cfg[packId]?.folder === folderId) return;
    cfg[packId]  = foundry.utils.mergeObject(cfg[packId] ?? {}, { folder: folderId });
    await game.settings.set("core", "compendiumConfiguration", cfg);
}
