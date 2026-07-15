import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { MODULE_ID } from "../../data/moduleId.js";

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
 * but no `ownerThemes` - those two fields name orthogonal axes and the legacy
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


export {
    PACK_SUFFIX,
    isQmPackRole,
    readEnabledPackSources,
    resolveQmAnyPacks,
    resolveQmContainerPacks,
    resolveQmTreasurePacks,
    resolveQmGemPacks,
    resolveQmCorePacks,
    parseDiscoveryPhrases,
    containerMatchesTerrain,
    containerIsTerrainSpecific,
    isBundledContainerEntry,
    containerOwnerThemeMatches,
    CONTAINER_BUNDLED_BIAS,
    FLAVOR_TERRAIN_MATCH_MULTIPLIER,
    FLAVOR_TERRAIN_SPECIFIC_BIAS,
    flavorTerrainTags,
    flavorIsTerrainBound,
    flavorMatchesTerrain,
    flavorEligibleForTheme,
    selectBlendedContainerPool,
    loadContainerPoolIndex,
    loadFilteredPoolIndex,
    isTreasureEntry,
    isTrinketEntry,
    isGemEntry
};
