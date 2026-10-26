import { createQuartermasterConfigApp } from "../QuartermasterSubmenuConfigApp.js";

export const IdentificationConfigApp = createQuartermasterConfigApp({
    appId: "qm-identification-config",
    title: "ionrift-quartermaster.config.identify.title",
    icon: "fas fa-eye-slash",
    get lead() { return game.i18n.localize("ionrift-quartermaster.config.identify.lead"); },
    get savedMessage() { return game.i18n.localize("ionrift-quartermaster.config.identify.savedMessage"); },
    rows: [
        {
            key: "obscureConsumables",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.identify.obscureConsumables.label"); },
            icon: "fas fa-flask",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.identify.obscureConsumables.hint"); },
            type: "boolean"
        },
        {
            key: "obscureScrolls",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.identify.obscureScrolls.label"); },
            icon: "fas fa-scroll",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.identify.obscureScrolls.hint"); },
            type: "boolean"
        },
        {
            key: "obscureMagicalItems",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.identify.obscureMagicalItems.label"); },
            icon: "fas fa-wand-sparkles",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.identify.obscureMagicalItems.hint"); },
            type: "boolean"
        },
        {
            key: "gmOnlyIdentification",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.identify.gmOnlyIdentification.label"); },
            icon: "fas fa-user-shield",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.identify.gmOnlyIdentification.hint"); },
            type: "boolean"
        }
    ]
});
