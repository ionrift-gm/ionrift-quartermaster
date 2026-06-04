/**
 * @module SettingsRegistrar
 * @description Registers Quartermaster settings, menus, and layout footer.
 */

import { LootGenerationConfigApp } from "../apps/LootGenerationConfigApp.js";
import { IdentificationConfigApp } from "../apps/IdentificationConfigApp.js";
import { ProgressionConfigApp } from "../apps/ProgressionConfigApp.js";
import { WorkshopPackRegistryApp } from "../apps/WorkshopPackRegistryApp.js";
import { SignatureLedger } from "./SignatureLedger.js";
import { registerQuartermasterSettingsPanel } from "./SettingsPanelLayout.js";
import { AmmoTypeRegistry } from "./AmmoTypeRegistry.js";

const MODULE_ID = "ionrift-quartermaster";

/**
 * @param {object} opts
 * @param {typeof import("../apps/CompendiumForgeApp.js").CompendiumForgeApp} opts.CompendiumForgeApp
 */
export function registerQuartermasterSettings({ CompendiumForgeApp }) {

    game.settings.register(MODULE_ID, "distributeCoins", {
        name: "Distribute Coinage",
        hint: "Automatically convert cache gold values into a randomized mix of cp, sp, ep, gp, and pp.",
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
        name: "Default Cache Owner Theme",
        hint: "Last-used owner theme for cache generation. Restored automatically when the generator opens.",
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
        name: "Advisory Panel Collapsed",
        hint: "Remembers whether the Progression Advisory panel was collapsed.",
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
        name: "Loot Pool Compendium Sources",
        hint: "JSON array of compendium IDs to draw loot from. Managed via the config button below.",
        scope: "world",
        config: false,
        type: String,
        default: JSON.stringify([
            "dnd5e.items", "dnd5e.tradegoods",
            "world.ionrift-forged-scrolls"
        ]),
        onChange: () => {
            import("./ItemPoolResolver.js").then(m => m.ItemPoolResolver.clearCache());
        }
    });

    game.settings.register(MODULE_ID, "lootEconomy", {
        name: "Loot Abundance",
        hint: "Scales the value of generated caches. Below 1.0 for scarce, gritty games. Above 1.0 for high-fantasy treasure runs.",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.25, max: 3.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "magicFrequency", {
        name: "Magic Frequency",
        hint: "Scales the likelihood of drawing magical items (Uncommon+) from loot caches. 0.0 (No Magic) to 1.0 (Standard) to 2.0 (High Fantasy).",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 2.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "magicAmmoFrequency", {
        name: "Magical Ammunition Frequency",
        hint: "Scales how often magical ammunition (+1/+2/+3) appears in caches. 0 disables magical ammo entirely. 1.0 follows the tier-appropriate curve. 2.0 is generous. Independent of Magic Frequency.",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 2.0, step: 0.25 },
        default: 1.0,
        restricted: true
    });

    game.settings.register(MODULE_ID, "ammoTypeTilt", {
        name: "Ammunition Type Preference",
        hint: "Legacy preset key synced from the ammunition type curve. Quick setup profiles still write this value.",
        scope: "world",
        config: false,
        type: String,
        choices: {
            balanced: "Balanced, equal weight for all ammo types",
            arrows: "Arrows, favour arrows and bow ammunition",
            bolts: "Bolts, favour bolts and crossbow ammunition",
            sling: "Sling, favour sling bullets",
            mixed: "Mixed, arrows and bolts heavy, others light",
            custom: "Custom, weights set in the ammunition type curve"
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
        name: "Ammunition Type Curve",
        hint: "Per-category weights and custom ammo match rules for cache generation.",
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });

    game.settings.register(MODULE_ID, "obscureConsumables", {
        name: "Obscure Consumables",
        hint: "When enabled, potions, oils, and other consumables are presented with generic names (e.g. 'Sealed Vial') until identified, regardless of rarity. Disable to show true names for common items like Potions of Healing.",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "obscureScrolls", {
        name: "Obscure Spell Scrolls",
        hint: "When enabled, all spell scrolls appear as 'Unidentified Scroll' until identified. By the 2024 DMG, anyone can identify a scroll via Identify or a Short Rest; this setting models the moment before the party has examined it. Disable to show spell names directly.",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "milestoneProfile", {
        name: "Campaign Milestone Profile",
        hint: "Adjusts the Signature Ledger milestone grid to match your campaign's level range. Each profile spreads 6 milestones across the selected band.",
        scope: "world",
        config: true,
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

    game.settings.register(MODULE_ID, "scrollLevelJitter", {
        scope: "world",
        config: false,
        type: Number,
        default: 0,
        restricted: true
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
        name: "Compiled Loot Pool Hash",
        hint: "Hash of the lootPoolSources config at last compile. Empty = never compiled.",
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });

    game.settings.register(MODULE_ID, "compiledLootPoolMeta", {
        name: "Compiled Loot Pool Metadata",
        hint: "JSON: { compiledAt, sourceIds, itemCount, templateCount }",
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
            import("./ItemPoolResolver.js").then(m => {
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

    game.settings.register(MODULE_ID, "scrollJitter", {
        name: "Scroll Jitter",
        hint: "How much scroll spell level can overshoot the tier cap on a lucky roll. 0 = scrolls stay within tier limits. Higher values allow rare high-level scrolls in lower-tier caches.",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0, max: 3, step: 1 },
        default: 1,
        restricted: true
    });

    game.settings.register(MODULE_ID, "shelfJitter", {
        name: "Auto-Seed Drift",
        hint: "Controls where auto-seeded shelf items land on the milestone grid. 0 = items appear at their exact rarity-based milestone. 1 or 2 = items may shift ±1 or ±2 columns (late-biased). Manually planned items always arrive at their designated milestone.",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0, max: 2, step: 1 },
        default: 1,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, "lootGenerationConfig", {
        name: "Loot Generation",
        label: "Configure Loot Generation",
        hint: "Loot abundance, magic frequency, ammunition, scroll jitter, and coin distribution.",
        icon: "fas fa-coins",
        type: LootGenerationConfigApp,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, "identificationConfig", {
        name: "Identification",
        label: "Configure Identification",
        hint: "Obscure consumables and spell scrolls until the party examines them.",
        icon: "fas fa-eye-slash",
        type: IdentificationConfigApp,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, "progressionConfig", {
        name: "Progression",
        label: "Configure Progression",
        hint: "Auto-seed drift on the Signature Ledger. Milestone band is set above.",
        icon: "fas fa-chart-line",
        type: ProgressionConfigApp,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, "compendiumForge", {
        name: "Compendium Forge",
        label: "Compendium Forge",
        hint: "Manage compiled content pools - loot sources, spell scrolls, and cursed items.",
        icon: "fas fa-hammer",
        type: CompendiumForgeApp,
        restricted: true
    });

    if (!game.ionrift?.library?.isOverlayDistributionActive?.()) {
        const SettingsLayoutForPack = game.ionrift?.library?.SettingsLayout;
        SettingsLayoutForPack?.registerPackButton(MODULE_ID, WorkshopPackRegistryApp, {
            hint: "Import and manage item packs, loot tables, and artwork."
        });
    }

    const SettingsLayout = game.ionrift?.library?.SettingsLayout;
    SettingsLayout?.registerFooter(MODULE_ID);

    game.settings.register(MODULE_ID, "debug", {
        name: "Cache Generator Debug Logging",
        hint: "Logs per-slot budget and scroll picks to the browser console (F12).",
        scope: "client",
        config: true,
        type: Boolean,
        default: false,
        restricted: true
    });

    registerQuartermasterSettingsPanel();
}
