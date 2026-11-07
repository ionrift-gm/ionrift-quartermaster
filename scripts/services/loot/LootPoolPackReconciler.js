import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";
/**
 * LootPoolCompiler
 *
 * Resolves the 2024 SRD template-first architecture into discrete loot-ready items.
 * The dnd5e.equipment24 pack ships named weapon templates (Dragon Slayer, Holy Avenger,
 * etc.) as GM-application shells with no base subtype and weight=0 - not loot items.
 * This service expands them into a full permutation matrix:
 *   template × base weapon × bonus tier to discrete item
 *
 * Output: world.quartermaster-compiled-pool (GM-only world compendium)
 * Hash-gated: only recompiles when lootPoolSources config changes.
 * Guards: GM-only, dnd5e only.
 *
 * Structural pattern mirrors SrdCurseAdapter.js.
 */

import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { ItemPoolResolver } from "./ItemPoolResolver.js";
import { isSrdCursedLootName, isSrdCursedTemplateName } from "../curse/SrdCurseCatalog.js";

import { enforcePackOwnership, assignPackToCompiledFolder, stableHash } from "../packs/CompendiumConfigHelper.js";
import { QM_FEATURES } from "../../data/QMFeatures.js";

import {
    keyToIdentifier,
    findSourceDoc,
    WEAPON_TEMPLATES,
    RANGE_STUB_EXPANSIONS,
    TIER_RARITY,
    SHIELD_BONUS_RARITY,
    ARMOR_BONUS_RARITY,
    BASE_ARMORS,
    GENERIC_WEAPON_BASES,
    ADAMANTINE_MITHRAL_BASES,
    RESISTANCE_BASES,
    RESISTANCE_TYPES,
    SPECIFIC_ARMOR_TEMPLATES,
    WONDROUS_TEMPLATE_SHELLS,
    NAMED_ECONOMY_ENRICHMENT,
    SLAYING_AMMO_TEMPLATE,
    SLAYING_AMMO_BASES,
    SLAYING_CREATURE_TYPES,
    SLAYING_AMMO_PRICE,
    ARCHITECTURE_2024_PACKS
} from "./LootPoolTemplateCatalog.js";

export class LootPoolPackReconciler {
    /**
     * Expand wondrous template shells (e.g. Belt of Giant Strength) into
     * discrete variant rows. Skips variants that already exist in sources
     * with a non-zero price.
     *
     * @param {Map<string, {item: Item, packId: string}>} allByName
     * @returns {object[]}
     */
    static _expandWondrousTemplates(allByName, report = null) {
        const expanded = [];

        for (const [templateName, variants] of Object.entries(WONDROUS_TEMPLATE_SHELLS)) {
            const templateEntry = findSourceDoc(allByName, null, templateName);
            const templateDoc   = templateEntry?.item ?? null;

            for (const variant of variants) {
                const key = variant.name.trim().toLowerCase();
                const existing = findSourceDoc(allByName, null, key);
                let existingDoc = null;
                try {
                    existingDoc = existing?.item?.toObject?.() ?? existing?.item ?? null;
                } catch (err) {
                    this._recordSkip(report, {
                        name:   variant.name,
                        packId: existing?.packId ?? "",
                        phase:  "source",
                        reason: err,
                    });
                    continue;
                }
                const existingPrice = existingDoc
                    ? ItemPoolResolver._extractPrice(existingDoc)
                    : 0;
                if (existingPrice > 0) continue;

                const sourceDoc = existing?.item ?? templateDoc;
                if (!sourceDoc) continue;

                const data = this._safeExpand(
                    report, "expand", variant.name, existing?.packId ?? templateEntry?.packId ?? "",
                    () => this._buildWondrousVariant(sourceDoc, variant, templateName)
                );
                if (data) expanded.push(data);
            }
        }

        return expanded;
    }

