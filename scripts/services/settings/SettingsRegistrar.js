import { MODULE_ID } from "../../data/moduleId.js";
/**
 * @module SettingsRegistrar
 * @description Registers Quartermaster settings, menus, and layout footer.
 */

import { LootGenerationConfigApp } from "../../apps/config/LootGenerationConfigApp.js";
import { IdentificationConfigApp } from "../../apps/config/IdentificationConfigApp.js";

import { SignatureLedger } from "../progression/SignatureLedger.js";
import { registerQuartermasterSettingsPanel } from "./SettingsPanelLayout.js";
import { AmmoTypeRegistry } from "../workshop/AmmoTypeRegistry.js";
import { GenericArmorBonusRegistry, DEFAULT_GENERIC_ARMOR_BONUS } from "../workshop/GenericArmorBonusRegistry.js";


/**
 * @param {object} opts
 * @param {typeof import("../../apps/forge/CompendiumForgeApp.js").CompendiumForgeApp} opts.CompendiumForgeApp
 */
export function registerQuartermasterSettings({ CompendiumForgeApp }) {

    game.settings.register(MODULE_ID, "distributeCoins", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.distributeCoinsName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.distributeCoinsHint",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        requiresReload: false,
        restricted: true
    });

    game.settings.register(MODULE_ID, "defaultCacheTier", {
        scope: "world",
        config: false,
        type: Number,
        default: 1
    });

    game.settings.register(MODULE_ID, "defaultCacheTheme", {
        scope: "world",
        config: false,
        type: String,
        default: "dungeon"
    });

    game.settings.register(MODULE_ID, "defaultCacheOwnerTheme", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.defaultCacheOwnerThemeName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.defaultCacheOwnerThemeHint",
        scope: "world",
        config: false,
        type: String,
        default: "unspecified"
    });

    game.settings.register(MODULE_ID, "ledgerHiddenActors", {
        scope: "world",
        config: false,
        type: String,
        default: "[]",
        restricted: true
    });

    game.settings.register(MODULE_ID, "advisoryCollapsed", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.advisoryCollapsedName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.advisoryCollapsedHint",
        scope: "client",
        config: false,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, "cacheBudgetAnchorPct", {
        scope: "client",
        config: false,
        type: Number,
        default: -1
    });

    game.settings.register(MODULE_ID, "cacheBudgetBracketIndex", {
        scope: "client",
        config: false,
        type: Number,
        default: -1
    });

    game.settings.register(MODULE_ID, "workshopEnabledPacks", {
        scope: "world",
        config: false,
        type: Object,
        default: {},
        restricted: true
    });

    game.settings.register(MODULE_ID, "workshopImportedPacks", {
        scope: "world",
        config: false,
        type: Object,
        default: {},
        restricted: true
    });

    game.settings.register(MODULE_ID, "lootPoolSources", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.lootPoolSourcesName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.lootPoolSourcesHint",
        scope: "world",
        config: false,
        type: String,
        default: JSON.stringify([
            "dnd5e.items", "dnd5e.tradegoods",
            "world.ionrift-forged-scrolls"
        ]),
        onChange: () => {
            import("../loot/ItemPoolResolver.js").then(m => m.ItemPoolResolver.clearCache());
        }
    });

    game.settings.register(MODULE_ID, "lootEconomy", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.lootEconomyName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.lootEconomyHint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.25, max: 3.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "magicFrequency", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.magicFrequencyName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.magicFrequencyHint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 2.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "armourDropChance", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.armourDropChanceName",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 1.0, step: 0.05 },
        default: 0.65,
        restricted: true
    });

    game.settings.register(MODULE_ID, "namedMagicFrequency", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.namedMagicFrequencyName",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 2.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "magicAmmoFrequency", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.magicAmmoFrequencyName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.magicAmmoFrequencyHint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 2.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "healingPotionFrequency", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.healingPotionFrequencyName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.healingPotionFrequencyHint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 4.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "ammoTypeTilt", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.ammoTypeTiltName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.ammoTypeTiltHint",
        scope: "world",
        config: false,
        type: String,
        choices: {
            balanced: "IONRIFT.QUARTERMASTER.SETTINGS.ammoTypeTiltChoices.balanced",
            arrows: "IONRIFT.QUARTERMASTER.SETTINGS.ammoTypeTiltChoices.arrows",
            bolts: "IONRIFT.QUARTERMASTER.SETTINGS.ammoTypeTiltChoices.bolts",
            sling: "IONRIFT.QUARTERMASTER.SETTINGS.ammoTypeTiltChoices.sling",
            mixed: "IONRIFT.QUARTERMASTER.SETTINGS.ammoTypeTiltChoices.mixed",
            custom: "IONRIFT.QUARTERMASTER.SETTINGS.ammoTypeTiltChoices.custom"
        },
        default: "balanced",
        restricted: true,
        onChange: (value) => {
            if (value === "custom") return;
            const config = AmmoTypeRegistry.applyPreset(value);
            game.settings.set(MODULE_ID, "ammoTypeConfig", JSON.stringify(config));
        }
    });

    game.settings.register(MODULE_ID, "ammoTypeConfig", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.ammoTypeConfigName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.ammoTypeConfigHint",
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });

    game.settings.register(MODULE_ID, "genericArmorBonusConfig", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.genericArmorBonusConfigName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.genericArmorBonusConfigHint",
        scope: "world",
        config: false,
        type: String,
        default: JSON.stringify(DEFAULT_GENERIC_ARMOR_BONUS),
        restricted: true,
        onChange: () => {
            import("../loot/ItemPoolResolver.js").then(m => m.ItemPoolResolver.clearCache());
        }
    });

    game.settings.register(MODULE_ID, "obscureConsumables", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.obscureConsumablesName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.obscureConsumablesHint",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "obscureScrolls", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.obscureScrollsName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.obscureScrollsHint",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "obscureMagicalItems", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.obscureMagicalItemsName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.obscureMagicalItemsHint",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "gmOnlyIdentification", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.gmOnlyIdentificationName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.gmOnlyIdentificationHint",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "milestoneProfile", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.milestoneProfileName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.milestoneProfileHint",
        scope: "world",
        config: true,
        type: String,
        choices: Object.fromEntries(
            Object.keys(SignatureLedger.PROFILES).map(k => [
                k,
                `IONRIFT.QUARTERMASTER.SETTINGS.milestoneProfileChoices.${k}`
            ])
        ),
        default: "full",
        restricted: true,
        requiresReload: false,
        onChange: () => {
            for (const w of Object.values(ui.windows)) {
                if (w.constructor.name === "SignatureLedgerApp") w.render(false);
            }
        }
    });

    game.settings.register(MODULE_ID, "scrollForgeEnabled", {
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollForgeHash", {
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollForgeMeta", {
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollForgeSpellPacks", {
        scope: "world",
        config: false,
        type: String,
        default: "[]",
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollForgeCandidateSnapshot", {
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });

    game.settings.register(MODULE_ID, "compiledContentPacks", {
        scope: "world",
        config: false,
        type: String,
        default: "{}",
        restricted: true
    });

    game.settings.register(MODULE_ID, "compiledLootPoolHash", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.compiledLootPoolHashName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.compiledLootPoolHashHint",
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });

    game.settings.register(MODULE_ID, "compiledLootPoolMeta", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.compiledLootPoolMetaName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.compiledLootPoolMetaHint",
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });

    game.settings.register(MODULE_ID, "materialisedOverlayPacks", {
        scope: "world",
        config: false,
        type: String,
        default: "{}",
        restricted: true
    });

    game.settings.register(MODULE_ID, "partyShelfSources", {
        scope: "world",
        config: false,
        type: String,
        default: JSON.stringify(["dnd5e.items"]),
        restricted: true
    });

    game.settings.register(MODULE_ID, "cursedItemSources", {
        scope: "world",
        config: false,
        type: String,
        default: JSON.stringify(["world.ionrift-srd-cursed"]),
        restricted: true,
        onChange: () => {
            import("../loot/ItemPoolResolver.js").then(m => {
                m.ItemPoolResolver._cursedBlocklist = null;
            });
        }
    });

    game.settings.register(MODULE_ID, "cursedPlanned", {
        scope: "world",
        config: false,
        type: String,
        default: "[]",
        restricted: true
    });

    game.settings.register(MODULE_ID, "cursedPool", {
        scope: "world",
        config: false,
        type: String,
        default: "[]",
        restricted: true
    });

    game.settings.register(MODULE_ID, "cursedT3Enabled", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.cursedT3EnabledName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.cursedT3EnabledHint",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "cursedT4Enabled", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.cursedT4EnabledName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.cursedT4EnabledHint",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "srdCurseHash", {
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });

    game.settings.register(MODULE_ID, "srdCurseMeta", {
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });

    game.settings.register(MODULE_ID, "spikeTolerance", {
        scope: "world",
        config: false,
        type: String,
        default: "flexible",
        restricted: true
    });


    game.settings.register(MODULE_ID, "scrollFloor", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.scrollFloorName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.scrollFloorHint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 1, max: 9, step: 1 },
        default: 1,
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollUpperReach", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.scrollUpperReachName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.scrollUpperReachHint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0, max: 4, step: 1 },
        default: 2,
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollConcentration", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.scrollConcentrationName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.scrollConcentrationHint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 1, max: 5, step: 1 },
        default: 2,
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollOffset", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.scrollOffsetName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.scrollOffsetHint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: -4, max: 4, step: 1 },
        default: -1,
        restricted: true
    });

    game.settings.register(MODULE_ID, "shelfConcentration", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.shelfConcentrationName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.shelfConcentrationHint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 1, max: 5, step: 1 },
        default: 3,
        restricted: true
    });

    game.settings.register(MODULE_ID, "shelfAttunementBias", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.shelfAttunementBiasName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.shelfAttunementBiasHint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0, max: 2, step: 1 },
        default: 1,
        restricted: true
    });

    game.settings.register(MODULE_ID, "shelfCategoryWeights", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.shelfCategoryWeightsName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.shelfCategoryWeightsHint",
        scope: "world",
        config: false,
        type: String,
        default: JSON.stringify({
            wondrous: { w: 70, on: true },
            focus:    { w: 15, on: true },
            armor:    { w: 10, on: true },
            weapon:   { w: 5,  on: true }
        }),
        restricted: true
    });



    game.settings.registerMenu(MODULE_ID, "lootGenerationConfig", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.lootGenerationConfigName",
        label: "IONRIFT.QUARTERMASTER.SETTINGS.lootGenerationConfigLabel",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.lootGenerationConfigHint",
        icon: "fas fa-coins",
        type: LootGenerationConfigApp,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, "identificationConfig", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.identificationConfigName",
        label: "IONRIFT.QUARTERMASTER.SETTINGS.identificationConfigLabel",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.identificationConfigHint",
        icon: "fas fa-eye-slash",
        type: IdentificationConfigApp,
        restricted: true
    });



    game.settings.registerMenu(MODULE_ID, "compendiumForge", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.compendiumForgeName",
        label: "IONRIFT.QUARTERMASTER.SETTINGS.compendiumForgeLabel",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.compendiumForgeHint",
        icon: "fas fa-hammer",
        type: CompendiumForgeApp,
        restricted: true
    });

    const SettingsLayout = game.ionrift?.library?.SettingsLayout;
    SettingsLayout?.registerFooter(MODULE_ID);

    game.settings.register(MODULE_ID, "debug", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.debugName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.debugHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: false,
        restricted: true
    });

    // Dev-only. Enable from console: game.settings.set("ionrift-quartermaster", "identifyTrace", true)
    game.settings.register(MODULE_ID, "identifyTrace", {
        name: "IONRIFT.QUARTERMASTER.SETTINGS.identifyTraceName",
        hint: "IONRIFT.QUARTERMASTER.SETTINGS.identifyTraceHint",
        scope: "client",
        config: false,
        type: Boolean,
        default: false,
        restricted: true
    });

    registerQuartermasterSettingsPanel();
}
