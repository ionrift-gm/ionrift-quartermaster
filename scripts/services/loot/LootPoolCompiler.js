import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";
/**
 * LootPoolCompiler
 *
 * Resolves the 2024 SRD template-first architecture into discrete loot-ready items.
 * The dnd5e.equipment24 pack ships named weapon templates (Dragon Slayer, Holy Avenger,
 * etc.) as GM-application shells with no base subtype and weight=0 - not loot items.
 * This service expands them into a full permutation matrix:
 *   template × base weapon × bonus tier to discrete item
 *
 * Output: world.quartermaster-compiled-pool (GM-only world compendium)
 * Hash-gated: only recompiles when lootPoolSources config changes.
 * Guards: GM-only, dnd5e only.
 *
 * Structural pattern mirrors SrdCurseAdapter.js.
 */

import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { ItemPoolResolver } from "./ItemPoolResolver.js";
import { isSrdCursedLootName, isSrdCursedTemplateName } from "../curse/SrdCurseCatalog.js";

import { enforcePackOwnership, assignPackToCompiledFolder, stableHash } from "../packs/CompendiumConfigHelper.js";
import { QM_FEATURES } from "../../data/QMFeatures.js";

import {
    keyToIdentifier,
    findSourceDoc,
    WEAPON_TEMPLATES,
    RANGE_STUB_EXPANSIONS,
    TIER_RARITY,
    SHIELD_BONUS_RARITY,
    ARMOR_BONUS_RARITY,
    BASE_ARMORS,
    GENERIC_WEAPON_BASES,
    ADAMANTINE_MITHRAL_BASES,
    RESISTANCE_BASES,
    RESISTANCE_TYPES,
    SPECIFIC_ARMOR_TEMPLATES,
    WONDROUS_TEMPLATE_SHELLS,
    NAMED_ECONOMY_ENRICHMENT,
    SLAYING_AMMO_TEMPLATE,
    SLAYING_AMMO_BASES,
    SLAYING_CREATURE_TYPES,
    SLAYING_AMMO_PRICE,
    ARCHITECTURE_2024_PACKS
} from "./LootPoolTemplateCatalog.js";
import { applyLootPoolItemBuilders } from "./LootPoolItemBuilders.js";
import { applyLootPoolPackReconciler } from "./LootPoolPackReconciler.js";

export { keyToIdentifier, findSourceDoc };

export class LootPoolCompiler {
    static COMPILER_VERSION = 17;

    static WORLD_PACK_NAME = "quartermaster-compiled-pool";
    static PACK_LABEL      = "Quartermaster: Compiled Loot Pool";
    static SETTING_HASH    = "compiledLootPoolHash";
    static SETTING_META    = "compiledLootPoolMeta";
    static _stableHash = stableHash;

    static get worldCollectionId() {
        return `world.${this.WORLD_PACK_NAME}`;
    }

    static keyToIdentifier = keyToIdentifier;
    static findSourceDoc = findSourceDoc;

    // ── Compile resilience (per-item isolation) ───────────────────────────

    /** @returns {{ skips: Array<{ name: string, packId: string, phase: string, reason: string }> }} */
    static _newCompileReport() {
        return { skips: [] };
    }

    /**
     * Record one skipped row. Compile continues; skips are surfaced in Forge UI.
     * @param {{ skips: object[] }} report
     * @param {{ name?: string, packId?: string, phase: string, reason: unknown }} entry
     */
    static _recordSkip(report, { name, packId = "", phase, reason }) {
        if (!report) return;
        const row = {
            name:   (name || "(unnamed)").toString(),
            packId: packId || "",
            phase:  phase || "unknown",
            reason: reason?.message ?? String(reason ?? "unknown error"),
        };
        report.skips.push(row);
        Logger.warn(
            MODULE_LABEL,
            `LootPoolCompiler: skipped [${row.phase}] "${row.name}"` +
            `${row.packId ? ` (${row.packId})` : ""}: ${row.reason}`
        );
    }

    /**
     * Run one expansion builder; record and continue on failure.
     * @param {{ skips: object[] }} report
     * @param {string} phase
     * @param {string} itemName
     * @param {string} [packId]
     * @param {function(): object|null|undefined} buildFn
     * @returns {object|null}
     */
    static _safeExpand(report, phase, itemName, packId, buildFn) {
        try {
            return buildFn() ?? null;
        } catch (err) {
            this._recordSkip(report, { name: itemName, packId, phase, reason: err });
            return null;
        }
    }

