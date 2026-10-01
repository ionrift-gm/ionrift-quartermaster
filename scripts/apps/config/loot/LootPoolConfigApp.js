import { ItemPoolResolver } from "../../../services/loot/ItemPoolResolver.js";
import { MODULE_ID } from "../../../data/moduleId.js";

/**
 * Configuration form for selecting which compendiums contribute to loot pools.
 * Opens from Module Settings > Configure Sources.
 * Uses Kernel CompendiumSourceService for grouping and form processing.
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
        const CSS = game.ionrift?.library?.CompendiumSourceService;

        if (CSS) {
            // ItemPoolResolver.listAvailableCompendiums() returns pack objects with enabled flag
            return {
                groups: CSS.groupPacksByPackage(packs, {
                    enabledIds: packs.filter(p => p.enabled).map(p => p.id)
                })
            };
        }

        // Fallback grouping
        const groups = {};
        for (const pack of packs) {
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
        const CSS = game.ionrift?.library?.CompendiumSourceService;
        const enabled = CSS
            ? CSS.extractSelectedIds(formData, "pack-")
            : Object.entries(formData).filter(([k, v]) => k.startsWith("pack-") && v).map(([k]) => k.replace("pack-", ""));

        await game.settings.set(MODULE_ID, "lootPoolSources", JSON.stringify(enabled));
        ItemPoolResolver.clearCache();
        ui.notifications?.info?.(`Loot pool updated: ${enabled.length} source${enabled.length !== 1 ? 's' : ''} enabled.`);
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find(".pool-group-header").on("click", ev => {
            ev.preventDefault();
            const group = $(ev.currentTarget).closest(".pool-group");
            group.toggleClass("collapsed");
        });
    }
}
