/**
 * TerrainDataRegistry
 * Data-driven terrain configuration for Quartermaster.
 *
 * Under strict sovereignty this is the sole source of truth for QM's terrain
 * picker. The module ships only its base set; every other terrain is
 * delivered by an overlay. At init the registry loads
 * `data/terrains/{id}/terrain-qm.json` for each id in the module's release
 * manifest, then scans every installed and active overlay for matching files
 * under `data/terrains/<id>/terrain-qm.json` and merges them in. Installing
 * a new overlay introduces its terrains without any module patch; the
 * library kernel base from `game.ionrift.library.terrains.getBase()` is the
 * only thing read from outside the module, and only for canonical id/label
 * alignment in the picker dropdown.
 */

import { Logger, MODULE_LABEL } from "../_logger.js";
import { normalizeTerrainCategory } from "../../../ionrift-library/scripts/services/TerrainRegistry.js";

const MODULE_ID = "ionrift-quartermaster";

export class TerrainDataRegistry {

    /** @type {Map<string, object>} Cached terrain data keyed by terrain id */
    static _terrains = new Map();

    /** @type {boolean} True once init() has completed at least once */
    static _ready = false;

    // ── Initialization ────────────────────────────────────────────────

    /**
     * Initialize the registry. Loads the module's released base terrains, then
     * scans every installed and active overlay for additional terrain folders
     * and merges them in. The module ships data only for the kernel base set;
     * everything else is delivered plug-and-play by the active overlays.
     *
     * @param {boolean} [force=false] - Force reload (e.g. after overlay install)
     */
    static async init(force = false) {
        if (this._ready && !force) return;

        if (force) this._terrains.clear();

        await this._loadModuleBase();
        await this._loadFromOverlays();

        this._ready = true;

        const sorted = [...this._terrains.keys()].sort().join(", ");
        Logger.info(MODULE_LABEL,
            `TerrainDataRegistry: Loaded ${this._terrains.size} terrains: ${sorted}`);
    }

    /**
     * Load the module-shipped terrains listed in data/terrains/manifest.json.
     * @private
     */
    static async _loadModuleBase() {
        let released = [];
        try {
            const resp = await fetch(`modules/${MODULE_ID}/data/terrains/manifest.json`);
            if (resp.ok) {
                const manifest = await resp.json();
                released = manifest.released ?? [];
            }
        } catch (e) {
            Logger.warn(MODULE_LABEL, "TerrainDataRegistry: Failed to load manifest.json:", e);
        }

        const loadPromises = released.map(async (terrainId) => {
            try {
                const resp = await fetch(
                    `modules/${MODULE_ID}/data/terrains/${terrainId}/terrain-qm.json`
                );
                if (!resp.ok) {
                    Logger.warn(MODULE_LABEL,
                        `TerrainDataRegistry: No terrain-qm.json for "${terrainId}"`);
                    return;
                }
                const data = await resp.json();
                data.id = data.id ?? terrainId;
                this._terrains.set(terrainId, data);
            } catch (e) {
                Logger.warn(MODULE_LABEL,
                    `TerrainDataRegistry: Failed to load ${terrainId}/terrain-qm.json:`, e);
            }
        });

        await Promise.all(loadPromises);
    }

    /**
     * Scan every installed overlay for `data/terrains/<id>/terrain-qm.json`
     * files and merge them into the local registry. An overlay that ships a
     * terrain id matching a module-shipped id wins. Only active overlays are
     * scanned.
     * @private
     */
    static async _loadFromOverlays() {
        const overlay = game.ionrift?.library?.overlay;
        if (!overlay) return;

        let sublayers = [];
        try {
            sublayers = await overlay.listInstalledSublayers(MODULE_ID);
        } catch (e) {
            Logger.warn(MODULE_LABEL, "TerrainDataRegistry: overlay sublayer scan failed:", e);
            return;
        }

        for (const sublayer of sublayers) {
            try {
                const manifest = await overlay.getLocalManifest(MODULE_ID, sublayer);
                if (!manifest?.overlayId) continue;

                const active = await overlay.isOverlayActive(
                    manifest.overlayId, MODULE_ID, sublayer
                );
                if (!active) continue;

                const listing = await overlay.listOverlayDir(
                    MODULE_ID, sublayer, "data/terrains"
                );
                const terrainDirs = listing?.dirs ?? [];

                for (const terrainId of terrainDirs) {
                    try {
                        const data = await overlay.readOverlayFile(
                            MODULE_ID, sublayer, `data/terrains/${terrainId}/terrain-qm.json`
                        );
                        if (!data) continue;
                        data.id = data.id ?? terrainId;
                        this._terrains.set(data.id, data);
                    } catch (e) {
                        Logger.warn(MODULE_LABEL,
                            `TerrainDataRegistry: Failed to read overlay terrain "${terrainId}" from ${sublayer}:`, e);
                    }
                }
            } catch (e) {
                Logger.warn(MODULE_LABEL,
                    `TerrainDataRegistry: Failed to scan overlay sublayer "${sublayer}":`, e);
            }
        }
    }

    // ── Accessors ─────────────────────────────────────────────────────

    /**
     * Get a single terrain's QM data by id.
     * @param {string} id - Terrain id (e.g. "dungeon", "ruins")
     * @returns {object|undefined}
     */
    static get(id) {
        return this._terrains.get(id);
    }

