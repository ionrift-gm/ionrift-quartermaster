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
import { isSrdCursedLootName, isSrdCursedTemplateName } from "./SrdCurseCatalog.js";

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
        // Expanded by _expandGenericWeaponBonus (base weapon x tier pass).
    ],
};

// ── Rarity by bonus tier ──────────────────────────────────────────────────
const TIER_RARITY = {
    1: "uncommon",
    2: "rare",
    3: "veryRare",
};

// Shield +N uses the standard tier ladder; body armor is one step higher per tier.
const SHIELD_BONUS_RARITY = { ...TIER_RARITY };
const ARMOR_BONUS_RARITY  = { 1: "rare", 2: "veryRare", 3: "legendary" };

// ── Armor Template Manifest ───────────────────────────────────────────────
//
// Named armor templates from dnd5e.equipment24. Same GM-application shell
// pattern as weapons: zero weight, no subtype, rarity+price set on the shell.

const BASE_ARMORS = [
    "Padded Armor", "Leather Armor", "Studded Leather Armor",
    "Hide Armor", "Chain Shirt", "Scale Mail", "Breastplate", "Half Plate Armor",
    "Ring Mail", "Chain Mail", "Splint Armor", "Plate Armor",
    "Shield",
];

/** Martial and simple bases expanded into generic +N weapons (stub pass). */
const GENERIC_WEAPON_BASES = [
    "Dagger", "Handaxe", "Javelin", "Light Hammer", "Mace", "Quarterstaff",
    "Spear", "Shortbow", "Longbow", "Light Crossbow",
    "Battleaxe", "Flail", "Glaive", "Greataxe", "Greatsword", "Halberd",
    "Longsword", "Maul", "Morningstar", "Pike", "Rapier", "Scimitar",
    "Shortsword", "Trident", "War Pick", "Warhammer", "Whip"
];

// Adamantine/Mithral apply to medium and heavy armor only (SRD: not hide, not light, not shield).
const ADAMANTINE_MITHRAL_BASES = [
    "Chain Shirt", "Scale Mail", "Breastplate", "Half Plate Armor",
    "Ring Mail", "Chain Mail", "Splint Armor", "Plate Armor",
];

const RESISTANCE_BASES = BASE_ARMORS.filter(name => name !== "Shield");
const RESISTANCE_TYPES = [
    "Acid", "Cold", "Fire", "Force", "Lightning",
    "Necrotic", "Poison", "Psychic", "Radiant", "Thunder",
];



const SPECIFIC_ARMOR_TEMPLATES = [
    {
        // Efreeti Chain: fire immunity + speaks Ignan are passive,
        // but may carry a template activity — keep for fidelity.
        template: "Efreeti Chain",
        base:     "Chain Mail",
        opts:     { keepActivities: true },
    },
    {
        template: "Elven Chain",
        base:     "Chain Mail",
        opts:     { name: "Elven Chain", rarity: "rare", subtype: "medium", weight: 20 },
    },
    {
        // Plate Armor of Etherealness: has a real Use action (become Ethereal).
        template: "Plate Armor of Etherealness",
        base:     "Plate Armor",
        opts:     { name: "Plate Armor of Etherealness", keepActivities: true },
    },
    {
        template: "Plate Armor of Etherealness",
        base:     "Half Plate Armor",
        opts:     { name: "Half Plate Armor of Etherealness", keepActivities: true },
    },
];

/** Generic wondrous template shells expanded into discrete SRD variants. */
const WONDROUS_TEMPLATE_SHELLS = {
    "Belt of Giant Strength": [
        { name: "Belt of Hill Giant Strength",  rarity: "rare",     price: 8000,  weight: 1 },
        { name: "Belt of Stone Giant Strength", rarity: "veryRare", price: 20000, weight: 1 },
        { name: "Belt of Frost Giant Strength", rarity: "veryRare", price: 20000, weight: 1 },
        { name: "Belt of Fire Giant Strength",  rarity: "veryRare", price: 20000, weight: 1 },
        { name: "Belt of Cloud Giant Strength", rarity: "legendary", price: 42000, weight: 1 },
        { name: "Belt of Storm Giant Strength", rarity: "legendary", price: 42000, weight: 1 }
    ]
};

/**
 * Named items that ship with mechanics but zero economy in equipment24.
 * Compiler emits loot-ready rows; raw shells stay excluded via ItemPoolResolver.
 */
const NAMED_ECONOMY_ENRICHMENT = {
    "Helm of Brilliance":               { price: 75000, weight: 2, subtype: "light" },
    "Helm of Teleportation":            { price: 81000, weight: 2, subtype: "light" },
    "Helm of Comprehending Languages":  { price: 12000, weight: 2, subtype: "light" },
    "Helm of Telepathy":                { price: 27000, weight: 2, subtype: "light" }
};

/** 2024 slaying ammo shell expanded into base ammo × creature type rows. */
const SLAYING_AMMO_TEMPLATE = "Ammunition of Slaying";

const SLAYING_AMMO_BASES = [
    { base: "Arrow",         short: "Arrow" },
    { base: "Crossbow Bolt", short: "Bolt" },
    { base: "Needle",        short: "Needle" },
    { base: "Sling Bullet",  short: "Sling Bullet" }
];

const SLAYING_CREATURE_TYPES = [
    "Aberrations", "Beasts", "Celestials", "Constructs", "Dragons",
    "Elementals", "Fey", "Fiends", "Giants", "Humanoids",
    "Monstrosities", "Oozes", "Plants", "Undead"
];

/** Matches legacy dnd5e.items slaying ammo pricing. */
const SLAYING_AMMO_PRICE = 20000;