    /**
     * Human-readable skip summary for Forge status cards and notifications.
     * @param {object[]} skips
     * @param {{ maxNames?: number }} [opts]
     * @returns {string}
     */
    static formatSkippedItemsSummary(skips, { maxNames = 5 } = {}) {
        if (!skips?.length) return "";
        const names = [...new Set(skips.map(s => s.name).filter(Boolean))];
        const shown = names.slice(0, maxNames);
        const extra = names.length - shown.length;
        let text = shown.join(", ");
        if (extra > 0) {
            text += game.i18n.format("ionrift-quartermaster.forge.skippedAndMore", { extra });
        }
        const key = names.length === 1
            ? "ionrift-quartermaster.forge.skippedSummaryOne"
            : "ionrift-quartermaster.forge.skippedSummaryMany";
        return game.i18n.format(key, { count: names.length, text });
    }

    /** Max skip rows shown in Forge status cards and done panel. Full list stays in meta / bug report. */
    static SKIP_REPORT_DISPLAY_MAX = 12;

    /**
     * Trim skip rows for Forge UI lists. Summary line and bug report keep the full set.
     * @param {object[]} skips
     * @param {{ maxRows?: number }} [opts]
     * @returns {{ rows: object[], overflowCount: number }}
     */
    static formatSkipReportForDisplay(skips, { maxRows = this.SKIP_REPORT_DISPLAY_MAX } = {}) {
        if (!skips?.length) return { rows: [], overflowCount: 0 };
        const limit = Math.max(1, maxRows);
        const rows = skips.slice(0, limit);
        return { rows, overflowCount: Math.max(0, skips.length - limit) };
    }

    /**
     * Verify a source document can be read for expansion (name + toObject).
     * @param {Item} doc
     */
    static _probeSourceDocument(doc) {
        if (!doc) throw new Error("missing document");
        const name = doc.name;
        if (!name || !String(name).trim()) throw new Error("missing name");
        if (typeof doc.toObject === "function") doc.toObject();
    }

    /**
     * Load compendium items with per-document isolation. Falls back to index +
     * getDocument when batch getDocuments() fails (common with stale adventure data).
     *
     * @param {CompendiumCollection} pack
     * @param {{ skips: object[] }} report
     * @returns {Promise<Item[]>}
     */
    static async _loadPackDocuments(pack, report) {
        const packId = pack.collection;
        const docs   = [];

        const tryPush = (doc, fallbackName = "") => {
            try {
                this._probeSourceDocument(doc);
                docs.push(doc);
            } catch (err) {
                this._recordSkip(report, {
                    name:   doc?.name ?? fallbackName ?? doc?.id ?? "(unknown)",
                    packId,
                    phase:  "source",
                    reason: err,
                });
            }
        };

        try {
            const batch = await pack.getDocuments();
            for (const doc of batch) tryPush(doc);
            if (docs.length) return docs;
        } catch (err) {
            Logger.warn(
                MODULE_LABEL,
                `LootPoolCompiler: batch read failed for "${packId}", trying per-document: ${err.message}`
            );
        }

        try {
            const index = await pack.getIndex({ fields: ["name"] });
            for (const entry of index) {
                try {
                    const doc = await pack.getDocument(entry._id);
                    tryPush(doc, entry.name);
                } catch (err) {
                    this._recordSkip(report, {
                        name:   entry.name ?? entry._id ?? "(unknown)",
                        packId,
                        phase:  "source",
                        reason: err,
                    });
                }
            }
        } catch (err) {
            Logger.warn(MODULE_LABEL, `LootPoolCompiler: could not read "${packId}": ${err.message}`);
            this._recordSkip(report, {
                name:   pack.metadata?.label ?? packId,
                packId,
                phase:  "source",
                reason: err,
            });
        }

        return docs;
    }

    /**
     * Manifest summary for LootPoolAuditor and Forge diagnostics.
     * @returns {object}
     */
    static getCompilerManifest() {
        return {
            weaponTemplates: Object.keys(WEAPON_TEMPLATES),
            armorTemplateShells: [
                "Armor, +1, +2, or +3",
                "Adamantine Armor",
                "Mithral Armor",
                "Armor of Resistance",
                ...SPECIFIC_ARMOR_TEMPLATES.map(t => t.template)
            ],
            wondrousTemplates: Object.keys(WONDROUS_TEMPLATE_SHELLS),
            rangeStubs: Object.keys(RANGE_STUB_EXPANSIONS),
            slayingAmmoTemplate: SLAYING_AMMO_TEMPLATE,
            slayingCreatureTypes: SLAYING_CREATURE_TYPES,
            namedEconomyEnrichment: Object.keys(NAMED_ECONOMY_ENRICHMENT)
        };
    }

