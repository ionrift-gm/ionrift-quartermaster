import { MODULE_ID } from "../../data/moduleId.js";
/**
 * SrdCurseAdapter: seeds the Quartermaster cursed pool with the 12 canonical
 * SRD cursed items. Real names, minimal metadata, no Ionrift IP.
 *
 * Structural pattern mirrors CurseForge.js in Cursewright, stripped of all
 * recipe lore, lure names, escalation, and Ionrift-branded content.
 *
 * Writes to: world.ionrift-srd-cursed (GM-only world compendium)
 * Hash-gated: only recompiles when the source packs change.
 * Guards: GM-only, dnd5e only.
 */

import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import {
    SRD_CURSE_MANIFEST,
    SRD_CURSE_ITEM_FALLBACKS as SRD_ITEM_FALLBACKS
} from "./SrdCurseCatalog.js";
import { enforcePackOwnership, assignPackToCompiledFolder, clearPackAndResetMeta, stableHash } from "../packs/CompendiumConfigHelper.js";
import { QM_FEATURES } from "../../data/QMFeatures.js";


// ── SrdCurseAdapter ─────────────────────────────────────────────────────

export class SrdCurseAdapter {
    static WORLD_PACK_NAME = "ionrift-srd-cursed";
    static PACK_LABEL      = "Quartermaster: SRD Cursed Items";
    static SETTING_HASH = "srdCurseHash";
    static SETTING_META = "srdCurseMeta";
    static _stableHash = stableHash;

    static get worldCollectionId() {
        return `world.${this.WORLD_PACK_NAME}`;
    }

    /**
     * Discover SRD item packs, match the manifest, and write results into
     * a GM-only world compendium. Hash-gated to avoid recompiling every load.
     *
     * @param {boolean} [forceRecompile=false] - Bypass hash gate (used when GM
     *   explicitly clicks Rebuild Pool, so they always get a fresh compile).
     */
    static async compile({ forceRecompile = false } = {}) {
        if (!game.user.isGM) return;
        if (!game.ionrift?.quartermaster?.adapter?.supports(QM_FEATURES.SRD_CURSES)) return;

        const itemPacks = this._discoverItemPacks();
        if (!itemPacks.length) {
            Logger.warn(MODULE_LABEL, "SrdCurseAdapter: no dnd5e item compendiums found.");
            return;
        }

        const sourceHash = await this._computeSourceHash(itemPacks);
        const lastHash   = game.settings.get(MODULE_ID, this.SETTING_HASH);
        if (!forceRecompile && sourceHash === lastHash) return;

        // Load all documents from discovered packs
        const allItems = [];
        for (const pack of itemPacks) {
            try {
                const docs = await pack.getDocuments();
                allItems.push(...docs);
            } catch (err) {
                Logger.warn(MODULE_LABEL, `SrdCurseAdapter: could not read "${pack.collection}": ${err.message}`);
            }
        }

        // Build name → item map (first occurrence wins)
        const itemsByName = new Map();
        for (const doc of allItems) {
            const key = (doc.name || "").trim().toLowerCase();
            if (key && !itemsByName.has(key)) itemsByName.set(key, doc);
        }

        // Match manifest entries against discovered items
        const pendingItems = [];
        let matchCount = 0;
        let missCount  = 0;

        for (const entry of SRD_CURSE_MANIFEST) {
            const key        = entry.match.trim().toLowerCase();
            const sourceItem = itemsByName.get(key);
            if (!sourceItem) {
                Logger.warn(MODULE_LABEL, `SrdCurseAdapter: "${entry.match}" not found in dnd5e packs. Skipping.`);
                missCount++;
                continue;
            }

            const data = this._stampItem(sourceItem, entry);
            if (data) {
                pendingItems.push(data);
                matchCount++;
            }
        }

        if (!pendingItems.length) {
            Logger.warn(MODULE_LABEL, "SrdCurseAdapter: no manifest entries matched. Nothing to compile.");
            return;
        }

        // Get or create the world compendium, then reconcile contents.
        let pack = game.packs.get(this.worldCollectionId);
        if (!pack) {
            pack = await this._createWorldPack();
            if (!pack) return;
            pack = game.packs.get(this.worldCollectionId) ?? pack;
        }

        try {
            await this._reconcilePack(pack, pendingItems);
        } catch (err) {
            Logger.error(MODULE_LABEL, "SrdCurseAdapter: reconcile failed:", err);
            ui.notifications.error("Quartermaster: SRD cursed item compile failed. Check the console.");
            return;
        }

        await game.settings.set(MODULE_ID, this.SETTING_HASH, sourceHash);
        // Persist rich metadata so the Forge UI can show "N items - compiled X ago".
        await this._writeMeta({
            compiledAt:  new Date().toISOString(),
            itemCount:   matchCount,
            sourceCount: itemPacks.length,
        });
        enforcePackOwnership(pack);
        await assignPackToCompiledFolder(pack);

        const skipNote = missCount > 0 ? ` (${missCount} item${missCount !== 1 ? "s" : ""} not found in your dnd5e packs)` : "";
        ui.notifications.info(
            `Quartermaster: compiled ${matchCount} SRD cursed items${skipNote}.`
        );
        Logger.info(MODULE_LABEL, `SrdCurseAdapter: ${matchCount} compiled, ${missCount} missed.`);
    }

