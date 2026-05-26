/**
 * CacheGenerator
 * Generates level-tuned, terrain-themed loot caches for placement on enemies,
 * in treasure rooms, or directly onto scenes.
 */

import { ItemPoolResolver } from "./ItemPoolResolver.js";
import { ItemMaskingHelper } from "./ItemMaskingHelper.js";
import { SignatureLedger } from "./SignatureLedger.js";
import { ScrollForge } from "./ScrollForge.js";
import { TerrainDataRegistry } from "./TerrainDataRegistry.js";
import { Logger, MODULE_LABEL } from "../_logger.js";

const MODULE_ID = "ionrift-quartermaster";

/**
 * Compendium suffixes that identify Quartermaster pack roles regardless of
 * delivery (module manifest packs vs world packs materialised from overlays).
 */
const PACK_SUFFIX = {
    gemstones: "quartermaster-gemstones",
    treasure: "quartermaster-treasure",
    core: "quartermaster-core",
    containers: "quartermaster-containers"
};

function isQmPackRole(compendiumId, role) {
    if (!compendiumId) return false;
    const suffix = PACK_SUFFIX[role];
    return !!suffix && compendiumId.endsWith(`.${suffix}`);
}

export const __testables__ = {
    MODULE_ID,
    PACK_SUFFIX,
    isQmPackRole,
    readEnabledPackSources: () => readEnabledPackSources(),
    resolveQmAnyPacks: (suffix) => resolveQmAnyPacks(suffix),
    resolveQmContainerPacks: () => resolveQmContainerPacks(),
    resolveQmTreasurePacks: () => resolveQmTreasurePacks(),
    resolveQmGemPacks: () => resolveQmGemPacks(),
    resolveQmCorePacks: () => resolveQmCorePacks(),
    loadContainerPoolIndex: () => loadContainerPoolIndex(),
    containerMatchesTerrain: (entry, theme) => containerMatchesTerrain(entry, theme),
    containerIsTerrainSpecific: (entry, theme) => containerIsTerrainSpecific(entry, theme),
    containerOwnerThemeMatches: (entry, ownerTheme) => containerOwnerThemeMatches(entry, ownerTheme),
    isBundledContainerEntry: (entry) => isBundledContainerEntry(entry),
    selectBlendedContainerPool: (byTerrain) => selectBlendedContainerPool(byTerrain),
    get CONTAINER_BUNDLED_BIAS() { return CONTAINER_BUNDLED_BIAS; },
    flavorMatchesTerrain: (entry, theme) => flavorMatchesTerrain(entry, theme),
    flavorIsTerrainBound: (entry) => flavorIsTerrainBound(entry),
    flavorEligibleForTheme: (entry, theme) => flavorEligibleForTheme(entry, theme),
    get FLAVOR_TERRAIN_MATCH_MULTIPLIER() { return FLAVOR_TERRAIN_MATCH_MULTIPLIER; },
    get FLAVOR_TERRAIN_SPECIFIC_BIAS() { return FLAVOR_TERRAIN_SPECIFIC_BIAS; }
};

/**
 * Read the GM-managed `lootPoolSources` setting as a Set. This setting is the
 * third-party source list consumed by {@link ItemPoolResolver} (dnd5e.items,
 * dnd5e.tradegoods, world.ionrift-forged-scrolls by default). It is also where
 * {@link OverlayItemMaterialiser} records materialised `world.quartermaster-*`
 * packs so the GM can toggle them via the LootPoolConfigApp.
 *
 * Returns `null` when the setting is missing or unparseable; callers treat
 * `null` as "no constraint" and include every candidate overlay pack.
 *
 * @returns {Set<string>|null}
 */
function readEnabledPackSources() {
    try {
        const raw = game.settings.get(MODULE_ID, "lootPoolSources");
        return new Set(JSON.parse(raw));
    } catch {
        return null;
    }
}

/**
 * Generic pool scanner for a Quartermaster role (containers, treasure, gems,
 * core). Returns:
 *   1. The module-shipped pack for the role (always included; this is
 *      canonical QM content and is never gated by `lootPoolSources`).
 *   2. Every materialised overlay pack under `world.quartermaster-*` whose
 *      collection id is present in `lootPoolSources` (or all of them when the
 *      setting is missing). Overlays self-register on install via
 *      {@link OverlayItemMaterialiser._registerLootSources}, so the GM can
 *      disable an installed overlay via the LootPoolConfigApp without
 *      uninstalling it.
 *
 * Overlay packs hold mixed content (containers + gems + treasure + trinkets
 * in one sublayer), so callers filter the merged index by item kind.
 *
 * @param {string} modulePackSuffix  e.g. PACK_SUFFIX.containers
 * @returns {CompendiumCollection[]}
 */
function resolveQmAnyPacks(modulePackSuffix) {
    const enabled = readEnabledPackSources();
    const packs = [];
    const seen = new Set();

    if (modulePackSuffix) {
        const mod = game.packs.get(`${MODULE_ID}.${modulePackSuffix}`);
        if (mod) {
            packs.push(mod);
            seen.add(mod.collection);
        }
    }

    const worldPrefix = "world.quartermaster-";
    for (const pack of game.packs) {
        if (pack.metadata?.type !== "Item") continue;
        const col = pack.collection;
        if (!col.startsWith(worldPrefix)) continue;
        if (seen.has(col)) continue;
        if (enabled && !enabled.has(col)) continue;
        packs.push(pack);
        seen.add(col);
    }

    return packs;
}

/**
 * Container compendiums for cache generation. Pulls the module-shipped pack
 * plus every materialised overlay pack under `world.quartermaster-*` (one per
 * overlay sublayer). The overlay packs hold mixed content, so the index merge
 * in {@link loadContainerPoolIndex} filters to `type === "container"`.
 *
 * @returns {CompendiumCollection[]}
 */
function resolveQmContainerPacks() {
    return resolveQmAnyPacks(PACK_SUFFIX.containers);
}

/** Treasure pool. Module ships none today; overlays fill this in. */
function resolveQmTreasurePacks() {
    return resolveQmAnyPacks(PACK_SUFFIX.treasure);
}

/** Gemstone pool. Module ships none today; overlays fill this in. */
function resolveQmGemPacks() {
    return resolveQmAnyPacks(PACK_SUFFIX.gemstones);
}

/** Core pool (cultural, mastercraft, trinkets). Module ships none today. */
function resolveQmCorePacks() {
    return resolveQmAnyPacks(PACK_SUFFIX.core);
}

