import { SoundPickerApp } from "./SoundPickerApp.js";
import { getQuartermasterAdapter } from "../adapters/getAdapter.js";

export class WorkshopApp extends Application {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ionrift-quartermaster-app",
            title: "Ionrift Quartermaster",
            template: "modules/ionrift-quartermaster/templates/quartermaster.hbs",
            width: 800,
            height: 640,
            classes: ["ionrift-window", "glass-ui"],
            resizable: true
        });
    }

    constructor(item = null, options = {}) {
        super(options);
        this._editItem = item;
        this._pendingImage = item?.img || null;
    }

    getData() {
        const types = this._getItemTypes();
        const isEdit = !!this._editItem;
        const hasResonance = game.modules.get("ionrift-resonance")?.active ?? false;

        return {
            title: isEdit ? `Editing: ${this._editItem.name}` : "Item Quartermaster",
            types,
            isEdit,
            hasResonance,
            hasAnimations: game.modules.get("autoanimations")?.active || false,
            itemData: isEdit ? {
                name: this._editItem.name,
                type: this._editItem.type,
                description: this._extractDescription(this._editItem),
                img: this._editItem.img
            } : {},
            currentImage: this._pendingImage || (isEdit ? this._editItem.img : null)
        };
    }

    /** Returns system-appropriate item types */
    _getItemTypes() {
        return [...getQuartermasterAdapter().getWorkshopItemTypes()];
    }

    /** Extracts description as plain text from system-specific formats */
    _extractDescription(item) {
        const desc = item.system?.description;
        if (!desc) return "";
        const html = typeof desc === "string" ? desc : desc.value || "";
        // Strip HTML for textarea display
        return html
            .replace(/<p>/g, "")
            .replace(/<\/p>/g, "\n\n")
            .replace(/<br\s*\/?>/g, "\n")
            .replace(/<\/?b>/g, "")
            .replace(/<\/?strong>/g, "")
            .replace(/<\/?em>/g, "")
            .replace(/<\/?i>/g, "")
            .replace(/&nbsp;/g, " ")
            .trim();
    }

    activateListeners(html) {
        super.activateListeners(html);

        html.find(".action-create").click(this._onCreateItem.bind(this));
        html.find(".action-search-sound").click(this._onSearchSound.bind(this));

        html.find(".action-pick-image").click(this._onPickImage.bind(this));
    }

    async _onPickImage(event) {
        event.preventDefault();
        const fp = new FilePicker({
            type: "image",
            current: this._pendingImage || "icons/",
            callback: (path) => {
                this._pendingImage = path;
                const preview = this.element.find(".item-image-preview");
                if (preview.length) {
                    preview.attr("src", path);
                    preview.closest(".image-preview-container").removeClass("empty");
                }
            }
        });
        fp.render(true);
    }

    async _onCreateItem(event) {
        event.preventDefault();
        const form = this.element.find("form")[0];
        const formData = Object.fromEntries(new FormData(form));

        if (!formData.name || !formData.type) {
            ui.notifications.warn("Please specify a Name and Type.");
            return;
        }

        // Prepare item data
        let itemData = {
            name: formData.name,
            type: formData.type,
            system: {
                equipped: false,
            },
            img: this._pendingImage || "icons/svg/mystery-man.svg"
        };

        // Sound bindings (only if Resonance is active)
        if (game.modules.get("ionrift-resonance")?.active) {
            itemData.flags = {
                "ionrift-resonance": {
                    "sound_attack": formData.sound_attack || "",
                    "sound_use": formData.sound_use || "",
                    "sound_equip": formData.sound_equip || "",
                    "sound_unequip": formData.sound_unequip || ""
                }
            };
        }

        // Format description
        let finalDescription = formData.description || "";
        if (finalDescription.includes("\n") && !finalDescription.includes("<p>")) {
            finalDescription = finalDescription
                .split(/\n+/)
                .filter(line => line.trim().length > 0)
                .map(line => `<p>${line.trim()}</p>`)
                .join("");
        }

        // System-specific description format
        if (game.system.id === "daggerheart") {
            itemData.system.description = finalDescription;
        } else {
            itemData.system.description = { value: finalDescription };
        }

        // Edit mode: update existing item
        if (this._editItem) {
            await this._editItem.update({
                name: itemData.name,
                type: itemData.type,
                "system.description": itemData.system.description,
                img: itemData.img,
                ...(itemData.flags ? { flags: itemData.flags } : {})
            });
            ui.notifications.info(`Updated: ${this._editItem.name}`);
            this._editItem.sheet.render(true);
            this.close();
            return;
        }

        // Create mode
        const item = await Item.create(itemData);
        if (item) {
            ui.notifications.info(`Forged: ${item.name}`);
            item.sheet.render(true);
            this.close();
        }
    }

    async _onSearchSound(event) {
        event.preventDefault();
        if (!game.modules.get("ionrift-resonance")?.active) {
            ui.notifications.warn("Ionrift Resonance is required for sound binding.");
            return;
        }

        const targetName = event.currentTarget.dataset.target;
        const input = this.element.find(`input[name='${targetName}']`);

        new SoundPickerApp((result) => {
            const currentVal = input.val();

            if (targetName === "sound_use" && currentVal.length > 0) {
                input.val(currentVal + ", " + result.id);
            } else {
                input.val(result.id);
            }

            ui.notifications.info(`Selected Sound: ${result.name} (${result.id})`);
        }).render(true);
    }

}

