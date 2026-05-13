import { Logger, MODULE_LABEL } from "../_logger.js";
import { SrdCurseAdapter } from "./SrdCurseAdapter.js";

const MODULE_ID = "ionrift-quartermaster";

/**
 * World-settings backing store for cursed planned + pool when Cursewright is absent.
 * Mirrors the CurseRegistry methods SignatureLedgerApp calls.
 */
export class StandalonePoolRegistry {

    static _indexDocId(entry) {
        return entry?._id ?? entry?.id ?? "";
    }

    /**
     * Map a compendium index entry to a slim pool row. Requires cursedMeta on the index.
     */
    static _mapIndexRow(entry, packId) {
        const docId = this._indexDocId(entry);
        if (!docId) return null;
        const meta = entry.flags?.[MODULE_ID]?.cursedMeta;
        if (!meta || typeof meta !== "object") return null;
        return {
            uuid:            `Compendium.${packId}.Item.${docId}`,
            name:            entry.name,
            img:             entry.img ?? "icons/svg/item-bag.svg",
            curseType:       meta.curseType ?? "unknown",
            decoyAppearance: meta.decoyAppearance ?? "",
            trueNature:      meta.trueNature ?? "",
            tier:            meta.tier ?? 1
        };
    }

    static async getCursedPlanned() {
        try {
            return JSON.parse(game.settings.get(MODULE_ID, "cursedPlanned") ?? "[]");
        } catch {
            return [];
        }
    }

    static async setCursedPlanned(value) {
        await game.settings.set(MODULE_ID, "cursedPlanned", JSON.stringify(value ?? []));
    }

    static async getCursedPool() {
        try {
            return JSON.parse(game.settings.get(MODULE_ID, "cursedPool") ?? "[]");
        } catch {
            return [];
        }
    }

    static async setCursedPool(value) {
        await game.settings.set(MODULE_ID, "cursedPool", JSON.stringify(value ?? []));
    }

    /**
     * Default rows from the SRD cursed world compendium (index only, cursedMeta required).
     * @returns {Promise<Object[]>}
     */
    static async getDefaultPoolPayload() {
        const packId = SrdCurseAdapter.worldCollectionId;
        try {
            const pack = game.packs.get(packId);
            if (!pack) return [];

            const index = await pack.getIndex({ fields: ["name", "img", "flags"] });
            if (!index.length) return [];

            return index
                .map(e => this._mapIndexRow(e, packId))
                .filter(Boolean);
        } catch (e) {
            Logger.warn(MODULE_LABEL, "StandalonePoolRegistry.getDefaultPoolPayload:", e.message);
            return [];
        }
    }

    static async getCatalogForSeeding(excludeLower = new Set()) {
        const rows = await this.getDefaultPoolPayload();
        const filtered = rows.filter(r => !excludeLower.has((r.uuid || "").toLowerCase()));
        return filtered.sort(() => Math.random() - 0.5);
    }

    static async ensureDefaultCursedPoolIfEmpty() {
        const pool = await this.getCursedPool();
        if (pool.length > 0) return false;
        const defaults = await this.getDefaultPoolPayload();
        if (!defaults.length) return false;
        await this.setCursedPool(defaults);
        Logger.info(MODULE_LABEL, `StandalonePoolRegistry: seeded pool with ${defaults.length} items.`);
        return true;
    }

    /**
     * Advisory sample from the settings-backed cursed pool (mirrors CurseRegistry.getPool).
     * @param {number} [tier=1]
     * @param {number} [count=3]
     * @returns {Promise<Object[]>}
     */
    static async getPool(tier = 1, count = 3) {
        await this.ensureDefaultCursedPoolIfEmpty();
        const pool = await this.getCursedPool();
        const t = Math.max(1, Math.min(4, Number(tier) || 1));
        const cap = Math.max(1, Math.min(12, Number(count) || 3));
        const eligible = pool.filter(r => (r.tier ?? 1) <= t);
        if (!eligible.length) return [];
        const shuffled = [...eligible].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, cap);
    }
}

/**
 * Returns the active cursed pool registry.
 * Prefers game.ionrift.cursewright.registry (Cursewright installed),
 * falls back to StandalonePoolRegistry for standalone operation.
 */
export function getActiveCursedRegistry() {
    return game.ionrift?.cursewright?.registry ?? StandalonePoolRegistry;
}