    /**
     * Emit loot-ready copies of named items whose source rows have zero economy.
     *
     * @param {Map<string, {item: Item, packId: string}>} allByName
     * @returns {object[]}
     */
    static _expandNamedEconomyEnrichment(allByName, report = null) {
        const expanded = [];

        for (const [itemName, spec] of Object.entries(NAMED_ECONOMY_ENRICHMENT)) {
            const entry = findSourceDoc(allByName, null, itemName);
            if (!entry?.item) continue;

            try {
                const sourceDoc = entry.item.toObject?.() ?? entry.item;
                const price = ItemPoolResolver._extractPrice(sourceDoc);
                const weight = ItemPoolResolver._extractWeight(sourceDoc);
                if (price > 0 && weight > 0) continue;

                const data = this._safeExpand(
                    report, "expand", itemName, entry.packId,
                    () => this._buildNamedEconomyItem(entry.item, itemName, spec)
                );
                if (data) expanded.push(data);
            } catch (err) {
                this._recordSkip(report, {
                    name:   itemName,
                    packId: entry.packId ?? "",
                    phase:  "source",
                    reason: err,
                });
            }
        }

        return expanded;
    }

    /**
     * @param {Item} sourceDoc
     * @param {{ name: string, rarity: string, price: number, weight?: number }} variant
     * @param {string} templateName
     * @returns {object|null}
     */
    static _buildWondrousVariant(sourceDoc, variant, templateName) {
        const data = sourceDoc.toObject();
        const system = data.system ??= {};

        data.name = variant.name;
        system.rarity = variant.rarity;
        system.price = { value: variant.price, denomination: "gp" };
        system.type ??= {};
        if (!system.type.value || system.type.value === "-" || system.type.value === "") {
            system.type.value = "wondrous";
        }

        const weight = variant.weight ?? 1;
        this._assignWeight(system, weight);

        const slug = variant.name.toLowerCase().replace(/\s+/g, "-");
        this._stampCompiledFlags(data,
            `compiled-pool-wondrous-${slug}`,
            { template: templateName, variant: variant.name }
        );

        this._stripEnchantmentShells(data);
        this._cleanCompiledDescription(data);
        return data;
    }

    /**
     * @param {Item} sourceDoc
     * @param {string} itemName
     * @param {{ price: number, weight: number, subtype?: string }} spec
     * @returns {object|null}
     */
    static _buildNamedEconomyItem(sourceDoc, itemName, spec) {
        const data = sourceDoc.toObject();
        const system = data.system ??= {};

        data.name = itemName;
        system.price = { value: spec.price, denomination: "gp" };
        if (spec.subtype) {
            system.type ??= {};
            system.type.value = spec.subtype;
        }
        this._assignWeight(system, spec.weight);

        const slug = itemName.toLowerCase().replace(/\s+/g, "-");
        this._stampCompiledFlags(data,
            `compiled-pool-enriched-${slug}`,
            { source: itemName, enrichment: true }
        );

        this._stripEnchantmentShells(data);
        this._cleanCompiledDescription(data);
        return data;
    }

    /**
     * Expand the 2024 Ammunition of Slaying shell into discrete base × creature
     * type rows (e.g. Arrow of Slaying (Dragons)).
     *
     * @param {Map<string, {item: Item, packId: string}>} allByName
     * @returns {object[]}
     */
    static _expandSlayingAmmunition(allByName, report = null) {
        const expanded = [];
        const shellEntry = findSourceDoc(allByName, null, SLAYING_AMMO_TEMPLATE);
        const shellDoc     = shellEntry?.item ?? null;
        if (!shellDoc) return expanded;

        for (const { base, short } of SLAYING_AMMO_BASES) {
            const baseEntry = findSourceDoc(allByName, null, base);
            if (!baseEntry?.item) {
                Logger.warn(MODULE_LABEL, `LootPoolCompiler: slaying ammo base "${base}" not found.`);
                continue;
            }

            for (const creatureType of SLAYING_CREATURE_TYPES) {
                const itemName = `${short} of Slaying (${creatureType})`;
                const existing = findSourceDoc(allByName, null, itemName);
                let existingDoc = null;
                try {
                    existingDoc = existing?.item?.toObject?.() ?? existing?.item ?? null;
                } catch (err) {
                    this._recordSkip(report, {
                        name:   itemName,
                        packId: existing?.packId ?? "",
                        phase:  "source",
                        reason: err,
                    });
                    continue;
                }
                if (existingDoc && ItemPoolResolver._extractPrice(existingDoc) > 0) continue;

                const riderName = `${SLAYING_AMMO_TEMPLATE} ${creatureType}`;
                const riderDoc = findSourceDoc(allByName, null, riderName)?.item ?? null;

                const data = this._safeExpand(
                    report, "expand", itemName, baseEntry.packId,
                    () => this._buildSlayingAmmoItem(
                        shellDoc,
                        baseEntry.item,
                        short,
                        creatureType,
                        riderDoc
                    )
                );
                if (data) expanded.push(data);
            }
        }

        return expanded;
    }

