import { WorkshopApp } from "./apps/WorkshopApp.js";
import { CacheGeneratorApp } from "./apps/CacheGeneratorApp.js";
import { SheetInjector } from "./SheetInjector.js";
import { WorkshopItemFactory } from "./services/WorkshopItemFactory.js";
import { CacheGenerator } from "./services/CacheGenerator.js";

import { IdentificationService } from "./services/IdentificationService.js";
import { IdentificationGuard } from "./services/IdentificationGuard.js";
import { PriceMasker } from "./services/PriceMasker.js";
import { PriceInjector } from "./PriceInjector.js";
import { SignatureLedger } from "./services/SignatureLedger.js";
import { ProgressionSeeder } from "./services/ProgressionSeeder.js";
import { ProgressionAdvisor } from "./services/ProgressionAdvisor.js";
import { ItemPoolResolver } from "./services/ItemPoolResolver.js";
import { LootPoolCompiler } from "./services/LootPoolCompiler.js";
import { ScrollForge } from "./services/ScrollForge.js";
import { SrdCurseAdapter } from "./services/SrdCurseAdapter.js";
import { ItemMaskingHelper } from "./services/ItemMaskingHelper.js";
import { StandalonePoolRegistry } from "./services/StandalonePoolRegistry.js";
import { TerrainDataRegistry } from "./services/TerrainDataRegistry.js";
import { registerQuartermasterSettings } from "./services/SettingsRegistrar.js";
import { openSetupGuide } from "./constants/SetupGuide.js";

import { ContentPackLoader } from "./services/ContentPackLoader.js";
import { ContentPackCompiler } from "./services/ContentPackCompiler.js";
import { OverlayItemMaterialiser } from "./services/OverlayItemMaterialiser.js";
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

/**
 * Drop loot-pool sources that must not feed cache generation (e.g. Respite activity items).
 */
async function migrateLootPoolSources() {
    if (!game.user.isGM) return;
    try {
        const raw = game.settings.get(MODULE_ID, "lootPoolSources");
        const sources = JSON.parse(raw);
        if (!Array.isArray(sources)) return;
        const filtered = sources.filter(id => !ItemPoolResolver.LOOT_POOL_EXCLUDED_PACKS.has(id));
        if (filtered.length === sources.length) return;
        await game.settings.set(MODULE_ID, "lootPoolSources", JSON.stringify(filtered));
        Logger.log(MODULE_LABEL,
            "Removed excluded compendiums from loot pool sources. Use ionrift-respite.respite-cache-utility for camp utility loot.");
    } catch {
        /* ignore unparseable setting */
    }
}

/**
 * Hash-gated loot pool compile on world load. Runs after overlay materialisation
 * so auto-registered world.quartermaster-* sources do not false-flag staleness.
 *
 * Compiler version bumps do not auto-recompile. They leave the pool stale so the
 * Forge badge and Cache Generator pip prompt a deliberate recompile.
 */