    // ── Public API ────────────────────────────────────────────────────────

    /**
     * True when any enabled lootPoolSource is a 2024-architecture pack that
     * requires compilation to produce discrete loot items.
     * @returns {boolean}
     */
    static is2024ArchitecturePresent() {
        const sources = this._getEnabledSources();
        return sources.some(id => ARCHITECTURE_2024_PACKS.has(id));
    }

    /**
     * Returns parsed compile metadata or null if never compiled.
     * @returns {{ compiledAt: string, sourceIds: string[], itemCount: number, templateCount: number }|null}
     */
    static getCompiledMeta() {
        try {
            const raw = game.settings.get(MODULE_ID, this.SETTING_META);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    /**
     * Returns the compile status of the pool.
     * @returns {"fresh"|"stale"|"never"|"error"}
     */
    static getStatus() {
        const meta = this.getCompiledMeta();
        if (meta?.error) return "error";  // last compile attempt threw

        const hash = game.settings.get(MODULE_ID, this.SETTING_HASH);
        if (!hash) return "never";

        // If the compiled pack no longer exists (e.g. deleted via sidebar),
        // treat as stale so the Forge badge and nudge both surface the problem.
        if (!game.packs.get(this.worldCollectionId)) return "stale";

        // Compare only sources that feed template expansion. Overlay materialised
        // packs and scroll output register in lootPoolSources at runtime but do
        // not affect the compiled pool; including them caused false stale states.
        const currentSources = this._getCompileTrackedSources().sort().join(",");
        const compiledSources = this._getCompileTrackedSources(meta?.sourceIds ?? []).sort().join(",");
        if (currentSources !== compiledSources) return "stale";

        if ((meta?.compilerVersion ?? 0) < this.COMPILER_VERSION) return "stale";

        return "fresh";
    }

    /**
     * Compute a stable hash of the current lootPoolSources configuration.
     * Async because it reads pack index sizes for a stronger signal.
     * @returns {Promise<string>}
     */
    static async computeSourceHash() {
        const sources = this._getCompileTrackedSources();
        const parts = [`v${this.COMPILER_VERSION}`, `sources:${sources.join("|")}`];
        for (const id of sources.sort()) {
            const pack = game.packs.get(id);
            if (!pack) { parts.push(`${id}:missing`); continue; }
            try {
                const index = await pack.getIndex();
                parts.push(`${id}:${index.size ?? 0}`);
            } catch {
                parts.push(`${id}:err`);
            }
        }
        return stableHash(parts.join("|"));
    }

    /**
     * Main compile entry point. Expands 2024 SRD templates into discrete loot
     * items and writes them to world.quartermaster-compiled-pool.
     *
     * @param {object} opts
     * @param {boolean} [opts.forceRecompile=false] Bypass hash gate.
     * @param {function} [opts.onProgress] Progress callback: ({ phase, current, total, label }) => void
     */
    static async compile({ forceRecompile = false, onProgress = null } = {}) {
        if (!game.user.isGM) return;
        if (!game.ionrift?.quartermaster?.adapter?.supports(QM_FEATURES.LOOT_POOL_COMPILE)) return;

        const emit = (phase, current, total, label = "") => {
            if (typeof onProgress === "function") onProgress({ phase, current, total, label });
        };

        emit("setup", 0, 1, game.i18n.localize("ionrift-quartermaster.forge.progressCheckingSources"));

        const sources = this._getEnabledSources();
        const has2024 = sources.some(id => ARCHITECTURE_2024_PACKS.has(id));
        if (!has2024) {
            Logger.log(MODULE_LABEL, "LootPoolCompiler: no 2024-architecture sources enabled. Skipping.");
            return;
        }

        // ── Hash gate ──────────────────────────────────────────────────
        const sourceHash = await this.computeSourceHash();
        const lastHash   = game.settings.get(MODULE_ID, this.SETTING_HASH);
        const priorMeta  = this.getCompiledMeta();
        const versionStale = (priorMeta?.compilerVersion ?? 0) < this.COMPILER_VERSION;
        if (!forceRecompile && !versionStale && sourceHash === lastHash) {
            Logger.log(MODULE_LABEL, "LootPoolCompiler: pool is current. Skipping.");
            return;
        }

        // ── Load source packs ──────────────────────────────────────────
        emit("setup", 0, 1, game.i18n.localize("ionrift-quartermaster.forge.progressLoadingSources"));

        const report   = this._newCompileReport();
        const packDocs = new Map(); // packId to Item[]
        for (const packId of sources) {
            const pack = game.packs.get(packId);
            if (!pack || pack.documentName !== "Item") continue;
            const docs = await this._loadPackDocuments(pack, report);
            if (docs.length) packDocs.set(packId, docs);
        }

        // Build name to { item, sourcePackId } map (first-seen wins within each pass)
        const allByName = new Map();
        const allByIdentifier = new Map();
        allByName._allByIdentifier = allByIdentifier;

        for (const [packId, docs] of packDocs) {
            for (const doc of docs) {
                const entry = { item: doc, packId };
                const nameKey = (doc.name || "").trim().toLowerCase();
                if (nameKey && !allByName.has(nameKey)) allByName.set(nameKey, entry);

                const ident = (doc.system?.identifier || "").trim().toLowerCase();
                if (ident) {
                    if (!allByIdentifier.has(ident)) allByIdentifier.set(ident, entry);
                    if (!allByName.has(ident)) allByName.set(ident, entry);
                }

                const slug = (doc.system?.slug || "").trim().toLowerCase();
                if (slug) {
                    if (!allByIdentifier.has(slug)) allByIdentifier.set(slug, entry);
                    if (!allByName.has(slug)) allByName.set(slug, entry);
                }

                const nameIdent = keyToIdentifier(doc.name);
                if (nameIdent) {
                    if (!allByIdentifier.has(nameIdent)) allByIdentifier.set(nameIdent, entry);
                    if (!allByName.has(nameIdent)) allByName.set(nameIdent, entry);
                }

                if (doc.id && !allByIdentifier.has(doc.id)) allByIdentifier.set(doc.id, entry);
                if (doc._id && !allByIdentifier.has(doc._id)) allByIdentifier.set(doc._id, entry);

                const sourceUuid = doc._stats?.compendiumSource;
                if (sourceUuid) {
                    const sourceId = String(sourceUuid).split(".").pop();
                    if (sourceId && !allByIdentifier.has(sourceId)) allByIdentifier.set(sourceId, entry);
                }
            }
        }

        // ── Template × base weapon expansion ──────────────────────────
        emit("templates", 0, 1, game.i18n.localize("ionrift-quartermaster.forge.progressExpandingWeaponTemplates"));

        const templateEntries = Object.entries(WEAPON_TEMPLATES);
        const totalTemplateItems = templateEntries.reduce(
            (sum, [, { bases, tiers }]) => sum + bases.length * tiers.length, 0
        );
        let templatesDone = 0;
        const expandedItems = [];

        for (const [templateName, { bases, tiers }] of templateEntries) {
            if (isSrdCursedTemplateName(templateName)) continue;
            const templateEntry = findSourceDoc(allByName, allByIdentifier, templateName);
            if (!templateEntry) {
                Logger.warn(MODULE_LABEL, `LootPoolCompiler: template "${templateName}" not found in sources.`);
                templatesDone += bases.length * tiers.length;
                continue;
            }
            const templateDoc = templateEntry.item;

            for (const baseName of bases) {
                const baseEntry = findSourceDoc(allByName, allByIdentifier, baseName);
                if (!baseEntry) {
                    Logger.warn(MODULE_LABEL, `LootPoolCompiler: base weapon "${baseName}" not found.`);
                    templatesDone += tiers.length;
                    continue;
                }
                const baseDoc = baseEntry.item;

                for (const tier of tiers) {
                    const itemName = `${templateName} ${baseName} +${tier}`;
                    const label = itemName;
                    templatesDone++;
                    emit("templates", templatesDone, totalTemplateItems, label);

                    const data = this._safeExpand(
                        report, "expand", itemName, templateEntry.packId,
                        () => this._buildTemplateItem(templateDoc, baseDoc, templateName, baseName, tier)
                    );
                    if (data) expandedItems.push(data);
                }
            }
        }

        // ── Range stub expansion ───────────────────────────────────────
        emit("stubs", 0, 1, game.i18n.localize("ionrift-quartermaster.forge.progressExpandingAmmoStubs"));

        const rangeStubEntries = Object.entries(RANGE_STUB_EXPANSIONS);
        const totalStubItems = rangeStubEntries.reduce(
            (sum, [, expansions]) => sum + expansions.reduce((s, e) => s + e.tiers.length, 0), 0
        );
        let stubsDone = 0;

        for (const [stubName, expansions] of rangeStubEntries) {
            if (!expansions.length) continue;
            for (const { base, tiers } of expansions) {
                const baseEntry = findSourceDoc(allByName, allByIdentifier, base);
                if (!baseEntry) {
                    Logger.warn(MODULE_LABEL, `LootPoolCompiler: ammo base "${base}" not found.`);
                    stubsDone += tiers.length;
                    continue;
                }
                for (const tier of tiers) {
                    const itemName = `${base} +${tier}`;
                    stubsDone++;
                    emit("stubs", stubsDone, totalStubItems, itemName);

                    // Check if this item already exists in sources (some packs ship
                    // "Arrow +1" as a discrete entry alongside the stub)
                    const existingEntry = findSourceDoc(allByName, allByIdentifier, itemName);
                    if (existingEntry) continue; // skip - raw pool already has it

                    const data = this._safeExpand(
                        report, "expand", itemName, baseEntry.packId,
                        () => this._buildAmmoItem(baseEntry.item, base, tier)
                    );
                    if (data) expandedItems.push(data);
                }
            }
        }

        // ── Armor template expansion ───────────────────────────────────
        emit("armor", 0, 1, game.i18n.localize("ionrift-quartermaster.forge.progressExpandingArmorTemplates"));

        const armorItems = this._expandArmorTemplates(allByName, report);
        const genericArmorPlusCount = armorItems.filter(
            i => /\+\d\b/.test(i.name ?? "") && !i.name.includes("Arrow") && !i.name.includes("Bolt")
        ).length;
        for (let armorDone = 0; armorDone < armorItems.length; armorDone++) {
            emit("armor", armorDone + 1, armorItems.length, armorItems[armorDone].name ?? "");
        }
        expandedItems.push(...armorItems);

        const genericWeaponItems = this._expandGenericWeaponBonus(allByName, report);
        for (let weaponDone = 0; weaponDone < genericWeaponItems.length; weaponDone++) {
            emit("weapons", weaponDone + 1, genericWeaponItems.length, genericWeaponItems[weaponDone].name ?? "");
        }
        expandedItems.push(...genericWeaponItems);

        // ── Wondrous template expansion (belts, etc.) ────────────────────
        emit("wondrous", 0, 1, game.i18n.localize("ionrift-quartermaster.forge.progressExpandingWondrousTemplates"));
        const wondrousItems = this._expandWondrousTemplates(allByName, report);
        for (let i = 0; i < wondrousItems.length; i++) {
            emit("wondrous", i + 1, wondrousItems.length, wondrousItems[i].name ?? "");
        }
        expandedItems.push(...wondrousItems);

        // ── Named economy enrichment (helms, etc.) ─────────────────────
        emit("enrich", 0, 1, game.i18n.localize("ionrift-quartermaster.forge.progressEnrichingNamedEconomy"));
        const enrichedItems = this._expandNamedEconomyEnrichment(allByName, report);
        for (let i = 0; i < enrichedItems.length; i++) {
            emit("enrich", i + 1, enrichedItems.length, enrichedItems[i].name ?? "");
        }
        expandedItems.push(...enrichedItems);

        // ── Slaying ammunition expansion ───────────────────────────────
        emit("slaying", 0, 1, game.i18n.localize("ionrift-quartermaster.forge.progressExpandingSlayingAmmo"));
        const slayingItems = this._expandSlayingAmmunition(allByName, report);
        for (let i = 0; i < slayingItems.length; i++) {
            emit("slaying", i + 1, slayingItems.length, slayingItems[i].name ?? "");
        }
        expandedItems.push(...slayingItems);

        // ── Collision resolution ───────────────────────────────────────
        emit("collision", 0, 1, game.i18n.localize("ionrift-quartermaster.forge.progressResolvingCollisions"));
        const resolved = this._filterCursedFromCompiled(
            this._collisionResolve(expandedItems, allByName, report)
        );

        // ── Write to world pack ────────────────────────────────────────
        emit("writing", 0, resolved.length, game.i18n.localize("ionrift-quartermaster.forge.progressWritingCompiledPool"));

        let pack = game.packs.get(this.worldCollectionId);
        if (!pack) {
            pack = await this._createWorldPack();
            if (!pack) {
                ui.notifications.error(game.i18n.localize("ionrift-quartermaster.notification.couldNotCreateLootCompendium"));
                return;
            }
            pack = game.packs.get(this.worldCollectionId) ?? pack;
        }

        let writeStats;
        try {
            writeStats = await this._reconcilePack(pack, resolved, (current, total, label) => {
                emit("writing", current, total, label);
            }, report);
        } catch (err) {
            Logger.error(MODULE_LABEL, "LootPoolCompiler: reconcile failed:", err);
            this._recordSkip(report, { name: "(pack write)", phase: "write", reason: err });

            const errorMeta = {
                error: true,
                errorMessage: err.message ?? String(err),
                errorAt: new Date().toISOString(),
                sourceIds: sources,
                skippedItems: report.skips,
                skippedCount: report.skips.length,
            };
            await game.settings.set(MODULE_ID, this.SETTING_META, JSON.stringify(errorMeta)).catch(() => {});

            ui.notifications.error(
                game.i18n.localize("ionrift-quartermaster.notification.lootCompileFailedRetry"),
                { permanent: true }
            );
            return;
        }

        if (resolved.length > 0 && (writeStats?.written ?? 0) === 0) {
            const errorMeta = {
                error: true,
                errorMessage: "No compiled items could be written to the world compendium.",
                errorAt: new Date().toISOString(),
                sourceIds: sources,
                skippedItems: report.skips,
                skippedCount: report.skips.length,
            };
            await game.settings.set(MODULE_ID, this.SETTING_META, JSON.stringify(errorMeta)).catch(() => {});
            ui.notifications.error(
                game.i18n.localize("ionrift-quartermaster.notification.lootCompileFailedReviewSkips"),
                { permanent: true }
            );
            return;
        }

        // ── Finalise ───────────────────────────────────────────────────
        const trackedSources = this._getCompileTrackedSources(sources);
        const meta = {
            compiledAt:         new Date().toISOString(),
            sourceIds:          trackedSources,
            itemCount:          writeStats?.written ?? resolved.length,
            templateCount:      templateEntries.length,
            genericArmorPlusCount,
            genericWeaponCount: genericWeaponItems.length,
            compilerVersion:    this.COMPILER_VERSION,
            skippedItems:       report.skips,
            skippedCount:       report.skips.length,
        };

        await game.settings.set(MODULE_ID, this.SETTING_HASH, sourceHash);
        await game.settings.set(MODULE_ID, this.SETTING_META, JSON.stringify(meta));
        enforcePackOwnership(pack);
        await assignPackToCompiledFolder(pack);

        emit("done", resolved.length, resolved.length, "");

        ItemPoolResolver.clearCache();

        if (report.skips.length) {
            ui.notifications.info(
                game.i18n.format("ionrift-quartermaster.notification.lootPoolCompiledWithSkips", {
                    count: meta.itemCount,
                    armorCount: genericArmorPlusCount,
                    weaponCount: genericWeaponItems.length,
                    skipSummary: this.formatSkippedItemsSummary(report.skips)
                })
            );
        } else {
            ui.notifications.info(
                game.i18n.format("ionrift-quartermaster.notification.lootPoolCompiled", {
                    count: meta.itemCount,
                    armorCount: genericArmorPlusCount,
                    weaponCount: genericWeaponItems.length
                })
            );
        }
        Logger.info(
            MODULE_LABEL,
            `LootPoolCompiler: ${meta.itemCount} items written ` +
            `(${genericArmorPlusCount} generic +N armor, ${genericWeaponItems.length} generic +N weapons).` +
            (report.skips.length ? ` ${report.skips.length} skipped.` : "")
        );
    }

    // ── Item Builders ─────────────────────────────────────────────────────

    /**
     * Build a discrete weapon item from a template + base weapon.
     * Template supplies: name prefix, rarity, price, description, flags.
     * Base weapon supplies: weight, subtype, baseItem, img fallback.
     *
     * @param {Item} templateDoc
     * @param {Item} baseDoc
     * @param {string} templateName  e.g. "Dragon Slayer"
     * @param {string} baseName      e.g. "Longsword"
     * @param {number} tier          1 | 2 | 3
     * @returns {object} Plain item data
     */
}

applyLootPoolItemBuilders(LootPoolCompiler);
applyLootPoolPackReconciler(LootPoolCompiler);
