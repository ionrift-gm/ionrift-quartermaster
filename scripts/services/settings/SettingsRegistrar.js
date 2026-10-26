import { MODULE_ID } from "../../data/moduleId.js";
/**
 * @module SettingsRegistrar
 * @description Registers Quartermaster settings, menus, and layout footer.
 */

import { LootGenerationConfigApp } from "../../apps/config/loot/LootGenerationConfigApp.js";
import { IdentificationConfigApp } from "../../apps/config/identify/IdentificationConfigApp.js";

import { SignatureLedger } from "../progression/SignatureLedger.js";
import { registerQuartermasterSettingsPanel } from "./SettingsPanelLayout.js";
import { AmmoTypeRegistry } from "../workshop/AmmoTypeRegistry.js";
import { DEFAULT_GENERIC_ARMOR_BONUS } from "../workshop/GenericArmorBonusRegistry.js";
import { getQuartermasterAdapter } from "../../adapters/getAdapter.js";
import { QM_FEATURES } from "../../data/QMFeatures.js";


/**
 * @param {object} opts
 * @param {typeof import("../../apps/forge/CompendiumForgeApp.js").CompendiumForgeApp} opts.CompendiumForgeApp
 */
export function registerQuartermasterSettings({ CompendiumForgeApp }) {
    const adapter = getQuartermasterAdapter();

    game.settings.register(MODULE_ID, "distributeCoins", {
        name: "ionrift-quartermaster.setting.distributeCoins.name",
        hint: "ionrift-quartermaster.setting.distributeCoins.hint",
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
        name: "ionrift-quartermaster.setting.defaultCacheOwnerTheme.name",
        hint: "ionrift-quartermaster.setting.defaultCacheOwnerTheme.hint",
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
        name: "ionrift-quartermaster.setting.advisoryCollapsed.name",
        hint: "ionrift-quartermaster.setting.advisoryCollapsed.hint",
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
        name: "ionrift-quartermaster.setting.lootPoolSources.name",
        hint: "ionrift-quartermaster.setting.lootPoolSources.hint",
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
        name: "ionrift-quartermaster.setting.lootEconomy.name",
        hint: "ionrift-quartermaster.setting.lootEconomy.hint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.25, max: 3.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "magicFrequency", {
        name: "ionrift-quartermaster.setting.magicFrequency.name",
        hint: "ionrift-quartermaster.setting.magicFrequency.hint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 2.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "armourDropChance", {
        name: "ionrift-quartermaster.setting.armourDropChance.name",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 1.0, step: 0.05 },
        default: 0.65,
        restricted: true
    });

    game.settings.register(MODULE_ID, "namedMagicFrequency", {
        name: "ionrift-quartermaster.setting.namedMagicFrequency.name",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 2.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "magicAmmoFrequency", {
        name: "ionrift-quartermaster.setting.magicAmmoFrequency.name",
        hint: "ionrift-quartermaster.setting.magicAmmoFrequency.hint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 2.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "healingPotionFrequency", {
        name: "ionrift-quartermaster.setting.healingPotionFrequency.name",
        hint: "ionrift-quartermaster.setting.healingPotionFrequency.hint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 4.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "ammoTypeTilt", {
        name: "ionrift-quartermaster.setting.ammoTypeTilt.name",
        hint: "ionrift-quartermaster.setting.ammoTypeTilt.hint",
        scope: "world",
        config: false,
        type: String,
        choices: {
            balanced: "ionrift-quartermaster.setting.ammoTypeTilt.choices.balanced",
            arrows: "ionrift-quartermaster.setting.ammoTypeTilt.choices.arrows",
            bolts: "ionrift-quartermaster.setting.ammoTypeTilt.choices.bolts",
            sling: "ionrift-quartermaster.setting.ammoTypeTilt.choices.sling",
            mixed: "ionrift-quartermaster.setting.ammoTypeTilt.choices.mixed",
            custom: "ionrift-quartermaster.setting.ammoTypeTilt.choices.custom"
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
        name: "ionrift-quartermaster.setting.ammoTypeConfig.name",
        hint: "ionrift-quartermaster.setting.ammoTypeConfig.hint",
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });

    game.settings.register(MODULE_ID, "genericArmorBonusConfig", {
        name: "ionrift-quartermaster.setting.genericArmorBonusConfig.name",
        hint: "ionrift-quartermaster.setting.genericArmorBonusConfig.hint",
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
        name: "ionrift-quartermaster.setting.obscureConsumables.name",
        hint: "ionrift-quartermaster.setting.obscureConsumables.hint",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "obscureScrolls", {
        name: "ionrift-quartermaster.setting.obscureScrolls.name",
        hint: "ionrift-quartermaster.setting.obscureScrolls.hint",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "obscureMagicalItems", {
        name: "ionrift-quartermaster.setting.obscureMagicalItems.name",
        hint: "ionrift-quartermaster.setting.obscureMagicalItems.hint",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "gmOnlyIdentification", {
        name: "ionrift-quartermaster.setting.gmOnlyIdentification.name",
        hint: "ionrift-quartermaster.setting.gmOnlyIdentification.hint",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "milestoneProfile", {
        name: "ionrift-quartermaster.setting.milestoneProfile.name",
        hint: "ionrift-quartermaster.setting.milestoneProfile.hint",
        scope: "world",
        config: adapter.supports(QM_FEATURES.SIGNATURE_LEDGER),
        type: String,
        choices: Object.fromEntries(
            Object.entries(SignatureLedger.PROFILES).map(([k, v]) => [k, v.label])
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
        name: "ionrift-quartermaster.setting.compiledLootPoolHash.name",
        hint: "ionrift-quartermaster.setting.compiledLootPoolHash.hint",
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });

    game.settings.register(MODULE_ID, "compiledLootPoolMeta", {
        name: "ionrift-quartermaster.setting.compiledLootPoolMeta.name",
        hint: "ionrift-quartermaster.setting.compiledLootPoolMeta.hint",
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
        name: "ionrift-quartermaster.setting.cursedT3Enabled.name",
        hint: "ionrift-quartermaster.setting.cursedT3Enabled.hint",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "cursedT4Enabled", {
        name: "ionrift-quartermaster.setting.cursedT4Enabled.name",
        hint: "ionrift-quartermaster.setting.cursedT4Enabled.hint",
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
        name: "ionrift-quartermaster.setting.scrollFloor.name",
        hint: "ionrift-quartermaster.setting.scrollFloor.hint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 1, max: 9, step: 1 },
        default: 1,
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollUpperReach", {
        name: "ionrift-quartermaster.setting.scrollUpperReach.name",
        hint: "ionrift-quartermaster.setting.scrollUpperReach.hint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0, max: 4, step: 1 },
        default: 2,
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollConcentration", {
        name: "ionrift-quartermaster.setting.scrollConcentration.name",
        hint: "ionrift-quartermaster.setting.scrollConcentration.hint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 1, max: 5, step: 1 },
        default: 2,
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollOffset", {
        name: "ionrift-quartermaster.setting.scrollOffset.name",
        hint: "ionrift-quartermaster.setting.scrollOffset.hint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: -4, max: 4, step: 1 },
        default: -1,
        restricted: true
    });

    game.settings.register(MODULE_ID, "shelfConcentration", {
        name: "ionrift-quartermaster.setting.shelfConcentration.name",
        hint: "ionrift-quartermaster.setting.shelfConcentration.hint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 1, max: 5, step: 1 },
        default: 3,
        restricted: true
    });

    game.settings.register(MODULE_ID, "shelfAttunementBias", {
        name: "ionrift-quartermaster.setting.shelfAttunementBias.name",
        hint: "ionrift-quartermaster.setting.shelfAttunementBias.hint",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0, max: 2, step: 1 },
        default: 1,
        restricted: true
    });

    game.settings.register(MODULE_ID, "shelfCategoryWeights", {
        name: "ionrift-quartermaster.setting.shelfCategoryWeights.name",
        hint: "ionrift-quartermaster.setting.shelfCategoryWeights.hint",
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

    game.settings.register(MODULE_ID, "importedTerrainData", {
        scope: "world",
        config: false,
        type: Object,
        default: {},
        restricted: true
    });



    const supportsMasking = adapter.supports(QM_FEATURES.LATENT_MASKING);
    const isSourcesOnly = !adapter.supports(QM_FEATURES.LOOT_POOL_COMPILE)
        && !adapter.supports(QM_FEATURES.SCROLL_FORGE)
        && !adapter.supports(QM_FEATURES.SRD_CURSES);

    game.settings.registerMenu(MODULE_ID, "lootGenerationConfig", {
        name: "ionrift-quartermaster.menu.lootGenerationConfig.name",
        label: "ionrift-quartermaster.menu.lootGenerationConfig.label",
        hint: supportsMasking
            ? "ionrift-quartermaster.menu.lootGenerationConfig.hintMasking"
            : "ionrift-quartermaster.menu.lootGenerationConfig.hintNoMasking",
        icon: "fas fa-coins",
        type: LootGenerationConfigApp,
        restricted: true
    });

    if (supportsMasking) {
        game.settings.registerMenu(MODULE_ID, "identificationConfig", {
            name: "ionrift-quartermaster.menu.identificationConfig.name",
            label: "ionrift-quartermaster.menu.identificationConfig.label",
            hint: "ionrift-quartermaster.menu.identificationConfig.hint",
            icon: "fas fa-eye-slash",
            type: IdentificationConfigApp,
            restricted: true
        });
    }

    game.settings.registerMenu(MODULE_ID, "compendiumForge", {
        name: "ionrift-quartermaster.menu.compendiumForge.name",
        label: "ionrift-quartermaster.menu.compendiumForge.label",
        hint: isSourcesOnly
            ? "ionrift-quartermaster.menu.compendiumForge.hintSourcesOnly"
            : "ionrift-quartermaster.menu.compendiumForge.hintFull",
        icon: "fas fa-hammer",
        type: CompendiumForgeApp,
        restricted: true
    });

    const SettingsLayout = game.ionrift?.library?.SettingsLayout;
    SettingsLayout?.registerFooter(MODULE_ID);

    game.settings.register(MODULE_ID, "debug", {
        name: "ionrift-quartermaster.setting.debug.name",
        hint: "ionrift-quartermaster.setting.debug.hint",
        scope: "client",
        config: false,
        type: Boolean,
        default: false
    });

    // Dev-only. Enable from console: game.settings.set("ionrift-quartermaster", "identifyTrace", true)
    game.settings.register(MODULE_ID, "identifyTrace", {
        name: "ionrift-quartermaster.setting.identifyTrace.name",
        hint: "ionrift-quartermaster.setting.identifyTrace.hint",
        scope: "client",
        config: false,
        type: Boolean,
        default: false,
        restricted: true
    });

    registerQuartermasterSettingsPanel();
}