    /**
     * Patch price and weight on a plain item data object when the compendium
     * entry carries zero/absent values. Only overwrites if the current value
     * is 0 or missing. Never downgrades a valid compendium value.
     *
     * @param {object} data       Plain item data (mutated in place).
     * @param {string} entryName  Manifest match name (e.g. "Berserker Axe").
     */
    static _applyFallbacks(data, entryName) {
        const fallback = SRD_ITEM_FALLBACKS[entryName.trim().toLowerCase()];
        if (!fallback) return;
        const system = data.system ??= {};
        // Weight: handles both object { value, units } and legacy number forms
        const w = system.weight;
        const currentWeight = (w !== null && typeof w === "object") ? (w.value ?? 0) : (w ?? 0);
        if (currentWeight === 0 && fallback.weight > 0) {
            if (w !== null && typeof w === "object") {
                w.value = fallback.weight;
            } else {
                system.weight = { value: fallback.weight, units: "lb" };
            }
        }
        // Price: only patch if current value is 0 (legacy entry)
        const p = system.price ?? {};
        if ((p.value ?? 0) === 0 && fallback.price > 0) {
            system.price = {
                value:        fallback.price,
                denomination: fallback.denomination ?? "gp",
            };
        }
    }

    /**
     * Clone a source item and stamp minimal cursedMeta.
     * No lure names, no escalation, no Ionrift prose. SRD only.
     *
     * @param {Item} sourceItem
     * @param {{ match: string, tier: number, curseType: string }} entry
     * @returns {object} Plain item data for createDocuments
     */
    static _stampItem(sourceItem, entry) {
        const data   = sourceItem.toObject();
        const system = data.system ??= {};
        // Apply price/weight fallbacks before any further mutation
        this._applyFallbacks(data, entry.match);

        // All SRD items are identified=true so the GM pool card renders the
        // real item name and icon. This is a GM-only compendium; hiding the
        // identity here serves no purpose and breaks pool card rendering.
        //
        // For entries with a masking blob (e.g. Potion of Poison disguised as
        // a Potion of Healing), the latentMagic flag records the swap target so
        // QM's distribution/identification flow can apply it at hand-off time.
        // We do NOT pre-overwrite img/description or set identified=false here.
        system.identified = true;

        if (entry.masking) {
            // Store the masked presentation for QM to use at distribution time.
            data.flags                                      ??= {};
            data.flags["ionrift-quartermaster"]             ??= {};
            data.flags["ionrift-quartermaster"].latentMagic = {
                originalName:        entry.masking.originalName,
                originalRarity:      entry.masking.originalRarity ?? "common",
                magicalBonus:        "",
                attunement:          "",
                properties:          ["mgc"],
                originalDescription: entry.masking.description,
                originalImg:         entry.masking.img,
                originalPrice:       { value: system.price?.value ?? 0, denomination: system.price?.denomination ?? "gp" }
            };
        }

        // Minimal cursedMeta: tier + curseType only.
        // decoyAppearance and trueNature are intentionally empty, no Ionrift IP.
        const cursedMeta = {
            tier:             entry.tier,
            curseType:        entry.curseType,
            category:         entry.curseType,
            tags:             [entry.curseType, `tier-${entry.tier}`],
            decoyAppearance:  "",
            trueNature:       ""
        };

        data.flags                                  ??= {};
        data.flags["ionrift-quartermaster"]         ??= {};
        data.flags["ionrift-quartermaster"].cursedMeta  = cursedMeta;
        data.flags["ionrift-quartermaster"].mintBatch   = `srd-curse-${entry.match.toLowerCase().replace(/\s+/g, "-")}`;

        return data;
    }

