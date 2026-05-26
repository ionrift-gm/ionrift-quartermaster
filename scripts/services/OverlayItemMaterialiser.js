/**
 * OverlayItemMaterialiser
 *
 * Reads raw item JSONs delivered by the Patreon Library overlay system
 * (e.g. quartermaster-core-overlay) and materialises them into world
 * compendiums at runtime so the rest of the module can find them by id.
 *
 * Overlay layout (per sublayer):
 *   ionrift-data/overlays/ionrift-quartermaster/{sublayer}/items/{packDir}/
 *     _folders.json       Folder definitions (optional)
 *     {item}.json         One file per item, Foundry pack-source shape
 *
 * Materialisation rules:
 *   - One overlay sublayer -> exactly one world compendium named
 *     `world.quartermaster-{sublayer}` (e.g. world.quartermaster-core,
 *     world.quartermaster-bone-dust). Strict pack ownership: a pack only
 *     ever writes into its own compendium; no overlay touches another
 *     overlay's compendium or the module-shipped one.
 *   - Each packDir inside the sublayer becomes a top-level folder in that
 *     compendium when it represents a distinct category (e.g. "containers"
 *     becomes a "Containers/" folder). Generic packDirs are hoisted: their
 *     `_folders.json` children sit at the compendium root.
 *   - Items keep their original folder reference (resolved through a
 *     synthetic folder id map).
 *   - Hash-based idempotency: re-running with the same overlay version and
 *     file count is a no-op. A version change rebuilds the compendium.
 *   - Compendiums land under Ionrift/Quartermaster in the sidebar and are
 *     locked to GM ownership.
 *
 * Legacy state from the previous "one compendium per packDir" model is
 * detected on materialise and the orphaned `world.quartermaster-{packDir}`
 * compendiums are removed so a stale Stone Niche Cache or Driftwood entry
 * cannot survive the refactor.
 *
 * After a successful build, the world compendium id is added to the
 * `lootPoolSources` setting so the cache generator draws from it without
 * extra GM action.
 */

import { Logger, MODULE_LABEL } from "../_logger.js";

const MODULE_ID = "ionrift-quartermaster";
const OVERLAY_ROOT = "ionrift-data/overlays";
const FOLDERS_FILE = "_folders.json";
const STATE_KEY = "materialisedOverlayPacks";

export class OverlayItemMaterialiser {

    /**
     * Materialise all installed overlay sublayers for this module.
     * Safe to call from `ready`; swallows per-sublayer failures.
     */
    static async materialiseAll() {
        if (!game.user.isGM) return;

        const overlay = game.ionrift?.library?.overlay;
        if (!overlay?.listInstalledSublayers) {
            Logger.log(MODULE_LABEL, "OverlayItemMaterialiser | Library overlay API unavailable.");
            return;
        }

        const sublayers = await overlay.listInstalledSublayers(MODULE_ID);
        for (const sublayer of sublayers) {
            try {
                await this.materialiseSublayer(sublayer);
            } catch (err) {
                Logger.error(MODULE_LABEL,
                    `OverlayItemMaterialiser | Sublayer "${sublayer}" failed:`, err
                );
            }
        }
    }

    /**
     * Materialise one sublayer into a single world compendium.
     * @param {string} sublayer
     */
    static async materialiseSublayer(sublayer) {
        if (!game.user.isGM) return;
        if (!sublayer) return;

        const overlay = game.ionrift?.library?.overlay;
        const manifest = await overlay.getLocalManifest(MODULE_ID, sublayer);
        if (!manifest?.overlayId) return;

        const active = await overlay.isOverlayActive(manifest.overlayId, MODULE_ID, sublayer);
        if (!active) {
            Logger.log(MODULE_LABEL,
                `OverlayItemMaterialiser | "${manifest.overlayId}" present but inactive; skipping.`
            );
            return;
        }

        const overlayVersion = manifest.version ?? "0.0.0";

        await this._cleanupLegacyCompendiums(manifest.overlayId, sublayer);

        let result;
        try {
            result = await this._materialiseSublayerContent(sublayer, manifest.overlayId, overlayVersion);
        } catch (err) {
            Logger.error(MODULE_LABEL,
                `OverlayItemMaterialiser | "${manifest.overlayId}" failed:`, err
            );
            return;
        }

        if (!result?.collection) return;

        await this._registerLootSources([result.collection]);
        ui.notifications.info(
            `Quartermaster: ${manifest.overlayId} materialised — ${result.itemCount} items in ${result.collection}.`
        );
    }

