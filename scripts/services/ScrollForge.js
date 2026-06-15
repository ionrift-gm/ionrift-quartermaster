/**
 * ScrollForge - runtime spell scroll compendium built from GM-selected spell sources.
 * Writes to a world compendium so no spell text is shipped with the module.
 */

import { Logger, MODULE_LABEL } from "../_logger.js";
import { ItemMaskingHelper } from "./ItemMaskingHelper.js";

const MODULE_ID = "ionrift-quartermaster";
const FORGED_FLAG = "ionrift-quartermaster";

/**
 * One Foundry scroll art per spell school (same paths as legacy quartermaster-scrolls / build-scroll-compendium).
 * Level-based SCROLL_ICONS lived in scripts/build-scroll-compendium.mjs; forge uses school for a stable shelf read.
 */
const SCROLL_IMG_BY_SCHOOL = {
    abj: "icons/sundries/scrolls/scroll-bound-blue-white.webp",
    con: "icons/sundries/scrolls/scroll-bound-sealed-orange.webp",
    div: "icons/sundries/scrolls/scroll-symbol-eye-brown.webp",
    enc: "icons/sundries/scrolls/scroll-bound-gold.webp",
    evo: "icons/sundries/scrolls/scroll-runed-brown-white.webp",
    ill: "icons/sundries/scrolls/scroll-runed-brown-grey.webp",
    nec: "icons/sundries/scrolls/scroll-bound-skull-brown.webp",
    trs: "icons/sundries/scrolls/scroll-bound-green.webp"
};

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

    /**
     * GM ready hook: silently compile with saved sources.
     * Never opens the source-picker dialog on load - that violates the nudge
     * policy. If the available compendium set changed, update the snapshot and
     * log a console note so the GM can revisit sources from the Ledger UI.
     */
    static async runAfterReady() {
        if (!game.user.isGM) return;
        if (game.system?.id !== "dnd5e") return;
        if (!game.settings.get(MODULE_ID, "scrollForgeEnabled")) return;

        const candidates = await this.discoverSpellCompendiums();
        if (!candidates.length) {
            Logger.log(MODULE_LABEL,
                "Scroll Forge: no Item compendiums with spells were found. Nothing to compile."
            );
            return;
        }

        // Detect snapshot drift but do NOT open the dialog - just log.
        const currentSnap = this._candidateSnapshot(candidates);
        const lastSnap = game.settings.get(MODULE_ID, this.SETTING_SNAPSHOT) || "";
        if (lastSnap && currentSnap !== lastSnap) {
            Logger.log(MODULE_LABEL,
                "Scroll Forge: available spell compendiums changed since last save. " +
                "Compiling with existing sources. Open the Quartermaster to review spell sources."
            );
            // Update the snapshot so we don't log every reload
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
        if (!game.user.isGM) return;
        const pack = this.getForgedPack();
        if (!pack) return;

        const cfg = foundry.utils.duplicate(game.settings.get("core", "compendiumConfiguration") ?? {});
        const entry = cfg[pack.collection] ??= {};
        const wanted = {};
        wanted["PLAYER"]    = "NONE";
        wanted["TRUSTED"]   = "NONE";
        wanted["ASSISTANT"] = "NONE";
        wanted["GAMEMASTER"]= "OWNER";
        const current = entry.ownership ?? {};
        const needsUpdate = Object.entries(wanted).some(([k, v]) => current[k] !== v);
        if (!needsUpdate) return;

        entry.ownership = wanted;
        game.settings.set("core", "compendiumConfiguration", cfg);
    }

    /**
     * @returns {Promise<{ id: string, label: string, packageLabel: string, spellCount: number }[]>}
     */
    static async discoverSpellCompendiums() {
        const forgedId = this.worldCollectionId;
        const out = [];

        for (const pack of game.packs) {
            if (pack.documentName !== "Item") continue;
            if (pack.collection === forgedId) continue;

            const packSystem = pack.metadata?.system;
            if (packSystem && game.system?.id && packSystem !== game.system.id) continue;

            try {
                const index = await pack.getIndex({ fields: ["type"] });
                const spellCount = index.filter(e => e.type === "spell").length;
                if (spellCount === 0) continue;

                const pkg = pack.metadata?.packageName
                    ?? pack.metadata?.package
                    ?? "unknown";
                const pkgTitle = game.modules.get(pkg)?.title
                    ?? (pkg === game.system?.id ? game.system.title : null)
                    ?? pkg;

                out.push({
                    id:           pack.collection,
                    label:        pack.metadata?.label ?? pack.collection,
                    packageLabel: pkgTitle,
                    spellCount
                });
            } catch {
                /* skip unreadable pack */
            }
        }

        out.sort((a, b) => a.label.localeCompare(b.label));
        return out;
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
        return this._stableHash(ids.join("\n"));
    }

    static _stableHash(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) + h) ^ str.charCodeAt(i);
        }
        return (h >>> 0).toString(16);
    }

    static async compile({ forceRecompile = false } = {}) {
        if (!game.user.isGM) return;
        if (game.system?.id !== "dnd5e") return;

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

        // 2024 packs win name collisions -- process them before legacy packs
        // so seenSpellNames deduplication favours the newer content.
        const PRIORITY_ORDER = ["dnd5e.spells24", "dnd5e.spells"];
        spellPacks.sort((a, b) => {
            const ai = PRIORITY_ORDER.indexOf(a.collection);
            const bi = PRIORITY_ORDER.indexOf(b.collection);
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });

        const sourceHash = await this._computeSourceHash(spellPacks);
        const lastHash = game.settings.get(MODULE_ID, this.SETTING_HASH);
        const packExists = !!game.packs.get(this.worldCollectionId);
        if (!forceRecompile && sourceHash === lastHash && packExists) {
            await this.ensureSidebarPlacement();
            return;
        }

        const ItemClass = CONFIG.Item.documentClass;
        /** @type {{ data: object, schoolKey: string, level: number }[]} */
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
                const lvl = spell.system?.level;
                if (typeof lvl !== "number" || lvl < 1) continue;

                const nameKey = (spell.name || "").toLowerCase();
                if (!nameKey || banSet.has(nameKey)) continue;
                if (seenSpellNames.has(nameKey)) continue;
                seenSpellNames.add(nameKey);

                try {
                    const data = await this._spellToScrollData(spell, ItemClass);
                    if (!data) { skipCount++; continue; }
                    pendingRows.push({
                        data,
                        schoolKey: spell.system?.school ?? "unknown",
                        level:     lvl
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
        this._compileSchoolFolderByKey = new Map();
        this._compileLevelFolderByKey = new Map();
        const scrollItems = [];
        for (const row of pendingRows) {
            row.data.folder = await this._ensureSchoolLevelFolder(pack, row.schoolKey, row.level);
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
            // Persist rich metadata so the Forge UI can show "N scrolls - compiled X ago".
            const enabledIds = spellPacks.map(p => p.collection);
            await this._writeMeta({ compiledAt: new Date().toISOString(), scrollCount: scrollItems.length, sourceIds: enabledIds });
        }
        await this.ensureSidebarPlacement();
        const skipNote = skipCount > 0 ? ` (${skipCount} spell${skipCount !== 1 ? 's' : ''} skipped, see console)` : "";
        ui.notifications.info(
            `Scroll Forge: compiled ${scrollItems.length} spell scrolls into "${this.PACK_LABEL}"${skipNote}. Opening it now.`
        );
        await this.openForgedPack();
    }

    /** Per-compile cache: `${schoolKey}|${level}` -> leaf folder document id */
    static _compileFolderCache = new Map();

    /** Per-compile: schoolKey (e.g. abj) -> school Folder document */
    static _compileSchoolFolderByKey = new Map();

    /** Per-compile: `${schoolKey}|${level}` -> level Folder document */
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
     * (Ionrift > Quartermaster > Compiled). Delegates to LootPoolCompiler so
     * all three compilers share a single, duplicate-safe folder-creation path.
     */
    static async assignForgedPackSidebarFolder(pack) {
        if (!game.user.isGM) return;
        const { LootPoolCompiler } = await import("./LootPoolCompiler.js");
        const folderId = await LootPoolCompiler._ensureCompiledFolderId();
        if (!folderId) {
            Logger.log(MODULE_LABEL,
                "Scroll Forge: could not locate or create Ionrift > Quartermaster > Compiled folder."
            );
            return;
        }
        const packId = pack.collection;
        const cfg = foundry.utils.duplicate(game.settings.get("core", "compendiumConfiguration") ?? {});
        if (cfg[packId]?.folder === folderId) return; // already correct
        cfg[packId] = foundry.utils.mergeObject(cfg[packId] ?? {}, { folder: folderId });
        await game.settings.set("core", "compendiumConfiguration", cfg);
    }

    /**
     * @param {CompendiumCollection} pack
     * @param {string} schoolKey dnd5e school id (e.g. abj)
     * @param {number} level spell level 1-9
     */
    static async _ensureSchoolLevelFolder(pack, schoolKey, level) {
        const leafKey = `${schoolKey}|${level}`;
        if (this._compileFolderCache.has(leafKey)) return this._compileFolderCache.get(leafKey);

        let schoolFolder = this._compileSchoolFolderByKey.get(schoolKey);
        if (!schoolFolder) {
            const schoolLabel = this._schoolFolderLabel(schoolKey);
            schoolFolder = await this._findOrCreateItemFolder(pack, schoolLabel, null);
            this._compileSchoolFolderByKey.set(schoolKey, schoolFolder);
        }

        const levelMapKey = `${schoolKey}|${level}`;
        let levelFolder = this._compileLevelFolderByKey.get(levelMapKey);
        if (!levelFolder) {
            const levelLabel = this._levelFolderLabel(level);
            levelFolder = await this._findOrCreateItemFolder(pack, levelLabel, schoolFolder.id);
            this._compileLevelFolderByKey.set(levelMapKey, levelFolder);
        }

        this._compileFolderCache.set(leafKey, levelFolder.id);
        return levelFolder.id;
    }

    static _schoolFolderLabel(schoolKey) {
        const def = CONFIG.DND5E?.spellSchools?.[schoolKey];
        if (def?.label) return game.i18n.localize(def.label);
        if (schoolKey === "unknown") return "Unknown";
        return String(schoolKey);
    }

    static _levelFolderLabel(level) {
        const locKey = CONFIG.DND5E?.spellLevels?.[level];
        if (locKey) return game.i18n.localize(locKey);
        return `Level ${level}`;
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
            const index = await p.getIndex({ fields: ["type"] });
            const n = index.filter(e => e.type === "spell").length;
            parts.push(`${p.collection}:${n}`);
        }
        return this._stableHash(parts.join("|"));
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
            ownership: (o => { o["PLAYER"] = "NONE"; o["TRUSTED"] = "NONE"; o["ASSISTANT"] = "NONE"; o["GAMEMASTER"] = "OWNER"; return o; })({})
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

    /**
     * @param {Item} spell
     * @param {typeof Item} ItemClass
     */
    static async _spellToScrollData(spell, ItemClass) {
        const schoolKey = spell.system?.school ?? "unknown";
        const scrollMeta = {
            spellName:  spell.name,
            spellLevel: spell.system?.level ?? 1
        };

        if (typeof ItemClass?.createScrollFromSpell === "function") {
            try {
                const scrollConfig = { dialog: false, explanation: "full" };
                const created = await ItemClass.createScrollFromSpell(spell, {}, scrollConfig);
                const plain = created?.toObject
                    ? created.toObject()
                    : foundry.utils.duplicate(created);
                plain.flags = foundry.utils.mergeObject(plain.flags ?? {}, {
                    [FORGED_FLAG]: {
                        scrollMeta,
                        forgedFrom: spell.uuid,
                        school:     schoolKey
                    }
                });
                plain.img = this._scrollImgForSchool(schoolKey);
                return plain;
            } catch (err) {
                Logger.warn(MODULE_LABEL,
                    `Scroll Forge: createScrollFromSpell failed for "${spell.name}" - using manual fallback. (${err.message})`
                );
            }
        }

        return this._manualScrollFromSpell(spell, scrollMeta, schoolKey);
    }

    /**
     * @param {string} schoolKey dnd5e school id (abj, con, …)
     */
    static _scrollImgForSchool(schoolKey) {
        if (SCROLL_IMG_BY_SCHOOL[schoolKey]) return SCROLL_IMG_BY_SCHOOL[schoolKey];
        const keys = Object.keys(CONFIG.DND5E?.spellSchools ?? {});
        const idx = keys.indexOf(schoolKey);
        if (idx >= 0) {
            const pool = Object.values(SCROLL_IMG_BY_SCHOOL);
            return pool[idx % pool.length];
        }
        return ItemMaskingHelper._genericIconFor("scroll");
    }

    static _manualScrollFromSpell(spell, scrollMeta, schoolKey) {
        const level = scrollMeta.spellLevel;
        const rarity = this._scrollRarity(level);
        const priceVal = this._scrollPrice(level);
        const desc = spell.system?.description?.value ?? "";
        const sk = schoolKey ?? spell.system?.school ?? "unknown";

        const { dc, bonus } = this._scrollChallengeValues(level);
        const activityId = foundry.utils.randomID();
        const activities = {
            [activityId]: {
                _id: activityId,
                type: "cast",
                consumption: {
                    targets: [{ type: "itemUses", value: "1" }]
                },
                spell: {
                    challenge: { attack: bonus, save: dc, override: true },
                    level,
                    uuid: spell.uuid
                }
            }
        };

        return {
            name: `Spell Scroll (${spell.name})`,
            type: "consumable",
            img:  this._scrollImgForSchool(sk),
            system: {
                description: { value: desc },
                rarity,
                weight:  { value: 0.1, units: "lb" },
                price:   { value: priceVal, denomination: "gp" },
                type:    { value: "scroll" },
                uses:    { max: 1, spent: 0, recovery: "", autoDestroy: true },
                quantity: 1,
                activities
            },
            flags: {
                [FORGED_FLAG]: {
                    scrollMeta,
                    forgedFrom: spell.uuid,
                    school:     sk
                }
            }
        };
    }

    /**
     * DMG spell scroll DC and attack bonus by spell level.
     * Reads from CONFIG.DND5E.spellScrollValues at runtime when available,
     * falls back to hardcoded 2024 DMG table.
     * @param {number} level
     * @returns {{ dc: number, bonus: number }}
     */
    static _scrollChallengeValues(level) {
        const cfg = CONFIG.DND5E?.spellScrollValues;
        if (cfg) {
            for (let lv = level; lv >= 0; lv--) {
                if (cfg[lv]) return { dc: cfg[lv].dc, bonus: cfg[lv].bonus };
            }
        }
        const table = [
            { dc: 13, bonus: 5 },  // 0
            { dc: 13, bonus: 5 },  // 1
            { dc: 13, bonus: 5 },  // 2
            { dc: 15, bonus: 7 },  // 3
            { dc: 15, bonus: 7 },  // 4
            { dc: 17, bonus: 9 },  // 5
            { dc: 17, bonus: 9 },  // 6
            { dc: 18, bonus: 10 }, // 7
            { dc: 18, bonus: 10 }, // 8
            { dc: 19, bonus: 11 }  // 9
        ];
        return table[Math.min(level, 9)] ?? table[1];
    }

    static _scrollRarity(level) {
        if (level <= 1) return "common";
        if (level <= 3) return "uncommon";
        if (level <= 5) return "rare";
        if (level <= 8) return "veryRare";
        return "legendary";
    }

    static _scrollPrice(level) {
        const table = [0, 25, 75, 150, 300, 500, 1000, 2000, 5000, 10000, 25000];
        return table[level] ?? 25;
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

        // No saved prefs: default-select both SRD spell packs when available.
        // Collisions are resolved at compile time in favour of 2024 content.
        const defaults = [];
        if (candidateIds.has("dnd5e.spells24")) defaults.push("dnd5e.spells24");
        if (candidateIds.has("dnd5e.spells"))   defaults.push("dnd5e.spells");
        return defaults.length ? defaults : [];
    }

    // ── Status / metadata helpers (mirrors LootPoolCompiler API) ───────────

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
            // Source-change staleness: compare stored sourceIds vs currently enabled.
            const meta = this.getCompiledMeta();
            if (meta?.sourceIds?.length) {
                let current = [];
                try { current = JSON.parse(game.settings.get(MODULE_ID, this.SETTING_SOURCES) || "[]"); } catch { /* ok */ }
                const stored  = new Set(meta.sourceIds);
                const now     = new Set(current);
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

    /**
     * Clear the compiled scroll pack and reset hash + metadata.
     * Mirrors LootPoolCompiler's clear pattern.
     */
    static async clearCompiledPack() {
        const pack = game.packs.get(this.worldCollectionId);
        if (pack) {
            try {
                const ItemClass = CONFIG.Item.documentClass;
                const docs = await pack.getDocuments();
                if (docs.length) {
                    await ItemClass.deleteDocuments(docs.map(d => d.id), { pack: pack.collection });
                }
            } catch (err) {
                Logger.warn(MODULE_LABEL, "ScrollForge.clearCompiledPack: partial failure:", err);
            }
        }
        await game.settings.set(MODULE_ID, this.SETTING_HASH, "");
        await game.settings.set(MODULE_ID, this.SETTING_META, "");
    }
}
