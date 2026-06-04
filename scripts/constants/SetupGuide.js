export const SETUP_GUIDE_PACK = "ionrift-quartermaster.quartermaster-guide-gm";
export const SETUP_GUIDE_JOURNAL_ID = "qmGuideJournal01";
export const SETUP_GUIDE_PAGE_ID = "qmSetupGuide001";

/**
 * Opens the GM setup guide journal from the compendium.
 * @returns {Promise<void>}
 */
export async function openSetupGuide() {
    const pack = game.packs.get(SETUP_GUIDE_PACK);
    if (!pack) {
        ui.notifications?.warn(
            "Quartermaster: setup guide compendium not found. Reload the world after updating the module."
        );
        return;
    }

    let entry;
    try {
        entry = await pack.getDocument(SETUP_GUIDE_JOURNAL_ID);
    } catch {
        ui.notifications?.warn("Quartermaster: setup guide journal entry is missing from the compendium.");
        return;
    }

    if (!entry) {
        ui.notifications?.warn("Quartermaster: setup guide journal entry is missing from the compendium.");
        return;
    }

    entry.sheet.render(true, { pageId: SETUP_GUIDE_PAGE_ID });
}
