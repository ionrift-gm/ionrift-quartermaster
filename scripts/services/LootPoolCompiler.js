/**
 * LootPoolCompiler
 *
 * Resolves the 2024 SRD template-first architecture into discrete loot-ready items.
 * The dnd5e.equipment24 pack ships named weapon templates (Dragon Slayer, Holy Avenger,
 * etc.) as GM-application shells with no base subtype and weight=0 - not loot items.
 * This service expands them into a full permutation matrix:
 *   template × base weapon × bonus tier → discrete item
 *
 * Output: world.quartermaster-compiled-pool (GM-only world compendium)
 * Hash-gated: only recompiles when lootPoolSources config changes.
 * Guards: GM-only, dnd5e only.
 *
 * Structural pattern mirrors SrdCurseAdapter.js.
 */

import { Logger, MODULE_LABEL } from "../_logger.js";
import { ItemPoolResolver } from "./ItemPoolResolver.js";

const MODULE_ID = "ionrift-quartermaster";

// ── Weapon Template Manifest ──────────────────────────────────────────────
//
// Named weapon templates from dnd5e.equipment24. Each entry defines which
// base weapon subtypes the template is applied to, and which bonus tiers
// (1/2/3) are generated. Rarity is derived from tier at expansion time.
//
// This is a closed set - only templates confirmed to exist in equipment24
// as zero-weight, no-subtype shells are listed here.

const WEAPON_TEMPLATES = {
    "Dragon Slayer": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [1, 2, 3]
    },
    "Holy Avenger": {
        bases: ["Greatsword", "Longsword", "Rapier"],
        tiers: [1, 2, 3]
    },
    "Vorpal Sword": {
        bases: ["Greatsword", "Longsword", "Scimitar"],
        tiers: [2, 3]
    },
    "Flame Tongue": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [1, 2, 3]
    },
    "Frost Brand": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [1, 2, 3]
    },
    "Giant Slayer": {
        bases: ["Battleaxe", "Greataxe", "Greatsword", "Longsword", "Rapier"],
        tiers: [1, 2, 3]
    },
    "Sword of Life Stealing": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [2, 3]
    },
    "Sword of Sharpness": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar"],
        tiers: [2, 3]
    },
    "Sword of Wounding": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [2, 3]
    },
    "Sun Blade": {
        bases: ["Longsword"],
        tiers: [2, 3]
    },
    "Nine Lives Stealer": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [3]
    },
    "Dancing Sword": {
        bases: ["Greatsword", "Longsword", "Rapier", "Scimitar", "Shortsword"],
        tiers: [2, 3]
    },
};

// ── Range Stub Expansions ─────────────────────────────────────────────────
//
// Aggregate stubs like "Ammunition, +1, +2, or +3" are roll-table pointers,
// not loot items. Expand them into discrete singular ammo items.
// Plural bundle forms (Arrows, Bolts) are already excluded by _isBulkAmmoCollection.

const RANGE_STUB_EXPANSIONS = {
    "Ammunition, +1, +2, or +3": [
        { base: "Arrow",        tiers: [1, 2, 3] },
        { base: "Crossbow Bolt", tiers: [1, 2, 3] },
        { base: "Needle",       tiers: [1, 2, 3] },
        { base: "Sling Bullet", tiers: [1, 2, 3] },
    ],
    "Weapon, +1, +2, or +3": [
        // Generic +N weapons - handled by the template pass above.
        // This stub itself is excluded; generic +1/+2/+3 weapons that exist
        // as discrete entries in legacy packs still flow through the raw pool.
    ],
};

// ── Rarity by bonus tier ──────────────────────────────────────────────────
const TIER_RARITY = {
    1: "uncommon",
    2: "rare",
    3: "veryRare",
};

// ── 2024-architecture source detection ───────────────────────────────────
const ARCHITECTURE_2024_PACKS = new Set(["dnd5e.equipment24"]);

// ── LootPoolCompiler ──────────────────────────────────────────────────────

export class LootPoolCompiler {
    static WORLD_PACK_NAME = "quartermaster-compiled-pool";
    static PACK_LABEL      = "Quartermaster: Compiled Loot Pool";
    static SETTING_HASH    = "compiledLootPoolHash";
    static SETTING_META    = "compiledLootPoolMeta";

