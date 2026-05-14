import { WorkshopApp } from "./apps/WorkshopApp.js";
import { CacheGeneratorApp } from "./apps/CacheGeneratorApp.js";
import { SheetInjector } from "./SheetInjector.js";
import { WorkshopItemFactory } from "./services/WorkshopItemFactory.js";
import { CacheGenerator } from "./services/CacheGenerator.js";

import { IdentificationService } from "./services/IdentificationService.js";
import { PriceMasker } from "./services/PriceMasker.js";
import { PriceInjector } from "./PriceInjector.js";
import { SignatureLedger } from "./services/SignatureLedger.js";
import { ProgressionSeeder } from "./services/ProgressionSeeder.js";
import { ProgressionAdvisor } from "./services/ProgressionAdvisor.js";
import { ItemPoolResolver } from "./services/ItemPoolResolver.js";
import { ScrollForge } from "./services/ScrollForge.js";
import { SrdCurseAdapter } from "./services/SrdCurseAdapter.js";
import { ItemMaskingHelper } from "./services/ItemMaskingHelper.js";
import { StandalonePoolRegistry } from "./services/StandalonePoolRegistry.js";

import { ContentPackLoader } from "./services/ContentPackLoader.js";
import { ContentPackCompiler } from "./services/ContentPackCompiler.js";
import { WorkshopPackRegistryApp } from "./apps/WorkshopPackRegistryApp.js";

import { Logger, MODULE_LABEL } from "./_logger.js";

const MODULE_ID = "ionrift-quartermaster";

/**
 * Systems with full Quartermaster support. On other systems the module loads
 * but logs an advisory; core loot and progression features require DnD5e schema.
 * Extend this list when a formal QMSystemAdapter is implemented.
 */
const SUPPORTED_SYSTEMS = ["dnd5e"];

function isResonanceActive() {
    return game.modules.get("ionrift-resonance")?.active ?? false;
}



