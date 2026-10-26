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

const QM_BUG_REPORT_CONTEXT = "quartermaster-loot-pool-compile";

/**
 * Report actions belong on a failed compile, not on compatibility skips.
 * Skips still leave a usable pool. Error status means the pool did not finish.
 * @param {{ tab?: string, phase?: string, status?: string }} state
 * @returns {boolean}
 */
export function shouldOfferLootPoolBugReport({ tab, phase, status } = {}) {
    return tab === "lootPool" && phase === "pick" && status === "error";
}

/**
 * No compile has been run, and the 2024 equipment compendium is not a saved
 * source. Loot still works from the selected packs. The forge screen should
 * not present that as a failed compile.
 * @param {{ compileSupported?: boolean, has2024?: boolean, status?: string }} state
 * @returns {boolean}
 */
export function lootPoolCompileIsOptional({ compileSupported, has2024, status } = {}) {
    return !!compileSupported && !has2024 && status === "never";
}

const LOOT_PHASE_LABELS = {
    get setup()     { return game.i18n.localize("ionrift-quartermaster.forge.phaseSetup"); },
    get templates() { return game.i18n.localize("ionrift-quartermaster.forge.phaseTemplates"); },
    get stubs()     { return game.i18n.localize("ionrift-quartermaster.forge.phaseStubs"); },
    get armor()     { return game.i18n.localize("ionrift-quartermaster.forge.phaseArmor"); },
    get wondrous()  { return game.i18n.localize("ionrift-quartermaster.forge.phaseWondrous"); },
    get enrich()    { return game.i18n.localize("ionrift-quartermaster.forge.phaseEnrich"); },
    get slaying()   { return game.i18n.localize("ionrift-quartermaster.forge.phaseSlaying"); },
    get collision() { return game.i18n.localize("ionrift-quartermaster.forge.phaseCollision"); },
    get writing()   { return game.i18n.localize("ionrift-quartermaster.forge.phaseWriting"); },
    get done()      { return game.i18n.localize("ionrift-quartermaster.forge.phaseDone"); },
};

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

    // ── Source group builders ─────────────────────────────────────────────

    _buildSourceGroups() {
        const packs = ItemPoolResolver.listAvailableCompendiums();
        const CSS   = game.ionrift?.library?.CompendiumSourceService;
        if (CSS) {
            return CSS.groupPacksByPackage(packs, {
                enabledIds: packs.filter(p => p.enabled).map(p => p.id),
                recommendedIds: packs.filter(p => p.recommended).map(p => p.id)
            });
        }

        const groups = {};

        for (const pack of packs) {
            const [moduleId] = pack.id.split(".");
            const moduleName = game.modules.get(moduleId)?.title ?? game.system?.title ?? moduleId;
            if (!groups[moduleName]) groups[moduleName] = { label: moduleName, packs: [] };
            groups[moduleName].packs.push(pack);
        }

        for (const group of Object.values(groups)) {
            group.packs.sort((a, b) => {
                if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
                return a.label.localeCompare(b.label);
            });
        }

        return Object.values(groups).sort((a, b) => {
            const aHasRec = a.packs.some(p => p.recommended);
            const bHasRec = b.packs.some(p => p.recommended);
            if (aHasRec !== bHasRec) return aHasRec ? -1 : 1;
            return a.label.localeCompare(b.label);
        });
    }

    _buildScrollGroups() {
        const rules = game.ionrift?.quartermaster?.adapter?.getScrollForgeRules?.();
        const recommendedIds = rules?.getRecommendedPackIds?.() ?? [];
        const RECOMMENDED_SCROLL = new Set(recommendedIds);
        const candidates = this._scrollCandidates ?? [];
        const checkedSet = new Set(ScrollForge.initialCheckedIds(candidates));

        const groups = {};
        for (const c of candidates) {
            const g = c.packageLabel || "Other";
            if (!groups[g]) groups[g] = { label: g, packs: [] };
            groups[g].packs.push({
                id:          c.id,
                label:       c.label,
                count:       c.spellCount,
                enabled:     checkedSet.has(c.id),
                recommended: RECOMMENDED_SCROLL.has(c.id),
                needsCompile: false,
            });
        }

        // Recommended packs float to top within each group
        for (const g of Object.values(groups)) {
            g.packs.sort((a, b) => {
                if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
                return a.label.localeCompare(b.label);
            });
        }

        return Object.values(groups).sort((a, b) => {
            const aRec = a.packs.some(p => p.recommended);
            const bRec = b.packs.some(p => p.recommended);
            if (aRec !== bRec) return aRec ? -1 : 1;
            return a.label.localeCompare(b.label);
        });
    }

    _buildBugReportUi(tab, phase) {
        if (!shouldOfferLootPoolBugReport({
            tab,
            phase,
            status: LootPoolCompiler.getStatus(),
        })) return null;

        const bugReport = game.ionrift?.library?.bugReport;
        return {
            context:   QM_BUG_REPORT_CONTEXT,
            canSubmit: bugReport?.canSubmit?.() ?? false,
            discordUrl: bugReport?.getDiscordUrl?.() ?? "https://discord.gg/vFGXf7Fncj",
        };
    }

    async _onCopyBugReport() {
        const bugReport = game.ionrift?.library?.bugReport;
        if (!bugReport) {
            ui.notifications.error(game.i18n.localize("ionrift-quartermaster.notification.bugReportLibraryRequired"));
            return;
        }
        try {
            const copied = await bugReport.copyToClipboard({ context: QM_BUG_REPORT_CONTEXT });
            ui.notifications.info(
                copied
                    ? game.i18n.localize("ionrift-quartermaster.notification.bugReportCopied")
                    : game.i18n.localize("ionrift-quartermaster.notification.bugReportDownloaded")
            );
        } catch (err) {
            Logger.error(MODULE_LABEL, "Copy bug report failed:", err);
            ui.notifications.error(game.i18n.localize("ionrift-quartermaster.notification.bugReportCopyFailed"));
        }
    }

    async _onSendBugReport() {
        const bugReport = game.ionrift?.library?.bugReport;
        if (!bugReport) {
            ui.notifications.error(game.i18n.localize("ionrift-quartermaster.notification.bugReportLibrarySendRequired"));
            return;
        }
        if (!bugReport.canSubmit()) {
            ui.notifications.warn(
                game.i18n.localize("ionrift-quartermaster.notification.bugReportPasteDiscord"),
                { permanent: true }
            );
            return;
        }

        const $sendBtn = this.element?.find?.(".forge-send-bug-report");
        if ($sendBtn?.length) $sendBtn.prop("disabled", true);

        try {
            const result = await bugReport.submit({ context: QM_BUG_REPORT_CONTEXT });
            if (!result?.ok) {
                const msg = bugReport.formatSubmitError?.(result?.error) ?? (result?.error ?? game.i18n.localize("ionrift-quartermaster.notification.bugReportUploadFailed"));
                ui.notifications.error(msg, { permanent: true });
                return;
            }
            await bugReport.showSubmitSuccess(result);
        } catch (err) {
            Logger.error(MODULE_LABEL, "Send bug report failed:", err);
            ui.notifications.error(game.i18n.localize("ionrift-quartermaster.notification.bugReportSendFailed"));
        } finally {
            if ($sendBtn?.length) $sendBtn.prop("disabled", false);
        }
    }

    _buildCurseSourceInfo() {
        const info = [];
        if (game.system?.id === "pf2e") {
            for (const id of ["pf2e.equipment-srd", "pf2e.consumables-srd"]) {
                const pack = game.packs.get(id);
                if (pack) info.push({ id: pack.collection, label: pack.title ?? pack.metadata?.label ?? id });
            }
            return info;
        }
        const pack24 = game.packs.get("dnd5e.equipment24");
        if (pack24) info.push({ id: pack24.collection, label: pack24.title ?? game.i18n.localize("ionrift-quartermaster.forge.fallbackEquipment2024") });
        const legacy = game.packs.get("dnd5e.items");
        if (legacy) info.push({ id: legacy.collection, label: legacy.title ?? game.i18n.localize("ionrift-quartermaster.forge.fallbackItemsSrd") });
        return info;
    }

    // ── Scroll Forge async candidate loading ──────────────────────────────

    async _loadScrollCandidates() {
        if (this._scrollCandidates !== null && this._scrollCandidates !== false) return; // already have data
        if (this._scrollCandidates === false) return; // fetch already in flight

        this._scrollCandidates = false; // mark in-flight
        this.render(false);             // show loading skeleton immediately

        try {
            const candidates = await ScrollForge.discoverSpellCompendiums();
            this._scrollCandidates = candidates;
        } catch (err) {
            Logger.error(MODULE_LABEL, "CompendiumForgeApp: scroll candidate discovery failed:", err);
            this._scrollCandidates = []; // empty but loaded -- show "no sources found"
        }

        this.render(false);
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

    // ── Source persistence ────────────────────────────────────────────────

    async _saveSources(html) {
        const tab = this._activeTab;

        if (tab === "lootPool") {
            const enabled = [];
            html.find('input[type="checkbox"][name^="pack-"]').each(function () {
                if (this.checked) enabled.push(this.name.replace("pack-", ""));
            });
            await game.settings.set(MODULE_ID, "lootPoolSources", JSON.stringify(enabled));
            ItemPoolResolver.clearCache();
            ui.notifications.info(enabled.length === 1
                ? game.i18n.format("ionrift-quartermaster.notification.lootPoolSourcesSavedOne", { count: enabled.length })
                : game.i18n.format("ionrift-quartermaster.notification.lootPoolSourcesSavedMany", { count: enabled.length }));
        }

        else if (tab === "scrollForge") {
            const enabled = [];
            html.find('input[type="checkbox"][name^="pack-"]').each(function () {
                if (this.checked) enabled.push(this.name.replace("pack-", ""));
            });

            const candidates = this._scrollCandidates ?? [];
            await game.settings.set(MODULE_ID, ScrollForge.SETTING_SOURCES, JSON.stringify(enabled));
            await game.settings.set(MODULE_ID, ScrollForge.SETTING_SNAPSHOT, ScrollForge._candidateSnapshot(candidates));
            await game.settings.set(MODULE_ID, ScrollForge.SETTING_HASH, "");
        }

        // cursedItems: no user-configurable sources -- SrdCurseAdapter manages its own
    }

    // ── Compile flows ─────────────────────────────────────────────────────

    _startLootPoolCompile() {
        if (this._compiling.lootPool) return;
        this._compiling.lootPool = true;
        this._phases.lootPool    = "compile";
        this._progress = { current: 0, total: 0, phase: "setup", label: LOOT_PHASE_LABELS.setup, log: [] };
        this.render(false);

        LootPoolCompiler.compile({
            forceRecompile: true,
            onProgress: p => this._onLootProgress(p),
        }).then(() => {
            const meta = LootPoolCompiler.getCompiledMeta();
            if (meta?.error) {
                this._doneResults.lootPool = null;
                this._phases.lootPool = "pick";
                return;
            }
            this._doneResults.lootPool = meta;
            this._phases.lootPool = "done";
        }).catch(err => {
            Logger.error(MODULE_LABEL, "CompendiumForgeApp: loot pool compile failed:", err);
            ui.notifications.error(game.i18n.localize("ionrift-quartermaster.notification.compileFailedConsole"));
            this._phases.lootPool = "pick";
        }).finally(() => {
            this._compiling.lootPool = false;
            refreshForgeAlertBadge();
            this.render(false);
        });
    }

    async _startScrollCompile() {
        if (this._compiling.scrollForge) return;
        this._compiling.scrollForge = true;
        this._phases.scrollForge    = "compile";
        this.render(false);

        try {
            // Capture scroll count before compile to detect net-new scrolls
            const packBefore  = game.packs.get(ScrollForge.worldCollectionId);
            const countBefore = packBefore ? (await packBefore.getIndex()).size : 0;

            await ScrollForge.compile({ forceRecompile: true });

            const packAfter  = game.packs.get(ScrollForge.worldCollectionId);
            const scrollCount = packAfter ? (await packAfter.getIndex()).size : 0;
            const sources     = JSON.parse(game.settings.get(MODULE_ID, ScrollForge.SETTING_SOURCES) ?? "[]");

            this._doneResults.scrollForge = { scrollCount, sourceCount: sources.length };
            this._phases.scrollForge = "done";
        } catch (err) {
            Logger.error(MODULE_LABEL, "CompendiumForgeApp: scroll compile failed:", err);
            ui.notifications.error(game.i18n.localize("ionrift-quartermaster.notification.scrollCompileFailedConsole"));
            this._phases.scrollForge = "pick";
        } finally {
            this._compiling.scrollForge = false;
            refreshForgeAlertBadge();
            this.render(false);
        }
    }

    async _startCurseCompile() {
        if (this._compiling.cursedItems) return;
        this._compiling.cursedItems = true;
        this._phases.cursedItems    = "compile";
        this.render(false);

        try {
            const CurseAdapter = getCurseAdapter();
            await CurseAdapter.compile({ forceRecompile: true });

            const pack   = game.packs.get(CurseAdapter.worldCollectionId);
            const count  = pack ? (await pack.getIndex()).size : 0;
            const { CursedSourcesApp } = await import("./CursedSourcesApp.js");
            const sources = CursedSourcesApp.getEnabledSources();

            this._doneResults.cursedItems = { itemCount: count, sourceCount: sources.length };
            this._phases.cursedItems = "done";
        } catch (err) {
            Logger.error(MODULE_LABEL, "CompendiumForgeApp: curse compile failed:", err);
            ui.notifications.error(game.i18n.localize("ionrift-quartermaster.notification.curseCompileFailedConsole"));
            this._phases.cursedItems = "pick";
        } finally {
            this._compiling.cursedItems = false;
            refreshForgeAlertBadge();
            this.render(false);
        }
    }

    _onLootProgress({ phase, current, total, label }) {
        this._progress.phase   = phase;
        this._progress.current = current;
        this._progress.total   = total;
        this._progress.label   = label;

        if (label) {
            this._progress.log.unshift(label);
            if (this._progress.log.length > 10) this._progress.log.length = 10;
        }

        if (!this._renderScheduled) {
            this._renderScheduled = true;
            setTimeout(() => {
                this._renderScheduled = false;
                if (this._phases.lootPool === "compile") this.render(false);
            }, 80);
        }
    }

    // ── Clear compiled packs (all tabs) ──────────────────────────────────

    async _clearForgeTab(tab) {
        const labels = {
            lootPool:    game.i18n.localize("ionrift-quartermaster.forge.labelLootPool"),
            scrollForge: game.i18n.localize("ionrift-quartermaster.forge.labelScrollPool"),
            cursedItems: game.i18n.localize("ionrift-quartermaster.forge.labelCursedPool"),
        };
        const label = labels[tab] ?? game.i18n.localize("ionrift-quartermaster.forge.labelDefaultPool");
        const confirmed = await Dialog.confirm({
            title:   game.i18n.localize("ionrift-quartermaster.forge.clearDialogTitle"),
            content: game.i18n.format("ionrift-quartermaster.forge.clearDialogContent", { label }),
            yes: () => true,
            no:  () => false,
        });
        if (!confirmed) return;

        if (tab === "lootPool") {
            await LootPoolCompiler.clearCompiledPack?.() ?? await this._clearLootPoolLegacy();
        } else if (tab === "scrollForge") {
            await ScrollForge.clearCompiledPack();
        } else if (tab === "cursedItems") {
            await getCurseAdapter().clearCompiledPack();
        }

        if (tab === "lootPool") ItemPoolResolver.clearCache();
        ui.notifications.info(game.i18n.format("ionrift-quartermaster.notification.poolCleared", { label }));
        this.render(false);
    }

    /** Fallback for loot pool clear if LootPoolCompiler.clearCompiledPack doesn't exist yet. */
    async _clearLootPoolLegacy() {
        const pack = game.packs.get(LootPoolCompiler.worldCollectionId);
        if (pack) {
            try {
                const ItemClass = CONFIG.Item.documentClass;
                const docs = await pack.getDocuments();
                if (docs.length) {
                    await ItemClass.deleteDocuments(docs.map(d => d.id), { pack: pack.collection });
                }
            } catch (err) {
                Logger.warn(MODULE_LABEL, "CompendiumForgeApp: clear pool partial failure:", err);
            }
        }
        await game.settings.set(MODULE_ID, LootPoolCompiler.SETTING_HASH, "");
        await game.settings.set(MODULE_ID, LootPoolCompiler.SETTING_META, "");
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    _relativeTime(isoString) {
        if (!isoString) return game.i18n.localize("ionrift-quartermaster.forge.timeUnknown");
        const ms = Date.now() - new Date(isoString).getTime();
        const minutes = Math.floor(ms / 60000);
        if (minutes < 1)  return game.i18n.localize("ionrift-quartermaster.forge.timeJustNow");
        if (minutes < 60) return minutes === 1
            ? game.i18n.format("ionrift-quartermaster.forge.timeMinuteAgo", { count: minutes })
            : game.i18n.format("ionrift-quartermaster.forge.timeMinutesAgo", { count: minutes });
        const hours = Math.floor(minutes / 60);
        if (hours < 24)   return hours === 1
            ? game.i18n.format("ionrift-quartermaster.forge.timeHourAgo", { count: hours })
            : game.i18n.format("ionrift-quartermaster.forge.timeHoursAgo", { count: hours });
        const days = Math.floor(hours / 24);
        return days === 1
            ? game.i18n.format("ionrift-quartermaster.forge.timeDayAgo", { count: days })
            : game.i18n.format("ionrift-quartermaster.forge.timeDaysAgo", { count: days });
    }

    // ── FormApplication stub ──────────────────────────────────────────────

    async _updateObject(_event, _formData) {
        // Source saves are handled manually via button listeners.
    }
}
