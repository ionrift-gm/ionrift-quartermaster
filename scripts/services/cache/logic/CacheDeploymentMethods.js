import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../../data/moduleId.js";

import { ItemPoolResolver } from "../../loot/ItemPoolResolver.js";
import { ItemClassifier } from "../../workshop/ItemClassifier.js";
import { SignatureLedger } from "../../progression/SignatureLedger.js";
import { TerrainDataRegistry } from "../../loot/TerrainDataRegistry.js";
import { PotionEnrichment } from "../../scroll/PotionEnrichment.js";
import { roundCoinGp, formatCoinPrice, withCoinPriceLabel } from "../../workshop/CoinFormat.js";
import { Logger, MODULE_LABEL } from "../../../utils/Logger.js";
import { getQuartermasterAdapter } from "../../../adapters/getAdapter.js";
import { QM_FEATURES } from "../../../data/QMFeatures.js";
import { SquashMerger } from "../../packs/SquashMerger.js";
import { ItemResolutionPipeline } from "../../workshop/ItemResolutionPipeline.js";
import {
    CacheScrollLogic,
    SCROLL_PRICES_BY_LEVEL,
    TIER_SCROLL_MIN_LEVEL,
    TIER_SCROLL_MAX_UNIQUES
} from "./CacheScrollLogic.js";
import { CacheAmmoLogic } from "./CacheAmmoLogic.js";
import { CacheHealingLogic } from "./CacheHealingLogic.js";
import { CacheQuantityLogic } from "./CacheQuantityLogic.js";
import { CacheCoinageLogic } from "./CacheCoinageLogic.js";
import {
    PACK_SUFFIX,
    isQmPackRole,
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
    flavorMatchesTerrain,
    flavorIsTerrainBound,
    flavorEligibleForTheme,
    selectBlendedContainerPool,
    loadContainerPoolIndex,
    loadFilteredPoolIndex,
    isTreasureEntry,
    isTrinketEntry,
    isGemEntry
} from "./CachePackIndex.js";

export class CacheDeploymentMethods {
    static _pendingCaches = new Map();
    static _distributeCoinage(totalGp) { return CacheCoinageLogic._distributeCoinage(totalGp); }

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
        const totalValueRaw = gold + items.reduce((s, i) => s + (i.price ?? 0), 0);
        const totalValue = roundCoinGp(totalValueRaw);
        const labelItems = (arr) => arr.map(i => withCoinPriceLabel(i));

        const html = await renderTemplate(
            `modules/ionrift-quartermaster/templates/partials/cache-chat-card.hbs`,
            { meta, gold, coinage, coinageRows, hasCoinage: coinageRows.length > 0,
                showGoldBlock: gold > 0,
                cacheId, totalValue, totalValueLabel: formatCoinPrice(totalValueRaw),
                itemCount: items.length,
                signatures, scrolls, weapons,
                treasures: labelItems(treasures),
                trinkets: labelItems(trinkets),
                consumables: labelItems(consumables),
                mundane: labelItems(mundane) }
        );