    static get worldCollectionId() {
        return `world.${this.WORLD_PACK_NAME}`;
    }

    // ── Public API ────────────────────────────────────────────────────────

    /**
     * True when any enabled lootPoolSource is a 2024-architecture pack that
     * requires compilation to produce discrete loot items.
     * @returns {boolean}
     */
    static is2024ArchitecturePresent() {
        const sources = this._getEnabledSources();
        return sources.some(id => ARCHITECTURE_2024_PACKS.has(id));
    }

    /**
     * Returns parsed compile metadata or null if never compiled.
     * @returns {{ compiledAt: string, sourceIds: string[], itemCount: number, templateCount: number }|null}
     */
    static getCompiledMeta() {
        try {
            const raw = game.settings.get(MODULE_ID, this.SETTING_META);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    /**
     * Returns the compile status of the pool.
     * @returns {"fresh"|"stale"|"never"|"error"}
     */
    static getStatus() {
        const meta = this.getCompiledMeta();
        if (meta?.error) return "error";  // last compile attempt threw

        const hash = game.settings.get(MODULE_ID, this.SETTING_HASH);
        if (!hash) return "never";

        // If the compiled pack no longer exists (e.g. deleted via sidebar),
        // treat as stale so the Forge badge and nudge both surface the problem.
        if (!game.packs.get(this.worldCollectionId)) return "stale";

        // Check if enabled sources match what was compiled
        const currentSources = this._getEnabledSources().sort().join(",");
        const compiledSources = (meta?.sourceIds ?? []).sort().join(",");
        if (currentSources !== compiledSources) return "stale";

        return "fresh";
    }

    /**
     * Compute a stable hash of the current lootPoolSources configuration.
     * Async because it reads pack index sizes for a stronger signal.
     * @returns {Promise<string>}
     */
    static async computeSourceHash() {
        const sources = this._getEnabledSources();
        const parts = [`sources:${sources.join("|")}`];
        for (const id of sources.sort()) {
            const pack = game.packs.get(id);
            if (!pack) { parts.push(`${id}:missing`); continue; }
            try {
                const index = await pack.getIndex();
                parts.push(`${id}:${index.size ?? 0}`);
            } catch {
                parts.push(`${id}:err`);
            }
        }
        return this._stableHash(parts.join("|"));
    }

    /**
     * Main compile entry point. Expands 2024 SRD templates into discrete loot
     * items and writes them to world.quartermaster-compiled-pool.
     *
     * @param {object} opts
     * @param {boolean} [opts.forceRecompile=false] Bypass hash gate.
     * @param {function} [opts.onProgress] Progress callback: ({ phase, current, total, label }) => void
     */
    static async compile({ forceRecompile = false, onProgress = null } = {}) {
        if (!game.user.isGM) return;
        if (game.system?.id !== "dnd5e") return;

        const emit = (phase, current, total, label = "") => {
            if (typeof onProgress === "function") onProgress({ phase, current, total, label });
        };

        emit("setup", 0, 1, "Checking sources…");

        const sources = this._getEnabledSources();
        const has2024 = sources.some(id => ARCHITECTURE_2024_PACKS.has(id));
        if (!has2024) {
            Logger.log(MODULE_LABEL, "LootPoolCompiler: no 2024-architecture sources enabled. Skipping.");
            return;
        }

        // ── Hash gate ──────────────────────────────────────────────────
        const sourceHash = await this.computeSourceHash();
        const lastHash   = game.settings.get(MODULE_ID, this.SETTING_HASH);
        if (!forceRecompile && sourceHash === lastHash) {
            Logger.log(MODULE_LABEL, "LootPoolCompiler: pool is current. Skipping.");
            return;
        }

        // ── Load source packs ──────────────────────────────────────────
        emit("setup", 0, 1, "Loading source compendiums…");

        const packDocs = new Map(); // packId → Item[]
        for (const packId of sources) {
            const pack = game.packs.get(packId);
            if (!pack || pack.documentName !== "Item") continue;
            try {
                const docs = await pack.getDocuments();
                packDocs.set(packId, docs);
            } catch (err) {
                Logger.warn(MODULE_LABEL, `LootPoolCompiler: could not read "${packId}": ${err.message}`);
            }
        }

        // Build name → { item, sourcePackId } map (first-seen wins within each pass)
        const allByName = new Map();
        for (const [packId, docs] of packDocs) {
            for (const doc of docs) {
                const key = (doc.name || "").trim().toLowerCase();
                if (!key) continue;
                if (!allByName.has(key)) allByName.set(key, { item: doc, packId });
            }
        }

        // ── Template × base weapon expansion ──────────────────────────
        emit("templates", 0, 1, "Expanding weapon templates…");

        const templateEntries = Object.entries(WEAPON_TEMPLATES);
        const totalTemplateItems = templateEntries.reduce(
            (sum, [, { bases, tiers }]) => sum + bases.length * tiers.length, 0
        );
        let templatesDone = 0;
        const expandedItems = [];

        for (const [templateName, { bases, tiers }] of templateEntries) {
            const templateEntry = allByName.get(templateName.trim().toLowerCase());
            if (!templateEntry) {
                Logger.warn(MODULE_LABEL, `LootPoolCompiler: template "${templateName}" not found in sources.`);
                templatesDone += bases.length * tiers.length;
                continue;
            }
            const templateDoc = templateEntry.item;

            for (const baseName of bases) {
                const baseEntry = allByName.get(baseName.trim().toLowerCase());
                if (!baseEntry) {
                    Logger.warn(MODULE_LABEL, `LootPoolCompiler: base weapon "${baseName}" not found.`);
                    templatesDone += tiers.length;
                    continue;
                }
                const baseDoc = baseEntry.item;

                for (const tier of tiers) {
                    const itemName = `${templateName} ${baseName} +${tier}`;
                    const label = itemName;
                    templatesDone++;
                    emit("templates", templatesDone, totalTemplateItems, label);

                    const data = this._buildTemplateItem(templateDoc, baseDoc, templateName, baseName, tier);
                    if (data) expandedItems.push(data);
                }
            }
        }

        // ── Range stub expansion ───────────────────────────────────────
        emit("stubs", 0, 1, "Expanding ammunition stubs…");

        const rangeStubEntries = Object.entries(RANGE_STUB_EXPANSIONS);
        const totalStubItems = rangeStubEntries.reduce(
            (sum, [, expansions]) => sum + expansions.reduce((s, e) => s + e.tiers.length, 0), 0
        );
        let stubsDone = 0;

        for (const [stubName, expansions] of rangeStubEntries) {
            if (!expansions.length) continue;
            for (const { base, tiers } of expansions) {
                const baseEntry = allByName.get(base.trim().toLowerCase());
                if (!baseEntry) {
                    Logger.warn(MODULE_LABEL, `LootPoolCompiler: ammo base "${base}" not found.`);
                    stubsDone += tiers.length;
                    continue;
                }
                for (const tier of tiers) {
                    const itemName = `${base} +${tier}`;
                    stubsDone++;
                    emit("stubs", stubsDone, totalStubItems, itemName);

                    // Check if this item already exists in sources (some packs ship
                    // "Arrow +1" as a discrete entry alongside the stub)
                    const existingEntry = allByName.get(itemName.trim().toLowerCase());
                    if (existingEntry) continue; // skip - raw pool already has it

                    const data = this._buildAmmoItem(baseEntry.item, base, tier);
                    if (data) expandedItems.push(data);
                }
            }
        }

        // ── Collision resolution ───────────────────────────────────────
        emit("collision", 0, 1, "Resolving collisions…");
        const resolved = this._collisionResolve(expandedItems, allByName);

        // ── Write to world pack ────────────────────────────────────────
        emit("writing", 0, resolved.length, "Writing compiled pool…");

        let pack = game.packs.get(this.worldCollectionId);
        if (!pack) {
            pack = await this._createWorldPack();
            if (!pack) {
                ui.notifications.error("Quartermaster: could not create compiled loot pool compendium.");
                return;
            }
            pack = game.packs.get(this.worldCollectionId) ?? pack;
        }

        try {
            await this._reconcilePack(pack, resolved, (current, total, label) => {
                emit("writing", current, total, label);
            });
        } catch (err) {
            Logger.error(MODULE_LABEL, "LootPoolCompiler: reconcile failed:", err);

            // Persist error state so the Forge UI can surface it on next open.
            // Hash is NOT written so the boot compile retries on next world load
            // and the nudge fires (status "error" !== "fresh").
            const errorMeta = {
                error: true,
                errorMessage: err.message ?? String(err),
                errorAt: new Date().toISOString(),
                sourceIds: sources,
            };
            await game.settings.set(MODULE_ID, this.SETTING_META, JSON.stringify(errorMeta)).catch(() => {});

            ui.notifications.error(
                "Quartermaster: loot pool compile failed. Open Compendium Forge to retry.",
                { permanent: true }
            );
            return;
        }

        // ── Finalise ───────────────────────────────────────────────────
        const meta = {
            compiledAt:    new Date().toISOString(),
            sourceIds:     sources,
            itemCount:     resolved.length,
            templateCount: templateEntries.length,
        };

        await game.settings.set(MODULE_ID, this.SETTING_HASH, sourceHash);
        await game.settings.set(MODULE_ID, this.SETTING_META, JSON.stringify(meta));
        this._enforceOwnership();
        await this._assignSidebarFolder(pack);

        emit("done", resolved.length, resolved.length, "");

        ui.notifications.info(
            `Quartermaster: compiled loot pool - ${resolved.length} items from ${templateEntries.length} templates.`
        );
        Logger.info(MODULE_LABEL, `LootPoolCompiler: ${resolved.length} items written.`);
    }

    // ── Item Builders ─────────────────────────────────────────────────────

    /**
     * Build a discrete weapon item from a template + base weapon.
     * Template supplies: name prefix, rarity, price, description, flags.
     * Base weapon supplies: weight, subtype, baseItem, img fallback.
     *
     * @param {Item} templateDoc
     * @param {Item} baseDoc
     * @param {string} templateName  e.g. "Dragon Slayer"
     * @param {string} baseName      e.g. "Longsword"
     * @param {number} tier          1 | 2 | 3
     * @returns {object} Plain item data
     */
    static _buildTemplateItem(templateDoc, baseDoc, templateName, baseName, tier) {
        const data   = templateDoc.toObject();
        const base   = baseDoc.toObject();
        const system = data.system ??= {};

        // Name: "Dragon Slayer Longsword +1"
        data.name = `${templateName} ${baseName} +${tier}`;

        // Image: prefer template image; fall back to base weapon image
        if (!data.img || data.img === "icons/svg/item-bag.svg") {
            data.img = base.img ?? data.img;
        }

        // Rarity: derived from bonus tier
        system.rarity = TIER_RARITY[tier] ?? "uncommon";

        // Weight: 2024 template weight=0 is unreliable. Inherit from base weapon.
        // Never downgrade a valid template weight (some future packs may fix this).
        const templateWeight = this._extractWeight(system);
        if (templateWeight === 0) {
            const baseWeight = this._extractWeight(base.system ?? {});
            if (baseWeight > 0) {
                if (system.weight !== null && typeof system.weight === "object") {
                    system.weight = { ...system.weight, value: baseWeight };
                } else {
                    system.weight = { value: baseWeight, units: "lb" };
                }
            }
        }

        // Subtype / baseItem: template has blank subtype, inherit from base
        system.type ??= {};
        if (!system.type.value || system.type.value === "-") {
            system.type.value = base.system?.type?.value ?? "";
        }
        if (!system.type.baseItem) {
            system.type.baseItem = base.system?.type?.baseItem ?? baseName.toLowerCase();
        }

        // Bonus tier stamp: stored on magicalBonus so CacheGenerator can reference it
        system.magicalBonus = `+${tier}`;

        // Flags: mint batch for reconcile tracking
        data.flags ??= {};
        data.flags[MODULE_ID] ??= {};
        data.flags[MODULE_ID].mintBatch = `compiled-pool-${templateName.toLowerCase().replace(/\s+/g, "-")}-${baseName.toLowerCase().replace(/\s+/g, "-")}-${tier}`;
        data.flags[MODULE_ID].compiledFrom = { template: templateName, base: baseName, tier };

        return data;
    }

    /**
     * Build a discrete ammunition item with a bonus tier applied.
     *
     * @param {Item} baseDoc  e.g. the Arrow item document
     * @param {string} base   e.g. "Arrow"
     * @param {number} tier   1 | 2 | 3
     * @returns {object} Plain item data
     */
    static _buildAmmoItem(baseDoc, base, tier) {
        const data   = baseDoc.toObject();
        const system = data.system ??= {};

        data.name = `${base} +${tier}`;
        system.rarity = TIER_RARITY[tier] ?? "uncommon";
        system.magicalBonus = `+${tier}`;

        data.flags ??= {};
        data.flags[MODULE_ID] ??= {};
        data.flags[MODULE_ID].mintBatch = `compiled-pool-ammo-${base.toLowerCase().replace(/\s+/g, "-")}-${tier}`;
        data.flags[MODULE_ID].compiledFrom = { template: "ammo-stub", base, tier };

        return data;
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
    static _collisionResolve(expanded, allByName) {
        for (const data of expanded) {
            const key = (data.name || "").trim().toLowerCase();
            const legacy = allByName.get(key);
            if (!legacy) continue;

            // Legacy collision: only fix weight if our version is 0
            const ourWeight = this._extractWeight(data.system ?? {});
            if (ourWeight === 0) {
                const legacyWeight = this._extractWeight(legacy.item.system ?? {});
                if (legacyWeight > 0) {
                    const sys = data.system ??= {};
                    if (sys.weight !== null && typeof sys.weight === "object") {
                        sys.weight = { ...sys.weight, value: legacyWeight };
                    } else {
                        sys.weight = { value: legacyWeight, units: "lb" };
                    }
                }
            }
        }
        return expanded;
    }

    // ── Weight / Price Helpers ────────────────────────────────────────────

    static _extractWeight(system) {
        const w = system?.weight;
        if (w === null || w === undefined) return 0;
        if (typeof w === "number") return w;
        if (typeof w === "object") return Number(w.value ?? 0) || 0;
        return Number(w) || 0;
    }

    // ── Source Helpers ────────────────────────────────────────────────────

    static _getEnabledSources() {
        return ItemPoolResolver.getEnabledSources();
    }

    // ── Hashing ───────────────────────────────────────────────────────────

    static _stableHash(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) + h) ^ str.charCodeAt(i);
        }
        return (h >>> 0).toString(16);
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
     * Reconcile pack contents: update existing, create missing, delete orphans.
     * Mirrors SrdCurseAdapter._reconcilePack.
     *
     * @param {CompendiumCollection} pack
     * @param {object[]} pendingItems
     * @param {function} [onItemWritten]  Called with (current, total, name) per item
     */
    static async _reconcilePack(pack, pendingItems, onItemWritten) {
        const ItemClass = CONFIG.Item.documentClass;
        const minting   = game.ionrift?.library?.minting;

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
        } catch { /* treat as empty */ }

        const pendingNames = new Set();
        const toCreate     = [];
        const toUpdate     = [];
        const toDelete     = [];

        for (const data of pendingItems) {
            const key  = (data.name || "").trim().toLowerCase();
            pendingNames.add(key);
            const docs = existingByName.get(key);
            if (docs?.length) {
                toUpdate.push({ ...data, _id: docs[0].id });
                for (let i = 1; i < docs.length; i++) toDelete.push(docs[i].id);
            } else {
                toCreate.push(data);
            }
        }

        for (const [key, docs] of existingByName) {
            if (pendingNames.has(key)) continue;
            for (const doc of docs) toDelete.push(doc.id);
        }

        if (minting?.guardAll && toCreate.length) {
            minting.guardAll(toCreate, { moduleId: MODULE_ID, mode: "pack" });
        }

        let written = 0;
        const total = toCreate.length + toUpdate.length;

        if (toCreate.length) {
            await ItemClass.createDocuments(toCreate, { pack: pack.collection });
            written += toCreate.length;
            if (typeof onItemWritten === "function") onItemWritten(written, total, `Created ${toCreate.length} items`);
        }

        for (const data of toUpdate) {
            try {
                await ItemClass.updateDocuments([data], { pack: pack.collection });
                written++;
                if (typeof onItemWritten === "function") onItemWritten(written, total, data.name);
            } catch { /* phantom; leave existing */ }
        }

        for (const id of toDelete) {
            try {
                await ItemClass.deleteDocuments([id], { pack: pack.collection });
            } catch { /* phantom; skip */ }
        }
    }

