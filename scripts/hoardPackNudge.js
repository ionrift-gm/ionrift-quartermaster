/**
 * Core Hoard Pack nudge wiring for Quartermaster.
 *
 * Feature-flagged via the `hoardPackNudgeEnabled` world setting. The pack
 * itself is not yet published, so this stays inert by default. Flip the flag
 * to surface the banner in the Module Settings panel.
 */

import { WorkshopPackRegistryApp } from "./apps/WorkshopPackRegistryApp.js";

const MODULE_ID = "ionrift-quartermaster";

/**
 * Public download URL for the Core Hoard Pack.
 * Placeholder until the pack is published. Falls back to the Patreon home so
 * the "Get Pack" button still points somewhere usable if the flag is enabled
 * before the canonical URL is known.
 */
const HOARD_PACK_URL = "https://www.patreon.com/ionrift";

/**
 * Returns true when the hoard pack is detected as installed.
 *
 * Placeholder: the pack ships in the future via the same overlay distribution
 * channel as Resonance / Respite. When the pack exists, this should resolve
 * via OverlayService.getOverlayState or by checking compiled content packs.
 */
function hasHoardPackInstalled() {
    try {
        const compiled = JSON.parse(game.settings.get(MODULE_ID, "compiledContentPacks") || "{}");
        if (Object.keys(compiled).length > 0) return true;

        const materialised = JSON.parse(game.settings.get(MODULE_ID, "materialisedOverlayPacks") || "{}");
        if (Object.keys(materialised).length > 0) return true;
    } catch { /* ignore */ }
    return false;
}

async function openHoardPackInstaller() {
    const lib = game.ionrift?.library;
    if (lib?.isOverlayDistributionActive?.()) {
        await lib.openPatreonLibrary?.({ moduleId: MODULE_ID });
        return;
    }
    new WorkshopPackRegistryApp().render(true);
}

/**
 * Registers the Quartermaster hoard pack nudge with the shared library
 * service. The `hoardPackNudgeEnabled` flag gates whether the banner ever
 * shows, so the registration itself is safe to perform unconditionally.
 */
export function registerHoardPackNudge() {
    const packNudge = game.ionrift?.library?.packNudge;
    if (!packNudge) return;
    if (packNudge.isRegistered(MODULE_ID)) return;

    packNudge.register({
        moduleId: MODULE_ID,
        packUrl: HOARD_PACK_URL,
        isEnabled: () => {
            try { return game.settings.get(MODULE_ID, "hoardPackNudgeEnabled") === true; }
            catch { return false; }
        },
        isContentInstalled: () => hasHoardPackInstalled(),
        openInstaller: () => openHoardPackInstaller(),
        title: "Core Hoard Pack not installed.",
        subtitle: "Download the Core Hoard Pack, then install the zip from Patreon Library (Quartermaster).",
        icon: "fas fa-treasure-chest",
        primaryLabel: "Install .zip",
        primaryIcon: "fas fa-file-import",
        secondaryLabel: "Get Pack",
        secondaryIcon: "fas fa-download"
    });
}
