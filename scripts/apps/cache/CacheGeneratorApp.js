import { applyCacheGeneratorAdvisoryMethods } from "./CacheGeneratorAdvisoryMethods.js";
import { applyCacheGeneratorCanvasMethods } from "./CacheGeneratorCanvasMethods.js";
import { CacheGenerator } from "../../services/cache/CacheGenerator.js";
import { ItemMaskingHelper } from "../../services/identify/ItemMaskingHelper.js";
import { ItemPoolResolver } from "../../services/loot/ItemPoolResolver.js";
import { LootPoolCompiler } from "../../services/loot/LootPoolCompiler.js";
import { PartyShelfPool } from "../../services/loot/PartyShelfPool.js";
import { ProgressionAdvisor } from "../../services/progression/ProgressionAdvisor.js";
import { SignatureLedger } from "../../services/progression/SignatureLedger.js";
import { getActiveCursedRegistry } from "../../services/loot/StandalonePoolRegistry.js";
import { takeVisibleCapped } from "../../services/settings/AdvisoryStripUtils.js";
import { CursedItemResolver } from "../../services/curse/CursedItemResolver.js";
import { ItemResolutionPipeline } from "../../services/workshop/ItemResolutionPipeline.js";
import { SquashMerger } from "../../services/packs/SquashMerger.js";
import { classifyCacheItem } from "../../services/cache/CacheItemClassifier.js";
import { TerrainDataRegistry } from "../../services/loot/TerrainDataRegistry.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { roundCoinGp, formatCoinPrice, withCoinPriceLabel } from "../../services/workshop/CoinFormat.js";
import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";
import { getQuartermasterAdapter } from "../../adapters/getAdapter.js";
import { QM_FEATURES } from "../../data/QMFeatures.js";


/** Foundry compendium / sidebar item drags (v12 and v13). */
export function getFoundryDragData(event) {
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    return TE?.getDragEventData?.(event) ?? null;
}

/** Rows shown in Party Shelf and Cursed Pool strips (ledger + pool combined). */
export const ADVISORY_SIDE_POOL_CAP = 2;

/** When Scroll Plan has no pins, those strips are hidden; shelf + cursed use one extra row. */
export const ADVISORY_SIDE_POOL_CAP_NO_SCROLLS = ADVISORY_SIDE_POOL_CAP + 1;

/** Ephemeral compendium draw size before cache visibility filter (must exceed cap). */
export const ADVISORY_EPHEMERAL_FETCH = 12;

/** Discrete budget windows per tier (click a segment to select). */
export const TIER_BUDGET_BRACKETS = {
    1: [
        { min: 50, max: 150 },
        { min: 150, max: 300 },
        { min: 300, max: 450 },
        { min: 450, max: 500 }
    ],
    2: [
        { min: 200, max: 450 },
        { min: 450, max: 750 },
        { min: 750, max: 1100 },
        { min: 1100, max: 1500 }
    ],
    3: [
        { min: 800, max: 1800 },
        { min: 1800, max: 3200 },
        { min: 3200, max: 4200 },
        { min: 4200, max: 5000 }
    ],
    4: [
        { min: 2000, max: 5000 },
        { min: 5000, max: 8000 },
        { min: 8000, max: 11000 },
        { min: 11000, max: 15000 }
    ]
};

export function formatGpShort(gp) {
    if (gp >= 1000) {
        const k = gp / 1000;
        return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
    }
    return `${gp}`;
}

export function formatBracketLabel(min, max) {
    return `${formatGpShort(min)}-${formatGpShort(max)} gp`;
}

export function bracketMidpoint(bracket) {
    return (bracket.min + bracket.max) / 2;
}

export function nearestBracketIndex(brackets, gp) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < brackets.length; i++) {
        const dist = Math.abs(gp - bracketMidpoint(brackets[i]));
        if (dist < bestDist) {
            bestDist = dist;
            best = i;
        }
    }
    return best;
}


/**
 * Cache Generator UI.
 * Three-column layout when Progression Advisory has data:
 *   Left   -- read-only advisory: character milestone cards (passive reference).
 *   Center -- configure tier/terrain/owner, generate, reroll items.
 *   Right  -- matched container card; drag to canvas to place (Item Piles),
 *             or "Add to Items" button as fallback.
 * Falls back to two-column (center + right) when advisory is empty.
 * GM-only.
 */
