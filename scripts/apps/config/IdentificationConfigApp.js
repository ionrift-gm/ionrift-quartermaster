import { createQuartermasterConfigApp } from "./QuartermasterSubmenuConfigApp.js";

export const IdentificationConfigApp = createQuartermasterConfigApp({
    appId: "qm-identification-config",
    title: "Identification",
    icon: "fas fa-eye-slash",
    lead: "Control how unidentified loot appears on sheets and in chat before the party examines it.",
    savedMessage: "Identification settings saved.",
    rows: [
        {
            key: "obscureConsumables",
            label: "Obscure Consumables",
            icon: "fas fa-flask",
            hint: "Potions and oils use generic names until identified. Off shows true names for common items like Potions of Healing.",
            type: "boolean"
        },
        {
            key: "obscureScrolls",
            label: "Obscure Spell Scrolls",
            icon: "fas fa-scroll",
            hint: "Spell scrolls appear as Unidentified Scroll until examined. Off shows spell names directly.",
            type: "boolean"
        },
        {
            key: "obscureMagicalItems",
            label: "Obscure Magical Items",
            icon: "fas fa-wand-sparkles",
            hint: "Weapons, armor, wondrous gear, and foci use mundane names until identified. Off shows true names and properties on the sheet.",
            type: "boolean"
        },
        {
            key: "gmOnlyIdentification",
            label: "GM-Only Identification",
            icon: "fas fa-user-shield",
            hint: "When on, the sheet identification toggle is GM-only. Players cannot flip masked loot to the generic unidentified label.",
            type: "boolean"
        }
    ]
});