Hooks.once('init', async () => {
    const version = game.modules.get(MODULE_ID)?.version ?? "unknown";
    Logger.info(MODULE_LABEL, `v${version} | Initializing.`);

    if (!SUPPORTED_SYSTEMS.includes(game.system?.id)) {
        Logger.warn(
            MODULE_LABEL,
            `System '${game.system?.id}' is not officially supported. ` +
            `Core features require DnD5e. The module will load but results may be unpredictable.`
        );
    }

    // Expose API
    game.modules.get(MODULE_ID).api = {
        items:       WorkshopItemFactory,
        cache:       CacheGenerator,
        ledger:      SignatureLedger,
        seeder:      ProgressionSeeder,
        advisor:     ProgressionAdvisor,
        scrollForge: ScrollForge,
    };

    game.settings.register(MODULE_ID, "distributeCoins", {
        name: "Distribute Coinage",
        hint: "Automatically convert cache gold values into a randomized mix of cp, sp, ep, gp, and pp.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        requiresReload: false
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

    // DEPRECATED: ledgerHiddenActors — superseded by library PartyRoster.
    // Kept registered to avoid errors in worlds that stored this setting.
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

    // Pack management state
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
            // Clear the resolver cache when sources change
            import("./services/ItemPoolResolver.js").then(m => m.ItemPoolResolver.clearCache());
        }
    });

    game.settings.register(MODULE_ID, "lootEconomy", {
        name: "Loot Abundance",
        hint: "Scales the value of generated caches. Below 1.0 for scarce, gritty games. Above 1.0 for high-fantasy treasure runs.",
        scope: "world",
        config: true,
        type: Number,
        range: { min: 0.25, max: 3.0, step: 0.25 },
        default: 1.0
    });

    game.settings.register(MODULE_ID, "magicFrequency", {
        name: "Magic Frequency",
        hint: "Scales the likelihood of drawing magical items (Uncommon+) from loot caches. 0.0 (No Magic) to 1.0 (Standard) to 2.0 (High Fantasy).",
        scope: "world",
        config: true,
        type: Number,
        range: { min: 0.0, max: 2.0, step: 0.25 },
        default: 1.0
    });

    game.settings.register(MODULE_ID, "obscureConsumables", {
        name: "Obscure Consumables",
        hint: "When enabled, potions, oils, and other consumables are presented with generic names (e.g. 'Sealed Vial') until identified, regardless of rarity. Disable to show true names for common items like Potions of Healing.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        restricted: true
    });

    game.settings.register(MODULE_ID, "obscureScrolls", {
        name: "Obscure Spell Scrolls",
        hint: "When enabled, all spell scrolls appear as 'Unidentified Scroll' until identified. By the 2024 DMG, anyone can identify a scroll via Identify or a Short Rest; this setting models the moment before the party has examined it. Disable to show spell names directly.",
        scope: "world",
        config: true,
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



    // Legacy setting; superseded by scrollJitter
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



    // Content Pack compiled state (hash map for idempotent rebuilds)
    game.settings.register(MODULE_ID, "compiledContentPacks", {
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

    // Extensible source registry for the cursed item pool.
    // Default: QM's own SRD stub compendium. Cursewright appends its sources
    // on the ionrift-quartermaster.ready hook — additive, never replacing.
    game.settings.register(MODULE_ID, "cursedItemSources", {
        scope: "world",
        config: false,
        type: String,
        default: JSON.stringify(["world.ionrift-srd-cursed"]),
        restricted: true
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

    // Hash used by SrdCurseAdapter to gate recompilation.
    game.settings.register(MODULE_ID, "srdCurseHash", {
        scope: "world",
        config: false,
        type: String,
        default: "",
        restricted: true
    });



    // Legacy setting; superseded by scrollJitter + shelfJitter
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
        config: true,
        type: Number,
        range: { min: 0, max: 3, step: 1 },
        default: 1,
        restricted: true
    });

    game.settings.register(MODULE_ID, "shelfJitter", {
        name: "Auto-Seed Drift",
        hint: "Controls where auto-seeded shelf items land on the milestone grid. 0 = items appear at their exact rarity-based milestone. 1 or 2 = items may shift ±1 or ±2 columns (late-biased). Manually planned items always arrive at their designated milestone.",
        scope: "world",
        config: true,
        type: Number,
        range: { min: 0, max: 2, step: 1 },
        default: 1,
        restricted: true
    });

    // Content Packs button (via kernel)
    const SettingsLayoutForPack = game.ionrift?.library?.SettingsLayout;
    SettingsLayoutForPack?.registerPackButton(MODULE_ID, WorkshopPackRegistryApp, {
        hint: "Import and manage item packs, loot tables, and artwork."
    });

    game.settings.registerMenu(MODULE_ID, "lootPoolConfig", {
        name: "Loot Pool Sources",
        label: "Configure Sources",
        hint: "Choose which compendiums contribute items to the loot cache generator.",
        icon: "fas fa-treasure-chest",
        type: (await import("./apps/LootPoolConfigApp.js")).LootPoolConfigApp,
        restricted: true
    });



    // FOOTER: Discord + Wiki (standardised via ionrift-library)
    const SettingsLayout = game.ionrift?.library?.SettingsLayout;
    SettingsLayout?.registerFooter(MODULE_ID);

    game.settings.register(MODULE_ID, "debug", {
        name: "Enable Debug Logging",
        hint: "Visible only in console. Useful for troubleshooting.",
        scope: "client",
        config: true,
        type: Boolean,
        default: false
    });

    // Sound integration (only if Resonance is present)
    if (isResonanceActive()) {
        SheetInjector.init();
    }

    // Register partials
    try {
        await foundry.applications.handlebars.loadTemplates([
            "modules/ionrift-quartermaster/templates/partials/sound-picker-row.hbs",
            "modules/ionrift-quartermaster/templates/partials/slot-cell.hbs",
            "modules/ionrift-quartermaster/templates/partials/cache-qty-stepper.hbs",
            "modules/ionrift-quartermaster/templates/partials/cache-chat-card.hbs",
            "modules/ionrift-quartermaster/templates/scroll-forge-sources.hbs"
        ]);
    } catch (e) {
        Logger.error(MODULE_LABEL, "Template load failed:", e);
    }
});

Hooks.on('ready', () => {
    // Flush caches so every reload re-fetches fresh data
    CacheGenerator._tables = null;
    ItemPoolResolver._cache.clear();
    ItemPoolResolver._cacheExpiry = null;

    // Expose ergonomic API on game.ionrift.workshop
    game.ionrift = game.ionrift ?? {};
    game.ionrift.workshop = game.ionrift.workshop ?? {};
    game.ionrift.workshop.generateCache = (opts) => CacheGenerator.generate(opts);
    game.ionrift.workshop.createCacheItems = (result) => CacheGenerator.createCacheItems(result);
    game.ionrift.workshop.getOwnerThemes = () => CacheGenerator.getOwnerThemes();
    game.ionrift.workshop.getThemes = () => CacheGenerator.getThemes();

    game.ionrift.workshop.identification = IdentificationService;
    game.ionrift.workshop.identify = (item, opts) => IdentificationService.identify(item, opts);
    game.ionrift.workshop.getLatentSummary = (item) => IdentificationService.getLatentSummary(item);
    game.ionrift.workshop.priceMasker = PriceMasker;
    game.ionrift.workshop.renderItemPrice = (item) => PriceMasker.render(item);
    game.ionrift.workshop.openForgedScrolls = () => ScrollForge.openForgedPack();



    PriceInjector.init();



    // Forge safety tests (infrastructure, non-IP-sensitive)
    if (game.ionrift?.library?.tests) {
        game.ionrift.library.tests.register("ionrift-quartermaster-forge", {
            name: "Quartermaster Forge Safety",
            description: "Partial registration checks",
            runFn: async () => {
                const { QuartermasterForgeTestRunner } = await import("./tests/ForgeTestRunner.js");
                return QuartermasterForgeTestRunner.runAll();
            }
        });


    }



    // Expose services on namespace for companion modules (Cursewright)
    game.ionrift.quartermaster = game.ionrift.quartermaster ?? {};
    game.ionrift.quartermaster.itemMaskingHelper = ItemMaskingHelper;
    game.ionrift.quartermaster.identificationService = IdentificationService;
    game.ionrift.quartermaster.standalonePoolRegistry = StandalonePoolRegistry;

    Logger.info(MODULE_LABEL, "Ready.");

    // Signal companion modules that QM is fully initialized
    Hooks.callAll("ionrift-quartermaster.ready", game.ionrift.quartermaster);
    Logger.log(MODULE_LABEL, "Cache Generator available: game.ionrift.workshop.generateCache()");

    if (game.user.isGM && game.settings.get(MODULE_ID, "scrollForgeEnabled")) {
        ScrollForge.runAfterReady().catch(err => {
            Logger.error(MODULE_LABEL, "Scroll Forge failed:", err);
        });
    }

    if (game.user.isGM && game.system?.id === "dnd5e") {
        SrdCurseAdapter.compile().catch(err => {
            Logger.error(MODULE_LABEL, "SrdCurseAdapter failed:", err);
        });
    }

    // Content Pack discovery + auto-compile
    if (game.user.isGM) {
        // Register QM-specific terrains into the lib spine so other modules can see them.
        const registerQmTerrains = (terrains) => {
            terrains.register({ id: "jungle", label: "Jungle" });
            terrains.register({ id: "coastal", label: "Coastal" });
            terrains.register({ id: "swamp", label: "Swamp" });
            terrains.register({ id: "arctic", label: "Arctic" });
        };
        Hooks.on("ionrift.terrainsReady", registerQmTerrains);
        const libTerrains = game.ionrift?.library?.terrains;
        if (libTerrains) registerQmTerrains(libTerrains);

        ContentPackLoader.init().then(() => {
            if (ContentPackLoader.loaded && ContentPackLoader.getLoadedPacks().length > 0) {
                ContentPackCompiler.compileAll().catch(err => {
                    Logger.error(MODULE_LABEL, "Content Pack compilation failed:", err);
                });
            }
        }).catch(err => {
            Logger.error(MODULE_LABEL, "Content Pack loader failed:", err);
        });
    }
});

Hooks.on("preUpdateItem", (item, changes, options) => {
    if (!game.user.isGM) return;
    if (changes?.system?.identified !== false) return;
    // Skip items on Item Piles containers — transfer operations can trigger
    // identified changes as a side-effect; never re-identify pile items.
    if (item.parent?.flags?.["item-piles"]?.data?.enabled) return;

    const latent = item.getFlag?.(MODULE_ID, "latentMagic");
    if (!latent?.promoted) return;

    if (latent.originalName) changes.name = latent.originalName;
    if (latent.originalRarity) changes.system.rarity = latent.originalRarity;
    if (latent.originalPrice) changes.system.price = latent.originalPrice;
    if (latent.originalDescription !== undefined) {
        changes.system ??= {};
        changes.system.description ??= {};
        changes.system.description.value = latent.originalDescription;
    }
    if (latent.magicalBonus !== undefined) {
        changes.system ??= {};
        changes.system.magicalBonus = "";
    }
    if (latent.attunement) {
        changes.system ??= {};
        changes.system.attunement = "";
    }
    if (latent.originalImg) changes.img = latent.originalImg;

    options.curseBypass = true;
    options._reobscureItem = item.id;
});

Hooks.on("updateItem", (item, changes, options) => {
    if (!options._reobscureItem || options._reobscureItem !== item.id) return;
    if (!game.user.isGM) return;
    item.setFlag(MODULE_ID, "latentMagic", {
        ...item.getFlag(MODULE_ID, "latentMagic"),
        promoted: false
    });
});

// Bind cache chat card buttons
Hooks.on("renderChatMessage", (message, html) => {
    CacheGenerator.bindChatListeners(html);
});

// Sidebar buttons (GM): Loot Cache and registry (Items directory)
Hooks.on("renderItemDirectory", (app, html, data) => {
    if (!game.user.isGM) return;

    const $html = $(html);
    if ($html.find(".ionrift-item-directory-toolbar").length > 0) return;

    const toolbar = $('<div class="ionrift-item-directory-toolbar"></div>');

    const cacheBtn = $(`<button type="button" class="ionrift-cache-btn"><i class="fas fa-treasure-chest"></i> Loot Cache</button>`);
    cacheBtn.click(() => {
        new CacheGeneratorApp().render(true);
    });

    const ledgerBtn = $(`<button type="button" class="ionrift-ledger-btn"><i class="fas fa-book-sparkles"></i> Quartermaster</button>`);
    ledgerBtn.click(async () => {
        const { SignatureLedgerApp } = await import("./apps/SignatureLedgerApp.js");
        new SignatureLedgerApp().render(true);
    });

    toolbar.append(cacheBtn).append(ledgerBtn);
    $html.find(".header-actions").append(toolbar);
});

// Windfall Logger for Signature Items
Hooks.on("createItem", async (item, options, userId) => {
    if (game.user.id !== userId) return; // Only process on the creating client
    if (!item.parent || item.parent.documentName !== "Actor") return;
    
    // Only care if it's going into a player-owned character
    const actor = item.parent;
    if (actor.type !== "character" || !actor.hasPlayerOwner) return;

    // Check if it's an Ionrift signature stub
    const flags = item.flags?.["ionrift-quartermaster"] || {};
    if (flags.isSignature) {
        // Did we suggest someone for this? Check if it matched. 
        // Either way, log it to the actor who ACTUALLY received it.
        const rarity = item.system?.rarity || "uncommon";
        
        await SignatureLedger.logWindfall(actor.id, rarity);
        
        ui.notifications.info(`Ionrift: ${actor.name} received a signature item. Ledger updated.`);
    }
});

// Context menu entries
Hooks.on("getItemDirectoryEntryContext", (html, options) => {
    // Edit in Quartermaster (always available for GMs)
    options.push({
        name: "Edit in Quartermaster",
        icon: '<i class="fas fa-hammer"></i>',
        callback: li => {
            const item = game.items.get(li.data("documentId"));
            if (item) {
                new WorkshopApp(item).render(true);
            }
        },
        condition: li => {
            if (!game.user.isGM) return false;
            const item = game.items.get(li.data("documentId"));
            return item && item.isOwner;
        }
    });

    // Sound binding (only when Resonance is available)
    if (isResonanceActive()) {
        options.push({
            name: "Ionrift Sounds",
            icon: '<i class="fas fa-volume-up"></i>',
            callback: li => {
                const item = game.items.get(li.data("documentId"));
                if (item) {
                    import("./SheetInjector.js").then(({ SheetInjector }) => {
                        SheetInjector.openSoundPicker(item);
                    });
                }
            },
            condition: li => {
                const item = game.items.get(li.data("documentId"));
                return item && item.isOwner;
            }
        });
    }
});