async function runLootPoolCompilerBoot() {
    if (!game.user.isGM || game.system?.id !== "dnd5e") return;
    try {
        await migrateLootPoolSources();
        const { LootPoolCompiler } = await import("./services/LootPoolCompiler.js");
        const { refreshForgeAlertBadge } = await import("./services/SettingsPanelLayout.js");

        const statusBefore = LootPoolCompiler.getStatus();
        const metaBefore   = LootPoolCompiler.getCompiledMeta();
        const versionStale = (metaBefore?.compilerVersion ?? 0) < LootPoolCompiler.COMPILER_VERSION;

        const shouldAutoCompile = statusBefore === "never"
            || statusBefore === "error"
            || (statusBefore === "stale" && !versionStale);

        if (shouldAutoCompile) {
            try {
                await LootPoolCompiler.compile();
            } catch (err) {
                Logger.error(MODULE_LABEL, "LootPoolCompiler boot compile failed:", err);
            }
        } else if (versionStale) {
            Logger.log(MODULE_LABEL,
                "LootPoolCompiler: compiler version stale; open Compendium Forge to recompile.");
        }

        refreshForgeAlertBadge();
    } catch (err) {
        Logger.error(MODULE_LABEL, "LootPoolCompiler import failed:", err);
    }
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

    const { CompendiumForgeApp } = await import("./apps/CompendiumForgeApp.js");
    registerQuartermasterSettings({ CompendiumForgeApp });

    Hooks.on("ionrift.collectBugReport", (builder, { context } = {}) => {
        if (context !== "quartermaster-loot-pool-compile") return;
        const meta = LootPoolCompiler.getCompiledMeta();
        builder.attach("quartermaster", {
            compileStatus:    LootPoolCompiler.getStatus(),
            compiledMeta:     meta,
            skippedItems:     meta?.skippedItems ?? [],
            skippedCount:     meta?.skippedCount ?? 0,
            lootPoolSources:  ItemPoolResolver.getEnabledSources(),
            compilerVersion:  LootPoolCompiler.COMPILER_VERSION,
        });
    });

    // Core pack nudge: shared library banner in Module Settings when the core
    // overlay is offered but not installed (see hoardPackNudge.js).
    try {
        const { registerHoardPackNudge } = await import("./hoardPackNudge.js");
        registerHoardPackNudge();
    } catch (e) {
        Logger.warn(MODULE_LABEL, "Core pack nudge registration failed:", e);
    }

    // Loot pool compiler nudge: banner when 2024 sources are present but pool
    // is not compiled or is stale (see lootPoolCompilerNudge.js).
    try {
        const { registerLootPoolCompilerNudge } = await import("./lootPoolCompilerNudge.js");
        registerLootPoolCompilerNudge();
    } catch (e) {
        Logger.warn(MODULE_LABEL, "Loot pool compiler nudge registration failed:", e);
    }

    Hooks.on("ionrift.overlayContentChanged", async (detail) => {
        if (detail?.moduleId !== MODULE_ID) return;
        const { ContentPackLoader } = await import("./services/ContentPackLoader.js");
        await ContentPackLoader.init();
        await TerrainDataRegistry.init(true);

        if (detail.installed && detail.active) {
            try { await OverlayItemMaterialiser.materialiseSublayer(detail.sublayer); }
            catch (err) {
                Logger.error(MODULE_LABEL, "OverlayItemMaterialiser sublayer rebuild failed:", err);
            }
        } else if (detail.installed && detail.overlayId) {
            try { await OverlayItemMaterialiser.setOverlayActive(detail.overlayId, false); }
            catch (err) {
                Logger.error(MODULE_LABEL, "OverlayItemMaterialiser deactivate failed:", err);
            }
        } else if (!detail.installed && detail.overlayId) {
            try { await OverlayItemMaterialiser.removeForOverlay(detail.overlayId); }
            catch (err) {
                Logger.error(MODULE_LABEL, "OverlayItemMaterialiser teardown failed:", err);
            }
        }
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
            "modules/ionrift-quartermaster/templates/scroll-forge-sources.hbs",
            "modules/ionrift-quartermaster/templates/compendium-forge-pick.hbs",
            "modules/ionrift-quartermaster/templates/compendium-forge-compile.hbs",
            "modules/ionrift-quartermaster/templates/compendium-forge-done.hbs"
        ]);
    } catch (e) {
        Logger.error(MODULE_LABEL, "Template load failed:", e);
    }
});

