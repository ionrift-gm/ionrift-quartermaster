import { createQuartermasterConfigApp } from "./QuartermasterSubmenuConfigApp.js";

export const IdentificationConfigApp = createQuartermasterConfigApp({
    appId: "qm-identification-config",
    title: "IONRIFT.QUARTERMASTER.APP.IdentificationConfigAppTitle",
    icon: "fas fa-eye-slash",
    lead: "IONRIFT.QUARTERMASTER.CONFIG.IdentificationLead",
    savedMessage: "IONRIFT.QUARTERMASTER.CONFIG.IdentificationSaved",
    rows: [
        {
            key: "obscureConsumables",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.obscureConsumablesName",
            icon: "fas fa-flask",
            hint: "IONRIFT.QUARTERMASTER.CONFIG.ObscureConsumablesHint",
            type: "boolean"
        },
        {
            key: "obscureScrolls",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.obscureScrollsName",
            icon: "fas fa-scroll",
            hint: "IONRIFT.QUARTERMASTER.CONFIG.ObscureScrollsHint",
            type: "boolean"
        },
        {
            key: "obscureMagicalItems",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.obscureMagicalItemsName",
            icon: "fas fa-wand-sparkles",
            hint: "IONRIFT.QUARTERMASTER.CONFIG.ObscureMagicalItemsHint",
            type: "boolean"
        },
        {
            key: "gmOnlyIdentification",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.gmOnlyIdentificationName",
            icon: "fas fa-user-shield",
            hint: "IONRIFT.QUARTERMASTER.CONFIG.GmOnlyIdentificationHint",
            type: "boolean"
        }
    ]
});
