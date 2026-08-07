import { createQuartermasterConfigApp } from "./QuartermasterSubmenuConfigApp.js";
import { AmmoTypeConfigApp } from "./AmmoTypeConfigApp.js";
import { GenericArmorBonusConfigApp } from "./GenericArmorBonusConfigApp.js";
import { AmmoTypeRegistry } from "../../services/workshop/AmmoTypeRegistry.js";
import { GenericArmorBonusRegistry } from "../../services/workshop/GenericArmorBonusRegistry.js";

export const LootGenerationConfigApp = createQuartermasterConfigApp({
    appId: "qm-loot-generation-config",
    title: "IONRIFT.QUARTERMASTER.APP.LootGenerationConfigAppTitle",
    icon: "fas fa-coins",
    lead: "IONRIFT.QUARTERMASTER.CONFIG.LootGenerationLead",
    savedMessage: "IONRIFT.QUARTERMASTER.CONFIG.LootGenerationSaved",
    popouts: {
        ammoTypes: AmmoTypeConfigApp,
        genericArmorBonus: GenericArmorBonusConfigApp
    },
    rows: [
        { type: "section", label: "IONRIFT.QUARTERMASTER.CONFIG.SectionEconomy" },
        {
            key: "lootEconomy",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.lootEconomyName",
            icon: "fas fa-scale-balanced",
            hint: "IONRIFT.QUARTERMASTER.SETTINGS.lootEconomyHint",
            type: "range",
            min: 0.25,
            max: 3,
            step: 0.25
        },
        { type: "section", label: "IONRIFT.QUARTERMASTER.CONFIG.SectionEnhancement" },
        {
            key: "magicFrequency",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.magicFrequencyName",
            icon: "fas fa-wand-sparkles",
            hint: "IONRIFT.QUARTERMASTER.CONFIG.MagicFrequencyHint",
            type: "range",
            min: 0,
            max: 2,
            step: 0.25
        },
        {
            key: "armourDropChance",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.armourDropChanceName",
            icon: "fas fa-shield-halved",
            hint: "IONRIFT.QUARTERMASTER.CONFIG.ArmourDropChanceHint",
            type: "range",
            min: 0,
            max: 1,
            step: 0.05
        },
        {
            key: "genericArmorBonusConfig",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.genericArmorBonusConfigName",
            icon: "fas fa-shield-halved",
            hint: "IONRIFT.QUARTERMASTER.CONFIG.GenericArmorBonusHint",
            type: "popout",
            popout: "genericArmorBonus",
            summary: () => GenericArmorBonusRegistry.getSummaryLabel()
        },
        { type: "section", label: "IONRIFT.QUARTERMASTER.CONFIG.SectionNamedMagic" },
        {
            key: "namedMagicFrequency",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.namedMagicFrequencyName",
            icon: "fas fa-wand-sparkles",
            hint: "IONRIFT.QUARTERMASTER.CONFIG.NamedMagicFrequencyHint",
            type: "range",
            min: 0,
            max: 2,
            step: 0.25
        },
        { type: "column-break" },
        { type: "section", label: "IONRIFT.QUARTERMASTER.CONFIG.SectionConsumables" },
        {
            key: "healingPotionFrequency",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.healingPotionFrequencyName",
            icon: "fas fa-heart-pulse",
            hint: "IONRIFT.QUARTERMASTER.CONFIG.HealingPotionFrequencyHint",
            type: "range",
            min: 0,
            max: 4,
            step: 0.25
        },
        { type: "section", label: "IONRIFT.QUARTERMASTER.CONFIG.SectionAmmunition" },
        {
            key: "magicAmmoFrequency",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.magicAmmoFrequencyName",
            icon: "fas fa-bullseye",
            hint: "IONRIFT.QUARTERMASTER.CONFIG.MagicAmmoFrequencyHint",
            type: "range",
            min: 0,
            max: 2,
            step: 0.25
        },
        {
            key: "ammoTypeConfig",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.ammoTypeConfigName",
            icon: "fas fa-bullseye-arrow",
            hint: "IONRIFT.QUARTERMASTER.CONFIG.AmmoTypeConfigHint",
            type: "popout",
            popout: "ammoTypes",
            summary: () => AmmoTypeRegistry.getSummaryLabel()
        },
        { type: "section", label: "IONRIFT.QUARTERMASTER.CONFIG.SectionCoinage" },
        {
            key: "distributeCoins",
            label: "IONRIFT.QUARTERMASTER.SETTINGS.distributeCoinsName",
            icon: "fas fa-coins",
            hint: "IONRIFT.QUARTERMASTER.SETTINGS.distributeCoinsHint",
            type: "boolean"
        }
    ]
});
