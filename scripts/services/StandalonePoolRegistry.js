import { Logger, MODULE_LABEL } from "../utils/Logger.js";
import { getCurseAdapter } from "./getCurseAdapter.js";
import { CursedItemResolver } from "./CursedItemResolver.js";

const MODULE_ID = "ionrift-quartermaster";

/**
 * World-settings backing store for cursed planned + pool when Cursewright is absent.
 * Mirrors the CurseRegistry methods SignatureLedgerApp calls.
 */
export class StandalonePoolRegistry {

    /**
     * Map a compendium document (or index entry) to a slim pool row.
     * Requires cursedMeta on the document flags.
     */
    static _mapDocRow(doc, packId) {
        const docId = doc?.id ?? doc?._id ?? "";
        if (!docId) return null;
        const meta = doc.flags?.[MODULE_ID]?.cursedMeta;
        if (!meta || typeof meta !== "object") return null;
        // Resolve display name via shared service (bypasses dnd5e's identified:false getter)
        const displayName = CursedItemResolver.resolveDisplayName(doc);
        return {
            uuid:            `Compendium.${packId}.Item.${docId}`,
            name:            displayName,
            img:             doc.img ?? "icons/svg/item-bag.svg",
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
        const packId = getCurseAdapter().worldCollectionId;
        try {
            const pack = game.packs.get(packId);
            if (!pack) return [];

            // getIndex() cannot be used - Foundry V14 applies dnd5e's name
            // getter, so items with identified:false return "Unidentified Consumable".
            // Full documents give us _source.name and reliable flag access.
            const docs = await pack.getDocuments();
            if (!docs.length) return [];

            return docs
                .map(doc => this._mapDocRow(doc, packId))
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
     * Move `uuid` to `newIndex` within its tier column, persisting the new order.
     * Position in the array is the priority weight — top (index 0) = highest.
     * @param {number} tier      1-4
     * @param {string[]} orderedUuids  Full ordered list of UUIDs for that tier (after reorder)
     */
    static async setPriorityOrder(tier, orderedUuids) {
        const pool = await this.getCursedPool();
        const t = Math.max(1, Math.min(4, Number(tier) || 1));

        // Split into this-tier and other-tier entries, preserving other-tier order.
        const others = pool.filter(e => (e.tier ?? 1) !== t);
        const tierEntries = pool.filter(e => (e.tier ?? 1) === t);

        // Re-index this tier according to the new uuid order.
        const byUuid = new Map(tierEntries.map(e => [(e.uuid ?? "").toLowerCase(), e]));
        const reordered = orderedUuids
            .map(u => byUuid.get(u.toLowerCase()))
            .filter(Boolean);

        // Items in the pool but absent from orderedUuids are appended at the end.
        const uuidSet = new Set(orderedUuids.map(u => u.toLowerCase()));
        const extras = tierEntries.filter(e => !uuidSet.has((e.uuid ?? "").toLowerCase()));

        await this.setCursedPool([...others, ...reordered, ...extras]);
    }

    /** Whether a given tier is enabled for advisory draw. */
    static getTierEnabled(tier) {
        const t = Math.max(1, Math.min(4, Number(tier) || 1));
        if (t === 3) return game.settings.get(MODULE_ID, "cursedT3Enabled") ?? true;
        if (t === 4) return game.settings.get(MODULE_ID, "cursedT4Enabled") ?? true;
        return true; // T1 and T2 always enabled
    }

    static async setTierEnabled(tier, enabled) {
        const t = Math.max(1, Math.min(4, Number(tier) || 1));
        if (t === 3) await game.settings.set(MODULE_ID, "cursedT3Enabled", !!enabled);
        else if (t === 4) await game.settings.set(MODULE_ID, "cursedT4Enabled", !!enabled);
    }

    /**
     * Priority-ordered sample from the settings-backed cursed pool (mirrors CurseRegistry.getPool).
     * Returns items in their stored array order (= priority order) within each enabled tier.
     * No shuffle — position IS the weight signal.
     * @param {number} [tier=1]    Tier cap (draws from tiers <= this)
     * @param {number} [count=3]   Max items to return
     * @returns {Promise<Object[]>}
     */
    static async getPool(tier = 1, count = 3) {
        await this.ensureDefaultCursedPoolIfEmpty();
        const pool = await this.getCursedPool();
        const t = Math.max(1, Math.min(4, Number(tier) || 1));
        const cap = Math.max(1, Math.min(12, Number(count) || 3));

        // Filter: within tier cap AND tier is enabled
        const eligible = pool.filter(r => {
            const itemTier = r.tier ?? 1;
            return itemTier <= t && this.getTierEnabled(itemTier);
        });

        // Return in priority order (array position), up to cap — no shuffle
        return eligible.slice(0, cap);
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
