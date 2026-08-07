import { SoundPickerApp } from "./SoundPickerApp.js";
import { localize, format } from "../../utils/I18n.js";

export class ActorSoundConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ionrift-actor-sound-config",
            title: localize("IONRIFT.QUARTERMASTER.SOUND.ActorConfigTitle"),
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
        const isFeminine = currentIdentity === "feminine" || currentIdentity === "female";
        const identityLabel = localize(
            isFeminine
                ? "IONRIFT.QUARTERMASTER.SOUND.IdentityFeminine"
                : "IONRIFT.QUARTERMASTER.SOUND.IdentityMasculine"
        );

        // Define Actor-specific sound slots
        const slots = [
            { key: "sound_pain", label: localize("IONRIFT.QUARTERMASTER.SOUND.PainHit"), icon: "fas fa-heart-broken" },
            { key: "sound_death", label: localize("IONRIFT.QUARTERMASTER.SOUND.Death"), icon: "fas fa-skull" },
            { key: "sound_crit_given", label: localize("IONRIFT.QUARTERMASTER.SOUND.CritDealt"), icon: "fas fa-bullseye" },
            { key: "sound_crit_received", label: localize("IONRIFT.QUARTERMASTER.SOUND.CritReceived"), icon: "fas fa-shield-alt" },
            { key: "sound_battle_theme", label: localize("IONRIFT.QUARTERMASTER.SOUND.CombatTheme"), icon: "fas fa-music", hint: localize("IONRIFT.QUARTERMASTER.SOUND.CombatThemeHint") }
        ];

        return {
            actorName: this.actor.name,
            actorImg: this.actor.img,
            voice: currentIdentity,
            // Display labels localized; option values stay as identity tokens
            voiceOptions: {
                masculine: localize("IONRIFT.QUARTERMASTER.SOUND.VoiceDeepLow"),
                feminine: localize("IONRIFT.QUARTERMASTER.SOUND.VoiceBrightHigh")
            },
            slots: slots.map(slot => {
                const val = this.actor.getFlag("ionrift-resonance", slot.key);
                const name = this.actor.getFlag("ionrift-resonance", slot.key + "_name");
                const meta = this.actor.getFlag("ionrift-resonance", slot.key + "_meta");

                let display = name || val;

                // MULTI-SOUND DISPLAY LOGIC
                if (val && typeof val === "string" && val.includes(",")) {
                    const count = val.split(",").filter(s => s.trim()).length;
                    if (count > 1) {
                        display = format("IONRIFT.QUARTERMASTER.SOUND.SoundsRandomized", { count });
                    }
                }

                if (!val) {
                    if (slot.key === "sound_pain" || slot.key === "sound_death") {
                        display = format("IONRIFT.QUARTERMASTER.SOUND.DefaultIdentity", { identity: identityLabel });
                    } else {
                        display = localize("IONRIFT.QUARTERMASTER.SOUND.DefaultSystem");
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
            ui.notifications.info(format("IONRIFT.QUARTERMASTER.SOUND.SavedFor", { name: this.actor.name }));
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
        let defaultSoundName = localize("IONRIFT.QUARTERMASTER.SOUND.SystemDefault");

        if (game.ionrift?.resonance?.handler ?? game.ionrift?.handler) {
            const h = game.ionrift?.resonance?.handler ?? game.ionrift?.handler;
            if (key === "sound_pain") {
                const keyId = h.getPCSound(this.actor, "PAIN");
                defaultSoundId = h.resolveSound(keyId);
                const i = this.actor.getFlag("ionrift-resonance", "identity") || "masculine";
                const identity = localize(
                    i === "feminine"
                        ? "IONRIFT.QUARTERMASTER.SOUND.IdentityFeminine"
                        : "IONRIFT.QUARTERMASTER.SOUND.IdentityMasculine"
                );
                defaultSoundName = format("IONRIFT.QUARTERMASTER.SOUND.DefaultIdentityPain", { identity });
            } else if (key === "sound_death") {
                const keyId = h.getPCSound(this.actor, "DEATH");
                defaultSoundId = h.resolveSound(keyId);
                const i = this.actor.getFlag("ionrift-resonance", "identity") || "masculine";
                const identity = localize(
                    i === "feminine"
                        ? "IONRIFT.QUARTERMASTER.SOUND.IdentityFeminine"
                        : "IONRIFT.QUARTERMASTER.SOUND.IdentityMasculine"
                );
                defaultSoundName = format("IONRIFT.QUARTERMASTER.SOUND.DefaultIdentityDeath", { identity });
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
            title: format("IONRIFT.QUARTERMASTER.SOUND.BindFor", { key, name: this.actor.name })
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