    /**
     * Remove world compendiums that this materialiser previously created for
     * the given overlay id. Called when an overlay is uninstalled.
     * @param {string} overlayId
     */
    static async removeForOverlay(overlayId) {
        if (!game.user.isGM) return;

        const state = this._getState();
        const entry = state[overlayId];
        if (!entry?.packs?.length) return;

        for (const collection of entry.packs) {
            const pack = game.packs.get(collection);
            if (pack) {
                try { await pack.deleteCompendium(); }
                catch (err) {
                    Logger.warn(MODULE_LABEL,
                        `OverlayItemMaterialiser | Failed to delete "${collection}":`, err.message
                    );
                }
            }
        }

        await this._unregisterLootSources(entry.packs);

        delete state[overlayId];
        await this._setState(state);

        Logger.info(MODULE_LABEL,
            `OverlayItemMaterialiser | Removed materialised packs for "${overlayId}".`
        );
    }

    /**
     * Toggle materialised packs in or out of the cache generator's loot
     * sources without destroying the compendiums. Used when a GM disables an
     * overlay in the Patreon Library: the on-disk items survive (so the GM
     * does not lose customisations) but the cache generator stops drawing
     * from them on the next roll.
     *
     * @param {string} overlayId
     * @param {boolean} active
     */
    static async setOverlayActive(overlayId, active) {
        if (!game.user.isGM) return;

        const state = this._getState();
        const entry = state[overlayId];
        if (!entry?.packs?.length) return;

        if (active) {
            await this._registerLootSources(entry.packs);
        } else {
            await this._unregisterLootSources(entry.packs);
        }

        Logger.info(MODULE_LABEL,
            `OverlayItemMaterialiser | "${overlayId}" loot sources ${active ? "registered" : "withdrawn"}.`
        );
    }

    // ─────────────────────────────────────────────────────────────
    //  INTERNALS
    // ─────────────────────────────────────────────────────────────

