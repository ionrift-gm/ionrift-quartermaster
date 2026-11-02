import { MODULE_ID } from "../../data/moduleId.js";
/**
 * CompendiumForgeApp
 *
 * Unified dialog for all Quartermaster compendium compilation workflows.
 * Three first-class tabs: Loot Pool, Scroll Forge, Cursed Items.
 * Each tab runs source picker, compile, then done.
 *
 * State machine runs independently per tab so switching never resets another
 * tab's phase or compile result.
 *
 * Scroll Forge source discovery is async (reads pack indexes). The tab renders
 * immediately in a loading skeleton state, then re-renders once candidates
 * arrive. That keeps the UI responsive regardless of world size.
 */

import { ItemPoolResolver } from "../../services/loot/ItemPoolResolver.js";
import { LootPoolCompiler  } from "../../services/loot/LootPoolCompiler.js";
import { ScrollForge       } from "../../services/scroll/ScrollForge.js";
import { getCurseAdapter   } from "../../services/curse/getCurseAdapter.js";
import { refreshForgeAlertBadge } from "../../services/settings/SettingsPanelLayout.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { getQuartermasterAdapter } from "../../adapters/getAdapter.js";
import { QM_FEATURES } from "../../data/QMFeatures.js";

import {
    QM_BUG_REPORT_CONTEXT,
    shouldOfferLootPoolBugReport,
    lootPoolCompileIsOptional,
    LOOT_PHASE_LABELS,
    applyCompendiumForgeWorkflows
} from "./CompendiumForgeWorkflows.js";

export { shouldOfferLootPoolBugReport, lootPoolCompileIsOptional };

export class CompendiumForgeApp extends FormApplication {

    constructor(object = {}, options = {}) {
        super(object, options);

        /** @type {"lootPool"|"scrollForge"|"cursedItems"} */
        this._activeTab = options.activeTab ?? "lootPool";

        // Per-tab phase: "pick" | "compile" | "done"
        this._phases    = { lootPool: "pick", scrollForge: "pick", cursedItems: "pick" };
        // Per-tab in-flight compile flag
        this._compiling = { lootPool: false,  scrollForge: false,  cursedItems: false  };
        // Per-tab done payload
        this._doneResults = { lootPool: null, scrollForge: null,   cursedItems: null   };

        // Loot Pool has a detailed onProgress stream
        this._progress = { current: 0, total: 0, phase: "setup", label: "", log: [] };
        this._renderScheduled = false;

        // Scroll Forge candidate cache (async discovery)
        // null  = not yet fetched for this session
        // false = fetch in flight (loading state)
        // []    = fetched, no candidates
        // [...]  = fetched with data
        this._scrollCandidates = null;
    }

    // ── Per-tab phase accessors (keep singular names for compat) ──────────

    get _phase()      { return this._phases[this._activeTab]; }
    set _phase(v)     { this._phases[this._activeTab] = v; }

    get _isCompiling() { return this._compiling[this._activeTab]; }
    get _doneResult()  { return this._doneResults[this._activeTab]; }

    /** True while scroll compendium discovery has not finished. */
    get _scrollLoading() {
        return this._scrollCandidates === null || this._scrollCandidates === false;
    }

