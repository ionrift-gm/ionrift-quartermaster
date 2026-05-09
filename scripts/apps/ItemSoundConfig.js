export class ItemSoundConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ionrift-item-sound-config",
            title: "Item Sound Configuration",
            template: "modules/ionrift-quartermaster/templates/item-sound-config.hbs",
            width: 500,
            height: "auto",
            classes: ["ionrift-window", "glass-ui"],
            closeOnSubmit: false,
            submitOnChange: false,
            resizable: true
        });
    }

    constructor(item) {
        super();
        this.item = item;
    }

    getData() {
        const slots = [
            { key: "sound_attack", label: "Attack / Cast", icon: "fas fa-khanda" },
            { key: "sound_use", label: "Use / Generic", icon: "fas fa-hand-sparkles" },
            { key: "sound_equip", label: "Equip", icon: "fas fa-tshirt" },
            { key: "sound_unequip", label: "Unequip", icon: "fas fa-box-open" }
        ];

        return {
            itemName: this.item.name,
            itemImg: this.item.img,
            slots: slots.map(slot => {
                const val = this.item.getFlag("ionrift-resonance", slot.key);
                const name = this.item.getFlag("ionrift-resonance", slot.key + "_name");
                const meta = this.item.getFlag("ionrift-resonance", slot.key + "_meta");
                return {
                    ...slot,
                    value: val,
                    displayValue: name || val,
                    meta: meta,
                    hasValue: !!val
                };
            })
        };
    }

    activateListeners(html) {
        super.activateListeners(html);

        // search
        html.find(".action-search").click(this._onSearch.bind(this));

        // play
        html.find(".action-play").click(this._onPlay.bind(this));

        // clear
        html.find(".action-clear").click(this._onClear.bind(this));
    }

    async _onSearch(event) {
        event.preventDefault();
        const key = event.currentTarget.dataset.key;

        // Launch Picker via Injector logic (reusing existing flow)
        // Check if SheetInjector is exported? It is.
        // But better to just instantiate SoundPickerApp directly since we are in the same module structure
        const { SoundPickerApp } = await import("./SoundPickerApp.js");

        const currentSoundId = this.item.getFlag("ionrift-resonance", key);
        const currentSoundName = this.item.getFlag("ionrift-resonance", key + "_name");
        const currentSoundMeta = this.item.getFlag("ionrift-resonance", key + "_meta");
        const existingConfig = this.item.getFlag("ionrift-resonance", "sound_config") || {};

        new SoundPickerApp(async (result) => {
            if (result === null) {
                // Removal
                await this.item.unsetFlag("ionrift-resonance", key);
                await this.item.unsetFlag("ionrift-resonance", key + "_name");
                await this.item.unsetFlag("ionrift-resonance", key + "_meta");
            } else {
                // Set/Update
                await this.item.setFlag("ionrift-resonance", key, result.id);
                await this.item.setFlag("ionrift-resonance", key + "_name", result.name);
                await this.item.setFlag("ionrift-resonance", key + "_meta", result.meta);

                // Update Config (Merge)
                if (result.config) {
                    const newConfig = { ...existingConfig, ...result.config };
                    await this.item.setFlag("ionrift-resonance", "sound_config", newConfig);
                }
            }
            this.render(); // Refresh ItemSoundConfig
        }, {
            currentSoundId: currentSoundId,
            currentSoundName: currentSoundName,
            currentSoundMeta: currentSoundMeta,
            soundConfig: existingConfig,
            title: `Bind ${key} for ${this.item.name}`
        }).render(true);
    }

    async _onPlay(event) {
        event.preventDefault();
        const key = event.currentTarget.dataset.key;
        const val = this.item.getFlag("ionrift-resonance", key);

        if (val) {
            const manager = game.ionrift?.sounds?.manager;
            if (manager) {
                manager.provider.playSound(val);
            }
        }
    }

    async _onClear(event) {
        event.preventDefault();
        const key = event.currentTarget.dataset.key;
        await this.item.unsetFlag("ionrift-resonance", key);
        this.render();
    }
}
