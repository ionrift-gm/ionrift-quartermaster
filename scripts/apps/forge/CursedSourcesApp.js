import { MODULE_ID } from "../../data/moduleId.js";
/**
 * GM dialog: choose which Item compendiums the cursed pool may draw from.
 * Launched from the Signature Ledger (standalone) or via Add from Compendium.
 */

export const SETTING_CURSED_ITEM_SOURCES = "cursedItemSources";

/** Ledger / import UIs listen to refresh after pool or source list changes. */
export const CURSED_POOL_DATA_HOOK = "ionrift-quartermaster.cursedPoolUpdated";

/** Index types that alone do not make a compendium a cursed loot source (spell books, etc.). */
const CURSED_SOURCE_INDEX_EXCLUDED_TYPES = new Set([
    "spell", "background", "subclass", "class", "feat"
]);

export class CursedSourcesApp extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id:            "ionrift-cursed-sources",
            title:         "Cursed Pool: Compendium Sources",
            template:      `modules/${MODULE_ID}/templates/cursed-sources.hbs`,
            width:         520,
            height:        480,
            closeOnSubmit: true,
            classes:       ["ionrift-window", "glass-ui"],
            scrollY:       [".cursed-sources-scroll"]
        });
    }

    getData() {
        const enabled = new Set(CursedSourcesApp.getEnabledSources());
        const packs   = CursedSourcesApp._listItemCompendiums();

        const groups = {};
        for (const pack of packs) {
            const [moduleId] = pack.id.split(".");
            const moduleName = game.modules.get(moduleId)?.title
                ?? game.system?.title
                ?? moduleId;

            if (!groups[moduleName]) groups[moduleName] = { label: moduleName, packs: [] };
            groups[moduleName].packs.push({
                id:      pack.id,
                label:   pack.label,
                count:   pack.count,
                enabled: enabled.has(pack.id)
            });
        }

        return {
            groups: Object.values(groups).sort((a, b) => a.label.localeCompare(b.label))
        };
    }

    /**
     * Item compendiums that are not spell/background-only packs. Count is eligible entries only.
     */
    static _listItemCompendiums() {
        const results = [];
        for (const pack of game.packs) {
            if (pack.documentName !== "Item") continue;

            let eligibleCount = 0;
            if (pack.index?.size > 0) {
                for (const entry of pack.index.values()) {
                    const t = (entry.type || "").toLowerCase();
                    if (!CURSED_SOURCE_INDEX_EXCLUDED_TYPES.has(t)) eligibleCount++;
                }
                if (eligibleCount === 0) continue;
            }

            results.push({
                id:    pack.collection,
                label: pack.title ?? pack.metadata?.label ?? pack.collection,
                count: pack.index?.size > 0 ? eligibleCount : null
            });
        }
        return results;
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find(".cursed-sources-toggle-selection").on("click", ev => {
            ev.preventDefault();
            const boxes = html.find('input[type="checkbox"][name^="cpack-"]');
            if (!boxes.length) return;
            const allOn = boxes.toArray().every(b => b.checked);
            boxes.prop("checked", !allOn);
        });
    }

    async _updateObject(_event, formData) {
        const enabled = [];
        for (const [key, value] of Object.entries(formData)) {
            if (key.startsWith("cpack-") && value) enabled.push(key.replace("cpack-", ""));
        }

        await game.settings.set(MODULE_ID, SETTING_CURSED_ITEM_SOURCES, JSON.stringify(enabled));
        ui.notifications.info(`Cursed pool sources saved: ${enabled.length} compendium${enabled.length !== 1 ? "s" : ""} enabled.`);
        Hooks.callAll(CURSED_POOL_DATA_HOOK);
    }

    /** Read the stored source list (falls back to SRD cursed world pack). */
    static getEnabledSources() {
        try {
            const raw = game.settings.get(MODULE_ID, SETTING_CURSED_ITEM_SOURCES);
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length) return parsed;
        } catch { /* fall through */ }
        return ["world.ionrift-srd-cursed"];
    }
}