    // ── Foundry app shell ─────────────────────────────────────────────────

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id:             "ionrift-compendium-forge",
            title:          "ionrift-quartermaster.forge.appTitle",
            template:       `modules/${MODULE_ID}/templates/compendium-forge.hbs`,
            width:          640,
            height:         520,
            classes:        ["ionrift-window", "glass-ui"],
            closeOnSubmit:  false,
            submitOnChange: false,
            resizable:      true,
        });
    }

    async close(options = {}) {
        const closed = await super.close(options);
        refreshForgeAlertBadge();
        return closed;
    }

    // ── Data ──────────────────────────────────────────────────────────────

    getData() {
        const tab   = this._activeTab;
        const phase = this._phase;

        // Groups are only needed in the pick phase
        let groups  = [];
        let loading = false;
        let curseSourceInfo = null;  // used by cursed items info-only view

        if (phase === "pick") {
            if (tab === "scrollForge") {
                if (this._scrollCandidates === null || this._scrollCandidates === false) {
                    loading = true;
                } else {
                    groups = this._buildScrollGroups();
                }
            } else if (tab === "cursedItems") {
                // Cursed Items has no user-selectable sources -- SrdCurseAdapter
                // uses a hardcoded manifest against all dnd5e item packs.
                // Show which packs it will scan as an informational list.
                curseSourceInfo = this._buildCurseSourceInfo();
            } else {
                groups = this._buildSourceGroups();
            }
        }

        const doneResult = this._doneResults[tab];

        return {
            tabs:              this._buildTabs(),
            activePartial:     this._activePartialName(),
            phase,
            loading,
            curseSourceInfo,

            // Pick phase
            paneTitle:         this._paneTitle(),
            paneDesc:          this._paneDesc(),
            groups,
            compiledStatus:    phase === "pick" ? this._buildCompiledStatus() : null,
            renderCompileButton: phase === "pick" && (this._shouldShowCompileButton() || this._lootCompileDormant()),
            compileButtonHidden: phase === "pick" && this._lootCompileDormant(),
            statusBadge:       phase === "pick" ? this._buildStatusBadge()    : null,
            isScrollForge:     tab === "scrollForge",
            isCursedItems:     tab === "cursedItems",
            isLootPool:        tab === "lootPool",

            // Compile phase
            phaseLabel:    LOOT_PHASE_LABELS[this._progress.phase] ?? game.i18n.localize("ionrift-quartermaster.forge.phaseProcessing"),
            progressPct:   this._progress.total > 0
                ? Math.round((this._progress.current / this._progress.total) * 100)
                : 0,
            progress:      this._progress,
            indeterminate: tab !== "lootPool",  // scroll/curse show spinner not bar+log

            // Done phase
            doneResult:        doneResult ? this._formatDoneResult(tab, doneResult) : null,
            bugReportUi:       this._buildBugReportUi(tab, phase),

            // Pick phase: view existing compendium if already compiled
            showViewCompendium: phase === "pick" && !!this._existingPackId(tab),
            viewPackId:         phase === "pick" ? (this._existingPackId(tab) ?? "") : "",
        };
    }

    /** Returns the world pack collection ID if it currently exists, else null. */
    _existingPackId(tab) {
        const ids = {
            lootPool:    LootPoolCompiler.worldCollectionId,
            scrollForge: "world.ionrift-forged-scrolls",
            cursedItems: "world.ionrift-srd-cursed",
        };
        const id = ids[tab];
        return (id && game.packs.get(id)) ? id : null;
    }

    _activePartialName() {
        const BASE = `modules/${MODULE_ID}/templates`;
        return `${BASE}/compendium-forge-${this._phase}.hbs`;
    }

    _formatDoneResult(tab, r) {
        if (tab === "lootPool") {
            const skipCount = r.skippedCount ?? r.skippedItems?.length ?? 0;
            return {
                primary:        { label: game.i18n.localize("ionrift-quartermaster.forge.statItems"),     value: r.itemCount     ?? 0 },
                secondary:      { label: game.i18n.localize("ionrift-quartermaster.forge.statTemplates"), value: r.templateCount ?? 0 },
                tertiary:       { label: game.i18n.localize("ionrift-quartermaster.forge.statSources"),   value: (r.sourceIds ?? []).length },
                skippedCount:   skipCount,
                skippedSummary: skipCount > 0
                    ? LootPoolCompiler.formatSkippedItemsSummary(r.skippedItems)
                    : "",
                skipReport:     skipCount > 0
                    ? LootPoolCompiler.formatSkipReportForDisplay(r.skippedItems)
                    : null,
                showViewPack:   true,
                packId:         LootPoolCompiler.worldCollectionId,
            };
        }
        if (tab === "scrollForge") {
            return {
                primary:      { label: game.i18n.localize("ionrift-quartermaster.forge.statScrolls"), value: r.scrollCount ?? 0 },
                secondary:    { label: game.i18n.localize("ionrift-quartermaster.forge.statSources"), value: r.sourceCount ?? 0 },
                tertiary:     null,
                showViewPack: true,
                packId:       "world.ionrift-forged-scrolls",
            };
        }
        if (tab === "cursedItems") {
            return {
                primary:      { label: game.i18n.localize("ionrift-quartermaster.forge.statItems"),   value: r.itemCount  ?? 0 },
                secondary:    { label: game.i18n.localize("ionrift-quartermaster.forge.statSources"), value: r.sourceCount ?? 0 },
                tertiary:     null,
                showViewPack: true,
                packId:       "world.ionrift-srd-cursed",
            };
        }
        return null;
    }

    // ── Tab helpers ───────────────────────────────────────────────────────

    _buildTabs() {
        const adapter = getQuartermasterAdapter();
        const scrollStatus = this._getScrollForgeStatus();
        const lootStatus   = LootPoolCompiler.getStatus();
        const curseStatus  = this._getCursedStatus();

        const tabs = [
            {
                id:          "scrollForge",
                label:       game.i18n.localize("ionrift-quartermaster.forge.tabScrollForge"),
                icon:        "fas fa-scroll",
                active:      this._activeTab === "scrollForge",
                status:      scrollStatus,
                statusLabel: this._dotLabel(scrollStatus),
            },
            {
                id:          "lootPool",
                label:       adapter.supports(QM_FEATURES.LOOT_POOL_COMPILE)
                    ? game.i18n.localize("ionrift-quartermaster.forge.tabLootPool")
                    : game.i18n.localize("ionrift-quartermaster.forge.tabLootSources"),
                icon:        "fas fa-treasure-chest",
                active:      this._activeTab === "lootPool",
                status:      this._lootTabStatus(lootStatus),
                statusLabel: this._lootTabStatusLabel(lootStatus),
            },
            {
                id:          "cursedItems",
                label:       game.i18n.localize("ionrift-quartermaster.forge.tabCursedItems"),
                icon:        "fas fa-skull",
                active:      this._activeTab === "cursedItems",
                status:      curseStatus,
                statusLabel: this._dotLabel(curseStatus),
            },
        ];

        return tabs.filter(tab => {
            if (tab.id === "scrollForge") return adapter.supports(QM_FEATURES.SCROLL_FORGE);
            if (tab.id === "cursedItems") return adapter.supports(QM_FEATURES.SRD_CURSES);
            if (tab.id === "lootPool") return adapter.supports(QM_FEATURES.LOOT_CACHE);
            return true;
        });
    }

    _dotLabel(status) {
        if (status === "fresh") return game.i18n.localize("ionrift-quartermaster.forge.dotFresh");
        if (status === "stale") return game.i18n.localize("ionrift-quartermaster.forge.dotStale");
        if (status === "never") return game.i18n.localize("ionrift-quartermaster.forge.dotNever");
        if (status === "error") return game.i18n.localize("ionrift-quartermaster.forge.dotError");
        return game.i18n.localize("ionrift-quartermaster.forge.dotOther");
    }

    _lootPoolCompileIsOptional() {
        return lootPoolCompileIsOptional({
            compileSupported: this._lootPoolCompileSupported(),
            has2024:          LootPoolCompiler.is2024ArchitecturePresent(),
            status:           LootPoolCompiler.getStatus(),
        });
    }

    /** Hidden compile button, revealed when the 2024 equipment row is checked. */
    _lootCompileDormant() {
        return this._activeTab === "lootPool"
            && this._lootPoolCompileIsOptional()
            && !this._shouldShowCompileButton();
    }

    _equipment24Title() {
        const pack = game.packs?.get?.("dnd5e.equipment24");
        return pack?.title || pack?.metadata?.label || "dnd5e.equipment24";
    }

    _lootTabStatus(lootStatus) {
        if (!this._lootPoolCompileSupported()) return "na";
        if (this._lootPoolCompileIsOptional()) return "na";
        return lootStatus;
    }

    _lootTabStatusLabel(lootStatus) {
        if (!this._lootPoolCompileSupported()) return game.i18n.localize("ionrift-quartermaster.forge.statusNoCompileStep");
        if (this._lootPoolCompileIsOptional()) {
            return game.i18n.format("ionrift-quartermaster.forge.statusCompileAppearsWhenEquipmentOn", { pack: this._equipment24Title() });
        }
        return this._dotLabel(lootStatus);
    }

    /** True when this world expands loot via a compiled pool (dnd5e 2024 path). */
    _lootPoolCompileSupported() {
        return getQuartermasterAdapter().supports(QM_FEATURES.LOOT_POOL_COMPILE);
    }

    _paneTitle() {
        if (this._activeTab === "scrollForge") return game.i18n.localize("ionrift-quartermaster.forge.tabScrollForge");
        if (this._activeTab === "cursedItems") return game.i18n.localize("ionrift-quartermaster.forge.tabCursedItems");
        return this._lootPoolCompileSupported()
            ? game.i18n.localize("ionrift-quartermaster.forge.tabLootPool")
            : game.i18n.localize("ionrift-quartermaster.forge.tabLootSources");
    }

    _paneDesc() {
        if (this._activeTab === "scrollForge") {
            const rules = game.ionrift?.quartermaster?.adapter?.getScrollForgeRules?.();
            const rec = rules?.getRecommendedPackIds?.() ?? [];
            if (rec.length) {
                return game.i18n.format("ionrift-quartermaster.forge.scrollForgeDescRecommended", { packs: rec.join(", ") });
            }
            return game.i18n.localize("ionrift-quartermaster.forge.scrollForgeDesc");
        }
        if (this._activeTab === "cursedItems") {
            if (game.system?.id === "pf2e") {
                return game.i18n.localize("ionrift-quartermaster.forge.cursedItemsDescPf2e");
            }
            return game.i18n.localize("ionrift-quartermaster.forge.cursedItemsDescSrd");
        }
        if (!this._lootPoolCompileSupported()) {
            const adapter = getQuartermasterAdapter();
            const recommended = adapter.getDefaultLootPoolSources?.() ?? [];
            return recommended.length
                ? game.i18n.format("ionrift-quartermaster.forge.lootSourcesDescRecommended", { packs: recommended.join(", ") })
                : game.i18n.localize("ionrift-quartermaster.forge.lootSourcesDesc");
        }
        if (!LootPoolCompiler.is2024ArchitecturePresent()) {
            return game.i18n.format("ionrift-quartermaster.forge.lootPoolDescEnable2024", { pack: this._equipment24Title() });
        }
        return game.i18n.localize("ionrift-quartermaster.forge.lootPoolDesc2024");
    }

    // ── Status helpers ────────────────────────────────────────────────────

    _getScrollForgeStatus() {
        return ScrollForge.getStatus();
    }

    _getCursedStatus() {
        return getCurseAdapter().getStatus();
    }

    _shouldShowCompileButton() {
        const adapter = getQuartermasterAdapter();
        const tab    = this._activeTab;
        if (tab === "lootPool" && !adapter.supports(QM_FEATURES.LOOT_POOL_COMPILE)) {
            return false;
        }
        const status = tab === "lootPool"
            ? LootPoolCompiler.getStatus()
            : tab === "scrollForge" ? this._getScrollForgeStatus()
            : this._getCursedStatus();

        if (tab === "scrollForge") {
            // Show only once candidates are loaded
            return !this._scrollLoading && this._scrollCandidates !== null && this._scrollCandidates !== false;
        }
        if (tab === "cursedItems") return true;
        return LootPoolCompiler.is2024ArchitecturePresent() || status === "error";
    }

    _buildStatusBadge() {
        const tab = this._activeTab;
        if (tab === "lootPool" && !this._lootPoolCompileSupported()) {
            return { type: "fresh", icon: "fas fa-circle-check", label: game.i18n.localize("ionrift-quartermaster.forge.badgeNoCompileNeeded") };
        }
        if (tab === "lootPool" && this._lootPoolCompileIsOptional()) {
            return { type: "na", icon: "fas fa-circle-info", label: game.i18n.localize("ionrift-quartermaster.forge.badgeSourcesOnly") };
        }
        let status;
        if (tab === "lootPool") {
            status = LootPoolCompiler.getStatus();
        } else if (tab === "scrollForge") {
            status = this._getScrollForgeStatus();
        } else {
            status = this._getCursedStatus();
        }

        if (status === "fresh") return { type: "fresh", icon: "fas fa-circle-check",         label: game.i18n.localize("ionrift-quartermaster.forge.badgeCompiled") };
        if (status === "stale") return { type: "stale", icon: "fas fa-triangle-exclamation", label: game.i18n.localize("ionrift-quartermaster.forge.badgeStale") };
        if (status === "never") return { type: "never", icon: "fas fa-circle-xmark",         label: game.i18n.localize("ionrift-quartermaster.forge.badgeNotCompiled") };
        if (status === "error") return { type: "error", icon: "fas fa-circle-exclamation",   label: game.i18n.localize("ionrift-quartermaster.forge.badgeCompileFailed") };
        return null;
    }

    _buildCompiledStatus() {
        const tab = this._activeTab;

        if (tab === "lootPool") {
            if (!this._lootPoolCompileSupported()) {
                return {
                    type: "fresh",
                    icon: "fas fa-circle-info",
                    text: game.i18n.localize("ionrift-quartermaster.forge.lootStatusNoCompiledPool"),
                    meta: null,
                    clearable: false,
                };
            }

            const meta   = LootPoolCompiler.getCompiledMeta();
            const status = LootPoolCompiler.getStatus();

            if (status === "error") {
                const when = meta?.errorAt ? this._relativeTime(meta.errorAt) : game.i18n.localize("ionrift-quartermaster.forge.timeRecently");
                const errMsg = meta?.errorMessage
                    ? meta.errorMessage.length > 120
                        ? meta.errorMessage.slice(0, 120) + "..."
                        : meta.errorMessage
                    : game.i18n.localize("ionrift-quartermaster.forge.unknownErrorConsole");
                const skipCount = meta?.skippedCount ?? meta?.skippedItems?.length ?? 0;
                return {
                    type: "error",
                    icon: "fas fa-circle-exclamation",
                    text: game.i18n.format("ionrift-quartermaster.forge.compileFailedWhen", { when }),
                    meta: errMsg,
                    skipSummary: skipCount > 0
                        ? LootPoolCompiler.formatSkippedItemsSummary(meta.skippedItems)
                        : null,
                    skipReport: skipCount > 0
                        ? LootPoolCompiler.formatSkipReportForDisplay(meta.skippedItems)
                        : null,
                    clearable: false,
                };
            }
            if (status === "never" && LootPoolCompiler.is2024ArchitecturePresent()) {
                return { type: "never", icon: "fas fa-circle-xmark", text: game.i18n.localize("ionrift-quartermaster.forge.lootStatusNever2024"), meta: null, clearable: false };
            }
            if (meta && (meta.compilerVersion ?? 0) < LootPoolCompiler.COMPILER_VERSION) {
                return {
                    type:      "stale",
                    icon:      "fas fa-triangle-exclamation",
                    text:      game.i18n.localize("ionrift-quartermaster.forge.lootStatusCompilerUpdated"),
                    meta:      meta.itemCount != null
                        ? game.i18n.format("ionrift-quartermaster.forge.metaItemsCompiledAge", { count: meta.itemCount, age: this._relativeTime(meta.compiledAt) })
                        : null,
                    clearable: !!game.packs.get(LootPoolCompiler.worldCollectionId),
                };
            }
            if ((status === "stale" || status === "fresh") && meta) {
                const age       = this._relativeTime(meta.compiledAt);
                const packGone  = !game.packs.get(LootPoolCompiler.worldCollectionId);
                const skipCount = meta.skippedCount ?? meta.skippedItems?.length ?? 0;
                const baseText  = packGone
                    ? game.i18n.localize("ionrift-quartermaster.forge.lootStatusPackRemoved")
                    : status === "stale"
                        ? game.i18n.localize("ionrift-quartermaster.forge.lootStatusSourcesChanged")
                        : skipCount > 0
                            ? game.i18n.localize("ionrift-quartermaster.forge.lootStatusWarnings")
                            : game.i18n.localize("ionrift-quartermaster.forge.lootStatusUpToDate");
                const compileMeta = meta.itemCount != null
                    ? game.i18n.format("ionrift-quartermaster.forge.metaItemsCompiledAge", { count: meta.itemCount, age })
                    : null;
                return {
                    type: packGone ? "stale" : (skipCount > 0 && status === "fresh" ? "warning" : status),
                    icon: (packGone || status === "stale")
                        ? "fas fa-triangle-exclamation"
                        : skipCount > 0
                            ? "fas fa-triangle-exclamation"
                            : "fas fa-circle-check",
                    text: baseText,
                    meta: compileMeta,
                    skipSummary: skipCount > 0
                        ? LootPoolCompiler.formatSkippedItemsSummary(meta.skippedItems)
                        : null,
                    skipReport: skipCount > 0
                        ? LootPoolCompiler.formatSkipReportForDisplay(meta.skippedItems)
                        : null,
                    clearable: !packGone,
                };
            }

        }

        if (tab === "scrollForge") {
            const status = this._getScrollForgeStatus();
            const meta   = ScrollForge.getCompiledMeta();

            if (status === "error") {
                const when = meta?.errorAt ? this._relativeTime(meta.errorAt) : game.i18n.localize("ionrift-quartermaster.forge.timeRecently");
                const msg  = meta?.errorMessage ?? game.i18n.localize("ionrift-quartermaster.forge.unknownErrorConsoleShort");
                return { type: "error", icon: "fas fa-circle-exclamation", text: game.i18n.format("ionrift-quartermaster.forge.compileFailedWhen", { when }), meta: msg, clearable: false };
            }
            if (status === "never") {
                return { type: "never", icon: "fas fa-circle-xmark", text: game.i18n.localize("ionrift-quartermaster.forge.scrollStatusNever"), meta: null, clearable: false };
            }
            const packGone = !game.packs.get(ScrollForge.worldCollectionId);
            if (packGone) {
                return { type: "stale", icon: "fas fa-triangle-exclamation", text: game.i18n.localize("ionrift-quartermaster.forge.scrollStatusPackRemoved"), meta: null, clearable: false };
            }
            const baseText = status === "stale"
                ? game.i18n.localize("ionrift-quartermaster.forge.lootStatusSourcesChanged")
                : game.i18n.localize("ionrift-quartermaster.forge.scrollStatusUpToDate");
            return {
                type:      status,
                icon:      status === "stale" ? "fas fa-triangle-exclamation" : "fas fa-circle-check",
                text:      baseText,
                meta:      meta?.scrollCount != null
                    ? (meta.compiledAt
                        ? game.i18n.format("ionrift-quartermaster.forge.metaScrollsCompiledAge", { count: meta.scrollCount, age: this._relativeTime(meta.compiledAt) })
                        : game.i18n.format("ionrift-quartermaster.forge.metaScrollsCount", { count: meta.scrollCount }))
                    : null,
                clearable: true,
            };
        }

        if (tab === "cursedItems") {
            const CurseAdapter = getCurseAdapter();
            const status = this._getCursedStatus();
            const meta   = CurseAdapter.getCompiledMeta();

            if (status === "error") {
                const when = meta?.errorAt ? this._relativeTime(meta.errorAt) : game.i18n.localize("ionrift-quartermaster.forge.timeRecently");
                const msg  = meta?.errorMessage ?? game.i18n.localize("ionrift-quartermaster.forge.unknownErrorConsoleShort");
                return { type: "error", icon: "fas fa-circle-exclamation", text: game.i18n.format("ionrift-quartermaster.forge.compileFailedWhen", { when }), meta: msg, clearable: false };
            }
            if (status === "never") {
                return { type: "never", icon: "fas fa-circle-xmark", text: game.i18n.localize("ionrift-quartermaster.forge.cursedStatusNever"), meta: null, clearable: false };
            }
            const packGone = !game.packs.get(CurseAdapter.worldCollectionId);
            if (packGone) {
                return { type: "stale", icon: "fas fa-triangle-exclamation", text: game.i18n.localize("ionrift-quartermaster.forge.cursedStatusPackRemoved"), meta: null, clearable: false };
            }
            const baseText = status === "stale"
                ? game.i18n.localize("ionrift-quartermaster.forge.lootStatusSourcesChanged")
                : game.i18n.localize("ionrift-quartermaster.forge.cursedStatusUpToDate");
            return {
                type:      status,
                icon:      status === "stale" ? "fas fa-triangle-exclamation" : "fas fa-circle-check",
                text:      baseText,
                meta:      meta?.itemCount != null
                    ? (meta.compiledAt
                        ? game.i18n.format("ionrift-quartermaster.forge.metaItemsCompiledAge", { count: meta.itemCount, age: this._relativeTime(meta.compiledAt) })
                        : game.i18n.format("ionrift-quartermaster.forge.metaItemsCount", { count: meta.itemCount }))
                    : null,
                clearable: true,
            };
        }

        return null;
    }


    // ── Listeners ─────────────────────────────────────────────────────────

    activateListeners(html) {
        super.activateListeners(html);

        // Opening directly on Scroll Forge (e.g. from Signature Ledger) never hits the
        // tab-click handler, so kick off discovery on first paint.
        if (this._activeTab === "scrollForge" && this._phase === "pick" && this._scrollCandidates === null) {
            this._loadScrollCandidates();
        }

        // Tab switching
        html.find(".forge-tab").on("click", ev => {
            const tab = ev.currentTarget.dataset.tab;
            if (tab === this._activeTab && this._phase === "pick") return;
            this._activeTab = tab;
            // Re-render with current phase -- don't reset other tabs
            if (tab === "scrollForge" && this._scrollCandidates === null) {
                this._loadScrollCandidates();
            } else {
                this.render(false);
            }
        });

        // Save sources (without compiling)
        html.find(".forge-save-sources").on("click", async ev => {
            ev.preventDefault();
            await this._saveSources(html);
            this.close();
        });

        html.find(".forge-copy-bug-report").on("click", async ev => {
            ev.preventDefault();
            await this._onCopyBugReport();
        });

        html.find(".forge-send-bug-report").on("click", async ev => {
            ev.preventDefault();
            await this._onSendBugReport();
        });

        html.find('input[type="checkbox"]').filter((_, el) => el.name === "pack-dnd5e.equipment24")
            .on("change", ev => {
                if (!this._lootCompileDormant()) return;
                html.find(".forge-compile-pool").prop("hidden", !ev.currentTarget.checked);
            });

        // Compile
        html.find(".forge-compile-pool").on("click", async ev => {
            ev.preventDefault();
            if (this._isCompiling) return;
            await this._saveSources(html);
            const tab = this._activeTab;
            if (tab === "lootPool")    this._startLootPoolCompile();
            else if (tab === "scrollForge") this._startScrollCompile();
            else if (tab === "cursedItems") this._startCurseCompile();
        });

        // Back to pick
        html.find(".forge-back").on("click", ev => {
            ev.preventDefault();
            if (this._isCompiling) return;
            this._phases[this._activeTab] = "pick";
            this.render(false);
        });

        // Done -- close
        html.find(".forge-done").on("click", ev => {
            ev.preventDefault();
            this.close();
        });

        // View compiled compendium (done screen + pick screen)
        html.find(".forge-view-compendium").on("click", ev => {
            ev.preventDefault();
            // Done screen passes packId via data attribute; pick screen uses viewPackId
            const packId = ev.currentTarget.dataset.packId
                || html.find(".forge-view-compendium").data("packId");
            const pack = packId ? game.packs.get(packId) : null;
            if (pack) pack.render(true);
            else ui.notifications.warn(game.i18n.localize("ionrift-quartermaster.notification.compiledCompendiumNotFound"));
        });

        // Clear pool (all tabs)
        html.find(".forge-clear-pool").on("click", async ev => {
            ev.preventDefault();
            await this._clearForgeTab(this._activeTab);
        });

        // Select All / None (any tab with selectable checkboxes)
        html.find(".forge-select-all").on("click", ev => {
            ev.preventDefault();
            html.find('input[type="checkbox"][name^="pack-"]').prop("checked", true);
        });
        html.find(".forge-select-none").on("click", ev => {
            ev.preventDefault();
            html.find('input[type="checkbox"][name^="pack-"]').prop("checked", false);
        });

        // Collapsible source groups
        html.find(".pool-group-header").on("click", ev => {
            ev.preventDefault();
            $(ev.currentTarget).closest(".pool-group").toggleClass("collapsed");
        });
    }

}

applyCompendiumForgeWorkflows(CompendiumForgeApp);