    static _enforceOwnership() {
        if (!game.user.isGM) return;
        const pack = game.packs.get(this.worldCollectionId);
        if (!pack) return;

        const cfg    = foundry.utils.duplicate(game.settings.get("core", "compendiumConfiguration") ?? {});
        const entry  = cfg[pack.collection] ??= {};
        const wanted = { PLAYER: "NONE", TRUSTED: "NONE", ASSISTANT: "NONE", GAMEMASTER: "OWNER" };
        const current = entry.ownership ?? {};
        const needsUpdate = Object.entries(wanted).some(([k, v]) => current[k] !== v);
        if (!needsUpdate) return;

        entry.ownership = wanted;
        game.settings.set("core", "compendiumConfiguration", cfg);
    }

    static async _assignSidebarFolder(pack) {
        if (!game.user.isGM) return;
        // Place compiled output packs under Ionrift > Quartermaster > Compiled
        // to keep them visually separate from curated content packs.
        const folderId = await this._ensureCompiledFolderId();
        if (!folderId) return;

        const packId = pack.collection;
        const cfg    = foundry.utils.duplicate(game.settings.get("core", "compendiumConfiguration") ?? {});
        cfg[packId]  = foundry.utils.mergeObject(cfg[packId] ?? {}, { folder: folderId });
        await game.settings.set("core", "compendiumConfiguration", cfg);
    }

