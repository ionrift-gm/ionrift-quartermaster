/**
 * CompendiumForgeApp
 *
 * Unified dialog for all Quartermaster compendium compilation workflows.
 * Three first-class tabs: Loot Pool, Scroll Forge, Cursed Items.
 * Each tab has a full source-picker -> compile -> done flow.
 *
 * State machine runs independently per tab so switching never resets another
 * tab's phase or compile result.
 *
 * Scroll Forge source discovery is async (reads pack indexes). The tab renders
 * immediately in a loading skeleton state, then re-renders once candidates
 * arrive -- keeps the UI responsive regardless of world size.
 */

import { ItemPoolResolver } from "../services/ItemPoolResolver.js";
import { LootPoolCompiler  } from "../services/LootPoolCompiler.js";
import { ScrollForge       } from "../services/ScrollForge.js";
import { SrdCurseAdapter   } from "../services/SrdCurseAdapter.js";
import { refreshForgeAlertBadge } from "../services/SettingsPanelLayout.js";
import { Logger, MODULE_LABEL } from "../_logger.js";

const MODULE_ID = "ionrift-quartermaster";
const QM_BUG_REPORT_CONTEXT = "quartermaster-loot-pool-compile";

const LOOT_PHASE_LABELS = {
    setup:     "Preparing...",
    templates: "Expanding weapon templates...",
    stubs:     "Expanding ammunition stubs...",
    armor:     "Expanding armor templates...",
    wondrous:  "Expanding wondrous templates...",
    enrich:    "Enriching named economy...",
    slaying:   "Expanding slaying ammunition...",
    collision: "Resolving collisions...",
    writing:   "Writing compiled pool...",
    done:      "Complete.",
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

    // ── Foundry app shell ─────────────────────────────────────────────────

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id:             "ionrift-compendium-forge",
            title:          "Compendium Forge",
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
            showCompileButton: phase === "pick" && this._shouldShowCompileButton(),
            statusBadge:       phase === "pick" ? this._buildStatusBadge()    : null,
            isScrollForge:     tab === "scrollForge",
            isCursedItems:     tab === "cursedItems",
            isLootPool:        tab === "lootPool",

            // Compile phase
            phaseLabel:    LOOT_PHASE_LABELS[this._progress.phase] ?? "Processing...",
            progressPct:   this._progress.total > 0
                ? Math.round((this._progress.current / this._progress.total) * 100)
                : 0,
            progress:      this._progress,
            indeterminate: tab !== "lootPool",  // scroll/curse show spinner not bar+log

            // Done phase
            doneResult:        doneResult ? this._formatDoneResult(tab, doneResult) : null,
            bugReportUi:       this._buildBugReportUi(tab, phase, doneResult),

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
                primary:        { label: "Items",     value: r.itemCount     ?? 0 },
                secondary:      { label: "Templates", value: r.templateCount ?? 0 },
                tertiary:       { label: "Sources",   value: (r.sourceIds ?? []).length },
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
                primary:      { label: "Scrolls", value: r.scrollCount ?? 0 },
                secondary:    { label: "Sources", value: r.sourceCount ?? 0 },
                tertiary:     null,
                showViewPack: true,
                packId:       "world.ionrift-forged-scrolls",
            };
        }
        if (tab === "cursedItems") {
            return {
                primary:      { label: "Items",   value: r.itemCount  ?? 0 },
                secondary:    { label: "Sources", value: r.sourceCount ?? 0 },
                tertiary:     null,
                showViewPack: true,
                packId:       "world.ionrift-srd-cursed",
            };
        }
        return null;
    }

    // ── Tab helpers ───────────────────────────────────────────────────────

    _buildTabs() {
        const scrollStatus = this._getScrollForgeStatus();
        const lootStatus   = LootPoolCompiler.getStatus();
        const curseStatus  = this._getCursedStatus();

        return [
            {
                id:          "scrollForge",
                label:       "Scroll Forge",
                icon:        "fas fa-scroll",
                active:      this._activeTab === "scrollForge",
                status:      scrollStatus,
                statusLabel: this._dotLabel(scrollStatus),
            },
            {
                id:          "lootPool",
                label:       "Loot Pool",
                icon:        "fas fa-treasure-chest",
                active:      this._activeTab === "lootPool",
                status:      lootStatus,
                statusLabel: this._dotLabel(lootStatus),
            },
            {
                id:          "cursedItems",
                label:       "Cursed Items",
                icon:        "fas fa-skull",
                active:      this._activeTab === "cursedItems",
                status:      curseStatus,
                statusLabel: this._dotLabel(curseStatus),
            },
        ];
    }

    _dotLabel(status) {
        if (status === "fresh") return "Compiled and up to date";
        if (status === "stale") return "Stale -- sources changed";
        if (status === "never") return "Not compiled";
        if (status === "error") return "Last compile failed -- click to retry";
        return "Managed separately";
    }

    _paneTitle() {
        if (this._activeTab === "scrollForge") return "Scroll Forge";
        if (this._activeTab === "cursedItems") return "Cursed Items";
        return "Loot Pool";
    }

    _paneDesc() {
        if (this._activeTab === "scrollForge") {
            return "Select which spell compendiums Scroll Forge may draw from. Both SRD sources are recommended -- 2024 spells take priority when names collide.";
        }
        if (this._activeTab === "cursedItems") {
            return "The SRD Curse Adapter scans dnd5e equipment compendiums for the 21 known SRD cursed items and compiles them into a GM-only pool. No configuration needed -- approve the compile and review the output.";
        }
        if (!LootPoolCompiler.is2024ArchitecturePresent()) {
            return "Select which compendiums contribute items to the loot cache generator. Enable dnd5e.equipment24 to unlock weapon template compilation.";
        }
        return "Select which compendiums feed the loot pool. 2024 SRD sources contain weapon templates that require compilation to appear as discrete loot items.";
    }

    // ── Status helpers ────────────────────────────────────────────────────

    _getScrollForgeStatus() {
        return ScrollForge.getStatus();
    }

    _getCursedStatus() {
        return SrdCurseAdapter.getStatus();
    }

    _shouldShowCompileButton() {
        const tab    = this._activeTab;
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
        let status;
        if (tab === "lootPool") {
            status = LootPoolCompiler.getStatus();
        } else if (tab === "scrollForge") {
            status = this._getScrollForgeStatus();
        } else {
            status = this._getCursedStatus();
        }

        if (status === "fresh") return { type: "fresh", icon: "fas fa-circle-check",         label: "Compiled" };
        if (status === "stale") return { type: "stale", icon: "fas fa-triangle-exclamation", label: "Stale" };
        if (status === "never") return { type: "never", icon: "fas fa-circle-xmark",         label: "Not compiled" };
        if (status === "error") return { type: "error", icon: "fas fa-circle-exclamation",   label: "Compile failed" };
        return null;
    }

    _buildCompiledStatus() {
        const tab = this._activeTab;

        if (tab === "lootPool") {
            const meta   = LootPoolCompiler.getCompiledMeta();
            const status = LootPoolCompiler.getStatus();

            if (status === "error") {
                const when = meta?.errorAt ? this._relativeTime(meta.errorAt) : "recently";
                const errMsg = meta?.errorMessage
                    ? meta.errorMessage.length > 120
                        ? meta.errorMessage.slice(0, 120) + "..."
                        : meta.errorMessage
                    : "Unknown error -- check the browser console for details.";
                const skipCount = meta?.skippedCount ?? meta?.skippedItems?.length ?? 0;
                return {
                    type: "error",
                    icon: "fas fa-circle-exclamation",
                    text: `Compile failed ${when}.`,
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
                return { type: "never", icon: "fas fa-circle-xmark", text: "Pool not compiled -- 2024 sources contain templates that need expanding.", meta: null, clearable: false };
            }
            if (meta && (meta.compilerVersion ?? 0) < LootPoolCompiler.COMPILER_VERSION) {
                return {
                    type:      "stale",
                    icon:      "fas fa-triangle-exclamation",
                    text:      "Compiler updated. Recompile to apply new template and enrichment rules.",
                    meta:      meta.itemCount != null ? `${meta.itemCount} items - compiled ${this._relativeTime(meta.compiledAt)}` : null,
                    clearable: !!game.packs.get(LootPoolCompiler.worldCollectionId),
                };
            }
            if ((status === "stale" || status === "fresh") && meta) {
                const age       = this._relativeTime(meta.compiledAt);
                const packGone  = !game.packs.get(LootPoolCompiler.worldCollectionId);
                const skipCount = meta.skippedCount ?? meta.skippedItems?.length ?? 0;
                const baseText  = packGone
                    ? "Compiled pool was removed -- recompile to restore expanded weapons."
                    : status === "stale"
                        ? "Sources changed since last compile."
                        : skipCount > 0
                            ? "Pool compiled with compatibility warnings."
                            : "Pool compiled and up to date.";
                const compileMeta = meta.itemCount != null
                    ? `${meta.itemCount} items - compiled ${age}`
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
                const when = meta?.errorAt ? this._relativeTime(meta.errorAt) : "recently";
                const msg  = meta?.errorMessage ?? "Unknown error -- check the browser console.";
                return { type: "error", icon: "fas fa-circle-exclamation", text: `Compile failed ${when}.`, meta: msg, clearable: false };
            }
            if (status === "never") {
                return { type: "never", icon: "fas fa-circle-xmark", text: "Not yet compiled. Select spell sources and click Forge Scrolls.", meta: null, clearable: false };
            }
            const packGone = !game.packs.get(ScrollForge.worldCollectionId);
            if (packGone) {
                return { type: "stale", icon: "fas fa-triangle-exclamation", text: "Compiled pack was removed -- recompile to restore.", meta: null, clearable: false };
            }
            const baseText = status === "stale"
                ? "Sources changed since last compile."
                : "Scroll pool compiled and up to date.";
            return {
                type:      status,
                icon:      status === "stale" ? "fas fa-triangle-exclamation" : "fas fa-circle-check",
                text:      baseText,
                meta:      meta?.scrollCount != null ? `${meta.scrollCount} scrolls${meta.compiledAt ? ` - compiled ${this._relativeTime(meta.compiledAt)}` : ""}` : null,
                clearable: true,
            };
        }

        if (tab === "cursedItems") {
            const status = this._getCursedStatus();
            const meta   = SrdCurseAdapter.getCompiledMeta();

            if (status === "error") {
                const when = meta?.errorAt ? this._relativeTime(meta.errorAt) : "recently";
                const msg  = meta?.errorMessage ?? "Unknown error -- check the browser console.";
                return { type: "error", icon: "fas fa-circle-exclamation", text: `Compile failed ${when}.`, meta: msg, clearable: false };
            }
            if (status === "never") {
                return { type: "never", icon: "fas fa-circle-xmark", text: "Not yet compiled. Click Compile Pool to build the cursed item pool.", meta: null, clearable: false };
            }
            const packGone = !game.packs.get(SrdCurseAdapter.worldCollectionId);
            if (packGone) {
                return { type: "stale", icon: "fas fa-triangle-exclamation", text: "Compiled pack was removed -- recompile to restore.", meta: null, clearable: false };
            }
            const baseText = status === "stale"
                ? "Sources changed since last compile."
                : "Cursed pool compiled and up to date.";
            return {
                type:      status,
                icon:      status === "stale" ? "fas fa-triangle-exclamation" : "fas fa-circle-check",
                text:      baseText,
                meta:      meta?.itemCount != null ? `${meta.itemCount} items${meta.compiledAt ? ` - compiled ${this._relativeTime(meta.compiledAt)}` : ""}` : null,
                clearable: true,
            };
        }

        return null;
    }

    // ── Source group builders ─────────────────────────────────────────────

    _buildSourceGroups() {
        const packs  = ItemPoolResolver.listAvailableCompendiums();
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
        const RECOMMENDED_SCROLL = new Set(["dnd5e.spells24", "dnd5e.spells"]);
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

    _buildBugReportUi(tab, phase, doneResult) {
        if (tab !== "lootPool") return null;

        const meta       = LootPoolCompiler.getCompiledMeta();
        const skipCount  = meta?.skippedCount ?? meta?.skippedItems?.length ?? 0;
        const showOnPick = phase === "pick" && (skipCount > 0 || LootPoolCompiler.getStatus() === "error");
        const showOnDone = phase === "done" && (doneResult?.skippedCount > 0);
        if (!showOnPick && !showOnDone) return null;

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
            ui.notifications.error("Ionrift Library is required for debug reports.");
            return;
        }
        try {
            const copied = await bugReport.copyToClipboard({ context: QM_BUG_REPORT_CONTEXT });
            ui.notifications.info(
                copied
                    ? "Debug report copied to clipboard."
                    : "Debug report downloaded as JSON."
            );
        } catch (err) {
            Logger.error(MODULE_LABEL, "Copy bug report failed:", err);
            ui.notifications.error("Could not copy debug report. Check the browser console.");
        }
    }

    async _onSendBugReport() {
        const bugReport = game.ionrift?.library?.bugReport;
        if (!bugReport) {
            ui.notifications.error("Ionrift Library is required to send reports.");
            return;
        }
        if (!bugReport.canSubmit()) {
            ui.notifications.warn(
                "Connect Patreon in Ionrift Library (free tier is fine), or copy the report and paste it in Discord.",
                { permanent: true }
            );
            return;
        }

        const $sendBtn = this.element?.find?.(".forge-send-bug-report");
        if ($sendBtn?.length) $sendBtn.prop("disabled", true);

        try {
            const result = await bugReport.submit({ context: QM_BUG_REPORT_CONTEXT });
            if (!result?.ok) {
                const msg = bugReport.formatSubmitError?.(result?.error) ?? (result?.error ?? "Upload failed.");
                ui.notifications.error(msg, { permanent: true });
                return;
            }
            await bugReport.showSubmitSuccess(result);
        } catch (err) {
            Logger.error(MODULE_LABEL, "Send bug report failed:", err);
            ui.notifications.error("Could not send bug report. Try copy and Discord instead.");
        } finally {
            if ($sendBtn?.length) $sendBtn.prop("disabled", false);
        }
    }

    _buildCurseSourceInfo() {
        // SrdCurseAdapter matches its hardcoded manifest against the dnd5e
        // equipment packs specifically. Display only those two sources --
        // the broader "any dnd5e Item pack" loop in _discoverItemPacks is an
        // internal safety net, not something the GM needs to see.
        const info = [];
        const pack24 = game.packs.get("dnd5e.equipment24");
        if (pack24) info.push({ id: pack24.collection, label: pack24.title ?? "Equipment (2024)" });
        const legacy = game.packs.get("dnd5e.items");
        if (legacy)  info.push({ id: legacy.collection, label: legacy.title  ?? "Items (SRD)" });
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

        // Tab switching
        html.find(".forge-tab").on("click", ev => {
            const tab = ev.currentTarget.dataset.tab;
            if (tab === this._activeTab && this._phase === "pick") return;
            this._activeTab = tab;
            // Re-render with current phase -- don't reset other tabs
            if (tab === "scrollForge" && (this._scrollCandidates === null || this._scrollCandidates === false)) {
                this._loadScrollCandidates(); // triggers its own render sequence
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
            else ui.notifications.warn("Compiled compendium not found.");
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
            ui.notifications.info(`Loot pool sources saved: ${enabled.length} source${enabled.length !== 1 ? "s" : ""} enabled.`);
        }

        else if (tab === "scrollForge") {
            const ScrollForge = this._scrollForgeRef?.ScrollForge;
            if (!ScrollForge) return;

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
        this._progress = { current: 0, total: 0, phase: "setup", label: "Preparing...", log: [] };
        this.render(false);

        LootPoolCompiler.compile({
            forceRecompile: true,
            onProgress: p => this._onLootProgress(p),
        }).then(() => {
            const meta = LootPoolCompiler.getCompiledMeta();
            this._doneResults.lootPool = meta;
            this._phases.lootPool = "done";
        }).catch(err => {
            Logger.error(MODULE_LABEL, "CompendiumForgeApp: loot pool compile failed:", err);
            ui.notifications.error("Compile failed -- see the browser console for details.");
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
            ui.notifications.error("Scroll Forge compile failed -- see the browser console for details.");
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
            const { SrdCurseAdapter } = await import("../services/SrdCurseAdapter.js");
            await SrdCurseAdapter.compile({ forceRecompile: true });

            const pack   = game.packs.get(SrdCurseAdapter.worldCollectionId);
            const count  = pack ? (await pack.getIndex()).size : 0;
            const { CursedSourcesApp } = await import("./CursedSourcesApp.js");
            const sources = CursedSourcesApp.getEnabledSources();

            this._doneResults.cursedItems = { itemCount: count, sourceCount: sources.length };
            this._phases.cursedItems = "done";
        } catch (err) {
            Logger.error(MODULE_LABEL, "CompendiumForgeApp: curse compile failed:", err);
            ui.notifications.error("Cursed Items compile failed -- see the browser console for details.");
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
            lootPool:    "compiled loot pool",
            scrollForge: "compiled scroll pool",
            cursedItems: "compiled cursed item pool",
        };
        const label = labels[tab] ?? "compiled pool";
        const confirmed = await Dialog.confirm({
            title:   "Clear Compiled Pool",
            content: `<p>Remove the ${label} compendium? You can recompile at any time.</p>`,
            yes: () => true,
            no:  () => false,
        });
        if (!confirmed) return;

        if (tab === "lootPool") {
            await LootPoolCompiler.clearCompiledPack?.() ?? await this._clearLootPoolLegacy();
        } else if (tab === "scrollForge") {
            await ScrollForge.clearCompiledPack();
        } else if (tab === "cursedItems") {
            await SrdCurseAdapter.clearCompiledPack();
        }

        if (tab === "lootPool") ItemPoolResolver.clearCache();
        ui.notifications.info(`Quartermaster: ${label} cleared.`);
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
        if (!isoString) return "unknown time ago";
        const ms = Date.now() - new Date(isoString).getTime();
        const minutes = Math.floor(ms / 60000);
        if (minutes < 1)  return "just now";
        if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24)   return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
        const days = Math.floor(hours / 24);
        return `${days} day${days !== 1 ? "s" : ""} ago`;
    }

    // ── FormApplication stub ──────────────────────────────────────────────

    async _updateObject(_event, _formData) {
        // Source saves are handled manually via button listeners.
    }
}