/** @param {string} html */
function parseDiscoveryPhrases(html) {
    if (!html || typeof html !== "string") return [];
    return html
        .split(/<\/p>/i)
        .map(part => part.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
        .filter(Boolean);
}

/**
 * True if the entry is valid for the given terrain. A container is valid when
 * its tags name the theme explicitly OR include the universal "any" marker.
 * Bundled fallback containers ship tagged ["any"] so they remain candidates
 * for every terrain alongside any terrain-specific containers shipped by
 * content overlays.
 *
 * @param {object} entry
 * @param {string} theme
 */
function containerMatchesTerrain(entry, theme) {
    const terrains = entry.flags?.["ionrift-quartermaster"]?.containerMeta?.terrains ?? ["any"];
    return terrains.includes(theme) || terrains.includes("any");
}

/** True when tagged for this terrain and not a generic any-only entry. */
function containerIsTerrainSpecific(entry, theme) {
    const terrains = entry.flags?.["ionrift-quartermaster"]?.containerMeta?.terrains ?? ["any"];
    return terrains.includes(theme) && !(terrains.length === 1 && terrains[0] === "any");
}

/**
 * True when a container pool entry comes from the bundled module pack
 * (ionrift-quartermaster.quartermaster-containers), as opposed to an
 * overlay-materialised pack under `world.quartermaster-*`.
 */
function isBundledContainerEntry(entry) {
    return entry._sourceCollection === `${MODULE_ID}.${PACK_SUFFIX.containers}`;
}

/**
 * True when a container is appropriate for the given owner theme.
 *
 * An entry that declares `containerMeta.ownerThemes` must list the active
 * theme. An entry that does NOT declare ownerThemes is treated as universal
 * and matches every owner theme. This is critical for the bundled compendium,
 * which ships with legacy `cacheTypes` ("stash", "camp_supplies", "hoard")
 * but no `ownerThemes` — those two fields name orthogonal axes and the legacy
 * cacheTypes vocabulary does not overlap with the owner theme vocabulary
 * ("unspecified", "arcana", "armaments", etc.). Treating missing ownerThemes
 * as a hard mismatch silently dropped every bundled container the moment any
 * overlay declared `ownerThemes`, because the picker would prefer the
 * overlay-matched subset and never fall through.
 */
function containerOwnerThemeMatches(entry, ownerTheme) {
    const themes = entry.flags?.["ionrift-quartermaster"]?.containerMeta?.ownerThemes;
    if (!Array.isArray(themes) || themes.length === 0) return true;
    return themes.includes(ownerTheme);
}

/**
 * Blended container picker. When the pool contains entries from both the
 * bundled module pack and one or more overlay-materialised packs, the picker
 * biases the choice between the two sources so a content overlay does not
 * shadow the bundled compendium entirely. Falls through cleanly when one
 * side is empty.
 *
 * Tuned by {@link CONTAINER_BUNDLED_BIAS}; 0.5 means equal chance per side.
 *
 * @param {object[]} byTerrain  Pre-filtered to entries valid for `theme`.
 * @returns {object[]}  The pool to uniform-random-pick from.
 */
const CONTAINER_BUNDLED_BIAS = 0.5;

/**
 * Per-entry weight when `flags.ionrift-quartermaster.terrain` includes the
 * active theme. Only applies inside the eligible pool after exclusivity filter.
 */
const FLAVOR_TERRAIN_MATCH_MULTIPLIER = 2;

/**
 * When both terrain-exclusive and generic entries are eligible, prefer the
 * exclusive subset this often before the weighted draw.
 */
const FLAVOR_TERRAIN_SPECIFIC_BIAS = 0.7;

/** @param {object} entry */
function flavorTerrainTags(entry) {
    return entry.flags?.["ionrift-quartermaster"]?.terrain ?? [];
}

/** True when the item declares at least one terrain (not universal). */
function flavorIsTerrainBound(entry) {
    return flavorTerrainTags(entry).length > 0;
}

/** @param {object} entry @param {string} theme */
function flavorMatchesTerrain(entry, theme) {
    return flavorTerrainTags(entry).includes(theme);
}

/**
 * Universal items (no terrain flag) are eligible everywhere. Terrain-bound
 * items are eligible only when the active theme is listed.
 *
 * @param {object} entry
 * @param {string} theme
 */
function flavorEligibleForTheme(entry, theme) {
    if (!flavorIsTerrainBound(entry)) return true;
    return flavorMatchesTerrain(entry, theme);
}

function selectBlendedContainerPool(byTerrain) {
    const bundled = byTerrain.filter(isBundledContainerEntry);
    const overlay = byTerrain.filter(e => !isBundledContainerEntry(e));
    if (bundled.length > 0 && overlay.length > 0) {
        return Math.random() < CONTAINER_BUNDLED_BIAS ? bundled : overlay;
    }
    if (bundled.length > 0) return bundled;
    if (overlay.length > 0) return overlay;
    return byTerrain;
}

/**
 * @returns {Promise<object[]>}
 */
async function loadContainerPoolIndex() {
    const packs = resolveQmContainerPacks();
    if (!packs.length) return [];

    const modulePackId = `${MODULE_ID}.${PACK_SUFFIX.containers}`;
    const merged = [];
    for (const pack of packs) {
        try {
            const index = await pack.getIndex({ fields: ["name", "img", "system", "flags", "type"] });
            const chunk = index.contents || Array.from(index) || [];
            const isModulePack = pack.collection === modulePackId;
            for (const entry of chunk) {
                if (!isModulePack && entry.type !== "container") continue;
                merged.push({ ...entry, _sourceCollection: pack.collection });
            }
        } catch (err) {
            Logger.warn(MODULE_LABEL, `Container index failed for ${pack.collection}:`, err.message);
        }
    }
    return merged;
}

/**
 * Build a merged pool index from one or more compendiums and apply a
 * caller-supplied kind filter. Used by gem, treasure, and trinket pickers
 * which need to scan both their role pack and every overlay sublayer pack.
 *
 * @param {CompendiumCollection[]} packs
 * @param {(entry: object) => boolean} kindFilter
 * @param {string} label  Human-readable kind name for log messages.
 * @returns {Promise<object[]>}
 */
async function loadFilteredPoolIndex(packs, kindFilter, label) {
    const merged = [];
    for (const pack of packs) {
        try {
            const index = await pack.getIndex({ fields: ["name", "img", "system", "flags", "type"] });
            const chunk = index.contents || Array.from(index) || [];
            for (const entry of chunk) {
                if (!kindFilter(entry)) continue;
                merged.push({ ...entry, _sourceCollection: pack.collection });
            }
        } catch (err) {
            Logger.warn(MODULE_LABEL, `${label} index failed for ${pack.collection}:`, err.message);
        }
    }
    return merged;
}

/** Treasure entries: loot type tagged as Treasure category. */
function isTreasureEntry(entry) {
    if (entry.type !== "loot") return false;
    const cat = entry.flags?.["ionrift-quartermaster"]?.coreMeta?.category;
    return cat === "Treasure";
}

/** Trinket entries: loot type tagged as Trinkets category. */
function isTrinketEntry(entry) {
    if (entry.type !== "loot") return false;
    const cat = entry.flags?.["ionrift-quartermaster"]?.coreMeta?.category;
    return cat === "Trinkets";
}

/** Gem entries: loot subtype "gem" or carrying a gemMeta.tier. */
function isGemEntry(entry) {
    if (entry.type !== "loot") return false;
    const sub = entry.system?.type?.value;
    if (sub === "gem") return true;
    const tier = entry.flags?.["ionrift-quartermaster"]?.gemMeta?.tier
        ?? entry.flags?.["ionrift-workshop"]?.gemMeta?.tier;
    return !!tier;
}

export class CacheGenerator {

    /** @type {Object|null} Loaded cache table data */
    static _tables = null;

    /**
     * @param {object[]} sources
     * @param {"create"|"update"|"pack"} [mode="create"]
     */
    static _guardMintSources(sources, mode = "create") {
        const minting = game.ionrift?.library?.minting;
        if (!minting?.guardAll || !sources?.length) return;
        minting.guardAll(sources, { moduleId: MODULE_ID, mode });
    }

    // ── Public API ────────────────────────────────────────────────

    /**
     * Generates a loot cache using the slot pool draw model.
     * @param {Object} options
     * @param {number} [options.tier=1] - Party tier (1-4)
     * @param {string} [options.theme="dungeon"] - Terrain theme (where the cache is)
     * @param {string} [options.ownerTheme="unspecified"] - Owner theme (whose cache it is)
     * @param {boolean} [options.silent=false] - If true, returns data without posting to chat
     * @returns {Object} { gold, items: [{ name, type, img, price, rarity, quantity }] }
     */
    static async generate(options = {}) {
        const defaultTier = game.settings?.get("ionrift-quartermaster", "defaultCacheTier") ?? 1;
        const defaultTheme = game.settings?.get("ionrift-quartermaster", "defaultCacheTheme") ?? "dungeon";

        const tier = Math.clamp(options.tier ?? defaultTier, 1, 4);
        const theme = options.theme ?? defaultTheme;
        const ownerTheme = options.ownerTheme ?? "unspecified";

        // Economy multiplier (GM configurable, default 1.0)
        const economy = game.settings?.get("ionrift-quartermaster", "lootEconomy") ?? 1.0;
        const magicMult = game.settings?.get("ionrift-quartermaster", "magicFrequency") ?? 1.0;

        const tables = await this._loadTables();
        if (tables.tiers) {
            for (const [key, td] of Object.entries(tables.tiers)) td._tier = parseInt(key);
        }
        const tierData = tables.tiers[String(tier)];
        const ownerDef = tables.ownerThemes?.[ownerTheme] ?? tables.ownerThemes?.unspecified;

        if (!tierData) {
            Logger.error(MODULE_LABEL, `Unknown tier: ${tier}`);
            return { gold: 0, items: [], container: null };
        }
        if (!ownerDef) {
            Logger.error(MODULE_LABEL, `Unknown owner theme: ${ownerTheme}`);
            return { gold: 0, items: [], container: null };
        }

        // Effective budget for this cache.
        // budgetMax caps the tier default from above (user set a ceiling).
        // budgetMin raises it from below (user wants a richer cache than the tier default).
        let effectiveBudget = (tierData.budgetCap ?? 150) * (ownerDef.budgetMultiplier ?? 1.0) * economy;
        if (options.budgetMax !== null && options.budgetMax !== undefined) effectiveBudget = Math.min(effectiveBudget, options.budgetMax);
        if (options.budgetMin !== null && options.budgetMin !== undefined) effectiveBudget = Math.max(effectiveBudget, Math.min(options.budgetMin, options.budgetMax ?? Infinity));
        const budgetFloor = options.budgetMin ?? 0;
        let spentBudget = 0;



        // Capitalise theme for display purposes when owner is unspecified
        const themeDisplay = theme.charAt(0).toUpperCase() + theme.slice(1);
        const cacheLabel = ownerTheme === "unspecified"
            ? `${themeDisplay} Cache`
            : ownerDef.label;

        const result = {
            gold: 0, items: [], container: null,
            meta: { 
                tier, theme, ownerTheme, tierLabel: tierData.label, 
                cacheLabel, economy,
                mintBatch: foundry.utils.randomID(8)
            }
        };

        // Tier-specific GP floor for filler slots. Tuned down from the
        // previous 5/15/40/100 set so failed slots and weight-overflow
        // contributions do not dominate the cache value with coin. The
        // floor still gates filler-slot price ceilings.
        const goldFillerFloor = [0, 3, 9, 25, 60][tier] ?? 3;

        // Discovery flavor is resolved after the container is picked (container
        // description paragraphs take priority over terrain phrases).

        // ── Gold: always roll, scaled by owner theme ────────────────
        const rawGold = await this._rollGold(tierData.goldDice);
        result.gold = Math.max(0, Math.round(rawGold * (ownerDef.budgetMultiplier ?? 1.0)));
        spentBudget += result.gold;

        // ── Signature: always check the Progression Registry ──────────
        const partyActors = game.ionrift?.library?.party?.getMembers()
            ?? game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
        const sugg = await SignatureLedger.getSuggestedRecipient(partyActors);
        if (sugg && !sugg.isSuppressed && sugg.actorId) {
            result.signatureOpportunity = sugg;
        }

        // ── Slot Pool Draw: build item slot list from owner theme ─────
        // Tier scaling factor: higher tiers produce larger, richer caches
        // T1: 1.0x, T2: 1.5x, T3: 2.0x, T4: 2.5x
        const tierScale = [0, 1.0, 1.5, 2.0, 2.5][tier] ?? 1.0;

        const slotRange = ownerDef.totalSlots ?? { min: 5, max: 8 };
        const scaledMin = Math.round(slotRange.min * tierScale);
        const scaledMax = Math.round(slotRange.max * tierScale);
        const totalSlotCount = Math.floor(Math.random() * (scaledMax - scaledMin + 1)) + scaledMin;
        const pool = ownerDef.slotPool ?? {};

        // Expand guaranteed entries into a flat list of slot types.
        // Entries can be plain strings ("scroll") or range objects ({ type, min, max }).
        // Range min/max are scaled by tier.
        const guaranteed = [];
        for (const entry of (ownerDef.guaranteed ?? [])) {
            if (typeof entry === "string") {
                guaranteed.push(entry);
            } else if (entry?.type) {
                const min = Math.round((entry.min ?? 1) * tierScale);
                const max = Math.round((entry.max ?? min) * tierScale);
                const count = Math.floor(Math.random() * (max - min + 1)) + min;
                for (let j = 0; j < count; j++) guaranteed.push(entry.type);
            }
        }

        // Build the slot draw list: guaranteed first, then random from pool
        const drawnSlots = [...guaranteed];
        const remainingCount = Math.max(0, totalSlotCount - drawnSlots.length);
        for (let i = 0; i < remainingCount; i++) {
            drawnSlots.push(this._weightedPoolDraw(pool));
        }

        // Container-first ordering: pick the container before items so we
        // know the weight budget. Items that don't fit are converted to gold.
        const container = await this._pickContainer(ownerTheme, theme);
        const weightBudget = container?.capacityLbs || 999;
        let currentWeight = 0;

        // ── Fill slots ────────────────────────────────────────────────
        const guaranteedCount = guaranteed.length;
        let slotsProcessed = 0;
        // When the GM sets an explicit cap, guaranteed slots are tracked against
        // spentBudget just like filler slots. Without an override, guaranteed
        // items are uncapped (original behaviour).
        const hardCap = options.budgetMax !== null && options.budgetMax !== undefined;
        for (const slotType of drawnSlots) {
            const isGuaranteed = slotsProcessed < guaranteedCount;

            // Budget gate: filler always; guaranteed only when GM has set a hard cap
            if (spentBudget >= effectiveBudget && (!isGuaranteed || hardCap)) break;

            // Budget shaping:
            // • hardCap active: ALL slots (guaranteed + filler) share remaining budget
            //   proportionally so no single item can consume the whole budget
            // • no hardCap + guaranteed: Infinity (original uncapped behaviour)
            // • no hardCap + filler: fair share of remaining budget
            const totalSlotsLeft    = Math.max(1, drawnSlots.length - slotsProcessed);
            const fillerSlotsLeft   = Math.max(1, drawnSlots.length - Math.max(slotsProcessed, guaranteedCount));
            const remainingBudget   = effectiveBudget - spentBudget;
            const priceCeiling = hardCap
                ? Math.max(remainingBudget / totalSlotsLeft, goldFillerFloor)
                : isGuaranteed
                    ? Infinity
                    : Math.max(remainingBudget / fillerSlotsLeft, goldFillerFloor);

            let item = null;
            let pickAttempts = 0;

            // Weight ceiling for this slot: never accept an item whose single
            // unit already exceeds what is left in the bag. Falls back to a
            // 45 lb sanity cap when no container constrains the cache.
            const weightCeiling = container
                ? Math.max(2, weightBudget - currentWeight)
                : 45;

            // Repick logic: reject items that are too heavy or on the GM ban list
            while (pickAttempts < 5) {
                item = await this._pickItem(slotType, theme, tierData, tables, priceCeiling);
                if (!item) break;
                if ((Number(item.weight) || 0) > weightCeiling) {
                    item = null;
                    pickAttempts++;
                } else if (await this._isBanned(item.name)) {
                    item = null;
                    pickAttempts++;
                } else {
                    break;
                }
            }

            slotsProcessed++;

            if (item) {
                // Quantity heuristic is capacity-aware: a single stack should
                // never claim more than a fair share of what is left in the bag,
                // so cheap bulky items (greatclubs, sacks of flour) cannot
                // ramp themselves up to 70 lb in a 35 lb pack.
                const remainingWeight = container
                    ? Math.max(0, weightBudget - currentWeight)
                    : null;
                const qty = (item.quantity !== null && item.quantity !== undefined && item.quantity > 1)
                    ? item.quantity
                    : this._resolveQuantity(item, { remainingWeight });
                const totalItemPrice = Math.round((item.price ?? 0) * qty * 100) / 100;
                const totalItemWeight = (Number(item.weight) || 0) * qty;

                // Weight budget check: reject if item won't fit in container
                if (container && (currentWeight + totalItemWeight) > weightBudget && result.items.length > 0) {
                    const filler = Math.floor(totalItemPrice * 0.5);
                    result.gold += filler;
                    // Track against budget when GM set a cap or slot is filler
                    if (!isGuaranteed || hardCap) spentBudget += filler;
                } else {
                    currentWeight += totalItemWeight;
                    if (!isGuaranteed || hardCap) spentBudget += totalItemPrice;
                    result.items.push({ ...item, quantity: qty, price: totalItemPrice });
                }
            } else {
                // Nothing useful in this slot -- gold filler
                const filler = Math.floor(goldFillerFloor * (0.5 + Math.random()));
                result.gold += filler;
                if (!isGuaranteed || hardCap) spentBudget += filler;
            }
        }


        // Attach container metadata (container was picked before the item loop)
        if (container) {
            const fillPercent = container.capacityLbs > 0
                ? Math.min(100, Math.round((currentWeight / container.capacityLbs) * 100))
                : 0;

            result.container = {
                ...container,
                contentWeightLbs: currentWeight,
                fillPercent,
                isOverweight: currentWeight > container.capacityLbs
            };

            CacheGenerator.applyContainerFlavor(result, theme, tables);
        }

        // Curse injection point — reserved for ionrift-cursewright.
        // Cursewright listens on this hook and runs its own applyCacheCurses().
        // Call signature: (result, options) — result.meta.mintBatch is the batch identity key.
        Hooks.callAll("ionrift-quartermaster.cacheGenerated", result, options);

        // Budget floor: if a minimum was dialled in and we fell short, bridge with gold
        if (budgetFloor > 0 && spentBudget < budgetFloor) {
            const topUp = Math.round(budgetFloor - spentBudget);
            result.gold += topUp;
        }

        if (result.gold > 0 && game.settings.get("ionrift-quartermaster", "distributeCoins") !== false) {
            result.coinage = this._distributeCoinage(result.gold);
        }

        if (!options.silent) {
            await this._postChatCard(result);
        }

        return result;
    }

    /**
     * Set result.meta.flavor from the picked container description (one random
     * paragraph) or fall back to terrain discovery phrases.
     * @param {Object} result
     * @param {string} theme
     * @param {Object} [tables]
     */
    static applyContainerFlavor(result, theme, tables = null) {
        const container = result.container;
        if (!container) return;

        const descPhrases = parseDiscoveryPhrases(container.system?.description?.value);
        if (descPhrases.length) {
            result.meta.flavor = descPhrases[Math.floor(Math.random() * descPhrases.length)];
            return;
        }

        const fromRegistry = TerrainDataRegistry.getFlavorPhrases(theme);
        const phrases = (fromRegistry?.length ? fromRegistry : null)
            ?? tables?.flavorPhrases?.[theme]
            ?? this._tables?.flavorPhrases?.[theme]
            ?? [];
        if (!phrases.length) return;

        let line = phrases[Math.floor(Math.random() * phrases.length)];
        if (line.includes("{container}")) {
            const name = container.name.toLowerCase();
            const article = /^[aeiou]/i.test(name) ? "an" : "a";
            line = line.replaceAll("{container}", `${article} ${name}`);
        }
        result.meta.flavor = line;
    }

    /**
     * Cache-time curse injection for manual cache edits and the Curse Cache action.
     * Delegates to Cursewright when that module is active.
     *
     * @param {Object} result
     * @param {Object} [options]
     * @returns {Promise<boolean>}
     */
    static async applyCacheCurses(result, options = {}) {
        const engine = game.ionrift?.cursewright?.engine;
        if (engine?.applyCacheCurses) {
            return engine.applyCacheCurses(result, options);
        }
        return false;
    }

    /** Remove all coinage from a cache preview without touching items. */
    static clearCacheGold(cacheResult) {
        if (!cacheResult) return;
        cacheResult.gold = 0;
        delete cacheResult.coinage;
    }

    /**
     * Roll a fresh base gold total for the cache tier and owner theme.
     * Items are unchanged. Uses the same dice and multipliers as initial generation.
     */
    static async rerollCacheGold(cacheResult) {
        if (!cacheResult?.meta) return cacheResult;

        const tables = await this._loadTables();
        const tier = cacheResult.meta.tier ?? 1;
        const ownerTheme = cacheResult.meta.ownerTheme ?? "unspecified";
        const tierData = tables.tiers?.[String(tier)];
        const ownerDef = tables.ownerThemes?.[ownerTheme] ?? tables.ownerThemes?.unspecified;
        if (!tierData) return cacheResult;

        const economy = game.settings.get("ionrift-quartermaster", "lootEconomy") ?? 1.0;
        const rawGold = await this._rollGold(tierData.goldDice);
        cacheResult.gold = Math.max(
            0,
            Math.round(rawGold * (ownerDef?.budgetMultiplier ?? 1.0) * economy)
        );

        if (cacheResult.gold > 0 && game.settings.get("ionrift-quartermaster", "distributeCoins") !== false) {
            cacheResult.coinage = this._distributeCoinage(cacheResult.gold);
        } else {
            delete cacheResult.coinage;
        }

        return cacheResult;
    }

    /**
     * Returns the list of available owner themes.
     * @returns {Object[]} [{ id, label, desc }]
     */
    static async getOwnerThemes() {
        const tables = await this._loadTables();
        return Object.entries(tables.ownerThemes ?? {}).map(([id, data]) => ({
            id, label: data.label, desc: data.desc
        }));
    }

    /**
     * Returns the list of valid theme keys.
     * @returns {string[]}
     */
    static async getThemes() {
        if (TerrainDataRegistry.isReady) {
            return TerrainDataRegistry.getTerrainList().map(t => t.id);
        }
        // Legacy fallback: read from cache-tables.json
        const tables = await this._loadTables();
        return Object.keys(tables.flavorPhrases ?? {});
    }

    // ── Slot Pool Draw ────────────────────────────────────────────

    /**
     * Draws a single slot type from a weighted pool.
     * Pool is an object like { "scroll": 4, "consumable": 3, "mundane": 1.5 }.
     * Higher weight = more likely to be drawn.
     * @param {Object} pool - Weighted slot pool
     * @returns {string} The drawn slot type
     */
    static _weightedPoolDraw(pool) {
        const entries = Object.entries(pool);
        if (entries.length === 0) return "mundane"; // safety fallback
        const total = entries.reduce((sum, [, w]) => sum + w, 0);
        let roll = Math.random() * total;
        for (const [type, weight] of entries) {
            roll -= weight;
            if (roll <= 0) return type;
        }
        return entries[entries.length - 1][0];
    }

    // ── Data Loading ──────────────────────────────────────────────

    static async _loadTables() {
        if (this._tables) return this._tables;

        try {
            const response = await fetch(`modules/${MODULE_ID}/data/cache-tables.json`);
            this._tables = await response.json();
        } catch (e) {
            Logger.error(MODULE_LABEL, "Failed to load cache-tables.json:", e);
            this._tables = { tiers: {}, ownerThemes: {}, flavorPhrases: {} };
        }

        return this._tables;
    }

    // ── Item Picking ──────────────────────────────────────────────

    /**
     * Picks a random item from the appropriate pool for this slot type.
     * Queries enabled compendiums via ItemPoolResolver.
     */
    static async _pickItem(slotType, theme, tierData, tables, priceCeiling = Infinity) {
        let item;
        switch (slotType) {
            case "scroll": {
                const scrollPricesByLevel = { 1: 60, 2: 120, 3: 200, 4: 320, 5: 640, 6: 1280, 7: 2560, 8: 5120, 9: 10240 };
                const tierScrollMinLevel = [0, 1, 2, 3, 5][tierData._tier ?? 1] ?? 1;
                const tierScrollMinPrice = scrollPricesByLevel[tierScrollMinLevel] ?? 60;
                const scrollCeiling = priceCeiling >= tierScrollMinPrice
                    ? priceCeiling
                    : (Math.random() < 0.40 ? tierScrollMinPrice : priceCeiling);
                item = await this._pickScroll(tierData, scrollCeiling);
                break;
            }
            case "consumable":  item = await this._pickConsumable(theme, tierData, tables, priceCeiling); break;
            case "mundane":     item = await this._pickMundane(theme, tierData, tables, priceCeiling); break;
            case "mastercraft": item = await this._pickMastercraft(theme, tierData, priceCeiling); break;
            case "gemstone":    item = await this._pickGemstone(theme, tierData, priceCeiling); break;
            case "trinket":     item = await this._pickTrinket(theme, tierData, priceCeiling); break;
            case "treasure":    item = await this._pickTreasure(theme, tierData, priceCeiling); break;
            default:            return null;
        }

        // Enrich with magical identification masking metadata
        if (item) {
            const mask = ItemMaskingHelper.detectMagical(item, { terrainTag: theme });
            if (mask.isMagical) {
                item._isMagical    = true;
                item._baseItemName = mask.baseItemName;
                item._mundaneDesc  = mask.mundaneDesc;
                if (mask.obscuredImg) {
                    item._maskSourceImg = item.img;
                    item._obscuredImg = mask.obscuredImg;
                    item.img          = mask.obscuredImg;
                }
            }
        }
        return item;
    }

    /**
     * Pick a cultural/mastercraft weapon or armor from the quartermaster-core compendium.
     * Filters to items priced within the tier's typical range.
     */
    static async _pickMastercraft(theme, tierData, priceCeiling = Infinity) {
        const tier = tierData._tier ?? 1;
        const priceMax = Math.min([0, 100, 400, 1500, 5000][tier], priceCeiling);
        const priceMin = [0, 5,   30,  200,  800 ][tier];

        const preferredMaterials = TerrainDataRegistry.getMaterials(theme);

        // Primary: query enabled compendiums via ItemPoolResolver (includes SRD dnd5e.items)
        try {
            const item = await ItemPoolResolver.pickRandom({
                slotType: "mastercraft",
                tier: tierData._tier ?? 1,
                theme,
                priceCeiling
            });
            if (item) return { ...item, quantity: 1 };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "ItemPoolResolver failed for mastercraft:", e.message);
        }

        // Fallback: scan all core-role packs for cultural / mastercraft entries.
        try {
            const packs = resolveQmCorePacks();
            if (packs.length === 0) return null;
            const kindFilter = (e) => {
                const cat = e.flags?.['ionrift-quartermaster']?.coreMeta?.category;
                return ['Cultural Weapons', 'Cultural Armor', 'Mastercraft'].includes(cat);
            };
            const pool = await loadFilteredPoolIndex(packs, kindFilter, "Mastercraft");
            const eligible = pool.filter(e => {
                const price = e.system?.price?.value ?? 0;
                return price >= priceMin && price <= priceMax;
            });

            if (eligible.length === 0) return null;

            const themed = eligible.filter(e => {
                const mat = e.flags?.['ionrift-quartermaster']?.coreMeta?.material ?? '';
                return preferredMaterials.includes(mat);
            });
            const finalPool = themed.length > 0 ? themed : eligible;
            const pick = finalPool[Math.floor(Math.random() * finalPool.length)];
            return {
                name: pick.name,
                type: pick.type ?? 'weapon',
                img: pick.img,
                price: pick.system?.price?.value ?? 30,
                weight: pick.system?.weight?.value ?? 3,
                rarity: pick.system?.rarity ?? 'common',
                _baseItem: pick.system?.type?.baseItem ?? '',
                quantity: 1,
                _compendiumId: pick._id,
                _qmKind: "mastercraft",
                sourceCompendium: pick._sourceCollection
            };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Mastercraft pool query failed:", e.message);
        }
        return null;
    }

    /**
     * Pick a gemstone from the quartermaster-gemstones compendium.
     * Tier gates which quality tier of gemstone is eligible.
     */
    static async _pickGemstone(theme, tierData, priceCeiling = Infinity) {
        const tier = tierData._tier ?? 1;
        // Tier gates which quality bands are eligible per cache tier.
        const eligibleTiers = [
            [],
            ['Chips & Fragments', 'Polished Common'],
            ['Chips & Fragments', 'Polished Common', 'Semi-Precious'],
            ['Polished Common', 'Semi-Precious', 'Precious'],
            ['Semi-Precious', 'Precious', 'Flawless']
        ][tier] ?? ['Polished Common'];

        // Tier-aware tier weights. The picker scales the gem-quality curve
        // with the cache tier so that T1 caches still favour chips and
        // common, but T2+ pushes meaningful weight onto semi-precious and
        // up. Without this, flat weights drowned out the (already rare)
        // mid-tier gems that overlay packs ship.
        const tierWeightsByCacheTier = {
            1: { 'Chips & Fragments': 3, 'Polished Common': 3 },
            2: { 'Chips & Fragments': 1, 'Polished Common': 2, 'Semi-Precious': 3 },
            3: { 'Polished Common': 1, 'Semi-Precious': 3, 'Precious': 2 },
            4: { 'Semi-Precious': 1, 'Precious': 3, 'Flawless': 2 }
        };
        const tierWeights = tierWeightsByCacheTier[tier] ?? { 'Polished Common': 1 };

        try {
            const packs = resolveQmGemPacks();
            if (packs.length === 0) return null;
            const pool = await loadFilteredPoolIndex(packs, isGemEntry, "Gemstone");
            const eligible = pool.filter(e => {
                const gemTier = e.flags?.['ionrift-quartermaster']?.gemMeta?.tier
                    ?? e.flags?.['ionrift-workshop']?.gemMeta?.tier;
                if (!eligibleTiers.includes(gemTier)) return false;
                const price = e.system?.price?.value ?? 0;
                return price <= priceCeiling;
            });
            if (eligible.length === 0) return null;

            const weighted = [];
            for (const e of eligible) {
                const gemTier = e.flags?.['ionrift-quartermaster']?.gemMeta?.tier
                    ?? e.flags?.['ionrift-workshop']?.gemMeta?.tier
                    ?? 'Polished Common';
                const w = tierWeights[gemTier] ?? 1;
                for (let i = 0; i < w; i++) weighted.push(e);
            }

            const pick = this._terrainWeightedPick(weighted, theme);
            if (!pick) return null;

            const pickedTier = pick.flags?.['ionrift-quartermaster']?.gemMeta?.tier
                ?? pick.flags?.['ionrift-workshop']?.gemMeta?.tier
                ?? 'Polished Common';
            const pickPrice = pick.system?.price?.value ?? 10;

            return {
                name: pick.name,
                type: 'loot',
                img: pick.img,
                price: pickPrice,
                weight: pick.system?.weight?.value ?? 0.1,
                rarity: pick.system?.rarity ?? 'common',
                quantity: this._resolveGemQuantity(pickedTier, pickPrice),
                _compendiumId: pick._id,
                _qmKind: "gemstones",
                _gemTier: pickedTier,
                sourceCompendium: pick._sourceCollection
            };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Gemstone pool query failed:", e.message);
        }
        return null;
    }

    /**
     * Stack count for a picked gem.
     *
     * Low-tier damaged variants are routinely scattered finds, so chips and
     * cheap polished common stones can stack into handfuls. Mid- and high-tier
     * gems are individual finds and never stack. Honest pricing is preserved;
     * this only changes the *count* the GM sees.
     *
     * @param {string} tier
     * @param {number} unitPrice
     * @returns {number}
     */
    static _resolveGemQuantity(tier, unitPrice) {
        if (tier === 'Chips & Fragments') {
            return 3 + Math.floor(Math.random() * 4);
        }
        if (tier === 'Polished Common' && unitPrice <= 12) {
            return 2 + Math.floor(Math.random() * 3);
        }
        return 1;
    }

    /**
     * Pick an art object or trade good from the quartermaster-treasure compendium.
     * Tier 1 = trade goods + cheap art, Tier 2+ = broader price range.
     */
    static async _pickTreasure(theme, tierData, priceCeiling = Infinity) {
        const tier = tierData._tier ?? 1;
        // Price gates by tier (art objects go up to ~250 gp, trade goods up to 100 gp)
        const priceMax = Math.min([0, 80, 200, 500, 5000][tier] ?? 80, priceCeiling);
        const priceMin = [0, 10,  40, 100,  250][tier] ?? 10;

        try {
            const packs = resolveQmTreasurePacks();
            if (packs.length === 0) return null;
            const pool = await loadFilteredPoolIndex(packs, isTreasureEntry, "Treasure");
            const eligible = pool.filter(e => {
                const price = e.system?.price?.value ?? 0;
                return price >= priceMin && price <= priceMax;
            });
            if (eligible.length === 0) return null;
            const pick = this._terrainWeightedPick([...eligible], theme);
            if (!pick) return null;
            return {
                name: pick.name,
                type: 'loot',
                img: pick.img,
                price: pick.system?.price?.value ?? 20,
                weight: pick.system?.weight?.value ?? 0.5,
                rarity: 'common',
                quantity: 1,
                _compendiumId: pick._id,
                _qmKind: "treasure",
                sourceCompendium: pick._sourceCollection
            };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Treasure pool query failed:", e.message);
        }
        return null;
    }


    static async _pickTrinket(theme, tierData, priceCeiling = Infinity) {
        const tier = tierData._tier ?? 1;
        // Tier-gating: trinkets have a price ceiling per tier
        const trinketCeiling = Math.min([0, 25, 75, 200, 500][tier] ?? 25, priceCeiling);

        try {
            const packs = resolveQmCorePacks();
            if (packs.length === 0) return null;
            const pool = await loadFilteredPoolIndex(packs, isTrinketEntry, "Trinket");
            const eligible = pool.filter(e => {
                const price = e.system?.price?.value ?? 0;
                return price <= trinketCeiling;
            });
            if (eligible.length === 0) return null;
            const pick = this._terrainWeightedPick([...eligible], theme);
            if (!pick) return null;
            return {
                name: pick.name,
                type: pick.type ?? 'loot',
                img: pick.img,
                price: pick.system?.price?.value ?? 5,
                weight: pick.system?.weight?.value ?? 0.1,
                rarity: pick.system?.rarity ?? 'common',
                quantity: 1,
                _compendiumId: pick._id,
                _qmKind: "trinkets",
                sourceCompendium: pick._sourceCollection
            };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Trinket pool query failed:", e.message);
        }
        return null;
    }

    /**
     * Pick a scroll from the forged world scroll compendium at the appropriate level.
     * Falls back to the stub list if the compendium is unavailable.
     */
    static async _pickScroll(tierData, priceCeiling = Infinity) {
        let maxLevel = tierData.scrollLevelMax ?? 2;
        
        // Scroll jitter: small chance to exceed the tier cap by 1-N levels
        const jitter = game.settings?.get("ionrift-quartermaster", "scrollJitter") ?? 0;
        if (jitter > 0 && Math.random() < 0.15) {
            const extra = Math.ceil(Math.random() * jitter);
            maxLevel = Math.min(maxLevel + extra, 9);
        }
        
        const level = this._weightedScrollLevel(maxLevel);

        try {
            const forgedId = `world.${ScrollForge.WORLD_PACK_NAME}`;
            const pack = game.packs.get(forgedId);
            if (pack) {
                const index = await pack.getIndex({ fields: ["name", "img", "system.price", "system.level", "flags"] });
                const scrollPrices = { 1: 60, 2: 120, 3: 200, 4: 320, 5: 640, 6: 1280, 7: 2560, 8: 5120, 9: 10240 };

                const _resolveScrollLevel = (e) =>
                    e.system?.level
                    ?? e.flags?.["ionrift-quartermaster"]?.scrollMeta?.spellLevel;

                // Exact level match first, fall back to <= level if empty
                let eligible = index.filter(e => {
                    const spellLevel = _resolveScrollLevel(e);
                    if (!spellLevel || spellLevel !== level) return false;
                    return (scrollPrices[spellLevel] ?? 60) <= priceCeiling;
                });
                if (eligible.length === 0) {
                    eligible = index.filter(e => {
                        const spellLevel = _resolveScrollLevel(e);
                        if (!spellLevel || spellLevel > level) return false;
                        return (scrollPrices[spellLevel] ?? 60) <= priceCeiling;
                    });
                }

                if (eligible.length > 0) {
                    // Party spell awareness: prefer scrolls the party doesn't already know
                    const partySpells = this._getPartyKnownSpells();
                    const novel = eligible.filter(e => {
                        const spellName = e.flags?.["ionrift-quartermaster"]?.scrollMeta?.spellName;
                        return spellName && !partySpells.has(spellName.toLowerCase());
                    });
                    const finalPool = novel.length > 0 ? novel : eligible;

                    const pick = finalPool[Math.floor(Math.random() * finalPool.length)];
                    const scrollMeta = pick.flags?.["ionrift-quartermaster"]?.scrollMeta ?? {};
                    const pickedLevel = pick.system?.level ?? scrollMeta.spellLevel;
                    return {
                        name: pick.name,
                        type: "consumable",
                        img: pick.img ?? ItemMaskingHelper._genericIconFor("scroll"),
                        price: scrollPrices[pickedLevel] ?? 60,
                        weight: 0.1,
                        rarity: pickedLevel <= 2 ? "common" : pickedLevel <= 4 ? "uncommon" : "rare",
                        quantity: 1,
                        spellLevel: pickedLevel,
                        spellName: scrollMeta.spellName,
                        _compendiumId: pick._id,
                        sourceCompendium: forgedId
                    };
                }
            }
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Scroll compendium query failed:", e.message);
        }

        // No eligible scroll in the ScrollForge pool at this level.
        // Return null — the slot loop converts empty picks to gold filler.
        // Do NOT fabricate stub scrolls from hardcoded spell lists; items
        // that don't exist in the compiled pool must not enter caches.
        Logger.warn(MODULE_LABEL,
            `No scroll available at level ${this._weightedScrollLevel(tierData.scrollLevelMax ?? 2)} — ` +
            `ensure Scroll Forge is compiled with spell sources enabled.`
        );
        return null;
    }

    /**
     * Weighted scroll level selection. Mid-tier scrolls are favored over
     * edge levels (1 and max) to produce a more balanced distribution.
     */
    static _weightedScrollLevel(maxLevel) {
        if (maxLevel <= 1) return 1;
        const weights = {};
        for (let i = 1; i <= maxLevel; i++) {
            weights[i] = Math.min(i, maxLevel - i + 1);
        }
        const total = Object.values(weights).reduce((a, b) => a + b, 0);
        let roll = Math.random() * total;
        for (const [lvl, w] of Object.entries(weights)) {
            roll -= w;
            if (roll <= 0) return parseInt(lvl);
        }
        return maxLevel;
    }

    /**
     * Collects all known spell names from party characters.
     * Uses SystemAdapter when ionrift-lib is available, with DnD5e fallback.
     */
    static _getPartyKnownSpells() {
        const SA = game.ionrift?.library?.system;
        const known = new Set();
        const actors = game.ionrift?.library?.party?.getMembers()
            ?? game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
        for (const actor of actors) {
            if (SA) {
                for (const spell of SA.getKnownSpells(actor)) known.add(spell);
            } else {
                for (const item of actor.items) {
                    if (item.type === "spell") known.add(item.name.toLowerCase());
                }
            }
        }
        return known;
    }

    /**
     * Terrain-weighted random pick from a pool of compendium index entries.
     *
     * Terrain-bound items (non-empty `terrain` flag) are exclusive: they
     * never appear outside their listed terrains. Items with no terrain flag
     * are universal and eligible everywhere.
     *
     * When both terrain-matched and generic entries are eligible, the picker
     * restricts to the matched subset with {@link FLAVOR_TERRAIN_SPECIFIC_BIAS}
     * probability so overlay kits are not drowned out by the core pool.
     *
     * @param {Object[]} pool - Array of compendium index entries
     * @param {string} theme - Current terrain theme
     * @returns {Object|undefined} The selected item
     */
    static _terrainWeightedPick(pool, theme) {
        if (pool.length === 0) return undefined;
        if (!theme) return pool[Math.floor(Math.random() * pool.length)];

        const eligible = pool.filter(item => flavorEligibleForTheme(item, theme));
        if (eligible.length === 0) return undefined;

        const specific = eligible.filter(item => flavorIsTerrainBound(item));
        const generic = eligible.filter(item => !flavorIsTerrainBound(item));

        let activePool = eligible;
        if (specific.length > 0 && generic.length > 0
            && Math.random() < FLAVOR_TERRAIN_SPECIFIC_BIAS) {
            activePool = specific;
        }

        const weighted = activePool.map(item => ({
            item,
            weight: flavorMatchesTerrain(item, theme) ? FLAVOR_TERRAIN_MATCH_MULTIPLIER : 1
        }));
        const total = weighted.reduce((sum, w) => sum + w.weight, 0);
        let roll = Math.random() * total;
        for (const { item, weight } of weighted) {
            roll -= weight;
            if (roll <= 0) return item;
        }
        return weighted[weighted.length - 1].item;
    }

    /**
     * Pick a consumable, biased toward actual potions and elixirs.
     * Resolves the full pool then splits it: 70% chance to draw from
     * the potion sub-pool, 30% from everything else.
     */
    static async _pickConsumable(theme, tierData, tables, priceCeiling = Infinity) {
        // Gather the full consumable pool
        let pool = [];
        try {
            pool = await ItemPoolResolver.resolve({
                slotType: "consumable",
                tier: tierData._tier ?? 1,
                theme,
                fallbackTables: tables
            });
        } catch (e) {
            Logger.warn(MODULE_LABEL, "ItemPoolResolver failed for consumable:", e.message);
        }

        // If resolver returned nothing, no consumables available for this theme/tier
        // (compendiums are the sole source of truth)

        if (!pool.length) return null;

        // Price ceiling
        const affordable = pool.filter(p => (p.price ?? 0) <= priceCeiling);
        const finalPool = affordable.length > 0 ? affordable : pool;

        // Split: potions vs everything else
        const isPotionLike = (item) => {
            const n = (item.name ?? "").toLowerCase();
            return n.includes("potion") || n.includes("elixir") || n.includes("philter")
                || n.includes("oil of") || n.includes("antitoxin")
                || (item.subtype ?? "").toLowerCase() === "potion";
        };

        const potions = finalPool.filter(isPotionLike);
        const other   = finalPool.filter(i => !isPotionLike(i));

        // 70% potion bias when potions exist
        const SA = game.ionrift?.library?.system;
        const situational = SA?.getSituationalConsumables?.() ?? new Set();

        function _weightedPick(arr) {
            if (!arr.length) return null;
            const tickets = [];
            for (const item of arr) {
                const count = situational.has((item.name ?? "").toLowerCase()) ? 1 : 3;
                for (let i = 0; i < count; i++) tickets.push(item);
            }
            return tickets[Math.floor(Math.random() * tickets.length)];
        }

        let pick;
        if (potions.length > 0 && (other.length === 0 || Math.random() < 0.7)) {
            pick = _weightedPick(potions);
        } else {
            pick = _weightedPick(finalPool);
        }

        return {
            name: pick.name,
            type: "consumable",
            subtype: pick.subtype ?? "",
            img: pick.img ?? "icons/consumables/potions/potion-bottle-corked-red.webp",
            price: pick.price ?? 0,
            weight: pick.weight || 0.1,
            rarity: pick.rarity ?? "common",
            quantity: 1,
            sourceCompendium: pick.sourceCompendium,
            _compendiumId: pick._compendiumId
        };
    }

    /**
     * Pick a mundane/trade goods item from enabled compendiums.
     */
    static async _pickMundane(theme, tierData, tables, priceCeiling = Infinity) {
        try {
            const item = await ItemPoolResolver.pickRandom({
                slotType: "mundane",
                tier: tierData._tier ?? 1,
                theme,
                fallbackTables: tables
            });
            if (item) return { ...item, quantity: 1 };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "ItemPoolResolver failed for mundane:", e.message);
        }
        return null;
    }

    /**
     * @deprecated Stub scroll generator — retained only for reroll compatibility.
     * ScrollForge is now the sole source of scroll items. _pickScroll returns null
     * when no eligible scroll exists; the slot loop handles the empty pick.
     * TODO: Remove once reroll paths are confirmed to never call this directly.
     */
    static _generateScrollStub(tierData) {
        const maxLevel = tierData.scrollLevelMax;
        const level = Math.max(1, Math.floor(Math.random() * maxLevel) + 1);

        // Placeholder spell names by level (Phase 2 replaces with compendium lookup)
        const spellsByLevel = {
            1: ["Shield", "Healing Word", "Magic Missile", "Detect Magic", "Sleep", "Thunderwave", "Bless", "Guiding Bolt", "Feather Fall", "Mage Armor"],
            2: ["Misty Step", "Hold Person", "Shatter", "Spiritual Weapon", "Web", "Invisibility", "Lesser Restoration", "Mirror Image"],
            3: ["Fireball", "Counterspell", "Revivify", "Fly", "Haste", "Spirit Guardians", "Dispel Magic", "Lightning Bolt"],
            4: ["Greater Invisibility", "Banishment", "Dimension Door", "Polymorph", "Wall of Fire", "Death Ward"],
            5: ["Cone of Cold", "Hold Monster", "Raise Dead", "Wall of Force", "Telekinesis", "Greater Restoration"],
            6: ["Chain Lightning", "Disintegrate", "Heal", "Globe of Invulnerability", "Sunbeam"],
            7: ["Teleport", "Finger of Death", "Forcecage", "Resurrection", "Plane Shift"],
            8: ["Power Word Stun", "Maze", "Sunburst", "Feeblemind", "Dominate Monster"],
            9: ["Wish", "Power Word Kill", "Meteor Swarm", "True Resurrection", "Gate"]
        };

        const pool = spellsByLevel[level] ?? spellsByLevel[1];
        const spell = pool[Math.floor(Math.random() * pool.length)];

        const scrollPrices = { 1: 60, 2: 120, 3: 200, 4: 320, 5: 640, 6: 1280, 7: 2560, 8: 5120, 9: 10240 };

        return {
            name: `Scroll of ${spell}`,
            weight: 0.1,
            type: "consumable",
            img: ItemMaskingHelper._genericIconFor("scroll"),
            price: scrollPrices[level] ?? 60,
            rarity: level <= 2 ? "common" : level <= 4 ? "uncommon" : level <= 6 ? "rare" : level <= 8 ? "veryRare" : "legendary",
            quantity: 1,
            spellLevel: level,
            spellName: spell
        };
    }

    /**
     * Check if an item is on the GM ban list and should be excluded from generation.
     *
     * @param {string} itemName
     * @returns {Promise<boolean>}
     */
    static async _isBanned(itemName) {
        if (!itemName) return false;
        try {
            const banSet = await SignatureLedger.getBanSet();
            return banSet.has(itemName.toLowerCase());
        } catch {
            return false; // Never block generation on ledger errors
        }
    }

    // ── Dice Rolling ──────────────────────────────────────────────

    static async _rollGold(formula) {
        try {
            const roll = await new Roll(formula).evaluate();
            return Math.floor(roll.total);
        } catch {
            return 5;
        }
    }

    /**
     * Price-based quantity heuristic.
     *
     * Cheap consumables and mundane goods naturally come in multiples.
     * The target value band (how much gp this slot *should* represent)
     * is chosen randomly within sensible bounds, then divided by the
     * unit price to get a quantity. This is purely mathematical --
     * no name lookups or item-type lists.
     *
     * Price brackets (per unit):
     *   < 0.05 gp  -> target 0.5-2 gp   -> e.g. 10-40 torches
     *   < 0.5  gp  -> target 0.5-3 gp   -> e.g. 1-6 rations
     *   < 2    gp  -> target 1-4 gp     -> e.g. 1-4 candles/chalk
     *   < 5    gp  -> target 2-6 gp     -> e.g. 1-2 flasks of oil
     *   >= 5   gp  -> quantity 1 always
     *
     * Signature, scroll, and magic items are never multiplied. Gem stacks
     * are pre-resolved by {@link _resolveGemQuantity} in {@link _pickGemstone}
     * so the slot loop's `item.quantity > 1` short-circuit honours that count
     * before this resolver is consulted.
     *
     * Weight awareness:
     *   When `opts.remainingWeight` is supplied (the bag's remaining capacity
     *   for this slot), a single stack is capped so it cannot exceed roughly
     *   half of what is left in the bag, with an absolute floor of 5 lb. This
     *   prevents one cheap bulky item (e.g. a 10 lb greatclub) from
     *   monopolising the container and forcing every other slot into coinage.
     *
     * @param {Object} item
     * @param {Object} [opts]
     * @param {number|null} [opts.remainingWeight] Remaining bag capacity in lb.
     *   Pass `null` (or omit) for cache flows without a container.
     * @returns {number}
     */
    static _resolveQuantity(item, opts = {}) {
        // Never stack these item classes
        if (item.isSignature || item.spellName) return 1;
        const rarity = (item.rarity ?? "common").toLowerCase();
        if (rarity !== "common" && rarity !== "none" && rarity !== "") return 1;
        if (item._qmKind === "gemstones" || isQmPackRole(item.sourceCompendium, "gemstones")) return 1;

        const unitPrice = item.price ?? 0;
        if (unitPrice <= 0) return 1;

        let targetMin, targetMax, qtyMax;
        if (unitPrice < 0.05) {
            targetMin = 0.5;  targetMax = 2;   qtyMax = 50;
        } else if (unitPrice < 0.5) {
            targetMin = 0.5;  targetMax = 3;   qtyMax = 20;
        } else if (unitPrice < 2) {
            targetMin = 1;    targetMax = 4;   qtyMax = 10;
        } else if (unitPrice < 5) {
            targetMin = 2;    targetMax = 6;   qtyMax = 4;
        } else {
            return 1;
        }

        const targetValue = targetMin + Math.random() * (targetMax - targetMin);
        let qty = Math.max(1, Math.min(qtyMax, Math.round(targetValue / unitPrice)));

        const unitWeight = Number(item.weight) || 0;
        if (unitWeight > 0) {
            const remaining = opts.remainingWeight;
            const stackWeightCap = (typeof remaining === "number" && remaining > 0)
                ? Math.max(5, remaining * 0.5)
                : 15;
            const weightCappedQty = Math.max(1, Math.floor(stackWeightCap / unitWeight));
            qty = Math.min(qty, weightCappedQty);
        }

        return qty;
    }

    // ── Chat Output ───────────────────────────────────────────────

    /** @type {Map<string, Object>} Pending cache results awaiting user action */
    static _pendingCaches = new Map();
    /**
     * Splits a raw GP value into a randomized mix of standard 5e coin denominations.
     */
    static _distributeCoinage(totalGp) {
        if (!totalGp || totalGp <= 0) return null;
        
        let remainingCp = Math.floor(totalGp * 100);
        const coins = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
        
        // 1. PP alloc (only sometimes when large enough)
        if (remainingCp >= 1000 && Math.random() < 0.6) {
            const maxPp = Math.floor(remainingCp / 1000);
            const ppAlloc = Math.floor(maxPp * (0.1 + Math.random() * 0.4));
            coins.pp = ppAlloc;
            remainingCp -= (ppAlloc * 1000);
        }
        
        // 2. EP alloc (rarely, small amounts)
        if (remainingCp >= 50 && Math.random() < 0.2) {
            const epAlloc = Math.floor(Math.random() * 10) + 1;
            const cost = epAlloc * 50;
            if (cost <= remainingCp * 0.2) {
                coins.ep = epAlloc;
                remainingCp -= cost;
            }
        }
        
        // 3. SP and CP (small handfuls)
        const spAlloc = Math.floor(Math.random() * 50);
        if (spAlloc * 10 <= remainingCp * 0.2) {
            coins.sp = spAlloc;
            remainingCp -= spAlloc * 10;
        }
        
        const cpAlloc = Math.floor(Math.random() * 100);
        if (cpAlloc <= remainingCp * 0.1) {
            coins.cp = cpAlloc;
            remainingCp -= cpAlloc;
        }
        
        // 4. GP takes the bulk
        const gpAlloc = Math.floor(remainingCp / 100);
        coins.gp = gpAlloc;
        remainingCp -= (gpAlloc * 100);
        
        // Dump absolute remainder into SP/CP
        if (remainingCp >= 10) {
            const extraSp = Math.floor(remainingCp / 10);
            coins.sp += extraSp;
            remainingCp -= extraSp * 10;
        }
        if (remainingCp > 0) {
            coins.cp += remainingCp;
        }
        
        for (const k of Object.keys(coins)) {
            if (coins[k] === 0) delete coins[k];
        }
        
        return Object.keys(coins).length > 0 ? coins : null;
    }

    static async _postChatCard(result) {
        const cacheId = foundry.utils.randomID();
        this._pendingCaches.set(cacheId, result);

        const { gold, items, meta: metaBase, coinage } = result;
        const meta = {
            ...metaBase,
            themeDisplay: metaBase.theme.charAt(0).toUpperCase() + metaBase.theme.slice(1)
        };
        const coinageRows = coinage
            ? ["pp", "gp", "ep", "sp", "cp"].filter(d => coinage[d]).map(d => ({ denom: d, amount: coinage[d] }))
            : [];

        const signatures  = items.filter(i => i.isSignature);
        const scrolls     = items.filter(i => i.spellName);
        const weapons     = items.filter(i => (i.type === "weapon" || i.type === "equipment") && !i.isSignature);
        const isKind = (i, role) => i._qmKind === role || isQmPackRole(i.sourceCompendium, role);
        const treasures   = items.filter(i => isKind(i, "treasure"));
        const trinkets    = items.filter(i => isKind(i, "trinkets"));
        const consumables = items.filter(i => i.type === "consumable" && !i.spellName && !i.isSignature);
        const mundane     = items.filter(i =>
            !i.isSignature && !i.spellName
            && i.type !== "weapon" && i.type !== "equipment"
            && !isKind(i, "gemstones")
            && !isKind(i, "treasure")
            && !isKind(i, "trinkets")
            && (i.type === "loot" || i.type === "tool" || !i.type)
        );
        const totalValue = Math.round((gold + items.reduce((s, i) => s + (i.price ?? 0), 0)) * 100) / 100;

        const html = await renderTemplate(
            `modules/ionrift-quartermaster/templates/partials/cache-chat-card.hbs`,
            { meta, gold, coinage, coinageRows, hasCoinage: coinageRows.length > 0,
                showGoldBlock: gold > 0,
                cacheId, totalValue, itemCount: items.length,
                signatures, scrolls, weapons, treasures, trinkets, consumables, mundane }
        );

        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: "Ionrift Quartermaster" }),
            content: html,
            whisper: game.users.filter(u => u.isGM).map(u => u.id)
        });
    }

    /**
     * Binds click handlers on cache chat card buttons.
     * Called from a renderChatMessage hook in module.js.
     */
    static bindChatListeners(html) {
        html.find(".ionrift-cache-create").on("click", async (event) => {
            const cacheId = event.currentTarget.dataset.cacheId;
            const result = this._pendingCaches.get(cacheId);
            if (!result) {
                ui.notifications.warn("Cache data expired. Generate a new cache.");
                return;
            }
            await this.createCacheItems(result);
            // Disable button after use
            $(event.currentTarget).prop("disabled", true).text("Created");
            this._pendingCaches.delete(cacheId);
        });
    }

    /**
     * Creates all items from a cache result into the world Items directory.
     * Called from the chat card button.
     * @param {Object} cacheResult - Output from generate()
     */
    static async createCacheItems(cacheResult, options = {}) {
        if (!game.user.isGM) {
            ui.notifications.warn("Only the GM can create cache items.");
            return;
        }

        const items = cacheResult.items ?? [];
        const { wrapInContainer = false, containerTerrain = 'any' } = options;

        // Create a folder for this cache
        const folderName = `Cache: ${cacheResult.meta?.cacheLabel ?? "Loot"} (${new Date().toLocaleDateString()})`;
        let folder = game.folders.find(f => f.name === folderName && f.type === "Item");
        if (!folder) {
            folder = await Folder.create({ name: folderName, type: "Item", parent: null });
        }

        // Build item data for all generated items
        const toCreate = items.map(item => {
            const base = {
                name: item.name,
                type: item.type ?? "loot",
                img: item.img ?? "icons/svg/item-bag.svg",
                folder: folder.id,
                system: {
                    quantity: item.quantity ?? 1,
                    price: { value: item.price ?? 0, denomination: "gp" },
                    rarity: item.rarity ?? "common",
                    description: { value: `<p>Generated from a ${cacheResult.meta?.cacheLabel ?? "loot cache"}.</p>` }
                },
                flags: {
                    "ionrift-quartermaster": {
                        ...(item.flags?.["ionrift-quartermaster"] || {}),
                        mintBatch: cacheResult.meta?.mintBatch
                    }
                }
            };

            if (item._isMagical) {
                ItemMaskingHelper.applyMask(base, {
                    baseItemName: item._baseItemName,
                    mundaneDesc: item._mundaneDesc,
                    obscuredImg: item._obscuredImg,
                    sourceImg: item._maskSourceImg
                });
            }

            return base;
        });

        // Add gold as a loot item
        if (cacheResult.gold > 0) {
            if (cacheResult.coinage) {
                for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                    if (cacheResult.coinage[denom]) {
                        toCreate.push({
                            name: `Coins (${denom.toUpperCase()})`,
                            type: "loot",
                            img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                            folder: folder.id,
                            system: { price: { value: cacheResult.coinage[denom], denomination: denom } }
                        });
                    }
                }
            } else {
                toCreate.push({
                    name: "Coin Purse",
                    type: "loot",
                    img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                    folder: folder.id,
                    system: {
                        quantity: 1,
                        price: { value: cacheResult.gold, denomination: "gp" },
                        description: { value: `<p>${cacheResult.gold} gold pieces.</p>` }
                    }
                });
            }
        }

        if (wrapInContainer && toCreate.length > 0) {
            // Pick a terrain-matched container from quartermaster-containers
            const container = await this._pickContainer(containerTerrain);
            if (container) {
                // Create the container, then place all generated items inside it
                const containerData = [{
                    name: container.name,
                    type: "container",
                    img: container.img,
                    folder: folder.id,
                    system: container.system ?? {}
                }];
                CacheGenerator._guardMintSources(containerData);
                const [containerItem] = await Item.create(containerData);
                // Place all items inside the container using dnd5e container system
                const innerItems = toCreate.map(i => ({ ...i, folder: folder.id, system: { ...i.system, container: containerItem.id } }));
                CacheGenerator._guardMintSources(innerItems);
                await Item.create(innerItems);
                ui.notifications.info(`Created "${container.name}" with ${innerItems.length} items in "${folderName}".`);
                return;
            }
        }

        CacheGenerator._guardMintSources(toCreate);
        const created = await Item.create(toCreate);
        ui.notifications.info(`Created ${created.length} items in "${folderName}".`);
    }

    /**
     * Pick a terrain and owner-theme appropriate container from quartermaster-containers.
     * Accepts ownerTheme for auto-matching and contentWeightLbs for capacity preference.
     * Returns a plain metadata object (not a Foundry document).
     */
    static async _pickContainer(ownerTheme = 'unspecified', theme = 'any', contentWeightLbs = 0) {
        try {
            const pool = await loadContainerPoolIndex();
            if (pool.length === 0) return null;

            // Primary filter: matches ownerTheme. Entries without an
            // ownerThemes array are treated as universal so the bundled
            // compendium (which has cacheTypes but no ownerThemes) stays
            // eligible alongside overlay entries that do declare it.
            const byTheme = pool.filter(e => containerOwnerThemeMatches(e, ownerTheme));

            // If no theme match, fall back to all containers (only possible
            // when every entry in the pool declares an ownerThemes set that
            // excludes the active theme).
            const activePool = byTheme.length > 0 ? byTheme : pool;

            // Secondary filter: terrain-matched (named or universal "any"),
            // then blend bundled-module entries with overlay-shipped entries
            // to avoid a content overlay shadowing the bundled compendium.
            const byTerrain = activePool.filter(e => containerMatchesTerrain(e, theme));
            const terrainPool = byTerrain.length > 0
                ? selectBlendedContainerPool(byTerrain)
                : activePool;

            // Prefer containers with sufficient capacity
            const withCapacity = terrainPool.filter(e => {
                const cap = e.flags?.['ionrift-quartermaster']?.containerMeta?.capacityLbs ?? 0;
                return cap >= contentWeightLbs;
            });
            const finalPool = withCapacity.length > 0 ? withCapacity : terrainPool;

            if (finalPool.length === 0) return null;
            const pick = finalPool[Math.floor(Math.random() * finalPool.length)];

            const emptyWeightLbs = ItemPoolResolver._extractWeight(pick);
            const packId = pick._sourceCollection ?? `${MODULE_ID}.${PACK_SUFFIX.containers}`;

            return {
                name: pick.name,
                img: pick.img,
                type: pick.type ?? "container",
                capacityLbs: pick.flags?.['ionrift-quartermaster']?.containerMeta?.capacityLbs ?? 0,
                emptyWeightLbs,
                _compendiumId: pick._id,
                sourceCompendium: packId,
                ...(pick.system
                    ? { system: foundry.utils.deepClone(pick.system) }
                    : {})
            };
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Container pick failed:", e.message);
            return null;
        }
    }

    /**
     * Creates all items from a cache result into the world Items directory.
     * Fallback path used when Item Piles is not installed.
     * @param {Object} result - Output from generate()
     */
    static async _addToItems(result) {
        if (!game.user.isGM) {
            ui.notifications.warn("Only the GM can create cache items.");
            return { count: 0 };
        }

        const items = result.items ?? [];
        const folderName = `Cache: ${result.meta?.cacheLabel ?? "Loot"} (${new Date().toLocaleDateString()})`;
        let folder = game.folders.find(f => f.name === folderName && f.type === "Item");
        if (!folder) {
            folder = await Folder.create({ name: folderName, type: "Item", parent: null });
        }

        const toCreate = items.map(item => {
            const data = {
                name: item.name,
                type: item.type ?? "loot",
                img: item.img ?? "icons/svg/item-bag.svg",
                folder: folder.id,
                system: {
                    quantity: item.quantity ?? 1,
                    price: { value: item.price ?? 0, denomination: "gp" },
                    weight: { value: item.weight ?? 0, units: "lb" },
                    rarity: item.rarity ?? "common",
                    description: { value: `<p>Generated from a ${result.meta?.cacheLabel ?? "loot cache"}.</p>` }
                }
            };

            // Apply identification masking for magical items
            if (item._isMagical) {
                ItemMaskingHelper.applyMask(data, {
                    baseItemName: item._baseItemName,
                    mundaneDesc: item._mundaneDesc,
                    obscuredImg: item._obscuredImg,
                    sourceImg: item._maskSourceImg
                });
            }

            return data;
        });

        // Add gold as loot items
        if (result.gold > 0) {
            if (result.coinage) {
                for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                    if (result.coinage[denom]) {
                        toCreate.push({
                            name: `Coins (${denom.toUpperCase()})`,
                            type: "loot",
                            img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                            folder: folder.id,
                            system: { price: { value: result.coinage[denom], denomination: denom } }
                        });
                    }
                }
            } else {
                toCreate.push({
                    name: "Coin Purse",
                    type: "loot",
                    img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                    folder: folder.id,
                    system: {
                        quantity: 1,
                        price: { value: result.gold, denomination: "gp" },
                        description: { value: `<p>${result.gold} gold pieces.</p>` }
                    }
                });
            }
        }

        CacheGenerator._guardMintSources(toCreate);
        const created = await Item.create(toCreate);

        ui.notifications.info(`Cache added to Items directory: ${created.length} items in "${folderName}".`);
        
        return { count: created.length };
    }
}
