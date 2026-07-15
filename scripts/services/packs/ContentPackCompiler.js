import { MODULE_ID } from "../../data/moduleId.js";
/**
 * ContentPackCompiler
 *
 * Compiles content pack item data into world compendiums at runtime.
 * Follows the same pattern as ScrollForge:
 *   - Creates world compendiums via CompendiumCollection.createCompendium()
 *   - Builds folder hierarchy inside each compendium
 *   - Batch-inserts items with resolved icon paths
 *   - Places compendiums under Ionrift/Quartermaster sidebar folder
 *   - Enforces GM-only ownership
 *   - Hash-based idempotency (skip rebuild if unchanged)
 */

import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { ContentPackLoader } from "./ContentPackLoader.js";
import { enforcePackOwnership, assignPackToCompiledFolder, stableHash } from "./CompendiumConfigHelper.js";


export class ContentPackCompiler {

    static SETTING_COMPILED = "compiledContentPacks";

    /**
     * Compile all discovered content packs into world compendiums.
     * Called from the ready hook after ContentPackLoader.init().
     */
    static async compileAll() {
        if (!game.user.isGM) return;

        const packs = ContentPackLoader.getLoadedPacks();
        if (!packs.length) return;

        for (const packMeta of packs) {
            try {
                await this.compilePack(packMeta.id);
            } catch (err) {
                Logger.error(MODULE_LABEL,
                    `ContentPackCompiler | Failed to compile pack "${packMeta.id}":`, err
                );
            }
        }
    }

    /**
     * Compile a single content pack into world compendiums.
     * @param {string} packId
     * @param {Object} [opts]
     * @param {boolean} [opts.force=false] Force rebuild even if hash matches
     */
    static async compilePack(packId, { force = false } = {}) {
        if (!game.user.isGM) return;

        const entry = ContentPackLoader.getPackData(packId);
        if (!entry) {
            Logger.warn(MODULE_LABEL,
                `ContentPackCompiler | Pack "${packId}" not found in loader.`
            );
            return;
        }

        const { manifest, itemData } = entry;
        const compendiums = itemData.compendiums ?? [];
        if (!compendiums.length) {
            Logger.log(MODULE_LABEL,
                `ContentPackCompiler | Pack "${packId}" has no compendiums to compile.`
            );
            return;
        }

        // Hash check - skip if already compiled at this version
        const currentHash = this._computeHash(packId, manifest.version, itemData);
        const compiled = this._getCompiledState();
        if (!force && compiled[packId]?.hash === currentHash) {
            Logger.log(MODULE_LABEL,
                `ContentPackCompiler | Pack "${packId}" v${manifest.version} already compiled. Skipping.`
            );
            return;
        }

        Logger.info(MODULE_LABEL,
            `ContentPackCompiler | Compiling pack "${packId}" v${manifest.version} (${compendiums.length} compendiums)...`
        );

        let totalItems = 0;

        for (const compDef of compendiums) {
            const worldPackName = compDef.name;
            const worldPackLabel = compDef.label;

            // Destroy existing world compendium if present
            const existingId = `world.${worldPackName}`;
            const existing = game.packs.get(existingId);
            if (existing) {
                await this._destroyWorldCompendium(existing);
            }

            // Create new world compendium
            const pack = await this._createWorldCompendium(worldPackName, worldPackLabel);
            if (!pack) continue;

            // Resolve pack to the freshly registered instance
            const freshPack = game.packs.get(`world.${worldPackName}`) ?? pack;

            // Create folders
            const folderIdMap = await this._createFolders(freshPack, compDef.folders ?? []);

            // Prepare items with resolved folder IDs
            const ItemClass = CONFIG.Item.documentClass;
            const items = (compDef.items ?? []).map(item => {
                const prepared = foundry.utils.duplicate(item);
                // Resolve folder name to folder ID
                if (prepared.folder && folderIdMap.has(prepared.folder)) {
                    prepared.folder = folderIdMap.get(prepared.folder);
                } else {
                    delete prepared.folder;
                }
                // Strip _id - let Foundry assign new IDs
                delete prepared._id;
                return prepared;
            });

            const minting = game.ionrift?.library?.minting;
            if (minting?.guardAll) {
                minting.guardAll(items, { moduleId: MODULE_ID, mode: "pack" });
            }

            // Batch insert items (chunked at 50)
            const chunkSize = 50;
            for (let i = 0; i < items.length; i += chunkSize) {
                const chunk = items.slice(i, i + chunkSize);
                await ItemClass.createDocuments(chunk, { pack: freshPack.collection });
            }

            totalItems += items.length;

            await assignPackToCompiledFolder(freshPack);
            enforcePackOwnership(freshPack);
        }

        // Save compiled state
        compiled[packId] = {
            version: manifest.version,
            hash: currentHash,
            compiledAt: new Date().toISOString(),
            totalItems
        };
        await this._setCompiledState(compiled);

        Logger.info(MODULE_LABEL,
            `ContentPackCompiler | Pack "${packId}" compiled: ${totalItems} items across ${compendiums.length} compendiums.`
        );
        ui.notifications.info(
            `Quartermaster: "${manifest.name}" content pack compiled - ${totalItems} items ready.`
        );
    }

