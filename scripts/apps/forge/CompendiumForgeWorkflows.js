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


export const QM_BUG_REPORT_CONTEXT = "quartermaster-loot-pool-compile";

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

export const LOOT_PHASE_LABELS = {
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


export class CompendiumForgeWorkflows {
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

export function applyCompendiumForgeWorkflows(TargetClass) {
    for (const key of Object.getOwnPropertyNames(CompendiumForgeWorkflows.prototype)) {
        if (key === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(CompendiumForgeWorkflows.prototype, key);
        if (desc) Object.defineProperty(TargetClass.prototype, key, desc);
    }
}
