/**
 * Pathfinder 2e cursed item compiler (Phase 1: compendium-faithful).
 * Scans pf2e equipment packs for the `cursed` trait, stamps minimal
 * cursedMeta, and writes to the shared GM-only world compendium.
 */

import { Logger, MODULE_LABEL } from "../_logger.js";
import { SrdCurseAdapter } from "./SrdCurseAdapter.js";
import {
    PF2E_CURSE_PACK_SOURCES,
    inferPf2eCurseMeta,
    itemHasPf2eCursedTrait,
    isPf2eCursedLootEntry
} from "./Pf2eCurseCatalog.js";
import { enforcePackOwnership, assignPackToCompiledFolder, stableHash } from "./CompendiumConfigHelper.js";
import { QM_FEATURES } from "../constants/QMFeatures.js";

const MODULE_ID = "ionrift-quartermaster";

export class Pf2eCurseAdapter {

    static get WORLD_PACK_NAME() { return SrdCurseAdapter.WORLD_PACK_NAME; }
    static get PACK_LABEL() { return "Quartermaster: Cursed Items"; }
    static get SETTING_HASH() { return SrdCurseAdapter.SETTING_HASH; }
    static get SETTING_META() { return SrdCurseAdapter.SETTING_META; }
    static get worldCollectionId() { return SrdCurseAdapter.worldCollectionId; }

    static getStatus = SrdCurseAdapter.getStatus;
    static getCompiledMeta = SrdCurseAdapter.getCompiledMeta;
    static clearCompiledPack = SrdCurseAdapter.clearCompiledPack;
    static getSrdPack = SrdCurseAdapter.getSrdPack;
    static _reconcilePack = SrdCurseAdapter._reconcilePack;
    static _createWorldPack = SrdCurseAdapter._createWorldPack;
    static _writeMeta = SrdCurseAdapter._writeMeta;
    static _stableHash = stableHash;

    static async compile({ forceRecompile = false } = {}) {
        if (!game.user.isGM) return;
        if (!game.ionrift?.quartermaster?.adapter?.supports(QM_FEATURES.SRD_CURSES)) return;

        const itemPacks = this._discoverItemPacks();
        if (!itemPacks.length) {
            Logger.warn(MODULE_LABEL, "Pf2eCurseAdapter: no pf2e item compendiums found.");
            return;
        }

        const sourceHash = await this._computeSourceHash(itemPacks);
        const lastHash = game.settings.get(MODULE_ID, this.SETTING_HASH);
        if (!forceRecompile && sourceHash === lastHash) return;

        const cursedItems = await this._collectCursedItems(itemPacks);
        if (!cursedItems.length) {
            Logger.warn(MODULE_LABEL, "Pf2eCurseAdapter: no cursed-trait items found in pf2e packs.");
            ui.notifications.warn("Quartermaster: no cursed items found in pf2e equipment compendiums.");
            return;
        }

        const pendingItems = [];
        let catalogHits = 0;

        for (const sourceItem of cursedItems) {
            const meta = inferPf2eCurseMeta(sourceItem);
            if (meta.catalogMatch) catalogHits++;
            const data = this._stampItem(sourceItem, meta);
            if (data) pendingItems.push(data);
        }

        let pack = game.packs.get(this.worldCollectionId);
        if (!pack) {
            pack = await this._createWorldPack();
            if (!pack) return;
            pack = game.packs.get(this.worldCollectionId) ?? pack;
        }

        try {
            await this._reconcilePack(pack, pendingItems);
        } catch (err) {
            Logger.error(MODULE_LABEL, "Pf2eCurseAdapter: reconcile failed:", err);
            ui.notifications.error("Quartermaster: cursed item compile failed. Check the console.");
            return;
        }

        await game.settings.set(MODULE_ID, this.SETTING_HASH, sourceHash);
        await this._writeMeta({
            compiledAt: new Date().toISOString(),
            itemCount: pendingItems.length,
            sourceCount: itemPacks.length,
            catalogHits,
            mode: "pf2e-faithful"
        });
        enforcePackOwnership(pack);
        await assignPackToCompiledFolder(pack);

        const catalogNote = catalogHits > 0
            ? ` (${catalogHits} matched GMG catalog)`
            : "";
        ui.notifications.info(
            `Quartermaster: compiled ${pendingItems.length} pf2e cursed items${catalogNote}.`
        );
        Logger.info(MODULE_LABEL,
            `Pf2eCurseAdapter: ${pendingItems.length} compiled (${catalogHits} GMG catalog matches).`
        );
    }

    /**
     * @param {Item} sourceItem
     * @param {{ tier: number, curseType: string, catalogMatch: string|null }} meta
     */
    static _stampItem(sourceItem, meta) {
        const data = sourceItem.toObject();
        const cursedMeta = {
            tier: meta.tier,
            curseType: meta.curseType,
            category: meta.curseType,
            tags: [meta.curseType, `tier-${meta.tier}`],
            decoyAppearance: "",
            trueNature: "",
            pf2eFaithful: true
        };
        if (meta.catalogMatch) cursedMeta.catalogMatch = meta.catalogMatch;

        const slug = (sourceItem.name || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        data.flags ??= {};
        data.flags["ionrift-quartermaster"] ??= {};
        data.flags["ionrift-quartermaster"].cursedMeta = cursedMeta;
        data.flags["ionrift-quartermaster"].mintBatch = `pf2e-curse-${slug}`;

        return data;
    }

    static _discoverItemPacks() {
        const packs = [];
        const ownId = this.worldCollectionId;

        for (const id of PF2E_CURSE_PACK_SOURCES) {
            const pack = game.packs.get(id);
            if (pack?.documentName === "Item" && !packs.includes(pack)) packs.push(pack);
        }

        for (const pack of game.packs) {
            if (pack.documentName !== "Item") continue;
            if (pack.collection === ownId) continue;
            if (packs.includes(pack)) continue;
            const pkg = pack.metadata?.packageName ?? pack.metadata?.package ?? "";
            if (pkg === "pf2e" || pkg === "sf2e") packs.push(pack);
        }

        return packs;
    }

    /**
     * @param {CompendiumCollection[]} itemPacks
     * @returns {Promise<Item[]>}
     */
    static async _collectCursedItems(itemPacks) {
        const byName = new Map();

        for (const pack of itemPacks) {
            let docs = [];
            try {
                docs = await pack.getDocuments();
            } catch (err) {
                Logger.warn(MODULE_LABEL,
                    `Pf2eCurseAdapter: could not read "${pack.collection}": ${err.message}`
                );
                continue;
            }

            for (const doc of docs) {
                if (!itemHasPf2eCursedTrait(doc) && !isPf2eCursedLootEntry(doc)) continue;
                const key = (doc.name || "").trim().toLowerCase();
                if (!key || byName.has(key)) continue;
                byName.set(key, doc);
            }
        }

        return [...byName.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }

    static async _computeSourceHash(itemPacks) {
        const parts = ["pf2e:cursed-trait"];
        for (const p of itemPacks.sort((a, b) => a.collection.localeCompare(b.collection))) {
            try {
                const index = await p.getIndex({ fields: ["name", "type", "system.traits"] });
                let cursedCount = 0;
                for (const row of index.values()) {
                    if (isPf2eCursedLootEntry(row)) cursedCount++;
                }
                parts.push(`${p.collection}:${cursedCount}`);
            } catch {
                parts.push(`${p.collection}:err`);
            }
        }
        return this._stableHash(parts.join("|"));
    }
}