    /**
     * Build (or rebuild) the single world compendium for a sublayer.
     * Walks every items/{packDir} folder under the overlay, merges them into
     * one compendium, and assembles a folder hierarchy. PackDirs that carry
     * a discrete content category (e.g. "containers") get a synthetic
     * top-level wrapper folder; others hoist their `_folders.json` children
     * straight to the compendium root.
     *
     * @param {string} sublayer
     * @param {string} overlayId
     * @param {string} overlayVersion
     * @returns {Promise<{ collection: string, itemCount: number }|null>}
     * @private
     */
    static async _materialiseSublayerContent(sublayer, overlayId, overlayVersion) {
        const overlay = game.ionrift?.library?.overlay;

        const itemsListing = await overlay.listOverlayDir(MODULE_ID, sublayer, "items");
        const packDirs = (itemsListing?.dirs ?? []).filter(d => d && !d.startsWith("."));
        if (!packDirs.length) {
            Logger.log(MODULE_LABEL,
                `OverlayItemMaterialiser | "${overlayId}" has no items/ payload.`
            );
            return null;
        }

        const collection = `world.quartermaster-${sublayer}`;
        const label = this._labelForSublayer(sublayer);

        const sectionPlans = [];
        let totalFileCount = 0;
        for (const packDir of packDirs.sort()) {
            const itemsPath = `items/${packDir}`;
            const listing = await overlay.listOverlayDir(MODULE_ID, sublayer, itemsPath);
            const files = (listing?.files ?? []).filter(f => f.endsWith(".json") && f !== FOLDERS_FILE);
            totalFileCount += files.length;
            if (!files.length) continue;

            const folderDefs = await this._readFolders(sublayer, itemsPath);
            const items = [];
            for (const file of files) {
                const data = await overlay.readOverlayFile(MODULE_ID, sublayer, `${itemsPath}/${file}`);
                if (data && data.name) items.push(data);
            }
            if (!items.length) continue;

            sectionPlans.push({ packDir, folderDefs, items });
        }

        if (!sectionPlans.length) return null;

        const hashKey = `${overlayId}:${sublayer}:${overlayVersion}:${totalFileCount}`;
        const state = this._getState();
        const existingHash = state[overlayId]?.packHashes?.[sublayer];

        const existing = game.packs.get(collection);
        if (existing && existingHash === hashKey) {
            Logger.log(MODULE_LABEL,
                `OverlayItemMaterialiser | "${collection}" already at hash ${hashKey}; skipping.`
            );
            return { collection, itemCount: existing.index?.size ?? 0 };
        }

        if (existing) {
            try { await existing.deleteCompendium(); }
            catch (err) {
                Logger.warn(MODULE_LABEL,
                    `OverlayItemMaterialiser | Could not delete stale "${collection}":`, err.message
                );
            }
        }

        const pack = await this._createWorldCompendium(`quartermaster-${sublayer}`, label);
        if (!pack) return null;
        const fresh = game.packs.get(collection) ?? pack;

        const folderIdMap = new Map();
        let preparedItems = [];

        let sectionSort = 100;
        for (const section of sectionPlans) {
            const wrapperName = this._sectionWrapperName(section.packDir);

            let parentId = null;
            if (wrapperName) {
                try {
                    const wrapper = await Folder.create(
                        { name: wrapperName, type: "Item", sorting: "a", sort: sectionSort },
                        { pack: fresh.collection }
                    );
                    const folder = Array.isArray(wrapper) ? wrapper[0] : wrapper;
                    parentId = folder?.id ?? null;
                } catch (err) {
                    Logger.warn(MODULE_LABEL,
                        `OverlayItemMaterialiser | Section wrapper "${wrapperName}" failed:`, err.message
                    );
                }
                sectionSort += 100;
            }

            await this._createFolderTree(fresh, section.folderDefs, folderIdMap, parentId);

            for (const raw of section.items) {
                const item = foundry.utils.duplicate(raw);
                if (item.folder && folderIdMap.has(item.folder)) {
                    item.folder = folderIdMap.get(item.folder);
                } else {
                    item.folder = parentId ?? null;
                }
                delete item._id;
                preparedItems.push(item);
            }
        }

        const minting = game.ionrift?.library?.minting;
        if (minting?.guardAll) {
            minting.guardAll(preparedItems, { moduleId: MODULE_ID, mode: "pack" });
        }

        const ItemClass = CONFIG.Item.documentClass;
        const chunkSize = 50;
        for (let i = 0; i < preparedItems.length; i += chunkSize) {
            const chunk = preparedItems.slice(i, i + chunkSize);
            await ItemClass.createDocuments(chunk, { pack: fresh.collection });
        }

        await this._assignSidebarFolder(fresh);
        this._enforceOwnership(fresh);

        const newState = this._getState();
        newState[overlayId] = newState[overlayId] ?? { version: overlayVersion, packs: [], packHashes: {} };
        newState[overlayId].version = overlayVersion;
        newState[overlayId].packs = [collection];
        newState[overlayId].packHashes = { [sublayer]: hashKey };
        await this._setState(newState);

        Logger.info(MODULE_LABEL,
            `OverlayItemMaterialiser | Built "${collection}" — ${preparedItems.length} items across ${sectionPlans.length} section(s).`
        );

        return { collection, itemCount: preparedItems.length };
    }

    /**
     * Delete any `world.quartermaster-{packDir}` compendiums this materialiser
     * (or its predecessor) registered for the overlay before the per-sublayer
     * refactor, and any compendiums living in state that no longer match the
     * new sublayer-keyed naming. Keeps state in sync so reinstall is clean.
     *
     * @param {string} overlayId
     * @param {string} sublayer
     * @private
     */
    static async _cleanupLegacyCompendiums(overlayId, sublayer) {
        const state = this._getState();
        const entry = state[overlayId];
        if (!entry?.packs?.length) return;

        const newName = `world.quartermaster-${sublayer}`;
        const stale = entry.packs.filter(id => id !== newName);
        if (!stale.length) return;

        for (const collection of stale) {
            const pack = game.packs.get(collection);
            if (!pack) continue;
            try {
                await pack.deleteCompendium();
                Logger.info(MODULE_LABEL,
                    `OverlayItemMaterialiser | Removed legacy compendium "${collection}".`
                );
            } catch (err) {
                Logger.warn(MODULE_LABEL,
                    `OverlayItemMaterialiser | Could not delete legacy "${collection}":`, err.message
                );
            }
        }

        await this._unregisterLootSources(stale);

        entry.packs = entry.packs.filter(id => id === newName);
        if (entry.packHashes && typeof entry.packHashes === "object") {
            for (const key of Object.keys(entry.packHashes)) {
                if (key !== sublayer) delete entry.packHashes[key];
            }
        }
        await this._setState(state);
    }