    /**
     * Get all loaded terrain data objects, sorted alphabetically by id.
     * @returns {object[]}
     */
    static getAll() {
        return [...this._terrains.values()].sort((a, b) =>
            (a.id ?? "").localeCompare(b.id ?? "")
        );
    }

    /**
     * Terrain list for UI dropdowns. Built locally from the kernel base plus
     * any QM-shipped terrains that have been loaded. The library spine is
     * never consulted at runtime under strict sovereignty.
     *
     * @returns {{ id: string, label: string, category: string }[]}
     */
    static getTerrainList() {
        const baseTerrains = game.ionrift?.library?.terrains?.getBase?.() ?? [];
        const out = [];
        const seen = new Set();

        for (const t of baseTerrains) {
            const local = this._terrains.get(t.id);
            out.push({
                id: t.id,
                label: local?.label ?? t.label,
                category: normalizeTerrainCategory(local?.category ?? t.category) ?? "wilderness"
            });
            seen.add(t.id);
        }

        for (const local of this._terrains.values()) {
            if (seen.has(local.id)) continue;
            out.push({
                id: local.id,
                label: local.label ?? this._deriveLabel(local.id),
                category: normalizeTerrainCategory(local.category) ?? "wilderness"
            });
        }

        return out;
    }

    /**
     * Derive a Title-Case label from an id when one was not declared.
     * Internal use only.
     * @param {string} id
     */
    static _deriveLabel(id) {
        return id.split(/[-_\s]+/)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ");
    }

    /**
     * Terrain dropdown groups aligned with Respite (Built, Safe Haven, Wilderness).
     * @param {string} [selectedId]
     * @returns {{ group: string, options: { id: string, label: string, selected?: boolean }[] }[]}
     */
    static getTerrainOptionGroups(selectedId) {
        const list = this.getTerrainList();
        const built = [];
        const safeHaven = [];
        const wilderness = [];
        for (const t of list) {
            const opt = { ...t, selected: t.id === selectedId };
            if (t.category === "built") built.push(opt);
            else if (t.category === "safe-haven") safeHaven.push(opt);
            else wilderness.push(opt);
        }
        const groups = [];
        if (built.length) groups.push({ group: "Built", options: built });
        if (safeHaven.length) groups.push({ group: "Safe Haven", options: safeHaven });
        if (wilderness.length) groups.push({ group: "Wilderness", options: wilderness });
        return groups;
    }

    /**
     * Discovery flavor phrases for a terrain (CacheGenerator consumption).
     * @param {string} id
     * @returns {string[]}
     */
    static getFlavorPhrases(id) {
        return this.get(id)?.flavorPhrases ?? [];
    }

    /**
     * Preferred mastercraft material keywords for a terrain.
     * @param {string} id
     * @returns {string[]}
     */
    static getMaterials(id) {
        return this.get(id)?.materials ?? ["Mastercraft"];
    }

    /**
     * Terrain-aware item descriptions for mundane masking (Layer 2).
     * Categories match ItemMaskingHelper._categorise() output:
     * sword, axe, ranged, bludgeon, dagger, polearm, shield,
     * heavy_armor, light_armor, ring, cloak, boots, gloves, generic, etc.
     *
     * Returns an empty array when no terrain-specific descriptions exist
     * for this category, signaling the caller to fall back to generic pools.
     *
     * @param {string} id - Terrain id
     * @param {string} category - Item category key
     * @returns {string[]}
     */
    static getItemDescriptions(id, category) {
        const descs = this.get(id)?.itemDescriptions;
        if (!descs) return [];
        return descs[category] ?? descs.generic ?? [];
    }

    // ── Runtime Registration ──────────────────────────────────────────

    /**
     * Register terrain data at runtime. Used by overlay packs and
     * companion modules to inject terrain content after boot.
     *
     * Behavior is additive:
     *   - flavorPhrases: appended to existing set (deduped)
     *   - materials: replaced entirely (overlay wins)
     *   - itemDescriptions: merged per-category (appended)
     *
     * If the terrain id is new, the data is stored directly.
     *
     * @param {object} data - Terrain data object (must have `id`)
     */
    static register(data) {
        if (!data?.id) {
            Logger.warn(MODULE_LABEL,
                "TerrainDataRegistry.register: data must have an id.");
            return;
        }

        const existing = this._terrains.get(data.id);
        if (!existing) {
            this._terrains.set(data.id, { ...data });
            return;
        }

        // Additive merge: phrases append, materials replace, descriptions merge
        if (data.flavorPhrases?.length) {
            const merged = new Set([
                ...(existing.flavorPhrases ?? []),
                ...data.flavorPhrases
            ]);
            existing.flavorPhrases = [...merged];
        }

        if (data.materials?.length) {
            existing.materials = [...data.materials];
        }

        if (data.itemDescriptions) {
            existing.itemDescriptions = existing.itemDescriptions ?? {};
            for (const [cat, descs] of Object.entries(data.itemDescriptions)) {
                if (!Array.isArray(descs)) continue;
                const merged = new Set([
                    ...(existing.itemDescriptions[cat] ?? []),
                    ...descs
                ]);
                existing.itemDescriptions[cat] = [...merged];
            }
        }
    }

    /**
     * Whether the registry has completed loading.
     * @returns {boolean}
     */
    static get isReady() {
        return this._ready;
    }
}
