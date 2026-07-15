import { SoundPickerApp } from "./SoundPickerApp.js";

export class ActorSoundConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ionrift-actor-sound-config",
            title: "Actor Sound Configuration",
            template: "modules/ionrift-quartermaster/templates/actor-sound-config.hbs",
            width: 500,
            height: "auto",
            classes: ["ionrift-window", "glass-ui"],
            closeOnSubmit: false,
            submitOnChange: false,
            resizable: true
        });
    }

    _getHeaderButtons() {
        // Filter out "Voice" button (likely from another module or core) as per user request
        return super._getHeaderButtons().filter(b => b.label !== "Voice");
    }

    constructor(actor) {
        super();
        this.actor = actor;
    }

    getData() {
        // Voice / Identity
        const currentIdentity = this.actor.getFlag("ionrift-resonance", "identity") || "masculine";
        // Ensure legacy "female" converts to "feminine" just in case
        const identityLabel = (currentIdentity === "feminine" || currentIdentity === "female") ? "Feminine" : "Masculine";

        // Define Actor-specific sound slots
        const slots = [
            { key: "sound_pain", label: "Pain / Hit", icon: "fas fa-heart-broken" },
            { key: "sound_death", label: "Death", icon: "fas fa-skull" },
            { key: "sound_crit_given", label: "Critical Hit (Dealt)", icon: "fas fa-bullseye" },
            { key: "sound_crit_received", label: "Critical Hit (Received)", icon: "fas fa-shield-alt" },
            { key: "sound_battle_theme", label: "Combat Theme", icon: "fas fa-music", hint: "Music played when this actor enters combat (Entity Start)." }
        ];

        return {
            actorName: this.actor.name,
            actorImg: this.actor.img,
            voice: currentIdentity,
            // We pass options for the helper or manual iteration
            voiceOptions: { masculine: "Deep / Low (Masculine)", feminine: "Bright / High (Feminine)" },
            slots: slots.map(slot => {
                const val = this.actor.getFlag("ionrift-resonance", slot.key);
                const name = this.actor.getFlag("ionrift-resonance", slot.key + "_name");
                const meta = this.actor.getFlag("ionrift-resonance", slot.key + "_meta");

                let display = name || val;

                // MULTI-SOUND DISPLAY LOGIC
                if (val && typeof val === "string" && val.includes(",")) {
                    const count = val.split(",").filter(s => s.trim()).length;
                    if (count > 1) {
                        display = `${count} Sounds (Randomized)`;
                    }
                }

                if (!val) {
                    if (slot.key === "sound_pain" || slot.key === "sound_death") {
                        display = `Default (${identityLabel})`;
                    } else {
                        display = "Default (System)";
                    }
                }

                return {
                    ...slot,
                    value: val,
                    displayValue: display,
                    meta: meta,
                    hasValue: !!val
                };
            })
        };
    }

    activateListeners(html) {
        super.activateListeners(html);

        // Voice
        html.find("select[name='identity']").change(async (ev) => {
            const val = ev.target.value;
            await this.actor.setFlag("ionrift-resonance", "identity", val);
            this.render();
        });

        // search
        html.find(".action-search").click(this._onSearch.bind(this));

        // Save & Close
        html.find(".action-save").click((ev) => {
            ev.preventDefault();
            this.close();
            ui.notifications.info(`Ionrift Sounds: Configuration Saved for ${this.actor.name}.`);
        });

        // play
        html.find(".action-play").click(this._onPlay.bind(this));

        // clear
        html.find(".action-clear").click(this._onClear.bind(this));
    }

    async _onSearch(event) {
        event.preventDefault();
        const key = event.currentTarget.dataset.key;

        const currentSoundId = this.actor.getFlag("ionrift-resonance", key);
        const currentSoundName = this.actor.getFlag("ionrift-resonance", key + "_name");
        const currentSoundMeta = this.actor.getFlag("ionrift-resonance", key + "_meta");

        // Resolve Default
        let defaultSoundId = null;
        let defaultSoundName = "System Default";

        if (game.ionrift?.resonance?.handler ?? game.ionrift?.handler) {
            const h = game.ionrift?.resonance?.handler ?? game.ionrift?.handler;
            if (key === "sound_pain") {
                const keyId = h.getPCSound(this.actor, "PAIN");
                defaultSoundId = h.resolveSound(keyId);
                const i = this.actor.getFlag("ionrift-resonance", "identity") || "masculine";
                defaultSoundName = `Default (${i === "feminine" ? "Feminine" : "Masculine"} Pain)`;
            } else if (key === "sound_death") {
                const keyId = h.getPCSound(this.actor, "DEATH");
                defaultSoundId = h.resolveSound(keyId);
                const i = this.actor.getFlag("ionrift-resonance", "identity") || "masculine";
                defaultSoundName = `Default (${i === "feminine" ? "Feminine" : "Masculine"} Death)`;
            }
        }

        // Load existing global sound config for this actor
        const existingConfig = this.actor.getFlag("ionrift-resonance", "sound_config") || {};

        new SoundPickerApp(async (result) => {
            if (result === null) {
                // Removal
                await this.actor.unsetFlag("ionrift-resonance", key);
                await this.actor.unsetFlag("ionrift-resonance", key + "_name");
                await this.actor.unsetFlag("ionrift-resonance", key + "_meta");
            } else {
                // Set/Update
                await this.actor.setFlag("ionrift-resonance", key, result.id);
                await this.actor.setFlag("ionrift-resonance", key + "_name", result.name);
                await this.actor.setFlag("ionrift-resonance", key + "_meta", result.meta);

                // Update Config (Merge)
                if (result.config) {
                    const newConfig = { ...existingConfig, ...result.config };
                    await this.actor.setFlag("ionrift-resonance", "sound_config", newConfig);
                }
            }
            this.render();
        }, {
            currentSoundId: currentSoundId,
            currentSoundName: currentSoundName,
            currentSoundMeta: currentSoundMeta,
            defaultSoundId: defaultSoundId,
            defaultSoundName: defaultSoundName,
            soundConfig: existingConfig, // Pass full config context
            title: `Bind ${key} for ${this.actor.name}`
        }).render(true);
    }

    async _onPlay(event) {
        event.preventDefault();
        const key = event.currentTarget.dataset.key;
        let val = this.actor.getFlag("ionrift-resonance", key);

        if (val) {
            // Handle Multiple Sounds (Randomize)
            if (typeof val === "string" && val.includes(",")) {
                const choices = val.split(",").map(s => s.trim()).filter(s => s);
                if (choices.length > 0) {
                    val = choices[Math.floor(Math.random() * choices.length)];
                }
            }

            const manager = game.ionrift?.sounds?.manager;
            if (manager) {
                // Try to use the handler if available for smarter playback, or direct provider
                const handler = game.ionrift?.resonance?.handler ?? game.ionrift?.handler;
                if (handler) {
                    handler.play(val);
                } else {
                    manager.provider.playSound(val);
                }
            }
        }
    }

    async _onClear(event) {
        event.preventDefault();
        const key = event.currentTarget.dataset.key;
        await this.actor.unsetFlag("ionrift-resonance", key);
        await this.actor.unsetFlag("ionrift-resonance", key + "_name");
        await this.actor.unsetFlag("ionrift-resonance", key + "_meta");
        this.render();
    }
}
