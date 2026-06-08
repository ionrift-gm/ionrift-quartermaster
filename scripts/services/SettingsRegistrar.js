/**
 * @module SettingsRegistrar
 * @description Registers Quartermaster settings, menus, and layout footer.
 */

import { LootGenerationConfigApp } from "../apps/LootGenerationConfigApp.js";
import { IdentificationConfigApp } from "../apps/IdentificationConfigApp.js";

import { WorkshopPackRegistryApp } from "../apps/WorkshopPackRegistryApp.js";
import { SignatureLedger } from "./SignatureLedger.js";
import { registerQuartermasterSettingsPanel } from "./SettingsPanelLayout.js";
import { AmmoTypeRegistry } from "./AmmoTypeRegistry.js";
import { GenericArmorBonusRegistry, DEFAULT_GENERIC_ARMOR_BONUS } from "./GenericArmorBonusRegistry.js";

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

    game.settings.register(MODULE_ID, "armourDropChance", {
        name: "Armour Drop Chance",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 1.0, step: 0.05 },
        default: 0.65,
        restricted: true
    });

    game.settings.register(MODULE_ID, "namedMagicFrequency", {
        name: "Named Magic Frequency",
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

    game.settings.register(MODULE_ID, "healingPotionFrequency", {
        name: "Healing Potion Frequency",
        hint: "Scales consumable slots, healing chance on those slots, and extra healing lines per cache. 0 is scarce. 1.0 is moderate. 4.0 adds several healing potions per cache when the loot pool includes them. Enable dnd5e.items (or recompile Forge) so healing rows exist.",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0.0, max: 4.0, step: 0.25 },
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

    game.settings.register(MODULE_ID, "genericArmorBonusConfig", {
        name: "Generic Armor Bonus Curve",
        hint: "Tier caps and pick weights for generic +N body armor and shields in mastercraft caches.",
        scope: "world",
        config: false,
        type: String,
        default: JSON.stringify(DEFAULT_GENERIC_ARMOR_BONUS),
        restricted: true,
        onChange: () => {
            import("./ItemPoolResolver.js").then(m => m.ItemPoolResolver.clearCache());
        }
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

    game.settings.register(MODULE_ID, "obscureMagicalItems", {
        name: "Obscure Magical Items",
        hint: "When enabled, weapons, armor, wondrous gear, and spell foci present as mundane base items until identified. Disable to show true names, rarity, and mechanical properties on the sheet immediately.",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "gmOnlyIdentification", {
        name: "GM-Only Identification",
        hint: "When enabled, players cannot use the identification toggle on item sheets. Only the GM can identify masked loot via the sheet wand, Quartermaster tools, or linked rest activities.",
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

    game.settings.register(MODULE_ID, "cursedT3Enabled", {
        name: "Cursed Pool: T3 Enabled",
        hint: "Allow Tier 3 cursed items to surface in advisory suggestions. T3 items are documented as high-lethality — they can kill players. Disable to keep them out of generated caches.",
        scope: "world",
        config: false,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "cursedT4Enabled", {
        name: "Cursed Pool: T4 Enabled",
        hint: "Allow Tier 4 cursed items to surface in advisory suggestions. T4 items are campaign-altering — side quests, major distractions, and long-term consequences. Disable to reserve them for deliberate placement.",
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
        name: "Scroll Floor",
        hint: "Lowest spell level scrolls can drop at. The distribution stretches down to this level as the party levels up. Set higher to exclude low-level scrolls from high-level caches.",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 1, max: 9, step: 1 },
        default: 1,
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollUpperReach", {
        name: "Scroll Upper Reach",
        hint: "Maximum spell levels above optimal that jitter can push. 0 = scrolls never exceed optimal. Higher values allow rare high-level scrolls.",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0, max: 4, step: 1 },
        default: 2,
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollConcentration", {
        name: "Scroll Concentration",
        hint: "How tightly the distribution clusters around the optimal level. 1 = flat spread, 5 = sharply peaked at optimal.",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 1, max: 5, step: 1 },
        default: 2,
        restricted: true
    });

    game.settings.register(MODULE_ID, "scrollOffset", {
        name: "Scroll Optimal Offset",
        hint: "Offsets the party's assumed optimal scroll level to favor pulling lower or higher level scrolls.",
        scope: "world",
        config: false,
        type: Number,
        range: { min: -4, max: 4, step: 1 },
        default: -1,
        restricted: true
    });

    game.settings.register(MODULE_ID, "shelfConcentration", {
        name: "Party Shelf Concentration",
        hint: "How tightly the rarity distribution peaks around Uncommon. 1 = flat spread across rarities, 5 = heavily Uncommon.",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 1, max: 5, step: 1 },
        default: 3,
        restricted: true
    });

    game.settings.register(MODULE_ID, "shelfAttunementBias", {
        name: "Party Shelf Attunement Bias",
        hint: "0 = Low (avoid attunement items), 1 = Medium (neutral), 2 = High (prefer powerful attuned items).",
        scope: "world",
        config: false,
        type: Number,
        range: { min: 0, max: 2, step: 1 },
        default: 1,
        restricted: true
    });

    game.settings.register(MODULE_ID, "shelfCategoryWeights", {
        name: "Party Shelf Category Weights",
        hint: "Per-category weight and enabled flag for the party shelf randomiser.",
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
        name: "Loot Generation",
        label: "Configure Loot Generation",
        hint: "Loot abundance, magic frequency, ammunition, healing potions, and coin distribution.",
        icon: "fas fa-coins",
        type: LootGenerationConfigApp,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, "identificationConfig", {
        name: "Identification",
        label: "Configure Identification",
        hint: "Obscure loot names and sheet details until the party examines them.",
        icon: "fas fa-eye-slash",
        type: IdentificationConfigApp,
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