Hooks.on('ready', () => {
    IdentificationGuard.init();

    // ── Dependency advisory ───────────────────────────────────────────────────
    // Item Piles is required for cache placement and player transfers.
    // Surface this clearly on a clean install rather than silently failing.
    if (game.user.isGM && !game.modules.get("item-piles")?.active) {
        ui.notifications.warn(
            "Quartermaster: Item Piles is not installed. " +
            "Cache placement on canvas and player loot transfers require it. " +
            "Install Item Piles from the Foundry module browser to enable these features.",
            { permanent: true }
        );
    }

    // Flush caches so every reload re-fetches fresh data
    CacheGenerator._tables = null;
    ItemPoolResolver._cache.clear();
    ItemPoolResolver._cacheExpiry = null;
    ItemPoolResolver._cursedBlocklist = null;  // rebuilds after SrdCurseAdapter compiles

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

        game.ionrift.library.tests.register("ionrift-quartermaster-spine", {
            name: "Quartermaster Terrain Spine",
            description: "Verifies QM reads the spine faithfully and never pollutes it",
            runFn: async () => {
                try {
                    const { runTerrainSpineTests } = await import("./tests/TerrainSpineTests.js");
                    return runTerrainSpineTests();
                } catch {
                    return { passed: 0, failed: 0, total: 0, skipped: true,
                        results: [{ name: "TerrainSpineTests", status: "skip", message: "Test file not present (production build)." }] };
                }
            }
        });

        game.ionrift.library.tests.register("ionrift-quartermaster-pool-resolver", {
            name: "Quartermaster Pool Resolver",
            description: "Guards the cache generator role-pack resolver against lootPoolSources mis-gating",
            runFn: async () => {
                try {
                    const { runPoolResolverTests } = await import("./tests/PoolResolverTests.js");
                    return runPoolResolverTests();
                } catch {
                    return { passed: 0, failed: 0, total: 0, skipped: true,
                        results: [{ name: "PoolResolverTests", status: "skip", message: "Test file not present (production build)." }] };
                }
            }
        });

        game.ionrift.library.tests.register("ionrift-quartermaster-overlay-materialiser", {
            name: "Quartermaster Overlay Materialiser",
            description: "Guards the overlay item walker against the silent empty-pack regression on nested terrain layouts",
            runFn: async () => {
                try {
                    const { runOverlayMaterialiserTests } = await import("./tests/OverlayMaterialiserTests.js");
                    return runOverlayMaterialiserTests();
                } catch {
                    return { passed: 0, failed: 0, total: 0, skipped: true,
                        results: [{ name: "OverlayMaterialiserTests", status: "skip", message: "Test file not present (production build)." }] };
                }
            }
        });
    }



    // Expose services on namespace for companion modules (Cursewright)
    game.ionrift.quartermaster = game.ionrift.quartermaster ?? {};
    game.ionrift.quartermaster.openSetupGuide = openSetupGuide;
    game.ionrift.quartermaster.itemMaskingHelper = ItemMaskingHelper;
    game.ionrift.quartermaster.identificationService = IdentificationService;
    game.ionrift.quartermaster.identificationGuard = IdentificationGuard;
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
        // Only compile SRD cursed items if the source is still enabled.
        // GMs who remove it from cursedItemSources shouldn't see compile
        // errors for data they've opted out of.
        let srdSourceEnabled = true;
        try {
            const sources = JSON.parse(game.settings.get(MODULE_ID, "cursedItemSources") ?? "[]");
            srdSourceEnabled = sources.includes(SrdCurseAdapter.worldCollectionId);
        } catch { /* default to enabled on parse failure */ }

        if (srdSourceEnabled) {
            SrdCurseAdapter.compile().catch(err => {
                Logger.error(MODULE_LABEL, "SrdCurseAdapter failed:", err);
            });
        }
    }

    // Content Pack discovery + auto-compile
    if (game.user.isGM) {
        // Initialise terrain data: the module ships data only for the kernel
        // base, and the registry merges in any active overlay's data/terrains
        // folders so packs are plug-and-play with no module patch required.
        TerrainDataRegistry.init().then(() => {
            Logger.log(MODULE_LABEL,
                `TerrainDataRegistry loaded ${TerrainDataRegistry.getAll().length} terrain data folders.`);
        }).catch(err => {
            Logger.error(MODULE_LABEL, "TerrainDataRegistry init failed:", err);
        });

        ContentPackLoader.init().then(() => {
            if (ContentPackLoader.loaded && ContentPackLoader.getLoadedPacks().length > 0) {
                ContentPackCompiler.compileAll().catch(err => {
                    Logger.error(MODULE_LABEL, "Content Pack compilation failed:", err);
                });
            }
        }).catch(err => {
            Logger.error(MODULE_LABEL, "Content Pack loader failed:", err);
        });

        OverlayItemMaterialiser.materialiseAll()
            .catch(err => {
                Logger.error(MODULE_LABEL, "OverlayItemMaterialiser boot run failed:", err);
            })
            .finally(() => {
                runLootPoolCompilerBoot();
            });
    }
});

Hooks.on("preUpdateItem", (item, changes, options) => {
    if (!game.user.isGM) return;
    if (changes?.system?.identified !== false) return;
    // Skip items on Item Piles containers - transfer operations can trigger
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
