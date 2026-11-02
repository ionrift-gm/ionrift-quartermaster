import { SignatureLedger } from "../../services/progression/SignatureLedger.js";
import { ProgressionSeeder }  from "../../services/progression/ProgressionSeeder.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { getCurseAdapter } from "../../services/curse/getCurseAdapter.js";
import { StandalonePoolRegistry, getActiveCursedRegistry } from "../../services/loot/StandalonePoolRegistry.js";
import { CursedSourcesApp, CURSED_POOL_DATA_HOOK } from "../forge/CursedSourcesApp.js";
import { CursedItemResolver } from "../../services/curse/CursedItemResolver.js";
import { LootGenerationConfigApp } from "../config/loot/LootGenerationConfigApp.js";
import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";

import {
    MILESTONES,
    applySignatureLedgerViewModelMethods
} from "./SignatureLedgerViewModelMethods.js";
import { applySignatureLedgerDragAndTooltipMethods } from "./SignatureLedgerDragAndTooltipMethods.js";
import { applySignatureLedgerActionMethods } from "./SignatureLedgerActionMethods.js";

// Handlebars helper: equality check for tab conditionals
Handlebars.registerHelper("eq", (a, b) => a === b);

export class SignatureLedgerApp extends Application {

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id:       "ionrift-signature-ledger",
            title:    "ionrift-quartermaster.ledger.appTitle",
            template: "modules/ionrift-quartermaster/templates/signature-ledger.hbs",
            width:    1000,
            height:   740,
            classes:  ["ionrift-window", "glass-ui"],
            resizable: true,
            scrollY:  [".ledger-scroll-area", ".party-panel-scroll", ".banlist-scroll-area"],
            dragDrop: [{
                dropSelector:
                    ".grid-slot, .sig-slots-strip, .party-slots-strip, .ban-drop-zone"
            }]
        });
    }

    constructor(options = {}) {
        super(options);
        this._activeTab       = "signatures";
        this._tooltipCache    = new Map();  // uuid → item doc
        this._tooltipTimer     = null;
        this._tooltipEl        = null;
        this._tooltipAnchorEl  = null;
        this._sigDragActorId  = null;  // actorId of the slot currently being dragged
        this._sigDragInFlight = false; // true briefly after a drag ends, suppresses next click
        /** @type {null | "planned" | "pool"} */
        this._cursedDragType   = null;
        this._cursedDragInFlight = false;
        /** @type {null | "pinned" | "pool"} */
        this._scrollDragType   = null;
        this._scrollDragInFlight = false;
        this._partyDragType    = null;
        this._partyDragInFlight = false;
        this._scrollTrackerExpanded = false;
        this._partyTrackerExpanded  = false;
        this._cursedPoolHookRegistered = false;
        this._onCursedPoolDataExternalUpdate = () => {
            if (!this.rendered) return;
            this.render(false);
        };
    }

    async close(options = {}) {
        if (this._cursedPoolHookRegistered) {
            Hooks.off(CURSED_POOL_DATA_HOOK, this._onCursedPoolDataExternalUpdate);
            this._cursedPoolHookRegistered = false;
        }
        return super.close(options);
    }

    /**
     * Drop hover cards when the template re-renders. Removing a slot does not fire
     * mouseleave on the destroyed node, so the body-mounted tooltip must be cleared here.
     */
    render(force = false, options = {}) {
        this._tooltipAnchorEl = null;
        this._hideItemTooltip();
        return super.render(force, options);
    }

    async _render(force, options) {
        const partialPath = "modules/ionrift-quartermaster/templates/partials/slot-cell.hbs";
        if (!Handlebars.partials[partialPath]) {
            try { await loadTemplates([partialPath]); }
            catch (e) { Logger.error(MODULE_LABEL, "slot-cell partial load failed:", e); }
        }
        return super._render(force, options);
    }

    // ── getData ───────────────────────────────────────────────────────────────

    async getData() {
        const partyActors = SignatureLedger._resolvePartyMembers();

        const [sigData, scrollPinnedRaw, partyShelf, banList] = await Promise.all([
            SignatureLedger.syncWithParty(partyActors),
            SignatureLedger.getScrollPinned(),
            SignatureLedger.getPartyShelf(),
            SignatureLedger.getBanList()
        ]);

        // Cursed Pool tab: standalone SRD stubs, or Cursewright when present.
        const curseSystemEnabled = true;
        const cwPresent = !!game.ionrift?.cursewright;

        let curseData = {};
        {
            const reg = getActiveCursedRegistry();
            if (game.user.isGM) await reg.ensureDefaultCursedPoolIfEmpty?.();

            // ── One-time migration: promote any cursedPlanned entries into the pool ──
            // Planned entries become high-priority pool items (prepended at top of their tier).
            if (typeof reg.getCursedPlanned === "function") {
                try {
                    const planned = await reg.getCursedPlanned();
                    if (planned.length > 0 && typeof reg.getCursedPool === "function" && typeof reg.setCursedPool === "function" && typeof reg.setCursedPlanned === "function") {
                        const pool = await reg.getCursedPool();
                        const poolUuids = new Set(pool.map(e => (e.uuid || "").toLowerCase()));
                        const toAdd = planned
                            .filter(p => p.uuid && !poolUuids.has(p.uuid.toLowerCase()))
                            .map(p => ({
                                uuid:            p.uuid,
                                name:            p.name || "",
                                img:             p.img || DEFAULT_ITEM_ICON,
                                curseType:       p.curseType ?? "unknown",
                                decoyAppearance: p.decoyAppearance ?? "",
                                trueNature:      p.trueNature ?? "",
                                tier:            p.tier ?? 1
                            }));
                        if (toAdd.length > 0) {
                            // Prepend to pool so they surface at high priority
                            await reg.setCursedPool([...toAdd, ...pool]);
                            await reg.setCursedPlanned([]);
                            Logger.info(MODULE_LABEL, `Cursed planner migration: promoted ${toAdd.length} item(s) into the pool.`);
                        } else {
                            // Planned all already in pool - clear the stale planned list
                            await reg.setCursedPlanned([]);
                        }
                    }
                } catch (e) {
                    Logger.warn(MODULE_LABEL, "Cursed planned migration failed (non-fatal):", e.message);
                }
            }

            const cursedPoolRaw = await reg.getCursedPool();

            // Resolve display names live (pool entries go stale after pack recompile)
            const cursedPoolResolved = await CursedItemResolver.resolvePoolDisplayNames(cursedPoolRaw);

            // Per-source counts for footer
            const cwPoolCount  = cursedPoolResolved.filter(p => (p.uuid || "").includes("ionrift-cursewright-forged")).length;
            const srdPoolCount = cursedPoolResolved.filter(p => (p.uuid || "").includes("ionrift-srd-cursed")).length;

            // Pack existence flags
            const hasSrdPack    = !!game.packs.get("world.ionrift-srd-cursed");
            const hasCurseForge = !!game.packs.get("world.ionrift-cursewright-forged")
                                || !!game.packs.get("world.ionrift-forged-cursed");

            // T3/T4 enabled flags
            const t3Enabled = reg.getTierEnabled?.(3) ?? (game.settings.get(MODULE_ID, "cursedT3Enabled") ?? true);
            const t4Enabled = reg.getTierEnabled?.(4) ?? (game.settings.get(MODULE_ID, "cursedT4Enabled") ?? true);

            // Build priority columns: T1-T4, max 5 per column, preserve array order
            const PRIORITY_COL_CAP = 5;
            const priorityColumns = SignatureLedgerApp._buildCursedPriorityColumns(
                cursedPoolResolved, t3Enabled, t4Enabled, PRIORITY_COL_CAP
            );

            // Tier distribution chart
            const partyLevel = SignatureLedgerApp._partyMedianLevel(partyActors);
            const cursedTierDistribution = SignatureLedgerApp._buildCursedTierDistribution(
                partyLevel, t3Enabled, t4Enabled
            );

            curseData = {
                cwPresent,
                hasSrdPack,
                hasCurseForge,
                cwPoolCount,
                srdPoolCount,
                t3Enabled,
                t4Enabled,
                partyLevel,
                priorityColumns,
                cursedTierDistribution,
                cursedPoolCount: cursedPoolResolved.length,
                priorityColCap: PRIORITY_COL_CAP
            };
        }


        const scrollPinned = SignatureLedger.sanitizeScrollPinned(scrollPinnedRaw);

        // Auto-detect delivered signature items by scanning party inventories
        await this._syncSignatureDelivery(sigData, partyActors);

        // Auto-detect delivered items by scanning party inventories
        const syncedShelf = await this._syncDeliveryStatus(partyShelf, partyActors);

        const shelfConcentration   = game.settings?.get(MODULE_ID, "shelfConcentration") ?? 3;
        const shelfAttunementBias  = game.settings?.get(MODULE_ID, "shelfAttunementBias") ?? 1;
        const shelfCategoryWeights = game.settings?.get(MODULE_ID, "shelfCategoryWeights")
            ?? '{"wondrous":{"w":70,"on":true},"focus":{"w":15,"on":true},"armor":{"w":10,"on":true},"weapon":{"w":5,"on":true}}';
        const scrollFloor      = game.settings?.get(MODULE_ID, "scrollFloor") ?? 1;
        const scrollUpperReach = game.settings?.get(MODULE_ID, "scrollUpperReach") ?? 2;
        const scrollConcentration = game.settings?.get(MODULE_ID, "scrollConcentration") ?? 2;
        const scrollOffset     = game.settings?.get(MODULE_ID, "scrollOffset") ?? -1;

        const hasParty = partyActors.length > 0;

        // --- Policy Dashboard Data (Bell-Curve Distribution) ---
        const partyMedian = SignatureLedgerApp._partyMedianLevel(partyActors);
        const optimalLevel = Math.max(1, Math.min(9, Math.ceil(partyMedian / 2) + scrollOffset));
        const distribution = SignatureLedgerApp._computeScrollDistribution(
            optimalLevel, scrollFloor, scrollUpperReach, scrollConcentration
        );

        const scrollPolicyData = {
            partyLevel: partyMedian,
            optimalLevel,
            scrollFloor,
            scrollUpperReach,
            scrollConcentration,
            scrollOffset,
            offsetLabel: scrollOffset > 0 ? `+${scrollOffset}` : `${scrollOffset}`,
            distribution
        };

        // --- Party Shelf Policy Dashboard Data ---
        const shelfPolicyData = {
            partyLevel: partyMedian,
            distribution: SignatureLedgerApp._computeShelfRarityDistribution(shelfConcentration),
            categoryMix:  SignatureLedgerApp._computeCategoryMix(shelfCategoryWeights),
            attunementBias: shelfAttunementBias,
            attunementLabel: ["LOW", "MED", "HIGH"][shelfAttunementBias] ?? "MED"
        };

        return {
            activeTab:       this._activeTab,
            milestones:      MILESTONES(),
            hasParty,
            curseSystemEnabled,
            shelfConcentration,
            shelfAttunementBias,
            shelfCategoryWeights,
            scrollFloor,
            scrollUpperReach,
            scrollConcentration,
            scrollOffset,
            scrollTrackerExpanded: this._scrollTrackerExpanded,
            partyTrackerExpanded:  this._partyTrackerExpanded,
            scrollPolicyData,
            shelfPolicyData,
            banCount:        banList.length,
            banList,

            // Signatures tab
            ...this._buildSignatureData(partyActors, sigData),

            // Scroll tab: pinned strip
            scrollPinnedRow: this._buildScrollPinnedStrip(partyActors, scrollPinned),

            // Party shelf tab
            partyShelfRow: this._buildPartyShelfStrip(partyActors, syncedShelf),

            // Cursed tab (empty when feature flag is off)
            ...curseData
        };
    }



    // ── Listeners ─────────────────────────────────────────────────────────────

    activateListeners(html) {
        super.activateListeners(html);

        if (!this._cursedPoolHookRegistered) {
            Hooks.on(CURSED_POOL_DATA_HOOK, this._onCursedPoolDataExternalUpdate);
            this._cursedPoolHookRegistered = true;
        }

        // Tab switching
        html.find(".registry-tab").click(this._onSwitchTab.bind(this));

        // Toggle trackers
        html.find(".action-toggle-scroll-tracker").click(ev => {
            ev.preventDefault();
            this._scrollTrackerExpanded = !this._scrollTrackerExpanded;
            this.render(false);
        });
        html.find(".action-toggle-party-tracker").click(ev => {
            ev.preventDefault();
            this._partyTrackerExpanded = !this._partyTrackerExpanded;
            this.render(false);
        });
        // Scroll Policy slider live updates
        const _updateSliderFill = (el) => {
            const min = parseFloat(el.min) || 0;
            const max = parseFloat(el.max) || 1;
            const val = parseFloat(el.value) || 0;
            const pct = ((val - min) / (max - min)) * 100;
            el.style.setProperty("--pct", `${pct}%`);
        };

        // Initialise fill on render
        html.find(".policy-slider").each((_, el) => _updateSliderFill(el));

        // Update fill live while dragging (input), save on release (change)
        html.find(".action-update-scroll-floor").on("input", ev => _updateSliderFill(ev.currentTarget));
        html.find(".action-update-scroll-floor").change(async ev => {
            const val = parseInt(ev.currentTarget.value, 10);
            if (!Number.isNaN(val)) {
                await game.settings.set(MODULE_ID, "scrollFloor", val);
                this.render(false);
            }
        });
        html.find(".action-update-scroll-upper-reach").on("input", ev => _updateSliderFill(ev.currentTarget));
        html.find(".action-update-scroll-upper-reach").change(async ev => {
            const val = parseInt(ev.currentTarget.value, 10);
            if (!Number.isNaN(val)) {
                await game.settings.set(MODULE_ID, "scrollUpperReach", val);
                this.render(false);
            }
        });
        html.find(".action-update-scroll-concentration").on("input", ev => _updateSliderFill(ev.currentTarget));
        html.find(".action-update-scroll-concentration").change(async ev => {
            const val = parseInt(ev.currentTarget.value, 10);
            if (!Number.isNaN(val)) {
                await game.settings.set(MODULE_ID, "scrollConcentration", val);
                this.render(false);
            }
        });
        html.find(".action-update-scroll-offset").on("input", ev => _updateSliderFill(ev.currentTarget));
        html.find(".action-update-scroll-offset").change(async ev => {
            const val = parseInt(ev.currentTarget.value, 10);
            if (!Number.isNaN(val)) {
                await game.settings.set(MODULE_ID, "scrollOffset", val);
                this.render(false);
            }
        });
        html.find(".action-reset-scroll-defaults").click(async ev => {
            ev.preventDefault();
            await game.settings.set(MODULE_ID, "scrollFloor", 1);
            await game.settings.set(MODULE_ID, "scrollUpperReach", 2);
            await game.settings.set(MODULE_ID, "scrollConcentration", 2);
            await game.settings.set(MODULE_ID, "scrollOffset", -1);
            ui.notifications.info(game.i18n.localize("ionrift-quartermaster.notification.scrollDefaultsReset"));
            this.render(false);
        });


        // Party manager (delegates to library PartyRoster UI)
        html.find(".btn-manage-party").click(this._onManageParty.bind(this));

        // Signatures tab
        html.find(".slot-filled[data-actor-id]").click(ev => this._openItemSheetFromSlot(ev, {
            dragGuard: () => this._sigDragInFlight,
            ignoreSelector: ".slot-btn"
        }));
        html.find(".action-clear-slot").click(this._onClearSignatureSlot.bind(this));
        html.find(".action-reroll-slot").click(this._onRerollSlot.bind(this));
        html.find(".action-toggle-sig-delivered").click(this._onToggleSignatureDelivered.bind(this));
        html.find(".action-seed-signatures").click(this._onSeedSignatures.bind(this));

        // Internal signature slot drag-and-drop (swap / move)
        this._initSignatureDragDrop(html);

        // Scroll tab: pinned strip
        html.find(".scroll-slot.slot-filled[data-uuid]").click(ev => this._openItemSheetFromSlot(ev, {
            dragGuard: () => this._scrollDragInFlight,
            ignoreSelector: ".slot-btn"
        }));
        html.find(".action-remove-scroll-pin").click(this._onRemoveScrollPin.bind(this));
        html.find(".action-toggle-scroll-delivered").click(this._onToggleScrollDelivered.bind(this));
        // Scroll tab: open compendium / compile
        html.find(".action-open-forged-scrolls").click(this._onOpenForgedScrolls.bind(this));
        html.find(".action-compile-scroll-forge").click(this._onCompileScrollForge.bind(this));

        // Party shelf tab
        html.find(".party-slot.slot-filled[data-uuid]").click(ev => this._openItemSheetFromSlot(ev, {
            dragGuard: () => this._partyDragInFlight,
            ignoreSelector: ".slot-btn"
        }));
        html.find(".action-remove-party-item").click(this._onRemovePartyItem.bind(this));
        html.find(".action-toggle-delivered").click(this._onToggleDelivered.bind(this));
        html.find(".action-seed-shelf").click(this._onSeedPartyShelf.bind(this));
        html.find(".action-curate-shelf").click(this._onCurateShelfSources.bind(this));

        // Party shelf policy sliders
        html.find(".party-category-slider").each((_, el) => _updateSliderFill(el));
        html.find(".action-update-shelf-concentration").on("input", ev => _updateSliderFill(ev.currentTarget));
        html.find(".action-update-shelf-concentration").change(async ev => {
            const val = parseInt(ev.currentTarget.value, 10);
            if (!Number.isNaN(val)) {
                await game.settings.set(MODULE_ID, "shelfConcentration", val);
                this.render(false);
            }
        });
        html.find(".action-update-shelf-attunement").on("input", ev => _updateSliderFill(ev.currentTarget));
        html.find(".action-update-shelf-attunement").change(async ev => {
            const val = parseInt(ev.currentTarget.value, 10);
            if (!Number.isNaN(val)) {
                await game.settings.set(MODULE_ID, "shelfAttunementBias", val);
                this.render(false);
            }
        });

        // Category mix checkboxes + weight sliders
        html.find(".action-toggle-category").change(async ev => {
            const cat = ev.currentTarget.dataset.category;
            if (!cat) return;
            const raw = game.settings?.get(MODULE_ID, "shelfCategoryWeights")
                ?? '{"wondrous":{"w":70,"on":true},"focus":{"w":15,"on":true},"armor":{"w":10,"on":true},"weapon":{"w":5,"on":true}}';
            let parsed;
            try { parsed = JSON.parse(raw); } catch { parsed = {}; }
            if (parsed[cat]) parsed[cat].on = ev.currentTarget.checked;
            await game.settings.set(MODULE_ID, "shelfCategoryWeights", JSON.stringify(parsed));
            this.render(false);
        });
        html.find(".action-update-category-weight").on("input", ev => {
            _updateSliderFill(ev.currentTarget);
            const row = ev.currentTarget.closest(".party-category-row");
            const valEl = row?.querySelector(".party-category-weight");
            if (valEl) valEl.textContent = `${ev.currentTarget.value}%`;
        });
        html.find(".action-update-category-weight").change(async ev => {
            const cat = ev.currentTarget.dataset.category;
            if (!cat) return;
            const raw = game.settings?.get(MODULE_ID, "shelfCategoryWeights")
                ?? '{"wondrous":{"w":70,"on":true},"focus":{"w":15,"on":true},"armor":{"w":10,"on":true},"weapon":{"w":5,"on":true}}';
            let parsed;
            try { parsed = JSON.parse(raw); } catch { parsed = {}; }
            if (parsed[cat]) parsed[cat].w = parseInt(ev.currentTarget.value, 10) || 0;
            await game.settings.set(MODULE_ID, "shelfCategoryWeights", JSON.stringify(parsed));
            this.render(false);
        });
        html.find(".action-open-loot-generation-config").click(ev => {
            ev.preventDefault();
            new LootGenerationConfigApp().render(true);
        });
        html.find(".action-reset-party-defaults").click(async ev => {
            ev.preventDefault();
            await game.settings.set(MODULE_ID, "shelfConcentration", 3);
            await game.settings.set(MODULE_ID, "shelfAttunementBias", 1);
            await game.settings.set(MODULE_ID, "shelfCategoryWeights", JSON.stringify({
                wondrous: { w: 70, on: true },
                focus:    { w: 15, on: true },
                armor:    { w: 10, on: true },
                weapon:   { w: 5,  on: true }
            }));
            ui.notifications.info(game.i18n.localize("ionrift-quartermaster.notification.partyShelfDefaultsReset"));
            this.render(false);
        });

        // Ban list tab
        html.find(".action-remove-ban").click(this._onRemoveBan.bind(this));
        this._initBanDropZoneVisuals(html);
        this._initCardSearchFilter(html, {
            inputSelector:   ".ban-search-input",
            cardSelector:    ".ban-card",
            noMatchSelector: ".ban-no-matches",
            emptySelector:   ".ban-empty-state"
        });

        // Cursed tab: CurseRegistryPanel launch (Curse Tracker button in header)
        html.find(".action-open-curse-registry").click(ev => {
            ev.preventDefault();
            const cw = game.ionrift?.cursewright;
            if (!cw) { ui.notifications.warn(game.i18n.localize("ionrift-quartermaster.notification.cursewrightNotInstalled")); return; }
            new cw.CurseRegistryPanel().render(true);
        });

        // Lock toggle (signatures, scrolls)
        html.find(".action-toggle-lock").click(this._onToggleLock.bind(this));

        // Cursed tab: priority pool cards - click to open sheet
        html.find(".curse-priority-card[data-uuid]").click(ev => {
            if (ev.target.closest(".curse-priority-card-remove")) return;
            if (this._cursedDragInFlight) return;
            const uuid = ev.currentTarget.dataset.uuid;
            if (uuid) fromUuid(uuid).then(doc => doc?.sheet?.render(true));
        });

        // Remove from priority pool
        html.find(".curse-priority-card-remove").click(this._onRemovePoolItem.bind(this));

        // T3/T4 tier enable toggles
        html.find(".action-toggle-t3").change(async ev => {
            const enabled = ev.currentTarget.checked;
            const reg = getActiveCursedRegistry();
            if (typeof reg.setTierEnabled === "function") await reg.setTierEnabled(3, enabled);
            else await game.settings.set(MODULE_ID, "cursedT3Enabled", enabled);
            this.render(false);
        });
        html.find(".action-toggle-t4").change(async ev => {
            const enabled = ev.currentTarget.checked;
            const reg = getActiveCursedRegistry();
            if (typeof reg.setTierEnabled === "function") await reg.setTierEnabled(4, enabled);
            else await game.settings.set(MODULE_ID, "cursedT4Enabled", enabled);
            this.render(false);
        });

        // Source footer actions
        html.find(".action-compile-curse-forge").click(this._onRebuildCursedPool.bind(this));
        html.find(".action-compile-srd-cursed").click(this._onLoadSrdCursedItems.bind(this));
        // Delegated handler for source footer inline buttons
        html.find(".curse-source-footer").on("click", "[data-action]", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const action = ev.currentTarget.dataset.action;
            if (action === "compile-srd-cursed")  this._onLoadSrdCursedItems(ev);
            if (action === "compile-curse-forge") this._onRebuildCursedPool(ev);
        });

        if (this._activeTab === "cursed") this._initCursedDragDrop(html);
        if (this._activeTab === "scrolls") this._initScrollDragDrop(html);
        if (this._activeTab === "party") this._initPartyDragDrop(html);

        // Tooltip hover cards (all tabs)
        this._initTooltipListeners(html);
    }
}

applySignatureLedgerViewModelMethods(SignatureLedgerApp);
applySignatureLedgerDragAndTooltipMethods(SignatureLedgerApp);
applySignatureLedgerActionMethods(SignatureLedgerApp);