    /**
     * @param {Item} shellDoc
     * @param {Item} baseDoc
     * @param {string} shortName       Display base, e.g. "Arrow" or "Bolt"
     * @param {string} creatureType    e.g. "Dragons"
     * @param {Item|null} riderEffectDoc  Enchantment rider from equipment24
     * @returns {object|null}
     */
    static _buildSlayingAmmoItem(shellDoc, baseDoc, shortName, creatureType, riderEffectDoc) {
        const data = shellDoc.toObject();
        const base = baseDoc.toObject();
        const system = data.system ??= {};
        const itemName = `${shortName} of Slaying (${creatureType})`;

        data.name = itemName;
        data.type = "consumable";
        system.rarity = "veryRare";
        system.price = { value: SLAYING_AMMO_PRICE, denomination: "gp" };
        system.type ??= {};
        system.type.value = "ammo";

        const baseWeight = this._extractWeight(base.system ?? {});
        if (baseWeight > 0) {
            this._assignWeight(system, baseWeight);
        }
        if (base.img && (!data.img || data.img === DEFAULT_ITEM_ICON)) {
            data.img = base.img;
        }

        this._filterSlayingForCreatureType(data, creatureType, riderEffectDoc, itemName);

        const slug = itemName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        this._stampCompiledFlags(data,
            `compiled-pool-slaying-${slug}`,
            { template: SLAYING_AMMO_TEMPLATE, base: shortName, creatureType }
        );

        this._cleanCompiledDescription(data);
        return data;
    }

    /**
     * Reduce the slaying shell to a single creature-type rider and concrete name.
     *
     * @param {object} data
     * @param {string} creatureType
     * @param {Item|null} riderEffectDoc
     * @param {string} itemName
     */
    static _filterSlayingForCreatureType(data, creatureType, riderEffectDoc, itemName) {
        const typeLower = creatureType.toLowerCase();
        const riderId = riderEffectDoc?.id ?? riderEffectDoc?._id ?? null;

        if (riderEffectDoc) {
            const riderObj = riderEffectDoc.toObject?.() ?? structuredClone(riderEffectDoc);
            const changes = riderObj.changes ?? riderObj.system?.changes ?? [];
            for (const change of changes) {
                if (change.key === "name") change.value = itemName;
                if (change.key === "system.description.value") {
                    change.value = `<p>Very rare ammunition effective against ${creatureType.toLowerCase()}.</p>`;
                }
            }
            if (riderObj.system?.changes) riderObj.system.changes = changes;
            else if (changes.length) riderObj.changes = changes;
            data.effects = [riderObj];
        } else if (Array.isArray(data.effects)) {
            data.effects = data.effects.filter(effect => {
                const name = (effect.name ?? "").toLowerCase();
                return name.includes(typeLower);
            });
        }

        const activities = data.system?.activities ?? {};
        for (const act of Object.values(activities)) {
            if (act.type !== "enchant" || !Array.isArray(act.effects)) continue;
            const match = riderId
                ? act.effects.find(entry => entry._id === riderId)
                : act.effects.find(entry => {
                    const fx = data.effects?.find(e => e._id === entry._id);
                    return (fx?.name ?? "").toLowerCase().includes(typeLower);
                });
            if (match) {
                act.effects = [match];
                act.appliedEffects = [match._id];
            } else {
                act.effects = act.effects.slice(0, 1);
                act.appliedEffects = act.appliedEffects?.slice(0, 1) ?? [];
            }
        }

        this._clearRiderFlags(data);
    }

