import { MODULE_ID } from "../../data/moduleId.js";
import { getQuartermasterAdapter } from "../../adapters/getAdapter.js";
/**
 * GM dialog: choose which item compendiums the Party Shelf randomiser draws from.
 * Launched from the Signature Ledger's Party Shelf tab.
 */

export const SETTING_PARTY_SHELF_SOURCES = "partyShelfSources";

const EQUIPMENT_TYPES = new Set(["equipment", "weapon", "armor"]);

export class PartyShelfSourceApp extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id:            "ionrift-party-shelf-sources",
            title:         "Party Shelf: item compendiums",
            template:      `modules/${MODULE_ID}/templates/party-shelf-sources.hbs`,
            width:         520,
            height:        480,
            closeOnSubmit: true,
            classes:       ["ionrift-window", "glass-ui"],
            scrollY:       [".party-shelf-sources-scroll"]
        });
    }

    async getData() {
        const enabled = new Set(PartyShelfSourceApp.getEnabledSources());
        const packs   = await PartyShelfSourceApp._listEquipmentCompendiums();

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
     * List only compendiums that contain equipment-type items.
     * Filters out spell packs, class packs, feature packs, etc.
     *
     * NOTE: Must be async - Forge lazy-loads compendium indexes, so
     * pack.index.size is 0 on a cold boot until getIndex() is called.
     */
    static async _listEquipmentCompendiums() {
        const results = [];
        for (const pack of game.packs) {
            if (pack.documentName !== "Item") continue;

            // Force-load the index so the type scan works on cold Forge instances.
            if (!pack.index?.size) {
                try { await pack.getIndex({ fields: ["type"] }); } catch { continue; }
            }

            let eqCount = 0;
            for (const entry of pack.index.values()) {
                if (EQUIPMENT_TYPES.has(entry.type)) eqCount++;
            }
            if (eqCount === 0) continue;

            results.push({
                id:    pack.collection,
                label: pack.title ?? pack.metadata?.label ?? pack.collection,
                count: eqCount
            });
        }
        return results;
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find(".party-shelf-select-all").on("click", ev => {
            ev.preventDefault();
            html.find('input[type="checkbox"][name^="pack-"]').prop("checked", true);
        });
        html.find(".party-shelf-select-none").on("click", ev => {
            ev.preventDefault();
            html.find('input[type="checkbox"][name^="pack-"]').prop("checked", false);
        });
    }

    async _updateObject(_event, formData) {
        const enabled = [];
        for (const [key, value] of Object.entries(formData)) {
            if (key.startsWith("pack-") && value) enabled.push(key.replace("pack-", ""));
        }

        await game.settings.set(MODULE_ID, SETTING_PARTY_SHELF_SOURCES, JSON.stringify(enabled));
        ui.notifications.info(`Party shelf sources saved: ${enabled.length} compendium${enabled.length !== 1 ? "s" : ""} enabled.`);
    }

    static getEnabledSources() {
        try {
            const raw = game.settings.get(MODULE_ID, "lootPoolSources");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length) return parsed;
        } catch { /* fall through */ }
        const defaults = getQuartermasterAdapter().getDefaultLootPoolSources();
        return defaults.length ? defaults : ["dnd5e.items"];
    }
}