    // ── Pack Discovery ───────────────────────────────────────────────────

    static _discoverItemPacks() {
        const packs    = [];
        const ownId    = this.worldCollectionId;

        // Prefer the 2024 equipment pack, then the legacy items pack
        const prefer24 = game.packs.get("dnd5e.equipment24");
        if (prefer24 && prefer24.documentName === "Item") packs.push(prefer24);

        const legacy = game.packs.get("dnd5e.items");
        if (legacy && legacy.documentName === "Item") packs.push(legacy);

        // Pick up any other dnd5e item packs
        for (const pack of game.packs) {
            if (pack.documentName !== "Item") continue;
            if (pack.collection === ownId) continue;
            if (packs.includes(pack)) continue;
            const pkg = pack.metadata?.packageName ?? pack.metadata?.package ?? "";
            if (pkg === "dnd5e") packs.push(pack);
        }

        return packs;
    }

    // ── Hashing ──────────────────────────────────────────────────────────

    static async _computeSourceHash(itemPacks) {
        const parts = [`manifest:${SRD_CURSE_MANIFEST.length}`];
        for (const p of itemPacks.sort((a, b) => a.collection.localeCompare(b.collection))) {
            try {
                const index = await p.getIndex();
                parts.push(`${p.collection}:${index.size ?? index.length ?? 0}`);
            } catch {
                parts.push(`${p.collection}:err`);
            }
        }
        return stableHash(parts.join("|"));
    }

    // ── World Pack Management ─────────────────────────────────────────────

    /**
     * Reconcile the world pack's contents with the pending items list.
     * Instead of clearing and re-inserting (which fails on phantom entries),
     * this reads what's already in the pack, updates existing items in-place,
     * creates missing ones, and removes items no longer in the manifest.
     *
     * @param {CompendiumCollection} pack
     * @param {object[]} pendingItems  Plain item data from _stampItem
     */
    static async _reconcilePack(pack, pendingItems) {
        const ItemClass = CONFIG.Item.documentClass;
        const minting   = game.ionrift?.library?.minting;

        // Build name -> doc[] map. Tracks ALL docs per name so duplicates
        // left over from a corrupted clear cycle can be pruned.
        const existingByName = new Map();
        try {
            const docs = await pack.getDocuments();
            for (const doc of docs) {
                const key = (doc.name || "").trim().toLowerCase();
                if (!key) continue;
                const arr = existingByName.get(key);
                if (arr) arr.push(doc);
                else existingByName.set(key, [doc]);
            }
        } catch {
            // Can't read the pack; treat as empty and insert everything fresh.
        }

        const pendingNames = new Set();
        const toCreate     = [];
        const toUpdate     = [];
        const toDelete     = [];

        for (const data of pendingItems) {
            const key  = (data.name || "").trim().toLowerCase();
            pendingNames.add(key);
            const docs = existingByName.get(key);
            if (docs?.length) {
                // Keep the first, update it. Mark extras for deletion.
                toUpdate.push({ ...data, _id: docs[0].id });
                for (let i = 1; i < docs.length; i++) toDelete.push(docs[i].id);
            } else {
                toCreate.push(data);
            }
        }

        // Any name in the pack that isn't in the manifest: delete all copies.
        for (const [key, docs] of existingByName) {
            if (pendingNames.has(key)) continue;
            for (const doc of docs) toDelete.push(doc.id);
        }

        // Guard new items through the minting pipeline.
        if (minting?.guardAll && toCreate.length) {
            minting.guardAll(toCreate, { moduleId: MODULE_ID, mode: "pack" });
        }

        if (toCreate.length) {
            await ItemClass.createDocuments(toCreate, { pack: pack.collection });
        }

        // Update existing items in-place (refreshes stale data).
        for (const data of toUpdate) {
            try {
                await ItemClass.updateDocuments([data], { pack: pack.collection });
            } catch { /* phantom; leave existing data */ }
        }

        // Prune duplicates and orphans (best effort).
        for (const id of toDelete) {
            try {
                await ItemClass.deleteDocuments([id], { pack: pack.collection });
            } catch { /* phantom or locked; skip */ }
        }
    }