export class CacheGeneratorApp extends Application {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ionrift-cache-generator",
            title: "ionrift-quartermaster.cacheGenerator.title",
            template: `modules/${MODULE_ID}/templates/cache-generator.hbs`,
            // Match three-column layout width up front so opening empty and
            // opening after Generate do not resize (advisory column is 960px wide).
            width: 960,
            height: 720,
            classes: ["ionrift-window", "glass-ui"],
            resizable: true
        });
    }

    constructor(options = {}) {
        super(options);
        this._currentResult    = null;
        this._generating       = false;
        this._advisory         = null;
        // Default collapsed; restore last state if setting exists
        this._advisoryCollapsed = game.settings?.get(MODULE_ID, "advisoryCollapsed") ?? true;
        this._cursedPool       = [];      // random compendium-drawn cursed items for left panel
        this._cursedPlanned    = [];      // ledger cursedPlanned (milestone-pinned)
        this._partyShelfPool   = [];      // ephemeral party shelf from compendiums
        this._partyShelfPoolLoaded = false;
        // Bound reference so we can remove it after use
        this._boundCanvasDrop = this._onCanvasDrop.bind(this);
        this._cursedPoolLoaded = false; // [EA] guards against re-fetch loop
        // Tracks pools manually rerolled via dice button: suppresses isPlanned (recipe) items.
        // Reset on _onGenerate so fresh generation restores milestone priority.
        this._poolRerollMode = new Set();
        // Budget segment state (null = use saved bracket or tier default)
        this._budgetMin = null;
        this._budgetMax = null;
        this._budgetBracketIndex = null;
        this._sliderDebounce = null;
        this._sliderPersistTimer = null;
        this._dragEnterCount = 0;
        /** @type {number|undefined} Pool row index to refocus after a qty-step re-render. */
        this._qtyStepFocusIndex = undefined;
    }

    /**
     * Preserve `.cache-results` scroll (and optional qty input focus) across re-renders.
     * Without this, each quantity click rebuilds the list and jumps to the top.
     */
    async render(force = false, options = {}) {
        const results = this.element?.[0]?.querySelector(".cache-results");
        const scrollTop = results?.scrollTop ?? 0;
        const focusIndex = this._qtyStepFocusIndex;
        this._qtyStepFocusIndex = undefined;

        await super.render(force, options);

        if (scrollTop <= 0 && focusIndex === undefined) return;

        requestAnimationFrame(() => {
            this._constrainResultsHeight();
            requestAnimationFrame(() => {
                const nextResults = this.element?.[0]?.querySelector(".cache-results");
                if (nextResults && scrollTop > 0) nextResults.scrollTop = scrollTop;
                if (focusIndex !== undefined && Number.isFinite(focusIndex)) {
                    const input = this.element?.[0]?.querySelector(
                        `.cache-qty-input[data-index="${focusIndex}"]`
                    );
                    input?.focus({ preventScroll: true });
                }
            });
        });
    }

    getData() {
        const tier  = this._currentResult?.meta?.tier  ?? game.settings?.get(MODULE_ID, "defaultCacheTier")  ?? 1;
        const theme = this._currentResult?.meta?.theme ?? game.settings?.get(MODULE_ID, "defaultCacheTheme") ?? "dungeon";

        const themeOptionGroups = TerrainDataRegistry.getTerrainOptionGroups(theme);
        const themes = TerrainDataRegistry.getTerrainList()
            .map(t => ({ ...t, selected: t.id === theme }));

        const themeObj = themes.find(t => t.selected) ?? themes[0];

        // Container panel data
        const container = this._currentResult?.container ?? null;
        const fillPct        = container?.fillPercent ?? 0;
        const overweightClass = container?.isOverweight ? "overweight" : "";
        const capacityLabel  = container
            ? `${Number(container.contentWeightLbs ?? 0).toFixed(1)} / ${container.capacityLbs} lb`
            : "";
        const statsLabel = container
            ? `Empty: ${container.emptyWeightLbs ?? 0} lb  |  Cap: ${container.capacityLbs} lb`
            : "";

        // Drag-to-canvas via Item Piles is dnd5e-only. On other systems the
        // pile creation crashes (Actor.create rejects with no valid actor
        // type, and the ITEM_TRANSFORMER reads CONFIG.DND5E.attunementTypes).
        // Force the fallback path on non-dnd5e systems.
        const itemPilesActive = !!(game.modules?.get("itempilesdnd5e")?.active)
            && game.system?.id === "dnd5e";

        // Systems whose adapter advertises a native loot actor path
        // (PF2E) replace the sidebar-folder fallback with Create Loot Actor
        // when Item Piles is unavailable.
        const supportsLootActor = !itemPilesActive
            && !!game.ionrift?.quartermaster?.adapter?.canCreateLootActor?.();

        const activeAdapter = getQuartermasterAdapter();
        const supportsScrollForge = activeAdapter.supports(QM_FEATURES.SCROLL_FORGE);
        const supportsAdvisory = activeAdapter.supports(QM_FEATURES.SIGNATURE_LEDGER)
            || activeAdapter.supports(QM_FEATURES.SRD_CURSES);

        let currentOwnerTheme = this._currentResult?.meta?.ownerTheme
            ?? game.settings?.get(MODULE_ID, "defaultCacheOwnerTheme")
            ?? "unspecified";
        if (!supportsScrollForge && currentOwnerTheme === "arcana") {
            currentOwnerTheme = "unspecified";
        }

        // Compact labels for the secondary context strip
        const tierLabels = { 1: "T1", 2: "T2", 3: "T3", 4: "T4" };
        const tierLabel = tierLabels[tier] ?? `T${tier}`;

        const ownerThemes = [
            { id: "unspecified", label: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeUnspecified"), desc: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeUnspecifiedDesc") },
            ...(supportsScrollForge ? [
                { id: "arcana",  label: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeArcana"), desc: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeArcanaDesc") }
            ] : []),
            { id: "apothecary",  label: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeApothecary"), desc: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeApothecaryDesc") },
            { id: "armaments",   label: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeArmaments"), desc: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeArmamentsDesc") },
            { id: "implements",  label: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeImplements"), desc: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeImplementsDesc") },
            { id: "relics",      label: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeRelics"), desc: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeRelicsDesc") },
            { id: "abandoned",   label: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeAbandoned"), desc: game.i18n.localize("ionrift-quartermaster.cacheGenerator.themeAbandonedDesc") }
        ].map(t => ({ ...t, selected: t.id === currentOwnerTheme }));

        const brackets = TIER_BUDGET_BRACKETS[tier] ?? TIER_BUDGET_BRACKETS[1];
        const bracketIndex = this._resolveBudgetBracketIndex(tier, brackets);
        const activeBracket = brackets[bracketIndex];
        const budgetMin = this._budgetMin ?? activeBracket.min;
        const budgetMax = this._budgetMax ?? activeBracket.max;
        const budgetBrackets = brackets.map((b, i) => ({
            min: b.min,
            max: b.max,
            label: formatBracketLabel(b.min, b.max),
            selected: i === bracketIndex
        }));
        const budgetRangeLabel = formatBracketLabel(budgetMin, budgetMax);

        // Detect whether any loot pool compendium is configured. When empty the
        // Generate button is replaced with a nudge so the GM sets up sources first.
        const hasLootPool = ItemPoolResolver.getEnabledSources().length > 0;
        const lootSourcesOnly = !getQuartermasterAdapter().supports(QM_FEATURES.LOOT_POOL_COMPILE);

        // Forge status pip -- shown inline next to Generate when a compiled pool
        // is stale or missing so the GM can act without leaving the generator.
        // Only surfaced when 2024 architecture is present (i.e. compilation matters).
        const forgeStatus     = LootPoolCompiler.is2024ArchitecturePresent()
            ? LootPoolCompiler.getStatus()
            : null;
        const forgeStalePip   = forgeStatus === "stale" || forgeStatus === "error";
        const forgeNeverPip   = forgeStatus === "never";

        return {
            tier,
            theme,
            tierIs1: tier === 1,
            tierIs2: tier === 2,
            tierIs3: tier === 3,
            tierIs4: tier === 4,
            tierLabel,
            themeLabel: themeObj.label,
            themes,
            themeOptionGroups,
            ownerThemes,
            currentOwnerTheme,
            result:    this._currentResult,
            generating: this._generating,
            hasResult: !!this._currentResult,
            hasLootPool,
            lootSourcesOnly,
            forgeStalePip,
            forgeNeverPip,

            container,
            fillPct,
            overweightClass,
            capacityLabel,
            statsLabel,
            itemPilesActive,
            supportsLootActor,
            advisory:         supportsAdvisory ? this._buildAdvisoryContext() : null,
            advisoryCollapsed: this._advisoryCollapsed,
            budgetMin,
            budgetMax,
            budgetBrackets,
            budgetRangeLabel,
            ...(this._currentResult ? this._groupItems(this._currentResult) : {})
        };
    }

    /**
     * Refresh cursed data for the left panel: random compendium pool + ledger planned.
     * Called after generation so the pool reflects the current tier.
     */

    activateListeners(html) {
        super.activateListeners(html);

        html.find(".action-generate").click(this._onGenerate.bind(this));

        const lootSourceBtns = html.find(".action-open-pool-compiler, .action-open-forge-from-pip");
        Logger.info(MODULE_LABEL,
            `CacheGen loot-sources bind: ${lootSourceBtns.length} button(s), html=${html[0]?.tagName ?? html[0]?.nodeName}`);
        lootSourceBtns.on("click", this._onOpenLootSources.bind(this));
        html.find(".action-reroll-slot").click(this._onRerollSlot.bind(this));
        html.find(".action-remove-slot").click(this._onRemoveSlot.bind(this));
        html.find(".action-qty-up").click(this._onQtyStep.bind(this, 1));
        html.find(".action-qty-down").click(this._onQtyStep.bind(this, -1));
        html.find(".cache-qty-input").on("change", this._onEditQuantity.bind(this));
        html.find(".cache-qty-input").on("blur", this._onQtyInputBlur.bind(this));
        html.find(".action-reroll-container").click(this._onRerollContainer.bind(this));
        html.find(".action-inject-signature").click(this._onInjectSignature.bind(this));
        html.find(".action-add-items").click(this._onAddToItems.bind(this));
        html.find(".action-create-loot-actor").click(this._onCreateLootActor.bind(this));
        html.find(".action-clear-gold").click(this._onClearGold.bind(this));
        html.find(".action-reroll-gold").click(this._onRerollGold.bind(this));

        // Advisory panel toggle
        html.find(".action-toggle-advisory").click(this._onToggleAdvisory.bind(this));
        // Section collapse toggles in the left panel
        html.find(".advisory-section-toggle").click(this._onToggleAdvisorySection.bind(this));
        // Panel pool reroll dice buttons (scroll plan / party shelf / cursed pool)
        html.find(".action-reroll-panel-pool").click(this._onRerollPanelPool.bind(this));

        // Auto-persist tier and theme selects on change; reroll if a result is already showing
        html.find("select[name='tier']").change(e => {
            game.settings.set(MODULE_ID, "defaultCacheTier", parseInt(e.target.value) || 1);
            // Reset budget segment when tier changes so the new tier picks a fresh bracket
            this._budgetMin = null;
            this._budgetMax = null;
            this._budgetBracketIndex = null;
            if (this._currentResult) this._onGenerate();
        });
        html.find("select[name='theme']").change(e => {
            game.settings.set(MODULE_ID, "defaultCacheTheme", e.target.value);
            if (this._currentResult) this._onGenerate();
        });

        // Live update guidance text for owner theme + persist + auto-reroll
        html.find("select[name='ownerTheme']").change(e => {
            const val = e.target.value;
            html.find(".guidance-text").hide();
            html.find(`.guidance-text.guidance-${val}`).css("display", "inline");
            game.settings.set(MODULE_ID, "defaultCacheOwnerTheme", val);
            if (this._currentResult) this._onGenerate();
        });

        html.find(".budget-segment").click(this._onBudgetSegmentClick.bind(this));

        html.find(".cache-item-row").on("click", ".cache-item-icon, .cache-item-name", this._onInspectItem.bind(this));

        // Drag-to-canvas: container card is the drag handle when Item Piles is active
        const card = html.find(".container-card[draggable='true']")[0];
        if (card) {
            card.addEventListener("dragstart", this._onDragContainerStart.bind(this));
            card.addEventListener("dragend", this._onDragContainerEnd.bind(this));
        }

        // Left-panel drags: signatures, party shelf, scroll plan, cursed pool (shared handler).
        html[0].querySelectorAll(".advisory-card-item[draggable=\"true\"], .shelf-item[draggable=\"true\"]").forEach(el => {
            el.addEventListener("dragstart", this._onLeftPanelItemDragStart.bind(this));
        });

        // Cache results list + the full right panel: accept drops from left-panel items.
        // Using the right panel as the outer drop zone means the GM can drop anywhere
        // in the preview area (container card, drag-hint, etc.) not just the item list.
        // Uses a dragEnter counter to avoid flickering when the cursor
        // crosses child-element boundaries within the drop zone.
        const resultsEl = html.find(".cache-results")[0];
        if (resultsEl) {
            resultsEl.addEventListener("dragenter",  this._onCacheResultsDragEnter.bind(this));
            resultsEl.addEventListener("dragover",   this._onCacheResultsDragOver.bind(this));
            resultsEl.addEventListener("dragleave",  this._onCacheResultsDragLeave.bind(this));
            resultsEl.addEventListener("drop",       this._onCacheResultsDrop.bind(this));
        }

        // Extend drop zone to the full right panel (container/loot preview area)
        const rightEl = html.find("#cache-right-drop-zone")[0];
        if (rightEl) {
            rightEl.addEventListener("dragenter",  this._onCacheResultsDragEnter.bind(this));
            rightEl.addEventListener("dragover",   this._onCacheResultsDragOver.bind(this));
            rightEl.addEventListener("dragleave",  this._onCacheResultsDragLeave.bind(this));
            rightEl.addEventListener("drop",       this._onCacheResultsDrop.bind(this));
        }

        // Constrain results height so overflow-y scroll is reliable
        requestAnimationFrame(() => this._constrainResultsHeight());

        if (this._currentResult) {
            html.find(".cache-results").addClass("visible");
        }

        // Eager advisory + pools: populate all three left-panel sections on
        // first open so the GM sees Signatures, Party Shelf, and Cursed Pool.
        const tier = this._currentResult?.meta?.tier ?? game.settings?.get(MODULE_ID, "defaultCacheTier") ?? 1;
        const pending = [];

        if (!this._advisory) {
            pending.push(
                ProgressionAdvisor.advise(tier, this._currentResult).then(adv => {
                    this._advisory = adv;
                })
            );
        }

        if (!this._partyShelfPoolLoaded) {
            pending.push(this._refreshPartyShelfPool(tier));
        }

        if (!this._cursedPoolLoaded) {
            pending.push(this._refreshCursedPool(tier));
        }

        if (pending.length) {
            Promise.all(pending).then(() => this.render());
        }
    }

    // ── Budget segment selection ─────────────────────────────────────────────

    _resolveBudgetBracketIndex(tier, brackets) {
        if (this._budgetBracketIndex !== null && this._budgetBracketIndex !== undefined) {
            return Math.max(0, Math.min(brackets.length - 1, this._budgetBracketIndex));
        }

        const savedIdx = game.settings?.get(MODULE_ID, "cacheBudgetBracketIndex") ?? -1;
        if (savedIdx >= 0) {
            return Math.max(0, Math.min(brackets.length - 1, savedIdx));
        }

        const savedAnchorPct = game.settings?.get(MODULE_ID, "cacheBudgetAnchorPct") ?? -1;
        if (savedAnchorPct >= 0) {
            const low = brackets[0].min;
            const high = brackets[brackets.length - 1].max;
            const approxGp = low + savedAnchorPct * (high - low);
            return nearestBracketIndex(brackets, approxGp);
        }

        return 0;
    }

    _onBudgetSegmentClick(event) {
        event.preventDefault();
        const btn = event.currentTarget;
        const min = parseInt(btn.dataset.min, 10);
        const max = parseInt(btn.dataset.max, 10);
        const index = parseInt(btn.dataset.index, 10);
        if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(index)) return;

        this._budgetMin = min;
        this._budgetMax = max;
        this._budgetBracketIndex = index;

        const html = $(this.element);
        html.find(".budget-segment").removeClass("is-selected");
        btn.classList.add("is-selected");
        html.find("[name='budgetMin']").val(min);
        html.find("[name='budgetMax']").val(max);
        html.find(".budget-range-display").text(formatBracketLabel(min, max));

        if (this._currentResult) {
            CacheGenerator.applyBudgetFloor(this._currentResult, min, max);
            this._syncBudgetDisplay();
        }

        this._persistBudgetBracket(index);
        this._debouncedBudgetReroll();
    }

    // ── Scroll constraint (set maxHeight on results so overflow-y works) ────

    _constrainResultsHeight() {
        const elem = this.element[0];
        if (!elem) return;
        const center  = elem.querySelector(".cache-center");
        const results = elem.querySelector(".cache-results");
        if (!center || !results) return;

        const centerH = center.getBoundingClientRect().height;
        if (centerH === 0) return; // not yet painted

        // Sum height of all .cache-center direct children EXCEPT .cache-results
        let taken = 0;
        for (const child of center.children) {
            if (child !== results) taken += child.getBoundingClientRect().height;
        }

        const available = Math.max(80, centerH - taken);
        results.style.maxHeight = `${available}px`;
        results.style.overflowY  = "auto";
    }

    /** Re-constrain after the user resizes the window */
    _onResize(event) {
        super._onResize(event);
        requestAnimationFrame(() => this._constrainResultsHeight());
    }

    // ── Generate ─────────────────────────────────────────────────────────────

    /**
     * Open Compendium Forge on the Loot Pool tab.
     * Stop the click from bubbling: Foundry brings the clicked window to the
     * front after inner handlers run, which would cover the newly opened Forge.
     */
    async _onOpenLootSources(event) {
        event?.preventDefault();
        event?.stopPropagation();
        Logger.info(MODULE_LABEL, "Set Up Loot Sources click fired");
        try {
            const { CompendiumForgeApp } = await import("../forge/CompendiumForgeApp.js");
            const app = new CompendiumForgeApp({}, { activeTab: "lootPool" });
            await app.render(true);
            Logger.info(MODULE_LABEL, "Compendium Forge rendered");
        } catch (err) {
            Logger.error(MODULE_LABEL, "Failed to open Compendium Forge:", err);
            ui.notifications.error(game.i18n.localize("ionrift-quartermaster.cacheGenerator.notifyOpenForgeFailed"));
        }
    }

    /** Debounce budget segment reroll after a segment click. */
    _debouncedBudgetReroll() {
        if (!this._currentResult) return;
        clearTimeout(this._sliderDebounce);
        this._sliderDebounce = setTimeout(() => {
            if (this._generating) {
                this._debouncedBudgetReroll();
                return;
            }
            this._onGenerate();
        }, 400);
    }

    _persistBudgetBracket(index) {
        if (!Number.isFinite(index)) return;
        clearTimeout(this._sliderPersistTimer);
        this._sliderPersistTimer = setTimeout(() => {
            game.settings?.set(MODULE_ID, "cacheBudgetBracketIndex", index).catch(() => {});
        }, 200);
    }

    async _onGenerate(event) {
        event?.preventDefault();
        if (this._generating) return;

        const form = this.element.find("form")[0];
        if (!form) return;

        const formData = Object.fromEntries(new FormData(form));
        const tier       = parseInt(formData.tier)       || 1;
        const theme      = formData.theme                || "dungeon";
        const ownerTheme = formData.ownerTheme           || "unspecified";

        // Budget overrides: explicit drag state → form hidden inputs → tier defaults.
        // The footer (hidden inputs) doesn't exist on first generate, so we always
        // have a tier-appropriate fallback to ensure the pill position is respected.
        const tierBudgetDefaults = {
            1: { min: 50,   max: 500   },
            2: { min: 200,  max: 1500  },
            3: { min: 800,  max: 5000  },
            4: { min: 2000, max: 15000 }
        };
        const tbd = tierBudgetDefaults[tier] ?? tierBudgetDefaults[2];
        const budgetMin = this._budgetMin ?? (formData.budgetMin ? parseInt(formData.budgetMin) : tbd.min);
        const budgetMax = this._budgetMax ?? (formData.budgetMax ? parseInt(formData.budgetMax) : tbd.max);


        this._generating = true;
        this._advisory   = null;
        this._poolRerollMode?.clear();  // Fresh generate restores milestone priority
        this._setGeneratingUi(true);

        try {
            this._currentResult = await CacheGenerator.generate({
                tier, theme, ownerTheme, silent: true,
                budgetMin, budgetMax
            });
            [this._advisory] = await Promise.all([
                ProgressionAdvisor.advise(tier, this._currentResult),
                this._refreshPartyShelfPool(tier),
                this._refreshCursedPool(tier)
            ]);
        } catch (e) {
            Logger.error(MODULE_LABEL, "Generation failed:", e);
            ui.notifications.error(game.i18n.localize("ionrift-quartermaster.cacheGenerator.notifyGenerationFailed"));
        } finally {
            this._generating = false;
            this._setGeneratingUi(false);
            this.render();
        }
    }

    // ── Left Panel Item Drag ──────────────────────────────────────────────────

    /**
     * Fired when the GM begins dragging an item from the advisory, party shelf,
     * or cursed pool panel. Sets the transfer payload to the item's UUID so the
     * cache results list can resolve and inject it on drop.
     */

    // ── Coinage controls ──────────────────────────────────────────────────────

    _onClearGold(event) {
        event.preventDefault();
        if (!this._currentResult) return;
        CacheGenerator.clearCacheGold(this._currentResult);
        this.render();
    }

    async _onRerollGold(event) {
        event.preventDefault();
        if (!this._currentResult) return;
        await CacheGenerator.rerollCacheGold(this._currentResult);
        this.render();
    }

    // ── Advisory Panel ────────────────────────────────────────────────────────

    async _onRerollSlot(event) {
        event.preventDefault();
        if (!this._currentResult) return;

        const slotType   = event.currentTarget.dataset.slot;
        const stackName  = event.currentTarget.dataset.stackName;
        const stackCount = parseInt(event.currentTarget.dataset.stackCount ?? "1");
        const index      = parseInt(event.currentTarget.dataset.index);
        const items      = this._currentResult.items;

        const tables   = await CacheGenerator._loadTables();
        const tierData = tables.tiers[String(this._currentResult.meta.tier)];
        if (tables.tiers) {
            for (const [key, td] of Object.entries(tables.tiers)) td._tier = parseInt(key);
        }
        const theme = this._currentResult.meta.theme;

        // Helper: pick one replacement (routed through _pickItem for masking)
        const pickOne = async () => {
            if (slotType === "signature") {
                return CacheGenerator._generateSignatureStub(this._currentResult.meta.tier, theme);
            }
            return CacheGenerator._pickItem(slotType, theme, tierData, tables);
        };

        if (stackCount > 1 && stackName) {
            // Reroll all instances of this stacked item in parallel
            const allIndices = items
                .map((item, i) => item.name === stackName ? i : -1)
                .filter(i => i >= 0);
            const replacements = await Promise.all(allIndices.map(() => pickOne()));
            allIndices.forEach((idx, i) => {
                if (replacements[i]) items[idx] = replacements[i];
            });
        } else {
            if (index < 0 || index >= items.length) return;
            const replacement = await pickOne();
            if (replacement) items[index] = replacement;
        }

        await this._refreshAdvisoryForCurrentCache();
        this.render();
    }

    // ── Quantity edit (cache preview) ─────────────────────────────────────────

    /** Keep line price aligned with quantity edits in the preview list. */
    _recalcLinePrice(item) {
        const qty = Math.max(1, Number(item.quantity) || 1);
        if (item._unitPrice == null) {
            const basisQty = Math.max(1, Number(item._priceBasisQty) || qty);
            item._unitPrice = (item.price ?? 0) / basisQty;
        }
        item._priceBasisQty = qty;
        item.price = roundCoinGp(item._unitPrice * qty);
    }

    /** Update gold chips and the footer estimate without rebuilding the item list. */
    _syncBudgetDisplay() {
        if (!this._currentResult) return;
        const grouped = this._groupItems(this._currentResult);
        const root = this.element?.[0];
        if (!root) return;

        const chips = root.querySelector(".cache-gold-chips");
        if (chips) chips.innerHTML = this._buildGoldChipsHtml(grouped);

        const totalEl = root.querySelector(".cache-total strong");
        if (totalEl) totalEl.textContent = grouped.totalValueLabel;
    }

    _buildGoldChipsHtml({ gold, coinage }) {
        if (!gold) {
            return `<span class="cache-gold-empty">${game.i18n.localize("ionrift-quartermaster.cacheGenerator.noCoinage")}</span>`;
        }

        const chip = (cls, amount, label) =>
            `<span class="coin-chip ${cls}"><i class="fas fa-circle"></i> ${amount} ${label}</span>`;

        if (coinage) {
            let html = "";
            if (coinage.pp) html += chip("coin-pp", coinage.pp, "pp");
            if (coinage.gp) html += chip("coin-gp", coinage.gp, "gp");
            if (coinage.ep) html += chip("coin-ep", coinage.ep, "ep");
            if (coinage.sp) html += chip("coin-sp", coinage.sp, "sp");
            if (coinage.cp) html += chip("coin-cp", coinage.cp, "cp");
            if (html) return html;
        }

        return chip("coin-gp", gold, "gp");
    }

    _setGeneratingUi(active) {
        const root = this.element?.[0];
        if (!root) return;

        for (const btn of root.querySelectorAll(".action-generate")) {
            btn.disabled = active;
            if (active) {
                if (!btn.dataset.prevHtml) btn.dataset.prevHtml = btn.innerHTML;
                btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${game.i18n.localize("ionrift-quartermaster.cacheGenerator.generating")}`;
            } else if (btn.dataset.prevHtml) {
                btn.innerHTML = btn.dataset.prevHtml;
                delete btn.dataset.prevHtml;
            }
        }
    }

    _onQtyStep(delta, event) {
        event.preventDefault();
        event.stopPropagation();
        if (!this._currentResult) return;
        const index = parseInt(event.currentTarget.dataset.index, 10);
        if (!Number.isFinite(index) || index < 0 || index >= this._currentResult.items.length) return;
        const item = this._currentResult.items[index];
        const current = Number(item.quantity) || 1;
        const next = Math.max(1, Math.min(99, current + delta));
        if (next === current) return;
        item.quantity = next;
        this._recalcLinePrice(item);
        this._qtyStepFocusIndex = index;
        this.render();
    }

    /** Restore blank quantity fields to the last known stack size (no commit). */
    _onQtyInputBlur(event) {
        const el = event.currentTarget;
        const v = String(el.value ?? "").trim();
        if (v !== "") return;
        const fallback = parseInt(el.dataset.stackCount || "1", 10) || 1;
        el.value = String(Math.max(1, Math.min(99, fallback)));
    }

    /**
     * Direct quantity edit on cache preview rows. Supports stacked same-name
     * lines by growing or shrinking the underlying item list.
     */
    _onEditQuantity(event) {
        event.stopPropagation();
        if (!this._currentResult) return;

        const el = event.currentTarget;
        const items = this._currentResult.items;
        const stackName = (el.dataset.stackName || "").trim();
        const stackCount = parseInt(el.dataset.stackCount || "1", 10) || 1;
        const index = parseInt(el.dataset.index, 10);

        const raw = parseInt(String(el.value).trim(), 10);
        if (!Number.isFinite(raw)) {
            el.value = String(Math.max(1, Math.min(99, stackCount)));
            return;
        }
        const target = Math.max(1, Math.min(99, raw));

        const groupIdx = stackName
            ? items.map((it, i) => (it.name === stackName ? i : -1)).filter(i => i >= 0)
            : [];

        if (stackName && groupIdx.length > 1) {
            const cur = groupIdx.length;
            if (target > cur) {
                const proto = items[groupIdx[0]];
                for (let i = cur; i < target; i++) {
                    items.push(foundry.utils.deepClone(proto));
                }
            } else if (target < cur) {
                const removeIdx = groupIdx.slice(target).sort((a, b) => b - a);
                for (const i of removeIdx) items.splice(i, 1);
            }
            for (const idx of items.map((it, i) => (it.name === stackName ? i : -1)).filter(i => i >= 0)) {
                items[idx].quantity = 1;
                this._recalcLinePrice(items[idx]);
            }
        } else if (Number.isFinite(index) && index >= 0 && index < items.length) {
            items[index].quantity = target;
            this._recalcLinePrice(items[index]);
        } else if (groupIdx.length === 1) {
            items[groupIdx[0]].quantity = target;
            this._recalcLinePrice(items[groupIdx[0]]);
        }

        el.value = String(target);
        if (Number.isFinite(index)) this._qtyStepFocusIndex = index;
        void this._refreshAdvisoryForCurrentCache().then(() => this.render());
    }

    // ── Remove individual slot ────────────────────────────────────────────────
}

applyCacheGeneratorAdvisoryMethods(CacheGeneratorApp);
applyCacheGeneratorCanvasMethods(CacheGeneratorApp);
