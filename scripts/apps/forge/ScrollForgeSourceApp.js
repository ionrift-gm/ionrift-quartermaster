import { MODULE_ID } from "../../data/moduleId.js";
/**
 * GM dialog: choose which spell compendiums Scroll Forge may read.
 */

import { ScrollForge } from "../../services/scroll/ScrollForge.js";


export class ScrollForgeSourceApp extends FormApplication {
    /**
     * @param {{ id: string, label: string, packageLabel: string, spellCount: number }[]} candidates
     * @param {{ firstRun?: boolean }} [opts]
     * @returns {Promise<boolean>} True if the GM saved sources, false if they closed without saving.
     */
    static waitForClose(candidates, { firstRun = false } = {}) {
        return new Promise(resolve => {
            new ScrollForgeSourceApp({}, { candidates, firstRun, onClose: resolve }).render(true);
        });
    }

    constructor(object = {}, options = {}) {
        super(object, options);
        /** @type {boolean} */
        this._submitted = false;
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id:       "ionrift-scroll-forge-sources",
            title:    "Scroll Forge: spell compendiums",
            template: `modules/${MODULE_ID}/templates/scroll-forge-sources.hbs`,
            width:    520,
            height:   "auto",
            closeOnSubmit: false,
            submitOnChange: false,
            classes:  ["ionrift-window", "glass-ui"]
        });
    }

    async getData() {
        const candidates = this.options.candidates?.length
            ? this.options.candidates
            : await ScrollForge.discoverSpellCompendiums();

        const checked = new Set(ScrollForge.initialCheckedIds(candidates));
        const groups = {};

        for (const c of candidates) {
            const g = c.packageLabel || "Other";
            if (!groups[g]) groups[g] = { label: g, packs: [] };
            groups[g].packs.push({
                id:      c.id,
                label:   c.label,
                count:   c.spellCount,
                enabled: checked.has(c.id)
            });
        }

        return {
            firstRun: !!this.options.firstRun,
            groups:   Object.values(groups).sort((a, b) => a.label.localeCompare(b.label))
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find(".scroll-forge-select-all").on("click", ev => {
            ev.preventDefault();
            html.find('input[type="checkbox"][name^="pack-"]').prop("checked", true);
        });
        html.find(".scroll-forge-select-none").on("click", ev => {
            ev.preventDefault();
            html.find('input[type="checkbox"][name^="pack-"]').prop("checked", false);
        });
    }

    async _updateObject(event, formData) {
        this._submitted = true;

        const enabled = [];
        for (const [key, value] of Object.entries(formData)) {
            if (key.startsWith("pack-") && value) enabled.push(key.replace("pack-", ""));
        }

        const candidates = this.options.candidates?.length
            ? this.options.candidates
            : await ScrollForge.discoverSpellCompendiums();

        await game.settings.set(MODULE_ID, ScrollForge.SETTING_SOURCES, JSON.stringify(enabled));
        await game.settings.set(
            MODULE_ID,
            ScrollForge.SETTING_SNAPSHOT,
            ScrollForge._candidateSnapshot(candidates)
        );
        await game.settings.set(MODULE_ID, ScrollForge.SETTING_HASH, "");

        ui.notifications.info("Scroll Forge spell sources saved. Compiling scrolls.");

        await ScrollForge.compile();
        this.close();
    }

    close(options = {}) {
        const ret = super.close(options);
        if (typeof this.options.onClose === "function") this.options.onClose(this._submitted);
        return ret;
    }
}