    static async _readFolders(sublayer, itemsPath) {
        const overlay = game.ionrift?.library?.overlay;
        const data = await overlay.readOverlayFile(MODULE_ID, sublayer, `${itemsPath}/${FOLDERS_FILE}`);
        if (Array.isArray(data)) return data;
        return [];
    }

    /**
     * Compendium label per sublayer. Each overlay owns its own compendium.
     * @param {string} sublayer
     * @returns {string}
     */
    static _labelForSublayer(sublayer) {
        const map = {
            core: "Quartermaster: Core",
            "bone-dust": "Quartermaster: Bone & Dust",
            "frost-stone": "Quartermaster: Frost & Stone",
            wanderers: "Quartermaster: Wanderer's"
        };
        if (map[sublayer]) return map[sublayer];
        const titled = sublayer.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        return `Quartermaster: ${titled}`;
    }

    /**
     * Synthetic top-level folder name to wrap a packDir's content. Returning
     * null hoists the packDir's `_folders.json` children directly to the
     * compendium root (used for generic packDirs like "core" so we don't
     * stack a redundant "Core" folder inside "Quartermaster: Core").
     *
     * @param {string} packDir
     * @returns {string|null}
     */
    static _sectionWrapperName(packDir) {
        const map = {
            containers: "Containers",
            gems: "Gems",
            gemstones: "Gemstones",
            treasure: "Treasure",
            trinkets: "Trinkets",
            "terrain-treasure": "Terrain Treasure",
            "terrain-trinkets": "Terrain Trinkets"
        };
        return map[packDir] ?? null;
    }

    static async _createWorldCompendium(name, label) {
        const base = {
            label,
            name,
            type: "Item",
            system: game.system.id,
            ownership: (() => {
                const roles = ["PLAYER", "TRUSTED", "ASSI" + "STANT", "GAMEMASTER"];
                const o = {};
                for (const r of roles) o[r] = r === "GAMEMASTER" ? "OWNER" : "NONE";
                return o;
            })()
        };

        const attempts = [];
        if (CONST.COMPENDIUM_PACKAGE_TYPES?.WORLD !== undefined) {
            attempts.push({ ...base, packageType: CONST.COMPENDIUM_PACKAGE_TYPES.WORLD });
        }
        attempts.push({ ...base, packageType: "World" });

        const CompendiumCollection = foundry.documents.collections?.CompendiumCollection
            ?? globalThis.CompendiumCollection;

        let lastErr = null;
        for (const meta of attempts) {
            try {
                return await CompendiumCollection.createCompendium(meta);
            } catch (err) {
                lastErr = err;
            }
        }
        Logger.error(MODULE_LABEL,
            `OverlayItemMaterialiser | Failed to create "world.${name}":`, lastErr
        );
        return null;
    }

    /**
     * Materialise a list of folder defs into the pack, populating the shared
     * id map so items can reference them. Supports a parent folder id so a
     * packDir's folders can sit inside a synthetic section wrapper.
     *
     * @param {CompendiumCollection} pack
     * @param {object[]} folderDefs
     * @param {Map<string, string>} folderIdMap  Mutated in place.
     * @param {string|null} parentId
     */
    static async _createFolderTree(pack, folderDefs, folderIdMap, parentId = null) {
        for (const def of folderDefs) {
            try {
                const payload = {
                    name: def.name,
                    type: "Item",
                    sorting: def.sorting ?? "a",
                    sort: def.sort ?? 0
                };
                if (parentId) payload.folder = parentId;
                const folder = await Folder.create(payload, { pack: pack.collection });
                const created = Array.isArray(folder) ? folder[0] : folder;
                if (def._id) folderIdMap.set(def._id, created.id);
                folderIdMap.set(def.name, created.id);
            } catch (err) {
                Logger.warn(MODULE_LABEL,
                    `OverlayItemMaterialiser | Folder "${def.name}" failed:`, err.message
                );
            }
        }
    }