    // ── Collision Resolution ──────────────────────────────────────────────

    /**
     * When expanded items share a name with a legacy item in the raw sources,
     * apply collision rules:
     *   - 2024 wins type/subtype/price (already embedded in expanded data)
     *   - Legacy weight is preserved when 2024 weight is 0 and legacy is non-zero
     *
     * No-op for items that are net-new (no collision). This pass only adjusts
     * weight when the expansion produced a zero-weight result.
     *
     * @param {object[]} expanded
     * @param {Map<string, {item: Item, packId: string}>} allByName
     * @returns {object[]}
     */
    static _filterCursedFromCompiled(items) {
        const kept = items.filter(item => !isSrdCursedLootName(item?.name));
        const dropped = items.length - kept.length;
        if (dropped > 0) {
            Logger.info(
                MODULE_LABEL,
                `LootPoolCompiler: excluded ${dropped} cursed row(s) from compiled loot pool.`
            );
        }
        return kept;
    }

    static _collisionResolve(expanded, allByName, report = null) {
        for (const data of expanded) {
            try {
                const key = (data.name || "").trim().toLowerCase();
                const legacy = findSourceDoc(allByName, null, key);
                if (!legacy) continue;

                const ourWeight = this._extractWeight(data.system ?? {});
                if (ourWeight === 0) {
                    const legacyWeight = this._extractWeight(legacy.item.system ?? {});
                    if (legacyWeight > 0) {
                        const sys = data.system ??= {};
                        this._assignWeight(sys, legacyWeight);
                    }
                }
            } catch (err) {
                this._recordSkip(report, {
                    name:   data.name ?? "(collision)",
                    phase:  "collision",
                    reason: err,
                });
            }
        }
        return expanded;
    }

    // ── Weight / Price Helpers ────────────────────────────────────────────

    static _extractWeight(system) {
        return ItemPoolResolver._extractWeight({ system });
    }

    /**
     * Assign a resolved weight value to a system object, handling the
     * dnd5e object-vs-scalar weight shape.
     * @param {object} system  The item's system data (mutated in place)
     * @param {number} value   Weight value to assign
     * @param {string} [units="lb"]
     */
    static _assignWeight(system, value, units = "lb") {
        if (system.weight !== null && typeof system.weight === "object") {
            system.weight = { ...system.weight, value, units };
        } else {
            system.weight = { value, units };
        }
    }

    /**
     * Stamp compiled-pool tracking flags onto an item data object.
     * @param {object} data          Plain item data (mutated in place)
     * @param {string} mintBatch     Unique slug for reconcile/dedup
     * @param {object} compiledFrom  Provenance metadata
     */
    static _stampCompiledFlags(data, mintBatch, compiledFrom) {
        data.flags ??= {};
        data.flags[MODULE_ID] ??= {};
        data.flags[MODULE_ID].mintBatch = mintBatch;
        data.flags[MODULE_ID].compiledFrom = compiledFrom;
        data.flags[MODULE_ID].compiledKey = mintBatch;
    }

    // ── Source Helpers ────────────────────────────────────────────────────

    static _getEnabledSources() {
        return ItemPoolResolver.getEnabledSources();
    }

    /**
     * True when a lootPoolSources entry affects compiled template expansion.
     * Overlay materialised packs, scroll output, pipeline outputs, and excluded
     * activity packs are runtime loot sources only.
     * @param {string} packId
     * @returns {boolean}
     */
    static _isCompileTrackedSource(packId) {
        if (!packId || typeof packId !== "string") return false;
        if (packId === this.worldCollectionId) return false;
        if (packId.startsWith("world.quartermaster-")) return false;
        if (packId === "world.ionrift-forged-scrolls") return false;
        if (packId === "world.ionrift-srd-cursed") return false;
        if (packId === "world.ionrift-cursewright-forged") return false;
        if (packId.startsWith("qm-preview.")) return false;
        return true;
    }

