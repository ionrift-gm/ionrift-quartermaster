/**
 * TerrainDataRegistry
 * Data-driven terrain configuration for Quartermaster.
 * Loads terrain manifests from data/terrains/{id}/terrain-qm.json at boot.
 *
 * This is the QM-scoped registry. It holds module-specific content
 * (flavor phrases, mastercraft materials, terrain-aware item descriptions).
 * For canonical terrain identity (id + label), delegate to the lib spine:
 *   game.ionrift.library.terrains
 *
 * Follows the same manifest-driven pattern as Respite's TerrainRegistry.
 */

import { Logger, MODULE_LABEL } from "../_logger.js";

const MODULE_ID = "ionrift-quartermaster";

export class TerrainDataRegistry {

    /** @type {Map<string, object>} Cached terrain data keyed by terrain id */
    static _terrains = new Map();

    /** @type {boolean} True once init() has completed at least once */
    static _ready = false;

    // ── Initialization ────────────────────────────────────────────────

    /**
     * Initialize the registry from the release manifest.
     * Loads data/terrains/manifest.json, then fetches each terrain's
     * terrain-qm.json in parallel.
     *
     * @param {boolean} [force=false] - Force reload (e.g. after overlay install)
     */
    static async init(force = false) {
        if (this._ready && !force) return;

        // On force reload, clear stale data so removed terrains disappear
        if (force) this._terrains.clear();

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
        this._ready = true;

        const sorted = [...this._terrains.keys()].sort().join(", ");
        Logger.info(MODULE_LABEL,
            `TerrainDataRegistry: Loaded ${this._terrains.size} terrains: ${sorted}`);
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
     * Terrain list for UI dropdowns. Reads the spine only.
     * QM never adds its own terrains — the spine is the sole authority.
     *
     * @returns {{ id: string, label: string }[]}
     */
    static getTerrainList() {
        const libTerrains = game.ionrift?.library?.terrains;
        if (libTerrains) {
            return libTerrains.getAll().map(t => ({ id: t.id, label: t.label }));
        }
        return [];
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