// ── 2024-architecture source detection ───────────────────────────────────
const ARCHITECTURE_2024_PACKS = new Set(["dnd5e.equipment24"]);

// ── LootPoolCompiler ──────────────────────────────────────────────────────

export class LootPoolCompiler {
    static COMPILER_VERSION = 17;

    static WORLD_PACK_NAME = "quartermaster-compiled-pool";
    static PACK_LABEL      = "Quartermaster: Compiled Loot Pool";
    static SETTING_HASH    = "compiledLootPoolHash";
    static SETTING_META    = "compiledLootPoolMeta";

    static get worldCollectionId() {
        return `world.${this.WORLD_PACK_NAME}`;
    }

    // ── Compile resilience (per-item isolation) ───────────────────────────

    /** @returns {{ skips: Array<{ name: string, packId: string, phase: string, reason: string }> }} */
    static _newCompileReport() {
        return { skips: [] };
    }

    /**
     * Record one skipped row. Compile continues; skips are surfaced in Forge UI.
     * @param {{ skips: object[] }} report
     * @param {{ name?: string, packId?: string, phase: string, reason: unknown }} entry
     */
    static _recordSkip(report, { name, packId = "", phase, reason }) {
        if (!report) return;
        const row = {
            name:   (name || "(unnamed)").toString(),
            packId: packId || "",
            phase:  phase || "unknown",
            reason: reason?.message ?? String(reason ?? "unknown error"),
        };
        report.skips.push(row);
        Logger.warn(
            MODULE_LABEL,
            `LootPoolCompiler: skipped [${row.phase}] "${row.name}"` +
            `${row.packId ? ` (${row.packId})` : ""}: ${row.reason}`
        );
    }

    /**
     * Run one expansion builder; record and continue on failure.
     * @param {{ skips: object[] }} report
     * @param {string} phase
     * @param {string} itemName
     * @param {string} [packId]
     * @param {function(): object|null|undefined} buildFn
     * @returns {object|null}
     */
    static _safeExpand(report, phase, itemName, packId, buildFn) {
        try {
            return buildFn() ?? null;
        } catch (err) {
            this._recordSkip(report, { name: itemName, packId, phase, reason: err });
            return null;
        }
    }

    /**
     * Human-readable skip summary for Forge status cards and notifications.
     * @param {object[]} skips
     * @param {{ maxNames?: number }} [opts]
     * @returns {string}
     */
    static formatSkippedItemsSummary(skips, { maxNames = 5 } = {}) {
        if (!skips?.length) return "";
        const names = [...new Set(skips.map(s => s.name).filter(Boolean))];
        const shown = names.slice(0, maxNames);
        const extra = names.length - shown.length;
        let text = shown.join(", ");
        if (extra > 0) text += `, and ${extra} more`;
        const noun = names.length === 1 ? "item was" : "items were";
        return `${names.length} ${noun} not imported due to compatibility issues: ${text}.`;
    }

    /** Max skip rows shown in Forge status cards and done panel. Full list stays in meta / bug report. */
    static SKIP_REPORT_DISPLAY_MAX = 12;

    /**
     * Trim skip rows for Forge UI lists. Summary line and bug report keep the full set.
     * @param {object[]} skips
     * @param {{ maxRows?: number }} [opts]
     * @returns {{ rows: object[], overflowCount: number }}
     */
    static formatSkipReportForDisplay(skips, { maxRows = this.SKIP_REPORT_DISPLAY_MAX } = {}) {
        if (!skips?.length) return { rows: [], overflowCount: 0 };
        const limit = Math.max(1, maxRows);
        const rows = skips.slice(0, limit);
        return { rows, overflowCount: Math.max(0, skips.length - limit) };
    }

    /**
     * Verify a source document can be read for expansion (name + toObject).
     * @param {Item} doc
     */
    static _probeSourceDocument(doc) {
        if (!doc) throw new Error("missing document");
        const name = doc.name;
        if (!name || !String(name).trim()) throw new Error("missing name");
        if (typeof doc.toObject === "function") doc.toObject();
    }

    /**
     * Load compendium items with per-document isolation. Falls back to index +
     * getDocument when batch getDocuments() fails (common with stale adventure data).
     *
     * @param {CompendiumCollection} pack
     * @param {{ skips: object[] }} report
     * @returns {Promise<Item[]>}
     */
    static async _loadPackDocuments(pack, report) {
        const packId = pack.collection;
        const docs   = [];

        const tryPush = (doc, fallbackName = "") => {
            try {
                this._probeSourceDocument(doc);
                docs.push(doc);
            } catch (err) {
                this._recordSkip(report, {
                    name:   doc?.name ?? fallbackName ?? doc?.id ?? "(unknown)",
                    packId,
                    phase:  "source",
                    reason: err,
                });
            }
        };

        try {
            const batch = await pack.getDocuments();
            for (const doc of batch) tryPush(doc);
            if (docs.length) return docs;
        } catch (err) {
            Logger.warn(
                MODULE_LABEL,
                `LootPoolCompiler: batch read failed for "${packId}", trying per-document: ${err.message}`
            );
        }

        try {
            const index = await pack.getIndex({ fields: ["name"] });
            for (const entry of index) {
                try {
                    const doc = await pack.getDocument(entry._id);
                    tryPush(doc, entry.name);
                } catch (err) {
                    this._recordSkip(report, {
                        name:   entry.name ?? entry._id ?? "(unknown)",
                        packId,
                        phase:  "source",
                        reason: err,
                    });
                }
            }
        } catch (err) {
            Logger.warn(MODULE_LABEL, `LootPoolCompiler: could not read "${packId}": ${err.message}`);
            this._recordSkip(report, {
                name:   pack.metadata?.label ?? packId,
                packId,
                phase:  "source",
                reason: err,
            });
        }

        return docs;
    }