    /**
     * Enabled loot sources that participate in compile input hashing and staleness.
     * @param {string[]|null} [sourceIds]
     * @returns {string[]}
     */
    static _getCompileTrackedSources(sourceIds = null) {
        const base = sourceIds ?? this._getEnabledSources();
        return base.filter(id => this._isCompileTrackedSource(id));
    }

    // ── World Pack Management ─────────────────────────────────────────────

    /**
     * Get or create the world compendium for the compiled pool.
     * Mirrors SrdCurseAdapter._createWorldPack exactly.
     */
    static async _createWorldPack() {
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
                const recheck = game.packs.get(this.worldCollectionId);
                if (recheck) return recheck;
            }
        }
        Logger.error(MODULE_LABEL, "LootPoolCompiler: failed to create world compendium:", lastErr);
        return null;
    }

    /**
     * Create compendium rows; on batch failure, retry per item and record skips.
     * @param {typeof Item} ItemClass
     * @param {object[]} items
     * @param {CompendiumCollection} pack
     * @param {{ skips: object[] }} report
     * @param {string} phase
     * @returns {Promise<number>} Count written
     */
    static async _createDocumentsResilient(ItemClass, items, pack, report, phase = "write") {
        if (!items.length) return 0;
        const minting = game.ionrift?.library?.minting;
        const packKey = pack.collection;

        try {
            if (minting?.guardAll) {
                minting.guardAll(items, { moduleId: MODULE_ID, mode: "pack" });
            }
            await ItemClass.createDocuments(items, { pack: packKey });
            return items.length;
        } catch (batchErr) {
            Logger.warn(
                MODULE_LABEL,
                `LootPoolCompiler: batch ${phase} failed (${items.length} items), retrying per-item: ${batchErr.message}`
            );
        }

        let written = 0;
        for (const data of items) {
            try {
                if (minting?.guardAll) {
                    minting.guardAll([data], { moduleId: MODULE_ID, mode: "pack" });
                }
                await ItemClass.createDocuments([data], { pack: packKey });
                written++;
            } catch (err) {
                this._recordSkip(report, {
                    name:   data.name ?? "(unnamed)",
                    packId: packKey,
                    phase,
                    reason: err,
                });
            }
        }
        return written;
    }

    /**
     * Reconcile pack contents: update existing, create missing, delete orphans.
     * Mirrors SrdCurseAdapter._reconcilePack.
     *
     * @param {CompendiumCollection} pack
     * @param {object[]} pendingItems
     * @param {function} [onItemWritten]  Called with (current, total, name) per item
     * @param {{ skips: object[] }} [report]
     * @returns {Promise<{ written: number, attempted: number }>}
     */
    static async _reconcilePack(pack, pendingItems, onItemWritten, report = null) {
        const ItemClass = CONFIG.Item.documentClass;
        const safeReport = report ?? this._newCompileReport();

        function getItemCompiledKey(docOrData) {
            const flagKey = docOrData.getFlag
                ? docOrData.getFlag(MODULE_ID, "compiledKey")
                : docOrData.flags?.[MODULE_ID]?.compiledKey;
            if (flagKey) return String(flagKey).trim().toLowerCase();
            const ident = docOrData.system?.identifier;
            if (ident) return String(ident).trim().toLowerCase();
            return (docOrData.name || "").trim().toLowerCase();
        }

        const existingByKey = new Map();
        const existingByName = new Map();
        try {
            const docs = await pack.getDocuments();
            for (const doc of docs) {
                const compKey = getItemCompiledKey(doc);
                if (compKey) {
                    const arr = existingByKey.get(compKey) ?? [];
                    arr.push(doc);
                    existingByKey.set(compKey, arr);
                }
                const nameKey = (doc.name || "").trim().toLowerCase();
                if (nameKey) {
                    const arr = existingByName.get(nameKey) ?? [];
                    arr.push(doc);
                    existingByName.set(nameKey, arr);
                }
            }
        } catch { /* treat as empty */ }

        const matchedDocIds = new Set();
        const toCreate     = [];
        const toUpdate     = [];
        const toDelete     = [];

        for (const data of pendingItems) {
            const compKey = getItemCompiledKey(data);
            const nameKey = (data.name || "").trim().toLowerCase();
            const docs = (compKey && existingByKey.get(compKey))
                || (nameKey && existingByName.get(nameKey));

            if (docs?.length) {
                const primaryDoc = docs[0];
                matchedDocIds.add(primaryDoc.id);
                toUpdate.push({ ...data, _id: primaryDoc.id });
                for (let i = 1; i < docs.length; i++) {
                    matchedDocIds.add(docs[i].id);
                    toDelete.push(docs[i].id);
                }
            } else {
                toCreate.push(data);
            }
        }

        for (const docs of existingByKey.values()) {
            for (const doc of docs) {
                if (!matchedDocIds.has(doc.id)) {
                    matchedDocIds.add(doc.id);
                    toDelete.push(doc.id);
                }
            }
        }
        for (const docs of existingByName.values()) {
            for (const doc of docs) {
                if (!matchedDocIds.has(doc.id)) {
                    matchedDocIds.add(doc.id);
                    toDelete.push(doc.id);
                }
            }
        }

        let written = 0;
        const total = toCreate.length + toUpdate.length;

        if (toCreate.length) {
            written += await this._createDocumentsResilient(
                ItemClass, toCreate, pack, safeReport, "write"
            );
            if (typeof onItemWritten === "function") {
                onItemWritten(written, total, `Created ${toCreate.length} items`);
            }
        }

        // Update path: delete then recreate. updateDocuments does a differential
        // merge on embedded effects, leaving stale effects when we reduce the
        // effects array (e.g. 10 resistance enchantments to 1). Delete+create
        // guarantees the compiled data is the ground truth.
        if (toUpdate.length) {
            const updateIds = toUpdate.map(d => d._id);
            try {
                await ItemClass.deleteDocuments(updateIds, { pack: pack.collection });
            } catch { /* if delete fails, create will just add */ }
            const freshData = toUpdate.map(({ _id, ...rest }) => rest);
            const updated = await this._createDocumentsResilient(
                ItemClass, freshData, pack, safeReport, "write"
            );
            written += updated;
            if (typeof onItemWritten === "function") {
                onItemWritten(written, total, `Updated ${toUpdate.length} items`);
            }
        }

        for (const id of toDelete) {
            try {
                await ItemClass.deleteDocuments([id], { pack: pack.collection });
            } catch { /* phantom; skip */ }
        }

        return { written, attempted: total };
    }

    /**
     * Find or create the Ionrift > Quartermaster > Compiled folder hierarchy.
     * Anchors on the existing Quartermaster folder via the reference module pack
     * so we never create a duplicate folder tree alongside the existing one.
     * @returns {Promise<string|null>}
     */
    static async _ensureCompiledFolderId() {
        return this._ensureQmSubfolderId("compiled", "Compiled", "#6d28d9");
    }

    /**
     * Ensure Ionrift > Quartermaster > Released Packs exists for public overlays.
     * @returns {Promise<string|null>}
     */
    static async _ensureReleasedFolderId() {
        return this._ensureQmSubfolderId("released", "Released Packs", "#15803d");
    }

    /**
     * Ensure Ionrift > Quartermaster > Incubating (Unreleased) exists for dev/incubating overlays.
     * @returns {Promise<string|null>}
     */
    static async _ensureIncubatingFolderId() {
        return this._ensureQmSubfolderId("incubating", "Incubating (Unreleased)", "#b45309");
    }

    /**
     * Locate or create a named subfolder under Ionrift > Quartermaster.
     * @param {string} folderKey
     * @param {string} folderName
     * @param {string} color
     * @returns {Promise<string|null>}
     */
    static async _ensureQmSubfolderId(folderKey, folderName, color) {
        const cfg     = game.settings.get("core", "compendiumConfiguration") ?? {};
        const refPack = "ionrift-quartermaster.quartermaster-containers";

        // Normalise: f.folder can be a string ID or a Folder document depending
        // on whether the folder came from game.folders vs game.packs.folders.
        // Always resolve to a plain string ID for comparison.
        const parentId = (f) => {
            const p = f?.folder;
            if (!p) return null;
            return typeof p === "string" ? p : (p?.id ?? null);
        };

        // Deduplicate by id so game.folders + game.packs.folders overlap doesn't matter.
        const allFolders = () => {
            const seen = new Set();
            return [
                ...game.folders.filter(f => f.type === "Compendium"),
                ...(game.packs?.folders?.filter(f => f.type === "Compendium") ?? [])
            ].filter(f => seen.has(f.id) ? false : seen.add(f.id));
        };

        // Step 1: locate the existing Quartermaster folder.
        // Primary: follow where the reference module pack already lives.
        let qmFolder = null;
        const refFolderId = cfg[refPack]?.folder;
        if (refFolderId) {
            qmFolder = allFolders().find(f => f.id === refFolderId) ?? null;
        }

        const matchesFolderKey = (f, key, name) => {
            const flagKey = f.getFlag ? f.getFlag(MODULE_ID, "folderKey") : f.flags?.[MODULE_ID]?.folderKey;
            if (flagKey === key) return true;
            return f.name === name;
        };

        // Secondary: name-walk under any Ionrift root
        if (!qmFolder) {
            const folders = allFolders();
            const ionriftRoots = folders.filter(f => matchesFolderKey(f, "ionrift", "Ionrift") && !parentId(f));
            for (const ion of ionriftRoots) {
                qmFolder = folders.find(f => matchesFolderKey(f, "quartermaster", "Quartermaster") && parentId(f) === ion.id);
                if (qmFolder) break;
            }
        }

        // Last resort: create the full hierarchy from scratch
        if (!qmFolder) {
            try {
                const folders = allFolders();
                let ionrift = folders.find(f => matchesFolderKey(f, "ionrift", "Ionrift") && !parentId(f));
                if (!ionrift) {
                    ionrift = await Folder.create({
                        name: "Ionrift",
                        type: "Compendium",
                        color: "#8b5cf6",
                        sorting: "a",
                        flags: { [MODULE_ID]: { folderKey: "ionrift" } }
                    });
                }
                qmFolder = await Folder.create({
                    name: "Quartermaster",
                    type: "Compendium",
                    folder: ionrift.id,
                    sorting: "a",
                    flags: { [MODULE_ID]: { folderKey: "quartermaster" } }
                });
            } catch (err) {
                Logger.warn(MODULE_LABEL, "LootPoolCompiler: could not create compendium folder hierarchy:", err);
                return null;
            }
        }

        // Step 2: find or create target subfolder under the located Quartermaster folder.
        const existing = allFolders().find(f => matchesFolderKey(f, folderKey, folderName) && parentId(f) === qmFolder.id);
        if (existing) return existing.id;

        try {
            const created = await Folder.create({
                name: folderName,
                type: "Compendium",
                folder: qmFolder.id,
                color,
                sorting: "a",
                flags: { [MODULE_ID]: { folderKey } }
            });
            return created.id;
        } catch (err) {
            Logger.warn(MODULE_LABEL, `LootPoolCompiler: could not create ${folderName} folder:`, err);
            return null;
        }
    }
}

export function applyLootPoolPackReconciler(TargetClass) {
    for (const key of Object.getOwnPropertyNames(LootPoolPackReconciler)) {
        if (key === "length" || key === "name" || key === "prototype") continue;
        const desc = Object.getOwnPropertyDescriptor(LootPoolPackReconciler, key);
        if (desc) Object.defineProperty(TargetClass, key, desc);
    }
}