    /**
     * Clear all documents from an existing world pack so it can be re-populated.
     * Never calls deleteCompendium(); destroying and recreating the pack leaves
     * Foundry's backend in a broken state on Windows (missing packData).
     * Instead, tolerates stale/phantom entries by deleting items individually.
     *
     * @param {CompendiumCollection} pack
     * @returns {Promise<boolean>}
     */
    static async _clearOrDestroyPack(pack) {
        const ids = await this._collectPackItemIds(pack);
        if (!ids.length) return true;

        const ItemClass = CONFIG.Item.documentClass;

        // Try batch delete first (fast path).
        try {
            await ItemClass.deleteDocuments(ids, { pack: pack.collection });
            return true;
        } catch {
            // Batch failed, likely stale/phantom entries. Fall through.
        }

        // Delete one at a time, tolerating phantom IDs.
        let failures = 0;
        for (const id of ids) {
            try {
                await ItemClass.deleteDocuments([id], { pack: pack.collection });
            } catch {
                failures++;
            }
        }

        if (failures > 0) {
            Logger.warn(MODULE_LABEL,
                `SrdCurseAdapter: ${failures}/${ids.length} stale entries could not be removed (phantom IDs in index).`);
        }
        return true;
    }

    /**
     * Collect item IDs from a pack, preferring getDocuments() but falling back
     * to getIndex() if the pack's LevelDB is partially corrupted.
     *
     * @param {CompendiumCollection} pack
     * @returns {Promise<string[]>}
     */
    static async _collectPackItemIds(pack) {
        try {
            const docs = await pack.getDocuments();
            if (docs.length) return docs.map(d => d.id);
            return [];
        } catch {
            // getDocuments failed; try the lighter-weight index.
        }

        try {
            const index = await pack.getIndex();
            const ids = [];
            for (const entry of index) {
                if (entry._id) ids.push(entry._id);
            }
            return ids;
        } catch {
            // Both failed. Return empty; compile will insert fresh.
            Logger.warn(MODULE_LABEL,
                "SrdCurseAdapter: could not read pack contents or index. Will attempt to insert directly.");
            return [];
        }
    }

    static async _createWorldPack() {
        // If the pack already exists (race condition or stale reference), return it.
        const existing = game.packs.get(this.worldCollectionId);
        if (existing) return existing;

        const base = {
            label:     this.PACK_LABEL,
            name:      this.WORLD_PACK_NAME,
            type:      "Item",
            system:    game.system.id,
            ownership: { PLAYER: "NONE", TRUSTED: "NONE", ASSISTANT: "NONE", GAMEMASTER: "OWNER" }
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
                // "already exists" from a concurrent tab or stale state: return it.
                const recheck = game.packs.get(this.worldCollectionId);
                if (recheck) return recheck;
            }
        }
        Logger.error(MODULE_LABEL, "SrdCurseAdapter: failed to create world compendium:", lastErr);
        ui.notifications.error("Quartermaster: could not create SRD cursed items compendium. Check the console.");
        return null;
    }

    // ── Status / metadata helpers (mirrors LootPoolCompiler API) ───────────

    /**
     * Synchronous status check — same contract as LootPoolCompiler.getStatus().
     * Sources are fixed (dnd5e.items + dnd5e.equipment24) so staleness is
     * pack-deletion only; no user source-change detection needed.
     * @returns {"fresh"|"stale"|"never"|"na"}
     */
    static getStatus() {
        try {
            const hash = game.settings.get(MODULE_ID, this.SETTING_HASH);
            if (!hash) return "never";
            if (!game.packs.get(this.worldCollectionId)) return "stale";
            return "fresh";
        } catch { return "na"; }
    }

    /**
     * Returns the stored compile metadata, or null if none exists.
     * @returns {{ compiledAt?: string, itemCount?: number, sourceCount?: number, errorAt?: string, errorMessage?: string }|null}
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

    static async clearCompiledPack() {
        await clearPackAndResetMeta(this.worldCollectionId, this.SETTING_HASH, this.SETTING_META, "SrdCurseAdapter");
    }
}
