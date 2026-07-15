import { ItemPoolResolver } from "../../services/loot/ItemPoolResolver.js";

const MODULE_ID = "ionrift-quartermaster";

/**
 * Configuration form for selecting which compendiums contribute to loot pools.
 * Opens from Module Settings > Configure Sources.
 * GM-only.
 */
export class LootPoolConfigApp extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ionrift-loot-pool-config",
            title: "Loot Pool Sources",
            template: `modules/${MODULE_ID}/templates/loot-pool-config.hbs`,
            width: 480,
            height: 520,
            classes: ["ionrift-window", "glass-ui"],
            closeOnSubmit: true,
            scrollY: [".loot-pool-sources-scroll"]
        });
    }

    getData() {
        const packs = ItemPoolResolver.listAvailableCompendiums();

        // Group by module/system
        const groups = {};
        for (const pack of packs) {
            // Extract module name from pack id (e.g. "dnd5e.items" -> "dnd5e")
            const [moduleId] = pack.id.split(".");
            const moduleName = game.modules.get(moduleId)?.title
                ?? game.system?.title
                ?? moduleId;

            if (!groups[moduleName]) {
                groups[moduleName] = { label: moduleName, packs: [] };
            }
            groups[moduleName].packs.push(pack);
        }


        return {
            groups: Object.values(groups).sort((a, b) => a.label.localeCompare(b.label))
        };
    }

    async _updateObject(event, formData) {
        // Collect checked pack IDs
        const enabled = [];
        for (const [key, value] of Object.entries(formData)) {
            if (key.startsWith("pack-") && value) {
                enabled.push(key.replace("pack-", ""));
            }
        }

        await game.settings.set(MODULE_ID, "lootPoolSources", JSON.stringify(enabled));
        ItemPoolResolver.clearCache();
        ui.notifications.info(`Loot pool updated: ${enabled.length} source${enabled.length !== 1 ? 's' : ''} enabled.`);
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find(".pool-group-header").on("click", ev => {
            ev.preventDefault();
            $(ev.currentTarget).closest(".pool-group").toggleClass("collapsed");
        });
    }
}
