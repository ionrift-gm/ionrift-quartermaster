/**
 * ContentPackLoader
 *
 * Scans ionrift-data/quartermaster/packs/ for extracted content pack ZIPs.
 * Each pack directory contains:
 *   manifest.json  - pack metadata (id, name, version, description)
 *   items.json     - compendium definitions with item data
 *   icons/         - icon image files referenced by items.json
 *
 * Mirrors the SoundPackLoader pattern from Ionrift Resonance.
 */

import { Logger, MODULE_LABEL } from "../_logger.js";

const PACK_ROOT = "ionrift-data/quartermaster/packs";
const MANIFEST_NAME = "manifest.json";
const ITEMS_NAME = "items.json";

export class ContentPackLoader {

    /**
     * Returns the platform-correct FilePicker class from the kernel.
     * Falls back to global FilePicker if the library hasn't initialized.
     * @returns {FilePicker}
     */
    static get _FP() {
        return game.ionrift?.library?.platform?.FP ?? FilePicker;
    }

    /** @type {Map<string, {manifest: Object, itemData: Object}>} */
    static _packs = new Map();

    /** True once init() has completed (success or not). */
    static _loaded = false;

    /**
     * Scans the pack directory, loads manifests and item data, resolves icon paths.
     * Safe to call at boot; swallows errors per-pack so one broken pack
     * does not block the rest.
     */
    static async init() {
        this._packs.clear();

        let packDirs;
        try {
            packDirs = await this._listPackDirectories();
        } catch (err) {
            Logger.log(MODULE_LABEL,
                `ContentPackLoader | Pack root not found or unreadable (${PACK_ROOT}). No packs loaded.`
            );
            this._loaded = true;
            return;
        }

        if (packDirs.length === 0) {
            Logger.log(MODULE_LABEL, "ContentPackLoader | No pack directories found.");
            this._loaded = true;
            return;
        }

        packDirs.sort();

        for (const dir of packDirs) {
            try {
                await this._loadPack(dir);
            } catch (err) {
                Logger.warn(MODULE_LABEL,
                    `ContentPackLoader | Failed to load pack "${dir}":`, err.message
                );
            }
        }

        this._loaded = true;
        Logger.log(MODULE_LABEL,
            `ContentPackLoader | ${this._packs.size} content pack(s) discovered.`
        );
    }

    /**
     * Returns metadata for every loaded pack.
     * @returns {Array<{id: string, name: string, version: string, description: string, author: string, totalItems: number, compendiumCount: number}>}
     */
    static getLoadedPacks() {
        const result = [];
        for (const [, entry] of this._packs) {
            const m = entry.manifest;
            const compendiums = entry.itemData?.compendiums ?? [];
            const totalItems = compendiums.reduce(
                (sum, c) => sum + (c.items?.length ?? 0), 0
            );
            result.push({
                id: m.id,
                name: m.name ?? m.id,
                version: m.version ?? "0.0.0",
                description: m.description ?? "",
                author: m.author ?? "",
                totalItems,
                compendiumCount: compendiums.length
            });
        }
        return result;
    }

    /**
     * Returns the full item data for a specific pack.
     * @param {string} packId
     * @returns {{manifest: Object, itemData: Object}|null}
     */
    static getPackData(packId) {
        return this._packs.get(packId) ?? null;
    }

    /** @returns {boolean} */
    static get loaded() {
        return this._loaded;
    }

    // ───────────────────────────────────────────────────────────────
    //  INTERNALS
    // ───────────────────────────────────────────────────────────────

    /**
     * Lists subdirectories under the pack root using FilePicker.
     * @returns {Promise<string[]>} directory names (not full paths)
     */
    static async _listPackDirectories() {
        const result = await this._FP.browse("data", PACK_ROOT);
        return (result.dirs ?? []).map(d => d.split("/").pop());
    }

    /**
     * Loads a single pack: validates manifest, loads item data, resolves paths.
     * @param {string} dirName
     */
    static async _loadPack(dirName) {
        const basePath = `${PACK_ROOT}/${dirName}`;

        const manifest = await this._fetchJson(`${basePath}/${MANIFEST_NAME}`);
        if (!manifest) throw new Error(`Missing or invalid ${MANIFEST_NAME}`);
        if (!manifest.id || typeof manifest.id !== "string") {
            throw new Error(`Manifest missing required "id" field`);
        }

        // Validate this is a Quartermaster pack
        if (manifest.moduleId && manifest.moduleId !== "ionrift-quartermaster") {
            throw new Error(
                `Pack "${manifest.id}" targets module "${manifest.moduleId}", not ionrift-quartermaster`
            );
        }

        let itemData = {};
        try {
            itemData = await this._fetchJson(`${basePath}/${ITEMS_NAME}`) ?? {};
        } catch {
            Logger.warn(MODULE_LABEL,
                `ContentPackLoader | Pack "${dirName}" has no ${ITEMS_NAME}, treating as empty.`
            );
        }

        // Resolve pack-relative icon paths to full Foundry-accessible paths
        if (itemData.compendiums) {
            for (const compendium of itemData.compendiums) {
                if (!compendium.items) continue;
                for (const item of compendium.items) {
                    item.img = this._resolveIconPath(item.img, basePath);
                }
            }
        }

        this._packs.set(manifest.id, { manifest, itemData });
    }

    /**
     * Resolves a pack-relative icon path to a full Foundry-accessible path.
     * Paths that already start with "modules/", "ionrift-data/", or "http"
     * are treated as absolute and left untouched.
     *
     * @param {string} imgPath
     * @param {string} basePath
     * @returns {string}
     */
    static _resolveIconPath(imgPath, basePath) {
        if (!imgPath || typeof imgPath !== "string") return imgPath;
        if (imgPath.startsWith("modules/") ||
            imgPath.startsWith("ionrift-data/") ||
            imgPath.startsWith("http") ||
            imgPath.startsWith("icons/")) {
            // "icons/" is the Foundry system icons directory - leave absolute
            if (imgPath.startsWith("icons/") && !imgPath.includes("/gems/") && !imgPath.includes("/treasure/")) {
                return imgPath;
            }
        }
        // Absolute paths (already resolved or system icons)
        if (imgPath.startsWith("modules/") ||
            imgPath.startsWith("ionrift-data/") ||
            imgPath.startsWith("http")) {
            return imgPath;
        }
        return `${basePath}/${imgPath}`;
    }

    /**
     * Fetches and parses a JSON file, returning null on failure.
     * @param {string} path
     * @returns {Promise<Object|null>}
     */
    static async _fetchJson(path) {
        try {
            const response = await fetch(path);
            if (!response.ok) return null;
            return await response.json();
        } catch {
            return null;
        }
    }
}
