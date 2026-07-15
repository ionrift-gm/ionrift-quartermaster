/**
 * ScrollForge - runtime spell scroll compendium built from GM-selected spell sources.
 * Writes to a world compendium so no spell text is shipped with the module.
 */

import { Logger, MODULE_LABEL } from "../utils/Logger.js";
import { enforcePackOwnership, assignPackToCompiledFolder, clearPackAndResetMeta, stableHash } from "./CompendiumConfigHelper.js";
import { QM_FEATURES } from "../data/QMFeatures.js";

const MODULE_ID = "ionrift-quartermaster";

/** Per-pack index load timeout (ms). Prevents one bad compendium from stalling discovery. */
const PACK_INDEX_TIMEOUT_MS = 12_000;

export class ScrollForge {
    static WORLD_PACK_NAME = "ionrift-forged-scrolls";

    /** Display name in the Compendium sidebar (matches other Quartermaster packs). */
    static PACK_LABEL = "Quartermaster: Spell Scrolls";

    /** @returns {string} Foundry collection id, e.g. world.ionrift-forged-scrolls */
    static get worldCollectionId() {
        return `world.${this.WORLD_PACK_NAME}`;
    }

    static SETTING_HASH     = "scrollForgeHash";
    static SETTING_META     = "scrollForgeMeta";
    static SETTING_SOURCES  = "scrollForgeSpellPacks";
    static SETTING_SNAPSHOT = "scrollForgeCandidateSnapshot";

    /** @returns {object|null} Active system scroll rules from the QM adapter. */
    static _scrollRules() {
        if (!game.ionrift?.quartermaster?.adapter?.supports(QM_FEATURES.SCROLL_FORGE)) return null;
        return game.ionrift.quartermaster.adapter.getScrollForgeRules?.() ?? null;
    }

    /**
     * GM ready hook: silently compile with saved sources.
     * Never opens the source-picker dialog on load - that violates the nudge
     * policy. If the available compendium set changed, update the snapshot and
     * log a console note so the GM can revisit sources from the Ledger UI.
     */
    static async runAfterReady() {
        if (!game.user.isGM) return;
        if (!this._scrollRules()) return;
        if (!game.settings.get(MODULE_ID, "scrollForgeEnabled")) return;

        const candidates = await this.discoverSpellCompendiums();
        if (!candidates.length) {
            Logger.log(MODULE_LABEL,
                "Scroll Forge: no Item compendiums with spells were found. Nothing to compile."
            );
            return;
        }

        const currentSnap = this._candidateSnapshot(candidates);
        const lastSnap = game.settings.get(MODULE_ID, this.SETTING_SNAPSHOT) || "";
        if (lastSnap && currentSnap !== lastSnap) {
            Logger.log(MODULE_LABEL,
                "Scroll Forge: available spell compendiums changed since last save. " +
                "Compiling with existing sources. Open the Quartermaster to review spell sources."
            );
            await game.settings.set(MODULE_ID, this.SETTING_SNAPSHOT, currentSnap);
        }

        await this.compile();
        await this.ensureSidebarPlacement();
    }

    /**
     * If the forged pack exists but has permissive ownership, lock it to GM-only.
     * Covers packs created before the ownership field was added to _createWorldPack.
     */
    static enforceOwnership() {
        enforcePackOwnership(this.getForgedPack());
    }

    /**
     * @returns {Promise<{ id: string, label: string, packageLabel: string, spellCount: number }[]>}
     */
    static async discoverSpellCompendiums() {
        const forgedId = this.worldCollectionId;
        const out = [];
        const seen = new Set();

        const rules = game.ionrift?.quartermaster?.adapter?.getScrollForgeRules?.();
        const priorityIds = rules?.getRecommendedPackIds?.() ?? [];

        for (const id of priorityIds) {
            const pack = game.packs.get(id);
            if (!pack || pack.documentName !== "Item" || pack.collection === forgedId) continue;
            const row = await this._describeSpellPack(pack);
            if (row) {
                out.push(row);
                seen.add(row.id);
            }
        }

        for (const pack of game.packs) {
            if (pack.documentName !== "Item") continue;
            if (pack.collection === forgedId) continue;
            if (seen.has(pack.collection)) continue;

            const packSystem = pack.metadata?.system;
            if (packSystem && game.system?.id && packSystem !== game.system.id) continue;

            const row = await this._describeSpellPack(pack);
            if (row) out.push(row);
        }

        out.sort((a, b) => a.label.localeCompare(b.label));
        return out;
    }