        const gmWhisper = game.users.filter(u => u.isGM).map(u => u.id);
        const rolls = result._goldRoll ? [result._goldRoll] : [];
        const rollService = game.ionrift?.library?.rolls;
        if (rollService?.postCard) {
            await rollService.postCard({
                speaker: ChatMessage.getSpeaker({ alias: "Ionrift Quartermaster" }),
                content: html,
                rolls,
                chatMode: "gm",
                whisper: gmWhisper,
                settle: rolls.length > 0
            });
            return;
        }

        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ alias: "Ionrift Quartermaster" }),
            content: html,
            whisper: gmWhisper,
            ...(rolls.length ? { rolls } : {})
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
                ui.notifications.warn(game.i18n.localize("ionrift-quartermaster.cacheGenerator.notifyCacheDataExpired"));
                return;
            }
            await this.createCacheItems(result);
            // Disable button after use
            $(event.currentTarget).prop("disabled", true).text(game.i18n.localize("ionrift-quartermaster.cacheGenerator.btnCreated"));
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
            ui.notifications.warn(game.i18n.localize("ionrift-quartermaster.cacheGenerator.notifyGmOnlyCreateCacheItems"));
            return;
        }

        const items = cacheResult.items ?? [];
        const { wrapInContainer = false, containerTerrain = 'any' } = options;

        // Create a folder for this cache
        const folderName = `Cache: ${cacheResult.meta?.cacheLabel ?? "Loot"} (${new Date().toLocaleDateString()})`;
        const folderKey = `cache-items-${String(cacheResult.meta?.cacheLabel ?? "loot").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        let folder = game.folders.find(f => (f.getFlag?.(MODULE_ID, "folderKey") === folderKey || f.flags?.[MODULE_ID]?.folderKey === folderKey || f.name === folderName) && f.type === "Item");
        if (!folder) {
            folder = await Folder.create({ name: folderName, type: "Item", parent: null, flags: { [MODULE_ID]: { folderKey } } });
        }

        // Build item data for all generated items via the active system adapter
        const adapter = getQuartermasterAdapter();
        const meta = cacheResult.meta ?? {};
        const toCreate = items.map(item => {
            const base = adapter.buildCacheItemPayload(item, meta);
            base.folder = folder.id;
            if (!base.img) base.img = DEFAULT_ITEM_ICON;
            base.flags = {
                ...(base.flags || {}),
                [MODULE_ID]: {
                    ...(base.flags?.[MODULE_ID] || {}),
                    ...(item.flags?.[MODULE_ID] || {}),
                    mintBatch: cacheResult.meta?.mintBatch
                }
            };

            if (item._isMagical) {
                adapter.applyCacheMask(base, {
                    baseItemName: item._baseItemName,
                    mundaneDesc: item._mundaneDesc,
                    obscuredImg: item._obscuredImg,
                    sourceImg: item._maskSourceImg
                });
            }

            return base;
        });

        // Add gold via adapter coin builder
        if (cacheResult.gold > 0) {
            for (const coin of adapter.buildCoinItems(cacheResult, meta)) {
                coin.folder = folder.id;
                toCreate.push(coin);
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
                this._guardMintSources(containerData);
                const [containerItem] = await Item.create(containerData);
                // Place all items inside the container using dnd5e container system
                const innerItems = toCreate.map(i => ({ ...i, folder: folder.id, system: { ...i.system, container: containerItem.id } }));
                this._guardMintSources(innerItems);
                await Item.create(innerItems);
                ui.notifications.info(game.i18n.format("ionrift-quartermaster.cacheGenerator.notifyCreatedContainerWithItems", { container: container.name, count: innerItems.length, folder: folderName }));
                return;
            }
        }

        this._guardMintSources(toCreate);
        const created = await Item.create(toCreate);
        ui.notifications.info(game.i18n.format("ionrift-quartermaster.cacheGenerator.notifyCreatedItemsInFolder", { count: created.length, folder: folderName }));
    }

    /**
     * Pick a terrain and owner-theme appropriate container from quartermaster-containers.
     * Accepts ownerTheme for auto-matching and contentWeightLbs for capacity preference.
     * Returns a plain metadata object (not a Foundry document).
     */
    static async _pickContainer(ownerTheme = 'unspecified', theme = 'any', contentWeightLbs = 0, tier = 1) {
        try {
            const pool = await loadContainerPoolIndex();
            if (pool.length === 0) return null;

            const tierMin = this._tierContainerMinLbs(tier);
            const requiredCap = Math.max(contentWeightLbs, tierMin);

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

            // Prefer containers with sufficient capacity for tier and content weight
            const withCapacity = terrainPool.filter(e => {
                const cap = e.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0;
                return cap >= requiredCap;
            });
            let pickPool = withCapacity.length > 0 ? withCapacity : terrainPool.filter(e => {
                const cap = e.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0;
                return cap >= contentWeightLbs;
            });
            if (pickPool.length === 0 && terrainPool.length > 0) {
                const ranked = [...terrainPool].sort((a, b) => {
                    const capA = a.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0;
                    const capB = b.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0;
                    return capB - capA;
                });
                const bestCap = ranked[0].flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0;
                pickPool = ranked.filter(e =>
                    (e.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0) >= bestCap
                );
            }

            if (pickPool.length === 0) return null;

            if (ownerTheme === "armaments") {
                const sturdy = pickPool.filter(e => {
                    const cap = e.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0;
                    return cap >= this.CONTAINER_STURDY_MIN_LBS;
                });
                if (sturdy.length > 0) pickPool = sturdy;
            }

            if (pickPool.length === 0) return null;
            const pick = pickPool[Math.floor(Math.random() * pickPool.length)];

            const emptyWeightLbs = ItemPoolResolver._extractWeight(pick);
            const packId = pick._sourceCollection ?? `${MODULE_ID}.${PACK_SUFFIX.containers}`;

            return {
                name: pick.name,
                img: pick.img,
                type: pick.type ?? "container",
                capacityLbs: pick.flags?.[MODULE_ID]?.containerMeta?.capacityLbs ?? 0,
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
     *
     * Payload construction is delegated to the active QuartermasterItemAdapter
     * so each system emits its own Item schema (dnd5e uses `type: "loot"` +
     * `system.price.denomination`; PF2E uses `type: "treasure"` +
     * `system.price.value.gp`, etc.).
     *
     * @param {Object} result - Output from generate()
     */
    static async _addToItems(result) {
        if (!game.user.isGM) {
            ui.notifications.warn(game.i18n.localize("ionrift-quartermaster.cacheGenerator.notifyGmOnlyCreateCacheItems"));
            return { count: 0 };
        }

        const adapter = getQuartermasterAdapter();
        const items = result.items ?? [];
        const meta = result.meta ?? {};
        const folderName = `Cache: ${meta.cacheLabel ?? "Loot"} (${new Date().toLocaleDateString()})`;
        const folderKey = `cache-items-${String(meta.cacheLabel ?? "loot").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        let folder = game.folders.find(f => (f.getFlag?.(MODULE_ID, "folderKey") === folderKey || f.flags?.[MODULE_ID]?.folderKey === folderKey || f.name === folderName) && f.type === "Item");
        if (!folder) {
            folder = await Folder.create({ name: folderName, type: "Item", parent: null, flags: { [MODULE_ID]: { folderKey } } });
        }

        const toCreate = items.map(item => {
            const data = adapter.buildCacheItemPayload(item, meta);
            data.folder = folder.id;
            if (!data.img) data.img = DEFAULT_ITEM_ICON;

            // Apply identification masking for magical items
            if (item._isMagical) {
                adapter.applyCacheMask(data, {
                    baseItemName: item._baseItemName,
                    mundaneDesc: item._mundaneDesc,
                    obscuredImg: item._obscuredImg,
                    sourceImg: item._maskSourceImg
                });
            }

            return data;
        });

        if (result.gold > 0) {
            for (const coin of adapter.buildCoinItems(result, meta)) {
                coin.folder = folder.id;
                toCreate.push(coin);
            }
        }

        this._guardMintSources(toCreate);
        const created = await Item.create(toCreate);

        ui.notifications.info(game.i18n.format("ionrift-quartermaster.cacheGenerator.notifyCacheAddedToItems", { count: created.length, folder: folderName }));

        return { count: created.length };
    }

    /**
     * Deploys a cache as a system-native Loot actor. Used on systems whose
     * adapter advertises {@link canCreateLootActor} = true (PF2E) and Item
     * Piles is not installed. Provides the distribute-coins, loot-selected-
     * tokens, and party-stash workflows the sidebar-folder path cannot.
     *
     * @param {Object} result - Output from generate()
     * @returns {Promise<{ actorId: string, itemCount: number }>}
     */
    static async _createLootActor(result) {
        if (!game.user.isGM) {
            ui.notifications.warn(game.i18n.localize("ionrift-quartermaster.cacheGenerator.notifyGmOnlyCreateLootActors"));
            return { actorId: null, itemCount: 0 };
        }

        const adapter = getQuartermasterAdapter();
        if (!adapter.canCreateLootActor()) {
            ui.notifications.warn(game.i18n.localize("ionrift-quartermaster.cacheGenerator.notifyLootActorNotSupported"));
            return { actorId: null, itemCount: 0 };
        }

        const meta = result.meta ?? {};
        const items = result.items ?? [];
        const folderName = `Cache: ${meta.cacheLabel ?? "Loot"} (${new Date().toLocaleDateString()})`;
        const folderKey = `cache-actor-${String(meta.cacheLabel ?? "loot").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        let folder = game.folders.find(f => (f.getFlag?.(MODULE_ID, "folderKey") === folderKey || f.flags?.[MODULE_ID]?.folderKey === folderKey || f.name === folderName) && f.type === "Actor");
        if (!folder) {
            folder = await Folder.create({ name: folderName, type: "Actor", parent: null, flags: { [MODULE_ID]: { folderKey } } });
        }

        const actorPayload = adapter.buildLootActorPayload(result, meta);
        if (!actorPayload) {
            throw new Error("Adapter advertises loot actor support but returned no payload");
        }
        actorPayload.folder = folder.id;

        const actor = await Actor.create(actorPayload);

        // Route items through the same resolution pipeline as the Item Piles
        // drag path: squash duplicate picks into single stacks, resolve real
        // compendium documents (so PF2E gets full system.traits, level, bulk,
        // etc.), apply identification masking, and stamp stack quantity.
        // A raw items.map(buildCacheItemPayload) misses all of that and would
        // emit N loose rows per stack with mask-only field shapes.
        const mintBatch = meta.mintBatch;
        const squashedMap = SquashMerger.merge(items, {
            log: (msg) => Logger.info(MODULE_LABEL, msg)
        });
        const itemPayloads = [];
        for (const entry of squashedMap.values()) {
            const resolved = await ItemResolutionPipeline.resolve(entry, mintBatch);
            itemPayloads.push(ItemResolutionPipeline.stampQuantity(resolved, entry._totalQty ?? 1));
        }

        this._guardMintSources(itemPayloads);

        if (itemPayloads.length > 0) {
            await actor.createEmbeddedDocuments("Item", itemPayloads);
        }

        await adapter.depositLootActorCurrency(actor, result);

        ui.notifications.info(game.i18n.format("ionrift-quartermaster.cacheGenerator.notifyLootActorCreated", { actor: actor.name, count: itemPayloads.length }));

        return { actorId: actor.id, itemCount: itemPayloads.length };
    }
}

export function applyCacheDeploymentMethods(TargetClass) {
    for (const key of Object.getOwnPropertyNames(CacheDeploymentMethods)) {
        if (key === "length" || key === "name" || key === "prototype") continue;
        const desc = Object.getOwnPropertyDescriptor(CacheDeploymentMethods, key);
        if (desc) Object.defineProperty(TargetClass, key, desc);
    }
}
