export class SheetInjector {
    static init() {
        // V1 / Legacy (ApplicationV1 sheets)
        Hooks.on("getActorSheetHeaderButtons", (app, buttons) => this._onGetHeaderButtons(app, buttons));
        Hooks.on("getItemSheetHeaderButtons", (app, buttons) => this._onGetHeaderButtons(app, buttons));

        // V2 / Modern (ApplicationV2, DnD5e v4+)
        Hooks.on("getApplicationHeaderControls", (app, controls) => this._onGetHeaderControls(app, controls));
    }

    /** ApplicationV1 header button injection */
    static _onGetHeaderButtons(app, buttons) {
        if (!this._shouldInject(app)) return;

        buttons.unshift({
            label: "Sounds",
            class: "ionrift-sound-config",
            icon: "fas fa-volume-up",
            onclick: () => this.openSoundPicker(app.document)
        });
    }

    /** ApplicationV2 header control injection */
    static _onGetHeaderControls(app, controls) {
        if (!this._shouldInject(app)) return;

        controls.push({
            label: "Ionrift Sounds",
            icon: "fas fa-volume-up",
            class: "ionrift-sound-config",
            action: "ionrift-sound-config",
            onClick: () => this.openSoundPicker(app.document)
        });
    }

    static _shouldInject(app) {
        if (!game.modules.get("ionrift-resonance")?.active) return false;

        const doc = app.document;
        if (!doc) return false;

        return (doc.documentName === "Actor" || doc.documentName === "Item");
    }

    static async openSoundPicker(doc) {
        if (!doc) return;

        if (doc.documentName === "Actor") {
            const { ActorSoundConfig } = await import("../../apps/sound/ActorSoundConfig.js");
            new ActorSoundConfig(doc).render(true);
        } else if (doc.documentName === "Item") {
            const { ItemSoundConfig } = await import("../../apps/sound/ItemSoundConfig.js");
            new ItemSoundConfig(doc).render(true);
        }
    }
}