    /**
     * Find or create the Ionrift > Quartermaster > Compiled folder hierarchy.
     * Anchors on the existing Quartermaster folder via the reference module pack
     * so we never create a duplicate folder tree alongside the existing one.
     * @returns {Promise<string|null>}
     */
    static async _ensureCompiledFolderId() {
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

        // Secondary: name-walk under any Ionrift root
        if (!qmFolder) {
            const folders = allFolders();
            const ionriftRoots = folders.filter(f => f.name === "Ionrift" && !parentId(f));
            for (const ion of ionriftRoots) {
                qmFolder = folders.find(f => f.name === "Quartermaster" && parentId(f) === ion.id);
                if (qmFolder) break;
            }
        }

        // Last resort: create the full hierarchy from scratch
        if (!qmFolder) {
            try {
                const folders = allFolders();
                let ionrift = folders.find(f => f.name === "Ionrift" && !parentId(f));
                if (!ionrift) {
                    ionrift = await Folder.create({ name: "Ionrift", type: "Compendium", color: "#8b5cf6", sorting: "a" });
                }
                qmFolder = await Folder.create({ name: "Quartermaster", type: "Compendium", folder: ionrift.id, sorting: "a" });
            } catch (err) {
                Logger.warn(MODULE_LABEL, "LootPoolCompiler: could not create compendium folder hierarchy:", err);
                return null;
            }
        }

        // Step 2: find or create Compiled under the located Quartermaster folder.
        // Use normalised parentId() so document-object vs string-ID never causes a miss.
        const compiled = allFolders().find(f => f.name === "Compiled" && parentId(f) === qmFolder.id);
        if (compiled) return compiled.id;

        try {
            const created = await Folder.create({ name: "Compiled", type: "Compendium", folder: qmFolder.id, color: "#6d28d9", sorting: "a" });
            return created.id;
        } catch (err) {
            Logger.warn(MODULE_LABEL, "LootPoolCompiler: could not create Compiled folder:", err);
            return null;
        }
    }

    /**
     * @deprecated Kept for SrdCurseAdapter parity -- use _ensureCompiledFolderId.
     */
    static async _ensureQuartermasterFolderId() {
        const allFolders = [
            ...game.folders.filter(f => f.type === "Compendium"),
            ...(game.packs?.folders?.filter(f => f.type === "Compendium") ?? [])
        ];
        const ionriftRoots = allFolders.filter(f => f.name === "Ionrift" && !f.folder);
        for (const ion of ionriftRoots) {
            const qm = allFolders.find(f => f.name === "Quartermaster" && f.folder === ion.id);
            if (qm) return qm.id;
        }
        return null;
    }
}
