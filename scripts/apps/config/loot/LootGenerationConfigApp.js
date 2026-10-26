import { createQuartermasterConfigApp } from "../QuartermasterSubmenuConfigApp.js";
import { AmmoTypeConfigApp } from "./AmmoTypeConfigApp.js";
import { GenericArmorBonusConfigApp } from "./GenericArmorBonusConfigApp.js";
import { AmmoTypeRegistry } from "../../../services/workshop/AmmoTypeRegistry.js";
import { GenericArmorBonusRegistry } from "../../../services/workshop/GenericArmorBonusRegistry.js";
import { getQuartermasterAdapter } from "../../../adapters/getAdapter.js";
import { QM_FEATURES } from "../../../data/QMFeatures.js";

const supportsMagicalLootTuning = () => getQuartermasterAdapter().supports(QM_FEATURES.LATENT_MASKING);

export const LootGenerationConfigApp = createQuartermasterConfigApp({
    appId: "qm-loot-generation-config",
    title: "ionrift-quartermaster.config.lootGen.title",
    icon: "fas fa-coins",
    get lead() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.lead"); },
    get savedMessage() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.savedMessage"); },
    popouts: {
        ammoTypes: AmmoTypeConfigApp,
        genericArmorBonus: GenericArmorBonusConfigApp
    },
    rows: [
        { type: "section", get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.section.economy"); } },
        {
            key: "lootEconomy",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.lootEconomy.label"); },
            icon: "fas fa-scale-balanced",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.lootEconomy.hint"); },
            type: "range",
            min: 0.25,
            max: 3,
            step: 0.25
        },
        { type: "section", get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.section.enhancement"); }, visible: supportsMagicalLootTuning },
        {
            key: "magicFrequency",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.magicFrequency.label"); },
            icon: "fas fa-wand-sparkles",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.magicFrequency.hint"); },
            type: "range",
            min: 0,
            max: 2,
            step: 0.25,
            visible: supportsMagicalLootTuning
        },
        {
            key: "armourDropChance",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.armourDropChance.label"); },
            icon: "fas fa-shield-halved",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.armourDropChance.hint"); },
            type: "range",
            min: 0,
            max: 1,
            step: 0.05,
            visible: supportsMagicalLootTuning
        },
        {
            key: "genericArmorBonusConfig",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.genericArmorBonusConfig.label"); },
            icon: "fas fa-shield-halved",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.genericArmorBonusConfig.hint"); },
            type: "popout",
            popout: "genericArmorBonus",
            summary: () => GenericArmorBonusRegistry.getSummaryLabel(),
            visible: supportsMagicalLootTuning
        },
        { type: "section", get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.section.namedMagic"); }, visible: supportsMagicalLootTuning },
        {
            key: "namedMagicFrequency",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.namedMagicFrequency.label"); },
            icon: "fas fa-wand-sparkles",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.namedMagicFrequency.hint"); },
            type: "range",
            min: 0,
            max: 2,
            step: 0.25,
            visible: supportsMagicalLootTuning
        },
        { type: "column-break", visible: supportsMagicalLootTuning },
        { type: "section", get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.section.consumables"); } },
        {
            key: "healingPotionFrequency",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.healingPotionFrequency.label"); },
            icon: "fas fa-heart-pulse",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.healingPotionFrequency.hint"); },
            type: "range",
            min: 0,
            max: 4,
            step: 0.25
        },
        { type: "section", get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.section.ammunition"); } },
        {
            key: "magicAmmoFrequency",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.magicAmmoFrequency.label"); },
            icon: "fas fa-bullseye",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.magicAmmoFrequency.hint"); },
            type: "range",
            min: 0,
            max: 2,
            step: 0.25,
            visible: supportsMagicalLootTuning
        },
        {
            key: "ammoTypeConfig",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.ammoTypeConfig.label"); },
            icon: "fas fa-bullseye-arrow",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.ammoTypeConfig.hint"); },
            type: "popout",
            popout: "ammoTypes",
            summary: () => AmmoTypeRegistry.getSummaryLabel()
        },
        { type: "section", get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.section.coinage"); } },
        {
            key: "distributeCoins",
            get label() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.distributeCoins.label"); },
            icon: "fas fa-coins",
            get hint() { return game.i18n.localize("ionrift-quartermaster.config.lootGen.distributeCoins.hint"); },
            type: "boolean"
        }
    ]
});