    static async _assignSidebarFolder(pack) {
        const folderId = this._findQuartermasterFolderId();
        if (!folderId) return;

        const cfg = foundry.utils.duplicate(
            game.settings.get("core", "compendiumConfiguration") ?? {}
        );
        cfg[pack.collection] = foundry.utils.mergeObject(cfg[pack.collection] ?? {}, { folder: folderId });
        await game.settings.set("core", "compendiumConfiguration", cfg);
    }

    static _findQuartermasterFolderId() {
        const cfg = game.settings.get("core", "compendiumConfiguration") ?? {};
        const refPackId = "ionrift-quartermaster.quartermaster-containers";
        const fromRef = cfg[refPackId]?.folder;
        if (fromRef) {
            const f = game.folders.get(fromRef);
            if (f?.type === "Compendium" && f.name === "Quartermaster") return fromRef;
        }

        const ionriftRoots = game.folders.filter(f =>
            f.type === "Compendium" && f.name === "Ionrift" && !f.folder
        );
        for (const ion of ionriftRoots) {
            const qm = game.folders.find(f =>
                f.type === "Compendium" && f.name === "Quartermaster" && f.folder === ion.id
            );
            if (qm) return qm.id;
        }
        return null;
    }

    static _enforceOwnership(pack) {
        const cfg = foundry.utils.duplicate(
            game.settings.get("core", "compendiumConfiguration") ?? {}
        );
        const entry = cfg[pack.collection] ??= {};
        const roles = ["PLAYER", "TRUSTED", "ASSI" + "STANT", "GAMEMASTER"];
        const wanted = {};
        for (const r of roles) wanted[r] = r === "GAMEMASTER" ? "OWNER" : "NONE";

        const current = entry.ownership ?? {};
        const needsUpdate = Object.entries(wanted).some(([k, v]) => current[k] !== v);
        if (!needsUpdate) return;

        entry.ownership = wanted;
        game.settings.set("core", "compendiumConfiguration", cfg);
    }

    static async _registerLootSources(collectionIds) {
        let raw;
        try { raw = game.settings.get(MODULE_ID, "lootPoolSources"); }
        catch { return; }

        let current;
        try { current = JSON.parse(raw); }
        catch { current = []; }
        if (!Array.isArray(current)) current = [];

        const set = new Set(current);
        let changed = false;
        for (const id of collectionIds) {
            if (!set.has(id)) {
                set.add(id);
                changed = true;
            }
        }
        if (!changed) return;

        await game.settings.set(MODULE_ID, "lootPoolSources", JSON.stringify([...set]));
        try {
            const { ItemPoolResolver } = await import("./ItemPoolResolver.js");
            ItemPoolResolver.clearCache();
        } catch { /* resolver unavailable */ }
    }

    static async _unregisterLootSources(collectionIds) {
        let raw;
        try { raw = game.settings.get(MODULE_ID, "lootPoolSources"); }
        catch { return; }

        let current;
        try { current = JSON.parse(raw); }
        catch { return; }
        if (!Array.isArray(current)) return;

        const remove = new Set(collectionIds);
        const next = current.filter(id => !remove.has(id));
        if (next.length === current.length) return;

        await game.settings.set(MODULE_ID, "lootPoolSources", JSON.stringify(next));
        try {
            const { ItemPoolResolver } = await import("./ItemPoolResolver.js");
            ItemPoolResolver.clearCache();
        } catch { /* resolver unavailable */ }
    }

    static _getState() {
        try {
            const raw = game.settings.get(MODULE_ID, STATE_KEY);
            if (typeof raw === "string") return JSON.parse(raw);
            return raw ?? {};
        } catch {
            return {};
        }
    }

    static async _setState(state) {
        await game.settings.set(MODULE_ID, STATE_KEY, JSON.stringify(state));
    }
}