    /**
     * @param {CompendiumCollection} pack
     * @returns {Promise<{ id: string, label: string, packageLabel: string, spellCount: number }|null>}
     */
    static async _describeSpellPack(pack) {
        try {
            const index = await this._getPackIndexWithTimeout(pack, ["type"]);
            const spellCount = [...index.values()].filter(e => e.type === "spell").length;
            if (spellCount === 0) return null;

            const pkg = pack.metadata?.packageName
                ?? pack.metadata?.package
                ?? "unknown";
            const pkgTitle = game.modules.get(pkg)?.title
                ?? (pkg === game.system?.id ? game.system.title : null)
                ?? pkg;

            return {
                id:           pack.collection,
                label:        pack.metadata?.label ?? pack.collection,
                packageLabel: pkgTitle,
                spellCount
            };
        } catch (err) {
            Logger.warn(MODULE_LABEL,
                `Scroll Forge: skipped pack "${pack.collection}" during discovery (${err.message}).`
            );
            return null;
        }
    }

    /**
     * @param {CompendiumCollection} pack
     * @param {string[]} fields
     * @param {number} [timeoutMs]
     */
    static async _getPackIndexWithTimeout(pack, fields, timeoutMs = PACK_INDEX_TIMEOUT_MS) {
        if (pack.index?.size) return pack.index;

        let timer;
        try {
            return await Promise.race([
                pack.getIndex({ fields }),
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`index load timed out after ${timeoutMs}ms`)),
                        timeoutMs
                    );
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * @param {{ id: string }[]} candidates
     */
    static _shouldPromptSourceDialog(candidates) {
        const currentSnap = this._candidateSnapshot(candidates);
        const lastSnap = game.settings.get(MODULE_ID, this.SETTING_SNAPSHOT) || "";

        let enabled = [];
        try {
            enabled = JSON.parse(game.settings.get(MODULE_ID, this.SETTING_SOURCES) || "[]");
        } catch {
            enabled = [];
        }

        const hadSavedSources = Array.isArray(enabled) && enabled.length > 0;
        if (!hadSavedSources) return false;
        if (currentSnap !== lastSnap) return true;
        return false;
    }

    static _candidateSnapshot(candidates) {
        const ids = candidates.map(c => c.id).sort();
        return stableHash(ids.join("\n"));
    }

    static async compile({ forceRecompile = false } = {}) {
        if (!game.user.isGM) return;
        const rules = this._scrollRules();
        if (!rules) return;

        let enabledIds = [];
        try {
            enabledIds = JSON.parse(game.settings.get(MODULE_ID, this.SETTING_SOURCES) || "[]");
        } catch {
            enabledIds = [];
        }

        const spellPacks = enabledIds
            .map(id => game.packs.get(id))
            .filter(p => p && p.documentName === "Item");

        if (!spellPacks.length) {
            if (enabledIds.length > 0) {
                ui.notifications.warn(
                    "Scroll Forge: no spell compendiums are enabled. Open module settings, Scroll Forge spell sources."
                );
            }
            return;
        }

        rules.sortSpellPacks(spellPacks);

        const sourceHash = await this._computeSourceHash(spellPacks);
        const lastHash = game.settings.get(MODULE_ID, this.SETTING_HASH);
        const packExists = !!game.packs.get(this.worldCollectionId);
        if (!forceRecompile && sourceHash === lastHash && packExists) {
            await this.ensureSidebarPlacement();
            return;
        }

        const ItemClass = CONFIG.Item.documentClass;
        /** @type {{ data: object, groupKey: string, level: number }[]} */
        const pendingRows = [];
        const seenSpellNames = new Set();
        let skipCount = 0;
        let banSet = new Set();
        try {
            const { SignatureLedger } = await import("./SignatureLedger.js");
            banSet = await SignatureLedger.getBanSet();
        } catch {
            /* ledger unavailable */
        }

        for (const spellPack of spellPacks) {
            let spells = [];
            try {
                spells = await spellPack.getDocuments({ type: "spell" });
            } catch {
                try {
                    const all = await spellPack.getDocuments();
                    spells = all.filter(d => d.type === "spell");
                } catch (packErr) {
                    Logger.warn(MODULE_LABEL,
                        `Scroll Forge: could not read pack "${spellPack.collection}" - skipping. (${packErr.message})`
                    );
                    continue;
                }
            }

            for (const spell of spells) {
                if (spell.type !== "spell") continue;
                if (!rules.isLeveledSpell(spell)) continue;

                const lvl = rules.getSpellLevel(spell);
                if (lvl === null) continue;

                const nameKey = (spell.name || "").toLowerCase();
                if (!nameKey || banSet.has(nameKey)) continue;
                if (seenSpellNames.has(nameKey)) continue;
                seenSpellNames.add(nameKey);

                try {
                    const data = await rules.spellToScrollData(spell, ItemClass);
                    if (!data) { skipCount++; continue; }
                    pendingRows.push({
                        data,
                        groupKey: rules.getSpellFolderGroupKey(spell),
                        level: lvl
                    });
                } catch (spellErr) {
                    skipCount++;
                    Logger.warn(MODULE_LABEL,
                        `Scroll Forge: skipped "${spell.name}" from ${spellPack.collection} - ${spellErr.message}`
                    );
                }
            }
        }

        if (!pendingRows.length) {
            ui.notifications.warn(
                "Scroll Forge: no scroll items were produced (no leveled spells after filters, or scroll creation failed). See the browser console (F12) for errors."
            );
            return;
        }

        let pack = game.packs.get(this.worldCollectionId);
        if (pack) {
            await this._destroyWorldPack(pack);
        }
        pack = await this._createWorldPack();
        if (!pack) return;
        pack = game.packs.get(this.worldCollectionId) ?? pack;

        this._compileFolderCache = new Map();
        this._compileGroupFolderByKey = new Map();
        this._compileLevelFolderByKey = new Map();
        const scrollItems = [];
        for (const row of pendingRows) {
            row.data.folder = await this._ensureGroupLevelFolder(pack, row.groupKey, row.level, rules);
            scrollItems.push(row.data);
        }

        const minting = game.ionrift?.library?.minting;
        if (minting?.guardAll) {
            minting.guardAll(scrollItems, { moduleId: MODULE_ID, mode: "pack" });
        }

        const chunkSize = 50;
        let writeOk = false;
        try {
            for (let i = 0; i < scrollItems.length; i += chunkSize) {
                const chunk = scrollItems.slice(i, i + chunkSize);
                await ItemClass.createDocuments(chunk, { pack: pack.collection });
            }
            writeOk = true;
        } catch (err) {
            Logger.error(MODULE_LABEL, "Scroll Forge createDocuments failed:", err);
            ui.notifications.error("Scroll Forge could not write items into the compendium. Check the console.");
            return;
        }

        if (scrollItems.length > 0 && writeOk) {
            await game.settings.set(MODULE_ID, this.SETTING_HASH, sourceHash);
            const enabledPackIds = spellPacks.map(p => p.collection);
            await this._writeMeta({
                compiledAt: new Date().toISOString(),
                scrollCount: scrollItems.length,
                sourceIds: enabledPackIds
            });
        }
        await this.ensureSidebarPlacement();
        const skipNote = skipCount > 0
            ? ` (${skipCount} spell${skipCount !== 1 ? "s" : ""} skipped, see console)`
            : "";
        ui.notifications.info(
            `Scroll Forge: compiled ${scrollItems.length} spell scrolls into "${this.PACK_LABEL}"${skipNote}. Opening it now.`
        );
        await this.openForgedPack();
    }

    /** Per-compile cache: `${groupKey}|${level}` -> leaf folder document id */
    static _compileFolderCache = new Map();

    /** Per-compile: groupKey -> group Folder document */
    static _compileGroupFolderByKey = new Map();

    /** Per-compile: `${groupKey}|${level}` -> level Folder document */
    static _compileLevelFolderByKey = new Map();

    /** @param {Folder} folderDoc */
    static _folderIsInItemPack(folderDoc, collectionId) {
        if (!folderDoc || folderDoc.type !== "Item") return false;
        const p = folderDoc.pack;
        if (p === collectionId) return true;
        if (typeof p === "string" && p === collectionId) return true;
        if (p?.collection === collectionId) return true;
        return false;
    }

    static _sameFolderParent(folderDoc, parentFolderId) {
        const a = folderDoc.folder ?? null;
        const b = parentFolderId ?? null;
        return a === b;
    }

    /** Lock ownership and place an existing forged pack under Ionrift / Quartermaster. */
    static async ensureSidebarPlacement() {
        if (!game.user.isGM) return;
        const pack = this.getForgedPack();
        if (!pack) return;
        this.enforceOwnership();
        await this.assignForgedPackSidebarFolder(pack);
    }

    /**
     * Place the forged world pack next to other compiled Quartermaster outputs
     * (Ionrift > Quartermaster > Compiled).
     */
    static async assignForgedPackSidebarFolder(pack) {
        await assignPackToCompiledFolder(pack);
    }

    /**
     * @param {CompendiumCollection} pack
     * @param {string} groupKey school or tradition id
     * @param {number} level spell rank / level
     * @param {object} rules scroll forge rules from the active adapter
     */
    static async _ensureGroupLevelFolder(pack, groupKey, level, rules) {
        const leafKey = `${groupKey}|${level}`;
        if (this._compileFolderCache.has(leafKey)) return this._compileFolderCache.get(leafKey);

        let groupFolder = this._compileGroupFolderByKey.get(groupKey);
        if (!groupFolder) {
            const groupLabel = rules.getSpellFolderGroupLabel(groupKey);
            groupFolder = await this._findOrCreateItemFolder(pack, groupLabel, null);
            this._compileGroupFolderByKey.set(groupKey, groupFolder);
        }

        const levelMapKey = `${groupKey}|${level}`;
        let levelFolder = this._compileLevelFolderByKey.get(levelMapKey);
        if (!levelFolder) {
            const levelLabel = rules.getSpellLevelFolderLabel(level);
            levelFolder = await this._findOrCreateItemFolder(pack, levelLabel, groupFolder.id);
            this._compileLevelFolderByKey.set(levelMapKey, levelFolder);
        }

        this._compileFolderCache.set(leafKey, levelFolder.id);
        return levelFolder.id;
    }

    /**
     * @param {CompendiumCollection} pack
     * @param {string} name
     * @param {string|null} parentFolderId
     */
    static async _findOrCreateItemFolder(pack, name, parentFolderId) {
        const col = pack.collection;
        const match = game.folders.find(f =>
            this._folderIsInItemPack(f, col)
            && f.name === name
            && this._sameFolderParent(f, parentFolderId)
        );
        if (match) return match;

        const data = { name, type: "Item", sorting: "a" };
        if (parentFolderId) data.folder = parentFolderId;

        const created = await Folder.create(data, { pack: pack.collection });
        return Array.isArray(created) ? created[0] : created;
    }

    /** @returns {CompendiumCollection|null} */
    static getForgedPack() {
        return game.packs.get(this.worldCollectionId) ?? null;
    }

    /** Opens the forged scroll compendium for the active GM client. */
    static async openForgedPack() {
        const pack = this.getForgedPack();
        if (!pack) {
            ui.notifications.warn(
                `"${ScrollForge.PACK_LABEL}" compendium not found. Enable Scroll Forge, pick spell sources, and save so the world pack is created.`
            );
            return;
        }
        if (typeof pack.render === "function") await pack.render(true);
    }

    static async _computeSourceHash(spellPacks) {
        const parts = [];
        for (const p of spellPacks.sort((a, b) => a.collection.localeCompare(b.collection))) {
            const index = await this._getPackIndexWithTimeout(p, ["type"]);
            const n = [...index.values()].filter(e => e.type === "spell").length;
            parts.push(`${p.collection}:${n}`);
        }
        return stableHash(parts.join("|"));
    }

    static async _destroyWorldPack(pack) {
        try {
            await pack.deleteCompendium();
        } catch (err) {
            Logger.error(MODULE_LABEL, "Scroll Forge failed to delete existing compendium:", err);
        }
    }

    static async _createWorldPack() {
        const base = {
            label:  this.PACK_LABEL,
            name:   this.WORLD_PACK_NAME,
            type:   "Item",
            system: game.system.id,
            ownership: (o => {
                o["PLAYER"] = "NONE";
                o["TRUSTED"] = "NONE";
                o["ASSISTANT"] = "NONE";
                o["GAMEMASTER"] = "OWNER";
                return o;
            })({})
        };
        const attempts = [];
        if (CONST.COMPENDIUM_PACKAGE_TYPES?.WORLD !== undefined) {
            attempts.push({ ...base, packageType: CONST.COMPENDIUM_PACKAGE_TYPES.WORLD });
        }
        attempts.push({ ...base, packageType: "World" });

        let lastErr = null;
        for (const meta of attempts) {
            try {
                return await foundry.documents.collections.CompendiumCollection.createCompendium(meta);
            } catch (err) {
                lastErr = err;
            }
        }
        Logger.error(MODULE_LABEL, "Scroll Forge failed to create world compendium:", lastErr);
        ui.notifications.error("Scroll Forge could not create the world compendium. Check the console.");
        return null;
    }

    /** @param {{ id: string }[]} candidates */
    static initialCheckedIds(candidates) {
        const candidateIds = new Set(candidates.map(c => c.id));

        let saved = [];
        try {
            saved = JSON.parse(game.settings.get(MODULE_ID, this.SETTING_SOURCES) || "[]");
        } catch {
            saved = [];
        }

        const intersection = saved.filter(id => candidateIds.has(id));
        if (intersection.length) return intersection;

        const rules = this._scrollRules();
        if (rules?.getDefaultSpellPackIds) {
            return rules.getDefaultSpellPackIds(candidates);
        }
        return [];
    }

    /**
     * Synchronous status check — same contract as LootPoolCompiler.getStatus().
     * @returns {"fresh"|"stale"|"never"|"na"}
     */
    static getStatus() {
        try {
            let enabledIds = [];
            try {
                enabledIds = JSON.parse(game.settings.get(MODULE_ID, this.SETTING_SOURCES) || "[]");
            } catch { /* ok */ }
            if (!enabledIds.length) return "na";

            const hash = game.settings.get(MODULE_ID, this.SETTING_HASH);
            if (!hash) return "never";
            if (!game.packs.get(this.worldCollectionId)) return "stale";
            const meta = this.getCompiledMeta();
            if (meta?.sourceIds?.length) {
                let current = [];
                try {
                    current = JSON.parse(game.settings.get(MODULE_ID, this.SETTING_SOURCES) || "[]");
                } catch { /* ok */ }
                const stored = new Set(meta.sourceIds);
                const now = new Set(current);
                const changed = stored.size !== now.size || [...stored].some(id => !now.has(id));
                if (changed) return "stale";
            }
            return "fresh";
        } catch { return "na"; }
    }

    /**
     * Returns the stored compile metadata, or null if none exists.
     * @returns {{ compiledAt?: string, scrollCount?: number, sourceIds?: string[], errorAt?: string, errorMessage?: string }|null}
     */
    static getCompiledMeta() {
        try {
            const raw = game.settings.get(MODULE_ID, this.SETTING_META);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }

    /** Write compile metadata. Internal helper. */
    static async _writeMeta(data) {
        try {
            await game.settings.set(MODULE_ID, this.SETTING_META, JSON.stringify(data));
        } catch { /* non-fatal */ }
    }

    static async clearCompiledPack() {
        await clearPackAndResetMeta(
            this.worldCollectionId,
            this.SETTING_HASH,
            this.SETTING_META,
            "ScrollForge"
        );
    }
}