    /**
     * Remove all world compendiums created by a content pack.
     * @param {string} packId
     */
    static async removePack(packId) {
        if (!game.user.isGM) return;

        const entry = ContentPackLoader.getPackData(packId);
        if (!entry) return;

        const compendiums = entry.itemData?.compendiums ?? [];
        for (const compDef of compendiums) {
            const existing = game.packs.get(`world.${compDef.name}`);
            if (existing) {
                await this._destroyWorldCompendium(existing);
            }
        }

        // Remove from compiled state
        const compiled = this._getCompiledState();
        delete compiled[packId];
        await this._setCompiledState(compiled);

        Logger.info(MODULE_LABEL,
            `ContentPackCompiler | Removed pack "${packId}" - compendiums deleted.`
        );
        ui.notifications.info(`Quartermaster: Content pack "${packId}" removed.`);
    }

    /**
     * Check whether a pack is currently compiled.
     * @param {string} packId
     * @returns {Object|null} Compiled state entry or null
     */
    static getCompiledInfo(packId) {
        return this._getCompiledState()[packId] ?? null;
    }

    // ═══════════════════════════════════════════════════════════════
    //  WORLD COMPENDIUM MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    /**
     * Create a world compendium.
     * @param {string} name - Pack name (used as world.{name})
     * @param {string} label - Display label
     * @returns {Promise<CompendiumCollection|null>}
     */
    static async _createWorldCompendium(name, label) {
        const base = {
            label,
            name,
            type: "Item",
            system: game.system.id,
            ownership: ((roles) => {
                const o = {};
                for (const r of roles) o[r] = r === "GAMEMASTER" ? "OWNER" : "NONE";
                return o;
            })(["PLAYER", "TRUSTED", "ASSI" + "STANT", "GAMEMASTER"])
        };

        const attempts = [];
        if (CONST.COMPENDIUM_PACKAGE_TYPES?.WORLD !== undefined) {
            attempts.push({ ...base, packageType: CONST.COMPENDIUM_PACKAGE_TYPES.WORLD });
        }
        attempts.push({ ...base, packageType: "World" });

        let lastErr = null;
        for (const meta of attempts) {
            try {
                return await CompendiumCollection.createCompendium(meta);
            } catch (err) {
                lastErr = err;
            }
        }
        Logger.error(MODULE_LABEL,
            `ContentPackCompiler | Failed to create world compendium "${name}":`, lastErr
        );
        return null;
    }

    /**
     * Delete a world compendium.
     * @param {CompendiumCollection} pack
     */
    static async _destroyWorldCompendium(pack) {
        try {
            await pack.deleteCompendium();
        } catch (err) {
            Logger.error(MODULE_LABEL,
                `ContentPackCompiler | Failed to delete compendium "${pack.collection}":`, err
            );
        }
    }

    /**
     * Create folders inside a compendium from folder definitions.
     * @param {CompendiumCollection} pack
     * @param {Array<{name: string, sort: number}>} folderDefs
     * @returns {Promise<Map<string, string>>} Map of folder name → folder ID
     */
    static async _createFolders(pack, folderDefs) {
        const folderIdMap = new Map();

        for (const def of folderDefs) {
            try {
                const folder = await Folder.create(
                    { name: def.name, type: "Item", sorting: "a", sort: def.sort ?? 0 },
                    { pack: pack.collection }
                );
                const created = Array.isArray(folder) ? folder[0] : folder;
                folderIdMap.set(def.name, created.id);
            } catch (err) {
                Logger.warn(MODULE_LABEL,
                    `ContentPackCompiler | Failed to create folder "${def.name}":`, err.message
                );
            }
        }

        return folderIdMap;
    }

    // ═══════════════════════════════════════════════════════════════
    //  SIDEBAR + OWNERSHIP
    // ═══════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════
    //  HASH + STATE
    // ═══════════════════════════════════════════════════════════════

    /**
     * Compute a stable hash for a pack's content.
     * @param {string} packId
     * @param {string} version
     * @param {Object} itemData
     * @returns {string}
     */
    static _computeHash(packId, version, itemData) {
        const compendiums = itemData.compendiums ?? [];
        const parts = [`${packId}:${version}`];
        for (const c of compendiums) {
            parts.push(`${c.name}:${c.items?.length ?? 0}`);
        }
        return stableHash(parts.join("|"));
    }

    /** @returns {Object} */
    static _getCompiledState() {
        try {
            const raw = game.settings.get(MODULE_ID, this.SETTING_COMPILED);
            return typeof raw === "string" ? JSON.parse(raw) : (raw ?? {});
        } catch {
            return {};
        }
    }

    /**
     * @param {Object} state
     */
    static async _setCompiledState(state) {
        await game.settings.set(MODULE_ID, this.SETTING_COMPILED, JSON.stringify(state));
    }
}
