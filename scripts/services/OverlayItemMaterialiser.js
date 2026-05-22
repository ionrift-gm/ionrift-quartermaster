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
 *   - One overlay items/{packDir} -> one world compendium
 *     `world.quartermaster-{packDir}` (e.g. world.quartermaster-gemstones).
 *     CacheGenerator looks up these collections by suffix.
 *   - Folder hierarchy from _folders.json is recreated inside the pack.
 *   - Items keep their original folder reference (resolved to new folder ids).
 *   - Hash-based idempotency: re-running with the same overlay version is
 *     a no-op. A version change or new file count rebuilds the pack.
 *   - Each materialised pack is placed in the Ionrift/Quartermaster sidebar
 *     folder and locked to GM ownership.
 *
 * After a successful build, the world compendium ids are added to the
 * `lootPoolSources` setting so they appear checked in the Loot Pool Sources
 * dialog and feed the cache generator without extra GM action.
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
     * Materialise one sublayer. Iterates every items/{packDir} inside it.
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

        const listing = await overlay.listOverlayDir(MODULE_ID, sublayer, "items");
        const packDirs = listing?.dirs ?? [];
        if (!packDirs.length) {
            Logger.log(MODULE_LABEL,
                `OverlayItemMaterialiser | "${manifest.overlayId}" has no items/ payload.`
            );
            return;
        }

        const overlayVersion = manifest.version ?? "0.0.0";
        let totalItems = 0;
        const materialisedIds = [];

        for (const packDir of packDirs) {
            try {
                const result = await this._materialisePackDir(sublayer, packDir, overlayVersion);
                if (result?.collection) {
                    totalItems += result.itemCount;
                    materialisedIds.push(result.collection);
                }
            } catch (err) {
                Logger.error(MODULE_LABEL,
                    `OverlayItemMaterialiser | items/${packDir} failed:`, err
                );
            }
        }

        if (materialisedIds.length) {
            await this._registerLootSources(materialisedIds);
            ui.notifications.info(
                `Quartermaster: ${manifest.overlayId} materialised — ${totalItems} items across ${materialisedIds.length} compendium${materialisedIds.length === 1 ? "" : "s"}.`
            );
        }
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

    static async _materialisePackDir(sublayer, packDir, overlayVersion) {
        const overlay = game.ionrift?.library?.overlay;
        const itemsPath = `items/${packDir}`;
        const listing = await overlay.listOverlayDir(MODULE_ID, sublayer, itemsPath);
        const files = (listing?.files ?? []).filter(f => f.endsWith(".json"));
        if (!files.length) return null;

        const collection = `world.quartermaster-${packDir}`;

        const state = this._getState();
        const overlayId = await this._readOverlayId(sublayer);
        const hashKey = `${overlayId}:${packDir}:${overlayVersion}:${files.length}`;
        const existingHash = state[overlayId]?.packHashes?.[packDir];

        const existing = game.packs.get(collection);
        if (existing && existingHash === hashKey) {
            Logger.log(MODULE_LABEL,
                `OverlayItemMaterialiser | "${collection}" already at hash ${hashKey}; skipping.`
            );
            return { collection, itemCount: existing.index?.size ?? 0 };
        }

        const folderDefs = await this._readFolders(sublayer, itemsPath);
        const items = [];
        for (const file of files) {
            if (file === FOLDERS_FILE) continue;
            const data = await overlay.readOverlayFile(MODULE_ID, sublayer, `${itemsPath}/${file}`);
            if (data && data.name) items.push(data);
        }

        if (!items.length) return null;

        if (existing) {
            try { await existing.deleteCompendium(); }
            catch (err) {
                Logger.warn(MODULE_LABEL,
                    `OverlayItemMaterialiser | Could not delete stale "${collection}":`, err.message
                );
            }
        }

        const label = this._labelFor(packDir);
        const pack = await this._createWorldCompendium(`quartermaster-${packDir}`, label);
        if (!pack) return null;

        const fresh = game.packs.get(collection) ?? pack;
        const folderIdMap = await this._createFolders(fresh, folderDefs);

        const prepared = items.map(raw => {
            const item = foundry.utils.duplicate(raw);
            if (item.folder && folderIdMap.has(item.folder)) {
                item.folder = folderIdMap.get(item.folder);
            } else {
                delete item.folder;
            }
            delete item._id;
            return item;
        });

        const minting = game.ionrift?.library?.minting;
        if (minting?.guardAll) {
            minting.guardAll(prepared, { moduleId: MODULE_ID, mode: "pack" });
        }

        const ItemClass = CONFIG.Item.documentClass;
        const chunkSize = 50;
        for (let i = 0; i < prepared.length; i += chunkSize) {
            const chunk = prepared.slice(i, i + chunkSize);
            await ItemClass.createDocuments(chunk, { pack: fresh.collection });
        }

        await this._assignSidebarFolder(fresh);
        this._enforceOwnership(fresh);

        const newState = this._getState();
        newState[overlayId] = newState[overlayId] ?? { version: overlayVersion, packs: [], packHashes: {} };
        newState[overlayId].version = overlayVersion;
        if (!newState[overlayId].packs.includes(collection)) {
            newState[overlayId].packs.push(collection);
        }
        newState[overlayId].packHashes[packDir] = hashKey;
        await this._setState(newState);

        Logger.info(MODULE_LABEL,
            `OverlayItemMaterialiser | Built "${collection}" — ${prepared.length} items.`
        );

        return { collection, itemCount: prepared.length };
    }

    static async _readOverlayId(sublayer) {
        const overlay = game.ionrift?.library?.overlay;
        const manifest = await overlay.getLocalManifest(MODULE_ID, sublayer);
        return manifest?.overlayId ?? `unknown-${sublayer}`;
    }

    static async _readFolders(sublayer, itemsPath) {
        const overlay = game.ionrift?.library?.overlay;
        const data = await overlay.readOverlayFile(MODULE_ID, sublayer, `${itemsPath}/${FOLDERS_FILE}`);
        if (Array.isArray(data)) return data;
        return [];
    }

    static _labelFor(packDir) {
        const map = {
            gemstones: "Quartermaster: Gemstones",
            treasure: "Quartermaster: Treasure",
            core: "Quartermaster: Core",
            "terrain-treasure": "Quartermaster: Terrain Treasure",
            "terrain-trinkets": "Quartermaster: Terrain Trinkets"
        };
        if (map[packDir]) return map[packDir];
        const titled = packDir.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        return `Quartermaster: ${titled}`;
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

    static async _createFolders(pack, folderDefs) {
        const map = new Map();
        for (const def of folderDefs) {
            try {
                const folder = await Folder.create(
                    { name: def.name, type: "Item", sorting: def.sorting ?? "a", sort: def.sort ?? 0 },
                    { pack: pack.collection }
                );
                const created = Array.isArray(folder) ? folder[0] : folder;
                if (def._id) map.set(def._id, created.id);
                map.set(def.name, created.id);
            } catch (err) {
                Logger.warn(MODULE_LABEL,
                    `OverlayItemMaterialiser | Folder "${def.name}" failed:`, err.message
                );
            }
        }
        return map;
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
