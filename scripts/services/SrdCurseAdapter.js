/**
 * SrdCurseAdapter: seeds the Quartermaster cursed pool with the 12 canonical
 * SRD cursed items. Real names, minimal metadata — no Ionrift IP.
 *
 * Structural pattern mirrors CurseForge.js in Cursewright, stripped of all
 * recipe lore, lure names, escalation, and Ionrift-branded content.
 *
 * Writes to: world.ionrift-srd-cursed (GM-only world compendium)
 * Hash-gated: only recompiles when the source packs change.
 * Guards: GM-only, dnd5e only.
 */

import { Logger, MODULE_LABEL } from "../_logger.js";

const MODULE_ID = "ionrift-quartermaster";

// ── SRD Manifest ────────────────────────────────────────────────────────
//
// 12 canonical SRD cursed items. Names are matched against the dnd5e system
// compendiums at runtime. cursedMeta stamps tier and curseType only.

const SRD_CURSE_MANIFEST = [
    { match: "Berserker Axe",               tier: 1, curseType: "compulsion" },
    { match: "Dust of Sneezing and Choking", tier: 1, curseType: "deceptive"  },
    { match: "Sword of Vengeance",           tier: 1, curseType: "compulsion" },
    { match: "Armor of Vulnerability",       tier: 2, curseType: "deceptive"  },
    { match: "Bag of Devouring",             tier: 2, curseType: "physical"   },
    { match: "Boots of Dancing",             tier: 2, curseType: "compulsion" },
    { match: "Cloak of Poisonousness",       tier: 2, curseType: "deceptive"  },
    { match: "Crown of Madness",             tier: 2, curseType: "compulsion" },
    { match: "Shield of Missile Attraction", tier: 2, curseType: "deceptive"  },
    { match: "Demon Armor",                  tier: 3, curseType: "binding"    },
    { match: "Necklace of Strangulation",    tier: 3, curseType: "binding"    },
    { match: "Scarab of Death",              tier: 3, curseType: "physical"   },
];

// ── SrdCurseAdapter ─────────────────────────────────────────────────────

export class SrdCurseAdapter {
    static WORLD_PACK_NAME = "ionrift-srd-cursed";
    static PACK_LABEL      = "Quartermaster: SRD Cursed Items";
    static SETTING_HASH    = "srdCurseHash";

    static get worldCollectionId() {
        return `world.${this.WORLD_PACK_NAME}`;
    }

    /**
     * Discover SRD item packs, match the manifest, and write results into
     * a GM-only world compendium. Hash-gated to avoid recompiling every load.
     */
    static async compile() {
        if (!game.user.isGM) return;
        if (game.system?.id !== "dnd5e") return;

        const itemPacks = this._discoverItemPacks();
        if (!itemPacks.length) {
            Logger.warn(MODULE_LABEL, "SrdCurseAdapter: no dnd5e item compendiums found.");
            return;
        }

        const sourceHash = await this._computeSourceHash(itemPacks);
        const lastHash   = game.settings.get(MODULE_ID, this.SETTING_HASH);
        if (sourceHash === lastHash) return;

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

        // Rebuild world compendium
        let pack = game.packs.get(this.worldCollectionId);
        if (pack) await this._destroyWorldPack(pack);

        pack = await this._createWorldPack();
        if (!pack) return;
        pack = game.packs.get(this.worldCollectionId) ?? pack;

        try {
            const ItemClass = CONFIG.Item.documentClass;
            await ItemClass.createDocuments(pendingItems, { pack: pack.collection });
        } catch (err) {
            Logger.error(MODULE_LABEL, "SrdCurseAdapter: createDocuments failed:", err);
            ui.notifications.error("Quartermaster: SRD cursed item compile failed. Check the console.");
            return;
        }

        await game.settings.set(MODULE_ID, this.SETTING_HASH, sourceHash);
        this._enforceOwnership();
        await this._assignSidebarFolder(pack);

        const skipNote = missCount > 0 ? ` (${missCount} item${missCount !== 1 ? "s" : ""} not found in your dnd5e packs)` : "";
        ui.notifications.info(
            `Quartermaster: compiled ${matchCount} SRD cursed items${skipNote}.`
        );
        Logger.info(MODULE_LABEL, `SrdCurseAdapter: ${matchCount} compiled, ${missCount} missed.`);
    }

    /**
     * Clone a source item and stamp minimal cursedMeta.
     * No lure names, no escalation, no Ionrift prose — SRD only.
     *
     * @param {Item} sourceItem
     * @param {{ match: string, tier: number, curseType: string }} entry
     * @returns {object} Plain item data for createDocuments
     */
    static _stampItem(sourceItem, entry) {
        const data   = sourceItem.toObject();
        const system = data.system ??= {};

        // Preserve name and stats — SRD items are public as-is.
        // Just mark it identified so it appears correctly.
        system.identified = true;

        // Minimal cursedMeta: tier + curseType only.
        // decoyAppearance and trueNature are intentionally empty — no Ionrift IP.
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
        return this._stableHash(parts.join("|"));
    }

    static _stableHash(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) + h) ^ str.charCodeAt(i);
        }
        return (h >>> 0).toString(16);
    }

    // ── World Pack Management ─────────────────────────────────────────────

    static getSrdPack() {
        return game.packs.get(this.worldCollectionId) ?? null;
    }

    static async _destroyWorldPack(pack) {
        try {
            await pack.deleteCompendium();
        } catch (err) {
            Logger.error(MODULE_LABEL, "SrdCurseAdapter: failed to delete existing compendium:", err);
        }
    }

    static async _createWorldPack() {
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
            }
        }
        Logger.error(MODULE_LABEL, "SrdCurseAdapter: failed to create world compendium:", lastErr);
        ui.notifications.error("Quartermaster: could not create SRD cursed items compendium. Check the console.");
        return null;
    }

    static _enforceOwnership() {
        if (!game.user.isGM) return;
        const pack = this.getSrdPack();
        if (!pack) return;

        const cfg   = foundry.utils.duplicate(game.settings.get("core", "compendiumConfiguration") ?? {});
        const entry = cfg[pack.collection] ??= {};
        const wanted  = { PLAYER: "NONE", TRUSTED: "NONE", ASSISTANT: "NONE", GAMEMASTER: "OWNER" };
        const current = entry.ownership ?? {};
        const needsUpdate = Object.entries(wanted).some(([k, v]) => current[k] !== v);
        if (!needsUpdate) return;

        entry.ownership = wanted;
        game.settings.set("core", "compendiumConfiguration", cfg);
    }

    static async _assignSidebarFolder(pack) {
        if (!game.user.isGM) return;
        const folderId = this._findQuartermasterFolderId();
        if (!folderId) return;

        const packId = pack.collection;
        const cfg    = foundry.utils.duplicate(game.settings.get("core", "compendiumConfiguration") ?? {});
        cfg[packId]  = foundry.utils.mergeObject(cfg[packId] ?? {}, { folder: folderId });
        await game.settings.set("core", "compendiumConfiguration", cfg);
    }

    static _findQuartermasterFolderId() {
        const cfg     = game.settings.get("core", "compendiumConfiguration") ?? {};
        const refPack = "ionrift-quartermaster.quartermaster-core";
        const fromRef = cfg[refPack]?.folder;
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
}
