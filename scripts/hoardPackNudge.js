/**
 * Quartermaster Core pack nudge wiring.
 *
 * Surfaces the shared library pack-nudge banner in Module Settings when the
 * core overlay is offered (registry / Patreon Library) but no overlay folder
 * or materialised compendiums exist yet.
 */

const MODULE_ID = "ionrift-quartermaster";
const CORE_OVERLAY_ID = "quartermaster-core-overlay";
const CORE_PACK_URL = "https://www.patreon.com/ionrift";
const MATERIALISED_STATE_KEY = "materialisedOverlayPacks";

/** @returns {object|null} Cached registry entry for the core overlay. */
function getCoreOverlayRegistryEntry() {
    try {
        const cache = game.settings.get("ionrift-library", "registryLastCheck") ?? {};
        const entry = cache.data?.overlays?.[CORE_OVERLAY_ID];
        if (!entry || entry.moduleId !== MODULE_ID) return null;
        return entry;
    } catch {
        return null;
    }
}

/**
 * True when overlay distribution is on and the core pack is visible to this
 * client (preview entries require showPreviewContent).
 * @returns {boolean}
 */
export function isCoreOverlayOffered() {
    if (!game.ionrift?.library?.isOverlayDistributionActive?.()) return false;
    if (!game.modules.get(MODULE_ID)?.active) return false;

    const entry = getCoreOverlayRegistryEntry();
    if (entry) {
        if (entry.preview && !game.settings.get("ionrift-library", "showPreviewContent")) {
            return false;
        }
        return true;
    }

    // Registry not cached yet (first load). Preview testers still see the nudge.
    return !!game.settings.get("ionrift-library", "showPreviewContent");
}

/**
 * True when treasure/trinket compendiums from the core overlay are present.
 * @returns {boolean}
 */
export function hasMaterialisedCoreCompendiums() {
    try {
        const state = JSON.parse(game.settings.get(MODULE_ID, MATERIALISED_STATE_KEY) || "{}");
        const entry = state[CORE_OVERLAY_ID];
        if (entry?.packs?.length) {
            return entry.packs.some(id => game.packs.get(id));
        }
    } catch { /* ignore */ }

    for (const pack of game.packs) {
        const col = pack.collection;
        if (!col.startsWith("world.quartermaster-")) continue;
        if (pack.index?.size > 0) return true;
    }

    return false;
}

/**
 * True when the core overlay is installed on disk (core or legacy free sublayer).
 * @returns {Promise<boolean>}
 */
async function hasCoreOverlayOnDisk() {
    const overlay = game.ionrift?.library?.overlay;
    if (!overlay?.getLocalManifest) return false;

    for (const sublayer of ["core", "free"]) {
        try {
            const manifest = await overlay.getLocalManifest(MODULE_ID, sublayer);
            if (manifest?.overlayId === CORE_OVERLAY_ID) return true;
        } catch { /* ignore */ }
    }

    if (typeof overlay.listInstalledSublayers === "function") {
        const sublayers = await overlay.listInstalledSublayers(MODULE_ID);
        for (const sublayer of sublayers) {
            try {
                const manifest = await overlay.getLocalManifest(MODULE_ID, sublayer);
                if (manifest?.overlayId === CORE_OVERLAY_ID) return true;
            } catch { /* ignore */ }
        }
    }

    return false;
}

/**
 * Canonical "core loot content is ready" check for the nudge gate.
 * @returns {Promise<boolean>}
 */
export async function hasCoreOverlayContent() {
    if (hasMaterialisedCoreCompendiums()) return true;
    if (await hasCoreOverlayOnDisk()) return true;

    try {
        const compiled = JSON.parse(game.settings.get(MODULE_ID, "compiledContentPacks") || "{}");
        if (Object.keys(compiled).length > 0) return true;
    } catch { /* ignore */ }

    return false;
}

async function openCorePackInstaller() {
    const lib = game.ionrift?.library;
    if (lib?.isOverlayDistributionActive?.()) {
        await lib.openPatreonLibrary?.({ moduleId: MODULE_ID });
        return;
    }
    const { WorkshopPackRegistryApp } = await import("./apps/WorkshopPackRegistryApp.js");
    new WorkshopPackRegistryApp().render(true);
}

/**
 * Registers the Quartermaster core pack nudge with the shared library service.
 * Idempotent. Settings panel injection runs centrally from ionrift-library.
 */
export function registerHoardPackNudge() {
    const packNudge = game.ionrift?.library?.packNudge;
    if (!packNudge) return;
    if (packNudge.isRegistered(MODULE_ID)) return;

    packNudge.register({
        moduleId: MODULE_ID,
        packUrl: CORE_PACK_URL,
        isEnabled: () => isCoreOverlayOffered(),
        isContentInstalled: () => hasCoreOverlayContent(),
        openInstaller: () => openCorePackInstaller(),
        title: "Core pack not installed.",
        subtitle: "Install the Core pack from Patreon Library to add treasure and trinkets to cache generation.",
        icon: "fas fa-treasure-chest",
        primaryLabel: "Open Library",
        primaryIcon: "fas fa-book-open",
        secondaryLabel: "Get Pack",
        secondaryIcon: "fas fa-download",
        findSettingsAnchor: ($html) => {
            const candidates = [
                { selector: `button[data-key="${MODULE_ID}.lootPoolConfig"]`, position: "after" },
                { selector: `button[data-key="${MODULE_ID}.contentPacks"]`, position: "after" }
            ];
            for (const { selector, position } of candidates) {
                const $btn = $html.find(selector);
                if (!$btn.length) continue;
                const $group = $btn.closest(".form-group");
                if ($group.length) return { $anchor: $group, position };
            }
            return null;
        }
    });
}
