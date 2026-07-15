import { SignatureLedger } from "./SignatureLedger.js";
import { Logger, MODULE_LABEL } from "../utils/Logger.js";
import { getQuartermasterAdapter } from "../adapters/getAdapter.js";

const MODULE_ID = "ionrift-quartermaster";

const RARITY_ORDER = ["uncommon", "rare", "veryRare", "legendary"];

const RARITY_CEILING = {
    uncommon:  "uncommon",
    rare:      "rare",
    veryRare:  "veryRare",
    legendary: "legendary"
};

/** Rarity → milestone position index (resolved to actual level at runtime). */
const RARITY_BASE_POS = { common: 0, uncommon: 0, rare: 1, veryRare: 3, legendary: 4 };

/**
 * Ephemeral party-shelf item pool for the Cache Generator advisory panel.
 * Mirrors the CurseRegistry.getPool pattern: reads from compendium indexes
 * each time, never persists to the journal. Tier-gated by rarityMax from
 * cache-tables.json.
 */
export class PartyShelfPool {

    /**
     * Return a randomised selection of party-utility items appropriate for
     * the given tier. Items are wondrous equipment (not weapons) drawn from
     * the GM-configured party shelf compendium sources.
     *
     * @param {number} [tier=1]  Party tier 1-4
     * @param {number} [count=3] Max items to return
     * @returns {Promise<Object[]>}
     */
    static async getPool(tier = 1, count = 3) {
        try {
            const rarityMax = await this._rarityMaxForTier(tier);
            const allowed   = this._raritiesUpTo(rarityMax);
            const banSet    = await SignatureLedger.getBanSet();
            const sources   = this._getEnabledSources();

            const candidates = [];
            const seen = new Set();

            for (const packId of sources) {
                const pack = game.packs.get(packId);
                if (!pack || pack.documentName !== "Item") continue;

                const adapter = getQuartermasterAdapter();
                const index = await pack.getIndex({
                    fields: adapter.getCompendiumIndexFields()
                });

                for (const entry of index) {
                    const rawRarity = adapter.getRarityFromEntry(entry);
                    if (!rawRarity || rawRarity === "common") continue;
                    const rarity = this._normaliseRarity(adapter.normalizeRarityForTier(rawRarity));
                    if (!allowed.has(rarity)) continue;
                    if (entry.type !== "equipment") continue;

                    const key = entry.name.toLowerCase();
                    if (banSet.has(key) || seen.has(key)) continue;
                    seen.add(key);

                    const docId = entry._id ?? entry.id ?? "";
                    if (!docId) continue;

                    candidates.push({
                        uuid:               `Compendium.${packId}.Item.${docId}`,
                        name:               entry.name,
                        img:                entry.img || "icons/svg/item-bag.svg",
                        rarity,
                        requiresAttunement: !!entry.system?.attunement,
                        _compendiumId:      docId,
                        sourceCompendium:   packId,
                        _hasCharges:        (entry.system?.uses?.max ?? 0) > 0
                    });
                }
            }

            if (!candidates.length) return this._fallback(tier, count);

            const shuffled = [...candidates].sort(() => Math.random() - 0.5);
            const picked = [];
            const usedNames = new Set();

            for (const item of shuffled) {
                if (picked.length >= count) break;
                if (usedNames.has(item.name.toLowerCase())) continue;
                usedNames.add(item.name.toLowerCase());

                picked.push({
                    uuid:             item.uuid,
                    name:             item.name,
                    img:              item.img,
                    rarity:           item.rarity,
                    level:            this._assignLevel(item),
                    delivered:        false,
                    _compendiumId:    item._compendiumId,
                    sourceCompendium: item.sourceCompendium
                });
            }

            return picked;
        } catch (e) {
            Logger.warn(MODULE_LABEL, "PartyShelfPool.getPool() failed:", e.message);
            return [];
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    static _normaliseRarity(raw) {
        const lower = (raw ?? "").toLowerCase().replace(/\s+/g, "");
        if (lower === "veryrare") return "veryRare";
        return lower;
    }

    static _raritiesUpTo(maxRarity) {
        const idx = RARITY_ORDER.indexOf(maxRarity);
        if (idx < 0) return new Set(["uncommon"]);
        return new Set(RARITY_ORDER.slice(0, idx + 1));
    }

    static async _rarityMaxForTier(tier) {
        try {
            const resp = await fetch(`modules/${MODULE_ID}/data/cache-tables.json`);
            const tables = await resp.json();
            const td = tables.tiers?.[String(tier)];
            if (td?.rarityMax) return this._normaliseRarity(td.rarityMax);
        } catch { /* fall through */ }
        return RARITY_CEILING[tier] ?? "uncommon";
    }

    static _getEnabledSources() {
        try {
            const raw = game.settings.get(MODULE_ID, "partyShelfSources");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length) return parsed;
        } catch { /* fall through */ }
        const adapter = getQuartermasterAdapter();
        const defaults = adapter.getDefaultLootPoolSources();
        return defaults.length ? defaults : ["dnd5e.items"];
    }

    /**
     * Assign a milestone level to an auto-seeded shelf item using the
     * rarity-to-milestone mapping. Items always land at their exact
     * rarity-based milestone. Manually planned items bypass this entirely.
     */
    static _assignLevel(item) {
        const ms = SignatureLedger.MILESTONES;
        const pos = RARITY_BASE_POS[item.rarity] ?? 0;
        const floorIdx = Math.min(pos, ms.length - 1);
        return item.requiresAttunement
            ? ms[Math.min(floorIdx + 1, ms.length - 1)]
            : ms[floorIdx];
    }

    static _fallback(tier, count) {
        const pool = [
            { name: "Bag of Holding",      rarity: "uncommon", img: "icons/containers/bags/pack-leather-tan.webp" },
            { name: "Cloak of Protection",  rarity: "uncommon", img: "icons/equipment/back/cloak-collared-green.webp" },
            { name: "Boots of Speed",       rarity: "rare",     img: "icons/equipment/feet/boots-laced-simple-leather.webp" },
            { name: "Portable Hole",        rarity: "rare",     img: "icons/commodities/cloth/cloth-bolt-black.webp" },
            { name: "Eversmoking Bottle",   rarity: "uncommon", img: "icons/containers/bottles/bottle-corked-labeled-blue.webp" }
        ];

        const maxRarity = RARITY_CEILING[tier] ?? "uncommon";
        const allowed = this._raritiesUpTo(maxRarity);
        const viable = pool.filter(p => allowed.has(p.rarity));
        const shuffled = [...viable].sort(() => Math.random() - 0.5).slice(0, count);

        return shuffled.map(item => ({
            uuid:             null,
            name:             item.name,
            img:              item.img,
            rarity:           item.rarity,
            level:            this._assignLevel({ rarity: item.rarity, requiresAttunement: false }),
            delivered:        false,
            _compendiumId:    "",
            sourceCompendium: ""
        }));
    }
}