    /**
     * Manifest summary for LootPoolAuditor and Forge diagnostics.
     * @returns {object}
     */
    static getCompilerManifest() {
        return {
            weaponTemplates: Object.keys(WEAPON_TEMPLATES),
            armorTemplateShells: [
                "Armor, +1, +2, or +3",
                "Adamantine Armor",
                "Mithral Armor",
                "Armor of Resistance",
                ...SPECIFIC_ARMOR_TEMPLATES.map(t => t.template)
            ],
            wondrousTemplates: Object.keys(WONDROUS_TEMPLATE_SHELLS),
            rangeStubs: Object.keys(RANGE_STUB_EXPANSIONS),
            slayingAmmoTemplate: SLAYING_AMMO_TEMPLATE,
            slayingCreatureTypes: SLAYING_CREATURE_TYPES,
            namedEconomyEnrichment: Object.keys(NAMED_ECONOMY_ENRICHMENT)
        };
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

        // Compare only sources that feed template expansion. Overlay materialised
        // packs and scroll output register in lootPoolSources at runtime but do
        // not affect the compiled pool; including them caused false stale states.
        const currentSources = this._getCompileTrackedSources().sort().join(",");
        const compiledSources = this._getCompileTrackedSources(meta?.sourceIds ?? []).sort().join(",");
        if (currentSources !== compiledSources) return "stale";

        if ((meta?.compilerVersion ?? 0) < this.COMPILER_VERSION) return "stale";

        return "fresh";
    }

