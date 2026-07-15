import { Logger, MODULE_LABEL } from "../../utils/Logger.js";

export class SoundPickerApp extends Application {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ionrift-sound-picker",
            title: "Sound Library",
            template: "modules/ionrift-quartermaster/templates/sound-picker.hbs",
            width: 500,
            height: 600,
            classes: ["ionrift-window", "glass-ui"],
            resizable: true
        });
    }

    constructor(callback, options = {}) {
        super();
        this.callback = callback;
        // Merge custom options like 'currentSoundId'
        this.opts = foundry.utils.mergeObject({
            currentSoundId: "", // Comma-separated string
            currentSoundName: "", // Label for the FIRST sound (legacy/compat)
            currentSoundMeta: "",
            defaultSoundId: null,
            defaultSoundName: "",
            bindings: null, // Array of {id, name, meta}
            soundConfig: {} // Object { [id]: { delayMin: 0, delayMax: 0 } }
        }, options);

        // Also override defaultOptions title if provided
        if (options.title) {
            this.options.title = options.title;
        }

        this.searchTerm = "";
        this.isLoading = false;
        this.filterOneshots = true; // Default: Only show reactive sounds

        // Pre-load cache if Resonance is available
        this.results = [];
        try {
            if (game.modules.get("ionrift-resonance")?.active) {
                const cache = game.settings.get('ionrift-resonance', 'oneshotCache');
                if (this.filterOneshots && cache?.results) {
                    this.results = cache.results;
                }
            }
        } catch { /* Resonance not available */ }

        // Parse initial bindings
        if (this.opts.bindings && Array.isArray(this.opts.bindings)) {
            this.currentBindings = this.opts.bindings;
        } else {
            this.currentBindings = this._parseBindings(this.opts.currentSoundId);
        }
    }

    _parseBindings(str) {
        if (!str) return [];
        const config = this.opts.soundConfig || {};

        return str.split(",").map(s => {
            const id = s.trim();
            const cfg = config[id] || {};

            return {
                id: id,
                // Prioritize saved name in config, then fallback to passed-in options (legacy), then ID
                name: cfg.name || ((id === this.opts.currentSoundId.split(",")[0].trim() && this.opts.currentSoundName)
                    ? this.opts.currentSoundName
                    : `ID: ${id}`),
                meta: cfg.meta || ((id === this.opts.currentSoundId.split(",")[0].trim() && this.opts.currentSoundMeta)
                    ? this.opts.currentSoundMeta
                    : ""),
                type: cfg.type || "oneshot",
                delayMin: cfg.delayMin || 0,
                delayMax: cfg.delayMax || 0
            };
        }).filter(b => b.id);
    }

    async _render(force, options) {
        // Guarantee partial registration before render
        const partialPath = "modules/ionrift-quartermaster/templates/partials/sound-picker-row.hbs";
        if (!Handlebars.partials[partialPath]) {
            try {
                await loadTemplates([partialPath]);
            } catch (e) {
                Logger.error(MODULE_LABEL, "Partial late-load failed:", e);
            }
        }

        return super._render(force, options);
    }

    getData() {
        // Read cache status, prefer override if we just synced
        let count = 0;
        if (this._cacheCountOverride !== undefined) {
            count = this._cacheCountOverride;
        } else {
            try {
                const cache = game.settings.get('ionrift-resonance', 'oneshotCache');
                count = cache?.results?.length ?? 0;
            } catch { count = 0; }
        }

        // Fallback: use loaded results count in cache mode
        if (count === 0 && !this.searchTerm && this.filterOneshots && this.results.length > 0) {
            count = this.results.length;
        }

        return {
            currentBindings: this.currentBindings,
            hasBindings: this.currentBindings.length > 0,
            searchTerm: this.searchTerm,
            results: this.results,
            isLoading: this.isLoading,
            defaultSoundId: this.opts.defaultSoundId,
            defaultSoundName: this.opts.defaultSoundName,
            filterOneshots: this.filterOneshots,
            cacheCount: count
        };
    }

    /* -------------------------------------------- */
    /*  Event Listeners                             */
    /* -------------------------------------------- */

    activateListeners(html) {
        super.activateListeners(html);

        // Search Input - Change to 'keypress' (Enter) and 'blur'/focusout to prevent re-render on every keystroke
        const searchInput = html.find("input[name='search']");
        searchInput.on("keypress", (ev) => {
            if (ev.key === "Enter") {
                ev.preventDefault();
                this._onSearch(ev);
            }
        });
        searchInput.on("focusout", this._onSearch.bind(this));

        // Delay Inputs Validation
        html.find("input[name='delayMin'], input[name='delayMax']").change(ev => {
            const $row = $(ev.currentTarget).closest(".binding-row");
            this._validateDelayInputs($row, ev);
        });

        // Filter Toggle
        html.find("#filterOneshots").change(ev => {
            this.filterOneshots = ev.currentTarget.checked;
            this._onSearch(ev);
        });

        // Play Preview (Library)
        html.find(".preview-icon").click(ev => {
            ev.stopPropagation();
            this._onPlayPreview(ev);
        });

        // Add Binding (Search Result)
        html.find(".result-row").click(this._onAddSound.bind(this));

        // Play Default
        html.find(".action-test-default").click((ev) => {
            ev.preventDefault();
            if (this.opts.defaultSoundId) {
                const manager = game.ionrift?.sounds?.manager;
                if (manager) manager.provider.playSound(this.opts.defaultSoundId);
            }
        });

        // Play Preview (Current)
        html.find(".action-test-current").click(this._onPlayCurrent.bind(this));

        // Remove from List
        html.find(".action-remove-binding").click(this._onRemoveBinding.bind(this));

        // SAVE / CONFIRM
        html.find(".action-save").click(this._onSave.bind(this));

        // Update Library
        html.find(".action-update-lib").click(this._onUpdateLib.bind(this));

        // Purge Library
        html.find(".action-purge-lib").click(this._onPurgeLib.bind(this));
    }

    async _onPurgeLib(event) {
        event.preventDefault();

        new Dialog({
            title: "Purge Cache?",
            content: `
                <div style="text-align: center; padding: 10px;">
                    <i class="fas fa-exclamation-triangle" style="font-size: 3em; color: #f87171; margin-bottom: 10px;"></i>
                    <p style="font-size: 1.1em; margin-bottom: 5px;">Clear your local One-Shot cache?</p>
                    <p style="font-size: 0.9em; color: #aaa;">You will need to Sync again to see Global One-Shots.</p>
                </div>
            `,
            buttons: {
                purge: {
                    label: `<i class="fas fa-trash"></i> Purge`,
                    callback: async () => {
                        await game.settings.set('ionrift-resonance', 'oneshotCache', { results: [] });
                        this._cacheCountOverride = 0;
                        this.results = [];
                        this.searchTerm = "";
                        this.render();
                        ui.notifications.info("Ionrift: Cache Purged.");
                    }
                },
                cancel: {
                    label: "Cancel"
                }
            },
            default: "cancel"
        }, {
            classes: ["ionrift-window", "glass-ui"],
            width: 320
        }).render(true);
    }

    async _onUpdateLib(event) {
        event.preventDefault();
        const manager = game.ionrift?.sounds?.manager;
        if (!manager) return;

        // Visual Feedback
        const btn = this.element.find(".action-update-lib");
        const originalContent = btn.html();
        btn.html('<i class="fas fa-spinner fa-spin"></i> Syncing...');
        btn.prop('disabled', true);

        try {
            ui.notifications.info("Ionrift: Syncing Global One-Shots...");
            const results = await manager.provider.cacheLibrary({});
            ui.notifications.info(`Ionrift: Sync Complete (${results.length} Global One-Shots).`);

            // Override cache count for this session to ensure UI updates immediately
            this._cacheCountOverride = results.length;

            // If empty search, refresh view to show new cache directly
            if (!this.searchTerm) {
                this.results = results || [];
            }
            // Always re-render to update the "Cache Panel" status and Results list
            this.render();

        } catch (e) {
            Logger.error(MODULE_LABEL, "Update failed:", e);
            ui.notifications.error("Update Failed.");
            btn.html(originalContent);
            btn.prop('disabled', false);
        }
    }

    async _onSearch(event) {
        if (event) event.preventDefault();
        const query = this.element.find("input[name='search']").val().trim();

        // Empty query + One-Shot filter: show cache
        if (!query && this.filterOneshots) {
            try {
                const cache = game.settings.get('ionrift-resonance', 'oneshotCache');
                this.results = cache?.results?.length > 0 ? cache.results : [];
            } catch {
                this.results = [];
            }
            this.searchTerm = "";
            this.isLoading = false;
            this.render();
            return;
        }

        if (!query) return;

        // URL sanitization: extract Syrinscape element ID from pasted URLs
        const urlMatch = query.match(/elements\/(\d+)/);
        if (urlMatch) {
            const id = urlMatch[1];

            // Manual Entry
            this.results = [{
                id: id,
                name: `Manual Entry: ${id}`,
                meta: "Syrinscape Element",
                icon: "fas fa-link" // Icon to indicate link
            }];
            this.isLoading = false;
            this.render();

            return;
        }

        this.searchTerm = query;
        this.isLoading = true;
        this.render(); // Show spinner

        try {
            const manager = game.ionrift?.sounds?.manager;
            if (manager) {
                // If filterOneshots is strictly true, maybe alter search logic?
                // For now, assuming manager.search handles general string search
                this.results = await manager.search(query);

                // Client-side Filter for "One-Shots Only"
                // Strict Mode: Only allow explicit OneShotElements (mapped to 'global-oneshot' or 'oneshot')
                // This removes generic 'element' (SFXElement) which are often looping.
                if (this.filterOneshots) {
                    this.results = this.results.filter(r =>
                        r.type === 'oneshot' ||
                        r.type === 'global-oneshot'
                    );
                }
            }
        } catch (err) {
            Logger.error(MODULE_LABEL, "Search failed:", err);
            ui.notifications.warn("Search failed.");
        } finally {
            this.isLoading = false;
            this.render();
        }
    }

    _onAddSound(event) {
        event.preventDefault();
        const id = event.currentTarget.dataset.id;
        const name = event.currentTarget.dataset.name;
        const type = event.currentTarget.dataset.type;
        const meta = event.currentTarget.dataset.meta;

        // Check duplicates
        if (this.currentBindings.some(b => b.id === id)) {
            ui.notifications.warn("Sound already in list.");
            return;
        }

        this.currentBindings.push({ id, name, type, meta });
        this.render();
    }

    _onRemoveBinding(event) {
        event.preventDefault();
        const idx = event.currentTarget.dataset.index;
        this.currentBindings.splice(idx, 1);
        this.render();
    }

    _validateDelayInputs($row, event) {
        // Fix: Use data-index to reliably find the object in the array
        const idx = $row.data("index");
        if (idx === undefined || idx === null) return;

        const binding = this.currentBindings[idx];
        if (!binding) return;

        const $min = $row.find("input[name='delayMin']");
        const $max = $row.find("input[name='delayMax']");

        let min = parseFloat($min.val()) || 0;
        let max = parseFloat($max.val()) || 0;

        // 1. Clamp to 0-10 range
        if (min < 0) min = 0;
        if (min > 10) min = 10;
        if (max < 0) max = 0;
        if (max > 10) max = 10;

        // 2. Ensure Min <= Max
        if (min > max) {
            // Determine which one changed to be helpful
            if (event && event.target.name === "delayMin") max = min;
            else min = max;
        }

        // 3. Update State (Source of Truth)
        binding.delayMin = min;
        binding.delayMax = max;

        // 4. Update UI to reflect clamped values
        $min.val(min);
        $max.val(max);


    }

    _onSave(event) {
        event.preventDefault();

        // Use currentBindings as the single source of truth
        const bindings = this.currentBindings;

        // Join IDs with commas for the simple ID string return
        const joinedId = bindings.map(b => b.id).join(",");

        // Heuristic: Use first item for display name/meta
        const first = bindings[0];

        if (this.callback) {
            if (bindings.length === 0) {
                this.callback(null); // Clear
            } else {
                // Return structured data
                this.callback({
                    id: joinedId,
                    name: first ? first.name : "",
                    type: first ? first.type : undefined,
                    meta: first ? first.meta : "",
                    // We also return the full items array which contains the delay config
                    items: bindings.map(b => ({
                        id: b.id,
                        name: b.name,
                        type: b.type,
                        meta: b.meta,
                        // Config object expected by handler
                        config: {
                            delayMin: b.delayMin || 0,
                            delayMax: b.delayMax || 0
                        }
                    }))
                });
            }
        }
        this.close();
    }

    async _onPlayPreview(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const parent = $(ev.currentTarget).closest(".result-row");
        const id = parent.data("id");
        const rawType = parent.data("type");

        // Map Picker Types to Provider Types
        let type = "element";
        if (rawType === "global-oneshot") type = "global-element";
        else if (rawType === "mood") type = "mood";
        else if (rawType === "music-element") type = "element";

        if (id) {
            const manager = game.ionrift?.sounds?.manager;
            if (manager) manager.play(id, { type: type });
        }
    }

    async _onPlayCurrent(ev) {
        ev.preventDefault();
        const id = ev.currentTarget.dataset.id;
        if (id) {
            const manager = game.ionrift?.sounds?.manager;
            if (manager) manager.playElement(id);
        }
    }
}