    /**
     * Compute a stable hash of the current lootPoolSources configuration.
     * Async because it reads pack index sizes for a stronger signal.
     * @returns {Promise<string>}
     */
    static async computeSourceHash() {
        const sources = this._getCompileTrackedSources();
        const parts = [`v${this.COMPILER_VERSION}`, `sources:${sources.join("|")}`];
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
        const priorMeta  = this.getCompiledMeta();
        const versionStale = (priorMeta?.compilerVersion ?? 0) < this.COMPILER_VERSION;
        if (!forceRecompile && !versionStale && sourceHash === lastHash) {
            Logger.log(MODULE_LABEL, "LootPoolCompiler: pool is current. Skipping.");
            return;
        }

        // ── Load source packs ──────────────────────────────────────────
        emit("setup", 0, 1, "Loading source compendiums…");

        const report   = this._newCompileReport();
        const packDocs = new Map(); // packId → Item[]
        for (const packId of sources) {
            const pack = game.packs.get(packId);
            if (!pack || pack.documentName !== "Item") continue;
            const docs = await this._loadPackDocuments(pack, report);
            if (docs.length) packDocs.set(packId, docs);
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
            if (isSrdCursedTemplateName(templateName)) continue;
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

                    const data = this._safeExpand(
                        report, "expand", itemName, templateEntry.packId,
                        () => this._buildTemplateItem(templateDoc, baseDoc, templateName, baseName, tier)
                    );
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

                    const data = this._safeExpand(
                        report, "expand", itemName, baseEntry.packId,
                        () => this._buildAmmoItem(baseEntry.item, base, tier)
                    );
                    if (data) expandedItems.push(data);
                }
            }
        }

        // ── Armor template expansion ───────────────────────────────────
        emit("armor", 0, 1, "Expanding armor templates…");

        const armorItems = this._expandArmorTemplates(allByName, report);
        const genericArmorPlusCount = armorItems.filter(
            i => /\+\d\b/.test(i.name ?? "") && !i.name.includes("Arrow") && !i.name.includes("Bolt")
        ).length;
        for (let armorDone = 0; armorDone < armorItems.length; armorDone++) {
            emit("armor", armorDone + 1, armorItems.length, armorItems[armorDone].name ?? "");
        }
        expandedItems.push(...armorItems);

        const genericWeaponItems = this._expandGenericWeaponBonus(allByName, report);
        for (let weaponDone = 0; weaponDone < genericWeaponItems.length; weaponDone++) {
            emit("weapons", weaponDone + 1, genericWeaponItems.length, genericWeaponItems[weaponDone].name ?? "");
        }
        expandedItems.push(...genericWeaponItems);

        // ── Wondrous template expansion (belts, etc.) ────────────────────
        emit("wondrous", 0, 1, "Expanding wondrous templates…");
        const wondrousItems = this._expandWondrousTemplates(allByName, report);
        for (let i = 0; i < wondrousItems.length; i++) {
            emit("wondrous", i + 1, wondrousItems.length, wondrousItems[i].name ?? "");
        }
        expandedItems.push(...wondrousItems);

        // ── Named economy enrichment (helms, etc.) ─────────────────────
        emit("enrich", 0, 1, "Enriching named economy…");
        const enrichedItems = this._expandNamedEconomyEnrichment(allByName, report);
        for (let i = 0; i < enrichedItems.length; i++) {
            emit("enrich", i + 1, enrichedItems.length, enrichedItems[i].name ?? "");
        }
        expandedItems.push(...enrichedItems);

        // ── Slaying ammunition expansion ───────────────────────────────
        emit("slaying", 0, 1, "Expanding slaying ammunition…");
        const slayingItems = this._expandSlayingAmmunition(allByName, report);
        for (let i = 0; i < slayingItems.length; i++) {
            emit("slaying", i + 1, slayingItems.length, slayingItems[i].name ?? "");
        }
        expandedItems.push(...slayingItems);

        // ── Collision resolution ───────────────────────────────────────
        emit("collision", 0, 1, "Resolving collisions…");
        const resolved = this._filterCursedFromCompiled(
            this._collisionResolve(expandedItems, allByName, report)
        );

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

        let writeStats;
        try {
            writeStats = await this._reconcilePack(pack, resolved, (current, total, label) => {
                emit("writing", current, total, label);
            }, report);
        } catch (err) {
            Logger.error(MODULE_LABEL, "LootPoolCompiler: reconcile failed:", err);
            this._recordSkip(report, { name: "(pack write)", phase: "write", reason: err });

            const errorMeta = {
                error: true,
                errorMessage: err.message ?? String(err),
                errorAt: new Date().toISOString(),
                sourceIds: sources,
                skippedItems: report.skips,
                skippedCount: report.skips.length,
            };
            await game.settings.set(MODULE_ID, this.SETTING_META, JSON.stringify(errorMeta)).catch(() => {});

            ui.notifications.error(
                "Quartermaster: loot pool compile failed. Open Compendium Forge to retry.",
                { permanent: true }
            );
            return;
        }

        if (resolved.length > 0 && (writeStats?.written ?? 0) === 0) {
            const errorMeta = {
                error: true,
                errorMessage: "No compiled items could be written to the world compendium.",
                errorAt: new Date().toISOString(),
                sourceIds: sources,
                skippedItems: report.skips,
                skippedCount: report.skips.length,
            };
            await game.settings.set(MODULE_ID, this.SETTING_META, JSON.stringify(errorMeta)).catch(() => {});
            ui.notifications.error(
                "Quartermaster: loot pool compile failed. Open Compendium Forge to review skipped items.",
                { permanent: true }
            );
            return;
        }

        // ── Finalise ───────────────────────────────────────────────────
        const trackedSources = this._getCompileTrackedSources(sources);
        const meta = {
            compiledAt:         new Date().toISOString(),
            sourceIds:          trackedSources,
            itemCount:          writeStats?.written ?? resolved.length,
            templateCount:      templateEntries.length,
            genericArmorPlusCount,
            genericWeaponCount: genericWeaponItems.length,
            compilerVersion:    this.COMPILER_VERSION,
            skippedItems:       report.skips,
            skippedCount:       report.skips.length,
        };

        await game.settings.set(MODULE_ID, this.SETTING_HASH, sourceHash);
        await game.settings.set(MODULE_ID, this.SETTING_META, JSON.stringify(meta));
        this._enforceOwnership();
        await this._assignSidebarFolder(pack);

        emit("done", resolved.length, resolved.length, "");

        ItemPoolResolver.clearCache();

        const skipNote = report.skips.length
            ? ` ${this.formatSkippedItemsSummary(report.skips)}`
            : "";
        ui.notifications.info(
            `Quartermaster: compiled loot pool - ${meta.itemCount} items ` +
            `(${genericArmorPlusCount} generic +N armor, ${genericWeaponItems.length} generic +N weapons).` +
            skipNote
        );
        Logger.info(
            MODULE_LABEL,
            `LootPoolCompiler: ${meta.itemCount} items written ` +
            `(${genericArmorPlusCount} generic +N armor, ${genericWeaponItems.length} generic +N weapons).` +
            (report.skips.length ? ` ${report.skips.length} skipped.` : "")
        );
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

        // Strip enchantment-type effects from the template. Weapon templates
        // carry enchantment shells (for the GM drag-to-apply workflow) that
        // corrupt compiled items via {} placeholder changes. Their rider
        // effects (bonus damage, slaying, etc.) are non-enchantment type
        // and survive this filter. Also clear item-level rider tracking
        // so surviving effects aren't skipped by Actor.allApplicableEffects().
        this._stripEnchantmentShells(data);

        this._cleanCompiledDescription(data);

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

        // Defensive: strip any enchantment shells from the base ammo item.
        // Mundane ammo shouldn't have enchantments, but guard against future
        // dnd5e changes to base items.
        this._stripEnchantmentShells(data);

        return data;
    }

    /**
     * Build a discrete generic +N weapon from a mundane base weapon row.
     *
     * @param {Item} baseDoc
     * @param {string} baseName
     * @param {number} tier
     * @returns {object}
     */
    static _buildGenericBonusWeapon(baseDoc, baseName, tier) {
        const data   = baseDoc.toObject();
        const system = data.system ??= {};
        const basePrice = system.price?.value ?? 0;

        data.name = `${baseName} +${tier}`;
        system.rarity = TIER_RARITY[tier] ?? "uncommon";
        system.magicalBonus = `+${tier}`;
        if (system.price !== null && typeof system.price === "object") {
            system.price = { ...system.price, value: basePrice, denomination: system.price.denomination ?? "gp" };
        } else {
            system.price = { value: basePrice, denomination: "gp" };
        }

        data.flags ??= {};
        data.flags[MODULE_ID] ??= {};
        data.flags[MODULE_ID].mintBatch = `compiled-pool-weapon-${baseName.toLowerCase().replace(/\s+/g, "-")}-${tier}`;
        data.flags[MODULE_ID].compiledFrom = {
            template: "Weapon, +1, +2, or +3",
            base: baseName,
            tier
        };

        this._stripEnchantmentShells(data);
        return data;
    }

    /**
     * True when a source row is already a loot-ready generic +N item (not a
     * zero-weight 2024 template shell that ItemPoolResolver excludes).
     *
     * @param {object} entry
     * @returns {boolean}
     */
    static _isLootReadyGenericPlusEntry(entry) {
        const doc = typeof entry?.toObject === "function" ? entry.toObject() : entry;
        const name = (doc?.name ?? "").trim();
        if (!name || !/\+\d\b/.test(name)) return false;
        if (ItemPoolResolver._isZeroWeightWeaponTemplate(doc)) return false;
        if (ItemPoolResolver._isZeroWeightArmorTemplate(doc)) return false;
        return ItemPoolResolver._extractWeight(doc) > 0;
    }

    /**
     * True when a compendium row is a mundane weapon base suitable for +N expansion.
     *
     * @param {object} entry
     * @returns {boolean}
     */
    static _isLootReadyWeaponBase(entry) {
        const doc = typeof entry?.toObject === "function" ? entry.toObject() : entry;
        if ((doc?.type ?? "").toLowerCase() !== "weapon") return false;
        const name = (doc.name ?? "").trim();
        if (!name || /\+\d\b/.test(name)) return false;
        if (ItemPoolResolver._isZeroWeightWeaponTemplate(doc)) return false;
        const subtype = (doc.system?.type?.value ?? "").trim();
        if (!subtype || subtype === "-") return false;
        return ItemPoolResolver._extractWeight(doc) > 0;
    }

    /**
     * Discover mundane weapon bases from enabled source compendiums.
     * @param {Map<string, {item: Item, packId: string}>} allByName
     * @returns {string[]}
     */
    static _discoverGenericWeaponBases(allByName, report = null) {
        const templateNames = new Set(Object.keys(WEAPON_TEMPLATES).map(n => n.toLowerCase()));
        const discovered = [];

        for (const { item, packId } of allByName.values()) {
            try {
                const doc = typeof item?.toObject === "function" ? item.toObject() : item;
                const name = (doc?.name ?? "").trim();
                if (!name || templateNames.has(name.toLowerCase())) continue;
                if (!this._isLootReadyWeaponBase(doc)) continue;
                discovered.push(name);
            } catch (err) {
                this._recordSkip(report, {
                    name:   item?.name ?? "(weapon base scan)",
                    packId: packId ?? "",
                    phase:  "source",
                    reason: err,
                });
            }
        }

        if (discovered.length >= 8) {
            return [...new Set(discovered)].sort((a, b) => a.localeCompare(b));
        }

        const merged = new Set(discovered);
        for (const baseName of GENERIC_WEAPON_BASES) {
            const entry = allByName.get(baseName.trim().toLowerCase());
            if (entry?.item && this._isLootReadyWeaponBase(entry.item)) {
                merged.add(baseName);
            }
        }
        return [...merged].sort((a, b) => a.localeCompare(b));
    }

    /**
     * Expand the Weapon +N stub into discrete base × tier rows.
     * @param {Map<string, {item: Item, packId: string}>} allByName
     * @returns {object[]}
     */
    static _expandGenericWeaponBonus(allByName, report = null) {
        const expanded = [];
        const bases = this._discoverGenericWeaponBases(allByName, report);

        for (const baseName of bases) {
            const baseEntry = allByName.get(baseName.trim().toLowerCase());
            const baseDoc = baseEntry?.item ?? null;
            if (!baseDoc || !this._isLootReadyWeaponBase(baseDoc)) continue;

            for (const tier of [1, 2, 3]) {
                const itemName = `${baseName} +${tier}`;
                const existing = allByName.get(itemName.trim().toLowerCase());
                if (existing?.item && this._isLootReadyGenericPlusEntry(existing.item)) {
                    continue;
                }
                const data = this._safeExpand(
                    report, "expand", itemName, baseEntry.packId,
                    () => this._buildGenericBonusWeapon(baseDoc, baseName, tier)
                );
                if (data) expanded.push(data);
            }
        }

        if (expanded.length === 0) {
            Logger.warn(
                MODULE_LABEL,
                `LootPoolCompiler: generic weapon +N expansion produced 0 rows ` +
                `(discovered ${bases.length} weapon bases). Check lootPoolSources include dnd5e.equipment24.`
            );
        }

        return expanded;
    }

    /**
     * Build a discrete armor item from a template shell + base armor stats.
     *
     * @param {Item} templateDoc
     * @param {string} baseName       e.g. "Chain Mail"
     * @param {{ subtype: string, weight: number, price: number }} baseData
     * @param {{ name: string, rarity: string, price: number, weight?: number, subtype?: string, bonusTier?: number }} opts
     * @returns {object} Plain item data
     */
    static _buildArmorItem(templateDoc, baseName, baseData, opts) {
        const data         = templateDoc.toObject();
        const templateName = data.name;
        const system       = data.system ??= {};

        data.name = opts.name;

        system.rarity = opts.rarity;
        system.price  = { value: opts.price, denomination: "gp" };

        system.type ??= {};
        system.type.value    = opts.subtype ?? baseData.subtype ?? "";
        system.type.baseItem = baseName.toLowerCase();

        const weight = opts.weight ?? baseData.weight ?? 0;
        if (system.weight !== null && typeof system.weight === "object") {
            system.weight = { ...system.weight, value: weight };
        } else {
            system.weight = { value: weight, units: "lb" };
        }

        if (opts.bonusTier !== undefined) {
            system.magicalBonus = `+${opts.bonusTier}`;
        } else {
            delete system.magicalBonus;
        }

        data.flags ??= {};
        data.flags[MODULE_ID] ??= {};
        const slugBase = baseName.toLowerCase().replace(/\s+/g, "-");
        const slugName = (opts.name || "").toLowerCase().replace(/\s+/g, "-");
        data.flags[MODULE_ID].mintBatch = opts.bonusTier !== undefined
            ? `compiled-pool-armor-${slugBase}-${opts.bonusTier}`
            : `compiled-pool-armor-${slugName}`;
        data.flags[MODULE_ID].compiledFrom = opts.bonusTier !== undefined
            ? { template: templateName, base: baseName, tier: opts.bonusTier }
            : { template: templateName, base: baseName };

        if (!opts.keepActivities) this._clearArmorActivities(data);

        // Strip enchantment effects. The 2024 SRD templates carry enchantment-
        // type ActiveEffects that are template-application shells (designed for
        // dragging onto base items). On a compiled discrete item these are
        // meaningless and can corrupt data via {} placeholder changes.
        if (opts.resistanceType) {
            // Resistance items: filter down to only the matching rider effect.
            this._filterResistanceEffects(data, opts.resistanceType);
        } else if (!opts.keepActivities) {
            // +N / Adamantine / Mithral: strip all enchantment shells.
            // Keep any non-enchantment effects (defensive).
            this._stripEnchantmentShells(data);
        }
        // keepActivities items (Efreeti Chain, Etherealness): leave effects
        // untouched — they may carry real rider effects or status grants.

        this._cleanCompiledDescription(data);

        return data;
    }

    /**
     * Remove template-era activities from a compiled armor item.
     * Most armor enchantments are passive (bonus to AC, resistance, etc.).
     * Items with real actions (Plate of Etherealness) set keepActivities=true
     * to bypass this.
     * @param {object} data  Plain item data (mutated in place)
     */
    static _clearArmorActivities(data) {
        // dnd5e 2024 stores activities as a keyed object on system.activities.
        // Wipe it so no template enchantment-application actions leak through.
        if (data.system) data.system.activities = {};
    }

    /**
     * Strip enchantment-type ActiveEffects from a compiled armor item.
     * Used for +N, Adamantine, and Mithral templates whose enchantment effects
     * are template-application shells (not meaningful on discrete items).
     * Non-enchantment effects (rare, but defensive) are preserved.
     * Also clears item-level rider tracking to prevent orphaned references.
     * @param {object} data  Plain item data (mutated in place)
     */
    static _stripEnchantmentShells(data) {
        if (!Array.isArray(data.effects)) return;
        data.effects = data.effects.filter(e => e.type !== "enchantment");
        this._clearRiderFlags(data);
    }

    /**
     * Clear the item-level flags.dnd5e.riders data from compiled items.
     *
     * The dnd5e 2024 system stores rider effect/activity references on the
     * item's flags (flags.dnd5e.riders.effect, flags.dnd5e.riders.activity).
     * The Actor's allApplicableEffects() checks this flag and SKIPS any
     * effect whose ID appears in it. On compiled items where we've removed
     * the parent enchantments, these references create orphaned riders that
     * are invisible in the UI and never apply to the actor.
     *
     * @param {object} data  Plain item data (mutated in place)
     */
    static _clearRiderFlags(data) {
        if (data.flags?.dnd5e?.riders) {
            delete data.flags.dnd5e.riders;
        }
    }

    /**
     * Filter the effects array on a resistance armor item so only the
     * rider effect matching the specific damage type survives.
     *
     * The template "Armor of Resistance" carries all 10 resistance
     * enchantments. Each enchantment has:
     *   - A parent effect (type "enchantment") with changes that modify
     *     the item (name, description, price, rarity). These are template-
     *     application shells containing {} placeholders — not loot-ready.
     *   - A child rider effect (referenced by the ITEM's
     *     flags.dnd5e.riders.effect array). The rider grants actual
     *     resistance to the wearer via system.traits.dr changes.
     *
     * Critical: after filtering, we must clear the item-level
     * flags.dnd5e.riders so the surviving rider effect is treated as a
     * standalone ActiveEffect. Without this, the dnd5e Actor's
     * allApplicableEffects() skips any effect whose ID appears in
     * parent.getFlag("dnd5e", "riders.effect") — making the resistance
     * invisible AND non-functional.
     *
     * @param {object} data          Plain item data (mutated in place)
     * @param {string} resistType    e.g. "Lightning"
     */
    static _filterResistanceEffects(data, resistType) {
        if (!Array.isArray(data.effects) || !data.effects.length) return;
        const type = resistType.toLowerCase();

        // Step 1: Collect rider effect IDs from the ITEM-level flags.
        // The dnd5e 2024 system tracks riders at the item level
        // (flags.dnd5e.riders.effect), not on individual effect objects.
        const riderIds = new Set(data.flags?.dnd5e?.riders?.effect ?? []);

        // Step 2: Filter effects. Keep rider effects that match the
        // resistance type, drop everything else.
        data.effects = data.effects.filter(effect => {
            const isEnchantmentShell = effect.type === "enchantment";
            const name = (effect.name ?? "").toLowerCase();

            // Always drop parent enchantment shells — they contain template
            // application changes (e.g. name → "{} of Acid Resistance") that
            // corrupt compiled items.
            if (isEnchantmentShell) return false;

            // Keep effects whose name matches the resistance type.
            return name.includes(type);
        });

        // Step 3: Clear item-level rider tracking so surviving effects
        // behave as standalone ActiveEffects. Without this, the Actor's
        // allApplicableEffects() would skip them as orphaned riders.
        this._clearRiderFlags(data);
    }

    /**
     * Strip template-era instructional content from compiled item descriptions.
     * Removes the "Make Magical Items with Templates" section and any embedded
     * roll tables (e.g. "Armor of Resistance Type"), since the compiled item is
     * already a discrete, concrete permutation.
     * @param {object} data  Plain item data (mutated in place)
     */
    static _cleanCompiledDescription(data) {
        const desc = data.system?.description?.value;
        if (!desc || typeof desc !== "string") return;

        let cleaned = desc;

        // ── 1. Strip <section class="secret"> blocks ──────────────────────────
        // dnd5e 2024 wraps template instructions ("Make Magical Items with
        // Templates") in a secret GM section. Compiled items need none of it.
        cleaned = cleaned.replace(
            /<section[^>]*class="[^"]*secret[^"]*"[^>]*>[\s\S]*?<\/section>/gi,
            ""
        );

        // ── 2. Strip all @Embed references ────────────────────────────────────
        // Template shells contain @Embed[RollTable...] for the resistance type
        // table and @Embed[JournalEntry...] for template instructions.
        // Compiled items are concrete — they don't need any embedded content.
        cleaned = cleaned.replace(
            /(<[^>]+>)?\s*@Embed\[[^\]]*\](?:\{[^}]*\})?(<\/[^>]+>)?/gi,
            ""
        );

        // ── 3. Strip "Make Magical Items with Templates" literal text block ───
        // Fallback: if the section wasn't in a <section> tag but inline.
        cleaned = cleaned.replace(
            /(<[^>]*>)?\s*Make Magical Items with Templates[\s\S]*/i,
            ""
        );

        // ── 4. "The GM chooses the type..." lead-in sentence ──────────────────
        cleaned = cleaned.replace(
            /The GM chooses the type or determines it randomly[^.]*\./gi,
            ""
        );

        // ── 5. Footer "- Armor of Resistance Type" link ───────────────────────
        cleaned = cleaned.replace(
            /[-\u2013]\s*(<[^>]*>)?[^<]*Armor of Resistance Type[^<]*(<\/[^>]*>)?/gi,
            ""
        );

        // ── 6. Debris cleanup ─────────────────────────────────────────────────
        cleaned = cleaned.replace(/(<p>\s*<\/p>\s*){2,}/g, "");
        cleaned = cleaned.replace(/(<br\s*\/?>\s*){2,}/gi, "<br>");
        cleaned = cleaned.trim();

        data.system.description.value = cleaned;
    }

    /**
     * Expand 2024 SRD armor template shells into discrete loot-ready items.
     *
     * @param {Map<string, {item: Item, packId: string}>} allByName
     * @returns {object[]}
     */
    static _isLootReadyNamedArmorOutput(entry) {
        const doc = typeof entry?.toObject === "function" ? entry.toObject() : entry;
        if ((doc?.type ?? "").toLowerCase() !== "equipment") return false;
        if (ItemPoolResolver._isZeroWeightArmorTemplate(doc)) return false;
        const subtype = (doc.system?.type?.value ?? "").trim().toLowerCase();
        if (!["heavy", "medium", "light", "shield"].includes(subtype)) return false;
        return ItemPoolResolver._extractWeight(doc) > 0;
    }

    /**
     * Expand armor template shells into discrete loot-ready rows.
     * @param {Map<string, {item: Item, packId: string}>} allByName
     * @returns {object[]}
     */
    static _expandArmorTemplates(allByName, report = null) {
        const expanded = [];

        const shouldSkip = (name, templateDoc) => {
            try {
                const entry = allByName.get((name || "").trim().toLowerCase());
                if (!entry?.item) return false;
                if (entry.item === templateDoc) return false;
                if (this._isLootReadyGenericPlusEntry(entry.item)) return true;
                if (this._isLootReadyNamedArmorOutput(entry.item)) return true;
                return false;
            } catch (err) {
                this._recordSkip(report, { name, phase: "expand", reason: err });
                return true;
            }
        };

        const lookupTemplate = (name) => allByName.get(name.trim().toLowerCase())?.item ?? null;

        const lookupBaseData = (baseName) => {
            const entry = allByName.get(baseName.trim().toLowerCase());
            if (!entry) return null;
            try {
                const base = entry.item.toObject();
                const sys  = base.system ?? {};
                return {
                    subtype: sys.type?.value ?? "",
                    weight:  this._extractWeight(sys),
                    price:   sys.price?.value ?? 0,
                };
            } catch (err) {
                this._recordSkip(report, {
                    name:   baseName,
                    packId: entry.packId ?? "",
                    phase:  "source",
                    reason: err,
                });
                return null;
            }
        };

        const templateMeta = (templateDoc) => {
            const obj = templateDoc.toObject();
            const sys = obj.system ?? {};
            return {
                rarity: sys.rarity ?? "",
                price:  sys.price?.value ?? 0,
            };
        };

        const pushArmor = (templateDoc, baseName, baseData, opts, packId = "") => {
            const data = this._safeExpand(report, "expand", opts.name, packId, () => {
                if (shouldSkip(opts.name, templateDoc)) return null;
                return this._buildArmorItem(templateDoc, baseName, baseData, opts);
            });
            if (data) expanded.push(data);
        };

        // +N armor stub: 13 bases × 3 tiers
        const plusStub = lookupTemplate("Armor, +1, +2, or +3");
        if (plusStub) {
            for (const baseName of BASE_ARMORS) {
                const baseData = lookupBaseData(baseName);
                if (!baseData) continue;
                for (const tier of [1, 2, 3]) {
                    const rarity = baseName === "Shield"
                        ? SHIELD_BONUS_RARITY[tier]
                        : ARMOR_BONUS_RARITY[tier];
                    pushArmor(plusStub, baseName, baseData, {
                        name:      `${baseName} +${tier}`,
                        rarity,
                        price:     baseData.price,
                        bonusTier: tier,
                    });
                }
            }
        }

        // Adamantine / Mithral: medium + heavy bases (8 each)
        for (const templateName of ["Adamantine Armor", "Mithral Armor"]) {
            if (isSrdCursedTemplateName(templateName)) continue;
            const templateDoc = lookupTemplate(templateName);
            if (!templateDoc) continue;
            const { rarity, price } = templateMeta(templateDoc);
            const prefix = templateName.replace(/\s+Armor$/, "");
            for (const baseName of ADAMANTINE_MITHRAL_BASES) {
                const baseData = lookupBaseData(baseName);
                if (!baseData) continue;
                pushArmor(templateDoc, baseName, baseData, {
                    name:   `${prefix} ${baseName}`,
                    rarity: rarity || "uncommon",
                    price:  price || 400,
                });
            }
        }

        // Armor of Resistance: all bases except shield × 10 damage types (120)
        const resistTemplate = lookupTemplate("Armor of Resistance");
        if (resistTemplate) {
            const { rarity, price } = templateMeta(resistTemplate);
            for (const baseName of RESISTANCE_BASES) {
                const baseData = lookupBaseData(baseName);
                if (!baseData) continue;
                for (const resistType of RESISTANCE_TYPES) {
                    pushArmor(resistTemplate, baseName, baseData, {
                        name:          `${baseName} of Resistance (${resistType})`,
                        rarity:        rarity || "rare",
                        price:         price || 4000,
                        resistanceType: resistType,
                    });
                }
            }
        }

        // Specific named templates (Demon Armor, Elven Chain, etc.)
        for (const { template, base, opts: overrides = {} } of SPECIFIC_ARMOR_TEMPLATES) {
            if (isSrdCursedTemplateName(template)) continue;
            const templateDoc = lookupTemplate(template);
            if (!templateDoc) continue;
            const baseData = lookupBaseData(base);
            if (!baseData) continue;
            const meta = templateMeta(templateDoc);
            pushArmor(templateDoc, base, baseData, {
                name:           overrides.name ?? template,
                rarity:         overrides.rarity ?? meta.rarity,
                price:          overrides.price ?? meta.price,
                weight:         overrides.weight,
                subtype:        overrides.subtype,
                keepActivities: overrides.keepActivities ?? false,
            });
        }

        return expanded;
    }

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
            const templateEntry = allByName.get(templateName.trim().toLowerCase());
            const templateDoc   = templateEntry?.item ?? null;

            for (const variant of variants) {
                const key = variant.name.trim().toLowerCase();
                const existing = allByName.get(key);
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
            const entry = allByName.get(itemName.trim().toLowerCase());
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
        if (system.weight !== null && typeof system.weight === "object") {
            system.weight = { ...system.weight, value: weight, units: "lb" };
        } else {
            system.weight = { value: weight, units: "lb" };
        }

        data.flags ??= {};
        data.flags[MODULE_ID] ??= {};
        const slug = variant.name.toLowerCase().replace(/\s+/g, "-");
        data.flags[MODULE_ID].mintBatch = `compiled-pool-wondrous-${slug}`;
        data.flags[MODULE_ID].compiledFrom = { template: templateName, variant: variant.name };

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
        if (system.weight !== null && typeof system.weight === "object") {
            system.weight = { ...system.weight, value: spec.weight, units: "lb" };
        } else {
            system.weight = { value: spec.weight, units: "lb" };
        }

        data.flags ??= {};
        data.flags[MODULE_ID] ??= {};
        const slug = itemName.toLowerCase().replace(/\s+/g, "-");
        data.flags[MODULE_ID].mintBatch = `compiled-pool-enriched-${slug}`;
        data.flags[MODULE_ID].compiledFrom = { source: itemName, enrichment: true };

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
        const shellEntry = allByName.get(SLAYING_AMMO_TEMPLATE.toLowerCase());
        const shellDoc     = shellEntry?.item ?? null;
        if (!shellDoc) return expanded;

        for (const { base, short } of SLAYING_AMMO_BASES) {
            const baseEntry = allByName.get(base.toLowerCase());
            if (!baseEntry?.item) {
                Logger.warn(MODULE_LABEL, `LootPoolCompiler: slaying ammo base "${base}" not found.`);
                continue;
            }

            for (const creatureType of SLAYING_CREATURE_TYPES) {
                const itemName = `${short} of Slaying (${creatureType})`;
                const existing = allByName.get(itemName.toLowerCase());
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
                const riderDoc = allByName.get(riderName.toLowerCase())?.item ?? null;

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
            if (system.weight !== null && typeof system.weight === "object") {
                system.weight = { ...system.weight, value: baseWeight, units: "lb" };
            } else {
                system.weight = { value: baseWeight, units: "lb" };
            }
        }
        if (base.img && (!data.img || data.img === "icons/svg/item-bag.svg")) {
            data.img = base.img;
        }

        this._filterSlayingForCreatureType(data, creatureType, riderEffectDoc, itemName);

        data.flags ??= {};
        data.flags[MODULE_ID] ??= {};
        const slug = itemName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        data.flags[MODULE_ID].mintBatch = `compiled-pool-slaying-${slug}`;
        data.flags[MODULE_ID].compiledFrom = {
            template: SLAYING_AMMO_TEMPLATE,
            base: shortName,
            creatureType
        };

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
                const legacy = allByName.get(key);
                if (!legacy) continue;

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
        // effects array (e.g. 10 resistance enchantments → 1). Delete+create
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
}
