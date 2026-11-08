import { CacheGenerator } from "../../services/cache/CacheGenerator.js";
import { ItemMaskingHelper } from "../../services/identify/ItemMaskingHelper.js";
import { ItemPoolResolver } from "../../services/loot/ItemPoolResolver.js";
import { LootPoolCompiler } from "../../services/loot/LootPoolCompiler.js";
import { PartyShelfPool } from "../../services/loot/PartyShelfPool.js";
import { ProgressionAdvisor } from "../../services/progression/ProgressionAdvisor.js";
import { SignatureLedger } from "../../services/progression/SignatureLedger.js";
import { getActiveCursedRegistry } from "../../services/loot/StandalonePoolRegistry.js";
import { takeVisibleCapped } from "../../services/settings/AdvisoryStripUtils.js";
import { CursedItemResolver } from "../../services/curse/CursedItemResolver.js";
import { ItemResolutionPipeline } from "../../services/workshop/ItemResolutionPipeline.js";
import { SquashMerger } from "../../services/packs/SquashMerger.js";
import { classifyCacheItem } from "../../services/cache/CacheItemClassifier.js";
import { TerrainDataRegistry } from "../../services/loot/TerrainDataRegistry.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { roundCoinGp, formatCoinPrice, withCoinPriceLabel } from "../../services/workshop/CoinFormat.js";
import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";
import { getQuartermasterAdapter } from "../../adapters/getAdapter.js";
import { QM_FEATURES } from "../../data/QMFeatures.js";
import {
    getFoundryDragData,
    ADVISORY_SIDE_POOL_CAP,
    ADVISORY_SIDE_POOL_CAP_NO_SCROLLS,
    ADVISORY_EPHEMERAL_FETCH,
    TIER_BUDGET_BRACKETS,
    formatGpShort,
    formatBracketLabel,
    bracketMidpoint,
    nearestBracketIndex
} from "./CacheGeneratorApp.js";

export class CacheGeneratorCanvasMethods {
    _onLeftPanelItemDragStart(event) {
        const el   = event.currentTarget;
        const uuid = (el.dataset.uuid ?? "").trim();
        if (!uuid) {
            event.preventDefault();
            return;
        }

        const isScroll = el.classList.contains("shelf-item--scroll");
        const isCursed = el.classList.contains("shelf-item--cursed");

        let panelSource = "signature";
        if (isScroll) panelSource = "scroll";
        else if (isCursed) panelSource = "cursed";
        else if (el.classList.contains("shelf-item")) panelSource = "partyShelf";

        const levelRaw = el.dataset.level;
        const levelParsed = levelRaw !== undefined && levelRaw !== ""
            ? parseInt(levelRaw, 10)
            : NaN;
        const level = Number.isFinite(levelParsed) ? levelParsed : undefined;

        const spellName = (el.dataset.spellName ?? "").trim();
        const spellLevelRaw = el.dataset.spellLevel ?? "";
        const spellLevelParsed = parseInt(spellLevelRaw, 10);
        const spellLevel = Number.isFinite(spellLevelParsed) ? spellLevelParsed : undefined;

        const payload = {
            type: "ionrift-left-panel-item",
            uuid,
            isCursed,
            panelSource,
            level
        };
        if (panelSource === "scroll" && spellName) {
            payload.spellName = spellName;
            payload.spellLevel = spellLevel ?? 0;
        }

        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("text/plain", JSON.stringify(payload));
        el.classList.add("dragging");
        event.target.addEventListener("dragend", () => el.classList.remove("dragging"), { once: true });
    }

    // ── Cache Results Drop Target ─────────────────────────────────────────────

    _canAcceptCacheDrop(event) {
        if (!this._currentResult) return false;
        const types = [...(event.dataTransfer?.types ?? [])];
        return types.includes("text/plain") || types.includes("application/json");
    }

    /**
     * Increment the drag-enter counter and activate the drop-zone highlight.
     * Using a counter (instead of just dragover/dragleave) prevents flickering
     * when the cursor crosses child-element boundaries inside the zone.
     */
    _onCacheResultsDragEnter(event) {
        if (!this._canAcceptCacheDrop(event)) return;
        event.preventDefault();
        this._dragEnterCount = (this._dragEnterCount ?? 0) + 1;
        event.currentTarget.classList.add("drop-target-active");
    }

    _onCacheResultsDragOver(event) {
        if (!this._canAcceptCacheDrop(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    }

    _onCacheResultsDragLeave(event) {
        this._dragEnterCount = Math.max(0, (this._dragEnterCount ?? 1) - 1);
        if (this._dragEnterCount === 0) {
            event.currentTarget.classList.remove("drop-target-active");
        }
    }

    _parseLeftPanelDropPayload(event) {
        try {
            const raw = event.dataTransfer.getData("text/plain");
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed?.type === "ionrift-left-panel-item" && parsed.uuid ? parsed : null;
        } catch {
            return null;
        }
    }

    async _isDropBanned(uuid) {
        const doc = await fromUuid(uuid);
        if (!doc) return false;
        const banSet = await SignatureLedger.getBanSet();
        const key = (doc.name ?? "").toLowerCase();
        if (key && banSet.has(key)) return true;
        const list = await SignatureLedger.getBanList();
        const uuidKey = uuid.toLowerCase();
        return list.some(b => (b.uuid || "").toLowerCase() === uuidKey);
    }

    _recalcContainerCapacity() {
        const result = this._currentResult;
        if (!result?.container) return;

        const contentWeightLbs = (result.items ?? []).reduce((sum, item) => {
            const w = Number(item.weight ?? item.system?.weight?.value) || 0;
            const qty = item.quantity ?? 1;
            return sum + w * qty;
        }, 0);

        const cap = result.container.capacityLbs ?? 0;
        const fillPercent = cap > 0
            ? Math.min(100, Math.round((contentWeightLbs / cap) * 100))
            : 0;

        result.container = {
            ...result.container,
            contentWeightLbs,
            fillPercent,
            isOverweight: cap > 0 && contentWeightLbs > cap
        };
    }

    async _handleLeftPanelDrop(payload) {
        const panelSource = payload.panelSource
            ?? (payload.isCursed ? "cursed" : "signature");

        if (panelSource === "scroll") {
            await this._injectAdvisoryScroll({
                uuid:        payload.uuid,
                spellName:   payload.spellName ?? "",
                spellLevel:  payload.spellLevel,
                level:       payload.level,
                img:         ""
            });
            return;
        }

        const badge = payload.isCursed ? "Cursed"
            : panelSource === "partyShelf" ? "Party Shelf"
            : "Advisory";

        await this._injectItem(
            { uuid: payload.uuid, level: payload.level },
            {
                badge,
                treatAsSignature: panelSource === "signature",
                markDelivered: panelSource === "partyShelf",
                markCursed: panelSource === "cursed"
            }
        );

        if (payload.isCursed) {
            await CacheGenerator.applyCacheCurses(this._currentResult, { forceCurse: false });
        }
    }

    async _handleExternalItemDrop(dropUuid) {
        if (await this._isDropBanned(dropUuid)) {
            const doc = await fromUuid(dropUuid);
            ui.notifications.warn(
                `"${doc?.name ?? "Item"}" is on the ban list and cannot be added to a cache.`
            );
            return;
        }

        const adv = this._buildAdvisoryContext();
        const shelfMatch  = (adv?.partyShelf ?? []).find(s => s.uuid === dropUuid);
        const cursedMatch = (adv?.cursedPool ?? []).find(c => c.uuid === dropUuid);
        const scrollMatch = (adv?.scrolls ?? []).find(s => s.uuid === dropUuid);

        if (scrollMatch) {
            await this._injectAdvisoryScroll({
                uuid:        dropUuid,
                spellName:   scrollMatch.spellName ?? "",
                spellLevel:  scrollMatch.spellLevel ?? 0,
                level:       scrollMatch.level,
                img:         scrollMatch.img ?? ""
            });
            return;
        }

        if (cursedMatch) {
            await this._injectItem(
                { uuid: dropUuid },
                { badge: "Cursed", markCursed: true }
            );
            await CacheGenerator.applyCacheCurses(this._currentResult, { forceCurse: false });
            return;
        }

        if (shelfMatch) {
            await this._injectItem(
                { uuid: dropUuid, level: shelfMatch.level },
                { badge: "Party Shelf", markDelivered: true }
            );
            return;
        }

        await this._injectItem({ uuid: dropUuid }, { badge: "Added" });
    }

    async _onCacheResultsDrop(event) {
        event.preventDefault();
        this._dragEnterCount = 0;
        event.currentTarget.classList.remove("drop-target-active");

        if (!this._currentResult) return;

        const leftPayload = this._parseLeftPanelDropPayload(event);
        if (leftPayload) {
            await this._handleLeftPanelDrop(leftPayload);
            this.render();
            return;
        }

        const data = getFoundryDragData(event);
        if (data?.type === "Item" && data.uuid) {
            await this._handleExternalItemDrop(data.uuid);
            this.render();
        }
    }


    _onRemoveSlot(event) {
        event.preventDefault();
        if (!this._currentResult) return;

        const stackName  = event.currentTarget.dataset.stackName;
        const stackCount = parseInt(event.currentTarget.dataset.stackCount ?? "1");
        const index      = parseInt(event.currentTarget.dataset.index);
        const items      = this._currentResult.items;

        if (stackCount > 1 && stackName) {
            this._currentResult.items = items.filter(item => item.name !== stackName);
        } else {
            if (index < 0 || index >= items.length) return;
            items.splice(index, 1);
        }

        void this._refreshAdvisoryForCurrentCache().then(() => this.render());
    }

    // ── Inspect item in compendium ────────────────────────────────────────────

    async _onInspectItem(event) {
        // Don't fire if the user clicked the reroll or remove button inside the row
        if (event.target.closest(".reroll-btn")
            || event.target.closest(".remove-btn")
            || event.target.closest(".cache-qty-stepper")
            || event.target.closest(".cache-qty-input")) return;

        const row = event.currentTarget.closest(".cache-item-row");
        if (!row) return;

        const sourceCompendium = row.dataset.sourceCompendium;
        const compendiumId     = row.dataset.compendiumId;

        if (sourceCompendium && compendiumId) {
            try {
                if (sourceCompendium === "world.items") {
                    const doc = game.items?.get(compendiumId);
                    if (doc) doc.sheet.render(true);
                    return;
                }
                const pack = game.packs.get(sourceCompendium);
                if (pack) {
                    const doc = await pack.getDocument(compendiumId);
                    if (doc) doc.sheet.render(true);
                }
            } catch (e) {
                Logger.warn(MODULE_LABEL, "Could not open item sheet:", e.message);
            }
        }
    }

    async _onRerollContainer(event) {
        event.preventDefault();
        if (!this._currentResult) return;

        const { ownerTheme, theme } = this._currentResult.meta;
        const contentWeightLbs = (this._currentResult.items ?? []).reduce((s, i) => s + (Number(i.weight) || 0), 0);

        const container = await CacheGenerator._pickContainer(
            ownerTheme, theme, contentWeightLbs, this._currentResult.meta?.tier ?? 1
        );
        if (!container) return;

        const fillPercent = container.capacityLbs > 0
            ? Math.min(100, Math.round((contentWeightLbs / container.capacityLbs) * 100))
            : 0;

        this._currentResult.container = {
            ...container,
            contentWeightLbs,
            fillPercent,
            isOverweight: contentWeightLbs > container.capacityLbs
        };

        CacheGenerator.applyContainerFlavor(this._currentResult, theme);

        this.render();
    }

    // ── Drag-to-canvas (primary, Item Piles) ─────────────────────────────────

    _onDragContainerStart(event) {
        if (!this._currentResult) {
            event.preventDefault();
            return;
        }

        const itemPilesActive = !!(game.modules?.get("itempilesdnd5e")?.active)
            && game.system?.id === "dnd5e";
        const adapter = game.ionrift?.quartermaster?.adapter;
        const supportsLootActor = !itemPilesActive
            && !!adapter?.canCreateLootActor?.();

        if (!itemPilesActive && !supportsLootActor) {
            event.preventDefault();
            return;
        }

        // Both deployment paths use a custom payload the app resolves on drop,
        // rather than the compendium Actor.uuid Foundry natively handles. This
        // lets us create the target actor lazily on drop so the sidebar never
        // fills up with orphaned actors when a GM iterates on the cache roll.
        const payloadType = supportsLootActor ? "ionrift-cache-loot-actor" : "ionrift-cache";
        event.dataTransfer.setData("text/plain", JSON.stringify({
            type: payloadType,
            result: supportsLootActor ? null : this._currentResult
        }));
        event.dataTransfer.effectAllowed = "copy";

        // Register one-time canvas drop listener
        const board = document.getElementById("board");
        if (board) {
            board.addEventListener("drop", this._boundCanvasDrop, { once: true });
        }

        this.element.find(".container-card").addClass("dragging");
    }

    _onDragContainerEnd(event) {
        // Clean up visual state regardless of where it was dropped
        this.element.find(".container-card").removeClass("dragging");
    }

    async _onCanvasDrop(event) {
        event.preventDefault();
        this.element.find(".container-card").removeClass("dragging");

        let data;
        try {
            data = JSON.parse(event.dataTransfer.getData("text/plain"));
        } catch {
            return;
        }

        // Convert browser client coords to canvas world coordinates, then snap to grid
        const t = canvas.stage.worldTransform;
        const rawX = (event.clientX - t.tx) / canvas.stage.scale.x;
        const rawY = (event.clientY - t.ty) / canvas.stage.scale.y;
        const snapped = canvas.grid.getSnappedPoint({ x: rawX, y: rawY }, { mode: CONST?.GRID_SNAPPING_MODES?.TOP_LEFT_VERTEX });
        const x = snapped?.x ?? rawX;
        const y = snapped?.y ?? rawY;

        if (data?.type === "ionrift-cache-loot-actor") {
            return this._onCanvasDropLootActor(x, y, rawX, rawY);
        }

        if (data?.type !== "ionrift-cache" || !data.result) return;

        const result = data.result;

        try {
            const pileItems = [];
            const mintBatch = result.meta?.mintBatch;

            const squashedMap = SquashMerger.merge(result.items ?? [], {
                log: (msg) => Logger.info(MODULE_LABEL, msg)
            });
            for (const entry of squashedMap.values()) {
                const resolved = await ItemResolutionPipeline.resolve(entry, mintBatch);
                pileItems.push(ItemResolutionPipeline.stampQuantity(resolved, entry._totalQty ?? 1));
            }

            // Diagnostic: full pile placement audit so the masking pipeline is
            // observable end-to-end. Each row shows the masked surface name IP
            // will see, the underlying lure (if any), infected count, and the
            // canStack flag - the three things that decide whether IP merges
            // identical-looking masked rows on pile creation or actor takes.
            const QM_FLAG = MODULE_ID;
            const pileAudit = pileItems.map((it) => ({
                name:         it.name,
                type:         it.type,
                qty:          it.system?.quantity ?? 1,
                _id:          it._id,
                originalName: it.flags?.[QM_FLAG]?.latentMagic?.originalName ?? null,
                forgedFrom:   it.flags?.[QM_FLAG]?.forgedFrom ?? null,
                infectedCount: it.flags?.[QM_FLAG]?.infectedCount ?? 0,
                canStack:     it.flags?.["item-piles"]?.item?.canStack ?? "(default)"
            }));
            const ipSimilarities = game.itempiles?.API?.ITEM_SIMILARITIES ?? [];
            Logger.info(MODULE_LABEL,
                `[CacheGen.placement] dropping ${pileItems.length} pile items at (${Math.round(x)}, ${Math.round(y)}). `
                + `IP ITEM_SIMILARITIES: [${ipSimilarities.join(", ")}]`
            );
            Logger.info(MODULE_LABEL, "[CacheGen.placement] pile audit:", pileAudit);

            const containerName = result.container?.name ?? "Loot Cache";
            const containerImg = result.container?.img ?? "icons/containers/chest/chest-worn-oak-tan.webp";

            // If dropped directly onto an existing container or Tripwire prefab/shell,
            // populate it and ensure Quartermaster's visualization and actor image take precedence.
            const targetToken = this._findTargetContainerToken(rawX, rawY);
            if (targetToken) {
                await this._populateExistingContainer(targetToken, result, pileItems, containerName, containerImg);
                return;
            }

            const currencyOverrides = {};
            if (result.coinage) {
                for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                    currencyOverrides[`system.currency.${denom}`] = result.coinage[denom] ?? 0;
                }
            } else {
                currencyOverrides["system.currency.gp"] = result.gold ?? 0;
            }

            const levelPlacement = this._resolveActiveLevelPlacement();

            const createdPileTokenUuid = await game.itempiles.API.createItemPile({
                position: { x, y },
                items: pileItems,
                pileSettings: {
                    type:            "container",
                    displayOne:      false,
                    showItemName:    false,
                    isContainer:     true,
                    canStackItems:   true,
                    canInspectItems: true,
                    deleteWhenEmpty: "yes",
                    // Currency sharing disabled - players can take as much as they want
                    shareCurrenciesEnabled: false
                },
                itemPileFlags: {
                    type:            "container",
                    displayOne:      false,
                    showItemName:    false,
                    isContainer:     true,
                    canStackItems:   true,
                    canInspectItems: true,
                    deleteWhenEmpty: "yes",
                    shareCurrenciesEnabled: false
                },
                tokenOverrides: {
                    name:            containerName,
                    "texture.src":   containerImg,
                    img:             containerImg,
                    texture:         { src: containerImg },
                    // Lock artwork rotation so the container token never spins
                    lockRotation:    true,
                    vision:          false,
                    sight:           { enabled: false },
                    ...levelPlacement
                },
                actorOverrides: {
                    name: containerName,
                    img: containerImg,
                    ...currencyOverrides
                }
            });

            if (typeof createdPileTokenUuid === "string" && (levelPlacement.level !== undefined || levelPlacement.elevation !== undefined)) {
                const createdDoc = await globalThis.fromUuid?.(createdPileTokenUuid);
                if (createdDoc && typeof createdDoc.update === "function") {
                    const patch = {};
                    if (levelPlacement.level && createdDoc.level !== levelPlacement.level) {
                        patch.level = levelPlacement.level;
                    }
                    if (levelPlacement.elevation !== undefined && createdDoc.elevation !== levelPlacement.elevation) {
                        patch.elevation = levelPlacement.elevation;
                    }
                    if (Object.keys(patch).length > 0) {
                        await createdDoc.update(patch);
                    }
                }
            }
        } catch (e) {
            Logger.error(MODULE_LABEL, "Item Piles createItemPile failed:", e);
            ui.notifications.error(game.i18n.localize("ionrift-quartermaster.cacheGenerator.notifyPlaceCacheFailed"));
        }
    }

    /**
     * Resolves the active level ID and base elevation on multi-level scenes
     * (Foundry v14+ native Scene Levels `canvas.level`, or Ripper93 `Levels`
     * `CONFIG.Levels.UI.currentLevels` on v12/v13) so dropped tokens land on
     * the currently viewed level rather than the scene's initial level.
     *
     * @returns {{ level?: string, elevation?: number }}
     * @private
     */
    _resolveActiveLevelPlacement() {
        const placement = {};
        const activeLevel = globalThis.canvas?.level;
        if (activeLevel?.id) {
            placement.level = activeLevel.id;
            const baseElev = activeLevel.elevation?.base ?? activeLevel.elevation?.bottom;
            if (Number.isFinite(baseElev)) {
                placement.elevation = baseElev;
            }
        } else {
            const ripperBottom = Number(globalThis.CONFIG?.Levels?.UI?.currentLevels?.[0]);
            if (Number.isFinite(ripperBottom)) {
                placement.elevation = ripperBottom;
            }
        }
        return placement;
    }

    /**
     * Finds a candidate container token on the active scene directly beneath the drop coordinates.
     * @param {number} rawX Canvas world X coordinate
     * @param {number} rawY Canvas world Y coordinate
     * @returns {Token|null}
     * @private
     */
    _findTargetContainerToken(rawX, rawY) {
        const activeLevelId = globalThis.canvas?.level?.id ?? null;
        const ripperLevels = !activeLevelId ? globalThis.CONFIG?.Levels?.UI?.currentLevels : null;
        const ripperBottom = Array.isArray(ripperLevels) ? Number(ripperLevels[0]) : NaN;
        const ripperTop = Array.isArray(ripperLevels) ? Number(ripperLevels[1]) : NaN;

        const tokens = canvas.tokens?.placeables ?? [];
        const underCursor = tokens.filter(tok => {
            if (tok.visible === false) return false;
            const doc = tok.document;
            if (activeLevelId && doc) {
                if (typeof doc.locatedInLevel === "function") {
                    if (!doc.locatedInLevel(activeLevelId)) return false;
                } else if (doc.level && doc.level !== activeLevelId) {
                    return false;
                }
            } else if (Number.isFinite(ripperBottom) && Number.isFinite(ripperTop) && doc) {
                const elev = Number(doc.elevation ?? 0);
                if (elev < ripperBottom || elev > ripperTop) return false;
            }
            if (tok.bounds?.contains) return tok.bounds.contains(rawX, rawY);
            const w = tok.w ?? tok.width;
            const h = tok.h ?? tok.height;
            return rawX >= tok.x && rawX <= tok.x + w && rawY >= tok.y && rawY <= tok.y + h;
        });

        if (!underCursor.length) return null;

        return underCursor.find(tok => {
            const doc = tok.document;
            const actor = tok.actor;
            if (!doc || !actor) return false;

            // 1. Explicitly tagged Quartermaster cache
            if (actor.flags?.[MODULE_ID]?.isQuartermasterCache) return true;

            // 2. Tripwire cache, secret, or lock
            if (doc.flags?.["ionrift-tripwire"]?.cache || doc.flags?.["ionrift-tripwire"]?.secret || doc.flags?.["ionrift-tripwire"]?.lock) {
                return true;
            }

            // 3. Item Piles container or loot pile
            const piles = game.itempiles?.API;
            if (piles) {
                if (piles.isItemPileContainer?.(tok) || piles.isItemPileContainer?.(actor)) return true;
                if (piles.isItemPile?.(actor ?? tok)) return true;
            }

            // 4. System container or loot actor type
            if (actor.type === "container" || actor.type === "loot") return true;

            if (actor.type === "character" && actor.hasPlayerOwner) return false;

            // 5. Token/actor named or themed as a container shell
            const arch = actor.getFlag?.(MODULE_ID, "containerArchetype")
                ?? actor.flags?.[MODULE_ID]?.containerArchetype
                ?? actor.system?.identifier
                ?? doc.getFlag?.(MODULE_ID, "containerArchetype")
                ?? doc.flags?.[MODULE_ID]?.containerArchetype
                ?? doc.system?.identifier;
            if (arch && ["chest", "cache", "crate", "barrel", "recess", "sack", "bag", "pouch"].includes(String(arch).toLowerCase())) {
                return true;
            }
            const name = (actor.name || doc.name || "").toLowerCase();
            if (name.includes("chest") || name.includes("cache") || name.includes("crate") || name.includes("barrel") || name.includes("recess") || name.includes("sack") || name.includes("bag") || name.includes("pouch")) {
                return true;
            }

            // Never target player characters or player-owned combatants
            if (actor.hasPlayerOwner) return false;

            return false;
        }) ?? null;
    }

    /**
     * Populates an existing container token with generated Quartermaster loot items and currency,
     * ensuring Quartermaster's visualization and actor imagery take precedence.
     * @param {Token} targetToken
     * @param {object} result
     * @param {object[]} pileItems
     * @param {string} containerName
     * @param {string} containerImg
     * @private
     */
    async _populateExistingContainer(targetToken, result, pileItems, containerName, containerImg) {
        const targetActor = targetToken.actor;
        const piles = game.itempiles?.API;

        // Ensure token is an Item Pile container
        if (piles && typeof piles.turnTokensIntoItemPiles === "function") {
            const isPile = typeof piles.isItemPile === "function" && piles.isItemPile(targetActor ?? targetToken);
            if (!isPile) {
                await piles.turnTokensIntoItemPiles([targetToken], {
                    pileSettings: {
                        type: "container",
                        isContainer: true,
                        closeOnInteract: true,
                        openedImage: containerImg,
                        lockedImage: containerImg
                    }
                });
            }
        }

        // Quartermaster visualisation & actor image take precedence
        const tokenUpdates = {
            name: containerName,
            "texture.src": containerImg,
            lockRotation: true,
            sight: { enabled: false }
        };

        const twFlags = targetToken.document?.flags?.["ionrift-tripwire"];
        if (twFlags) {
            if (twFlags.cache) tokenUpdates["flags.ionrift-tripwire.cache.label"] = containerName;
            if (twFlags.mechanism) tokenUpdates["flags.ionrift-tripwire.mechanism.label"] = containerName;
        }

        await targetToken.document.update(tokenUpdates);

        if (targetActor) {
            const ownerPerm = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
            const actorUpdates = {
                name: containerName,
                img: containerImg,
                "ownership.default": ownerPerm,
                [`flags.${MODULE_ID}.isQuartermasterCache`]: true
            };

            const cur = targetActor.system?.currency;
            const hasNativeCurrency = cur && typeof cur === "object" && Object.keys(cur).length > 0;
            if (hasNativeCurrency) {
                if (result.coinage) {
                    for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                        const added = result.coinage[denom] ?? 0;
                        if (added > 0 && denom in cur) {
                            const existing = typeof cur[denom] === "object" ? (Number(cur[denom]?.value) || 0) : (Number(cur[denom]) || 0);
                            if (typeof cur[denom] === "object" && cur[denom] !== null) {
                                actorUpdates[`system.currency.${denom}.value`] = existing + added;
                            } else {
                                actorUpdates[`system.currency.${denom}`] = existing + added;
                            }
                        }
                    }
                } else if (result.gold && "gp" in cur) {
                    const existing = typeof cur.gp === "object" ? (Number(cur.gp?.value) || 0) : (Number(cur.gp) || 0);
                    if (typeof cur.gp === "object" && cur.gp !== null) {
                        actorUpdates["system.currency.gp.value"] = existing + (result.gold ?? 0);
                    } else {
                        actorUpdates["system.currency.gp"] = existing + (result.gold ?? 0);
                    }
                }
            }

            await targetActor.update(actorUpdates);

            if (!hasNativeCurrency) {
                await getQuartermasterAdapter().depositLootActorCurrency(targetActor, result);
            }
        }

        // Update Item Pile container imagery
        if (piles && typeof piles.updateItemPile === "function") {
            try {
                await piles.updateItemPile(targetToken, {
                    openedImage: containerImg,
                    closedImage: containerImg,
                    lockedImage: containerImg,
                    emptyImage: containerImg,
                    isContainer: true
                });
            } catch (err) {
                Logger.warn(MODULE_LABEL, "Could not update Item Pile container images:", err);
            }
        }

        // Add generated loot items into container
        if (piles && typeof piles.addItems === "function") {
            await piles.addItems(targetToken, pileItems);
        } else if (targetActor) {
            await targetActor.createEmbeddedDocuments("Item", pileItems);
        }

        Logger.info(MODULE_LABEL, `Populated container ${containerName} (${targetToken.id}) with ${pileItems.length} items.`);
        ui.notifications.info(game.i18n.format("ionrift-quartermaster.cacheGenerator.notifyPopulatedContainer", { container: containerName, count: pileItems.length }));
    }

    /**
     * Native loot-actor drop path: creates a Loot actor from the current cache
     * result (or populates an existing container token under the cursor), then
     * places a token for it at the drop coordinates. When Item Piles is active
     * on a generic system, also initializes the dropped token as an Item Pile
     * container.
     *
     * @param {number} x - Canvas world x (already grid-snapped)
     * @param {number} y - Canvas world y
     * @param {number} [rawX] - Raw unsnapped world x for target token hit-testing
     * @param {number} [rawY] - Raw unsnapped world y for target token hit-testing
     */
    async _onCanvasDropLootActor(x, y, rawX, rawY) {
        if (!this._currentResult) return;
        if (!canvas.scene) {
            ui.notifications.warn(game.i18n.localize("ionrift-quartermaster.cacheGenerator.notifyOpenSceneForLootActor"));
            return;
        }

        try {
            const result = this._currentResult;
            const targetToken = (rawX !== undefined && rawY !== undefined)
                ? this._findTargetContainerToken(rawX, rawY)
                : null;
            if (targetToken) {
                const pileItems = [];
                const mintBatch = result.meta?.mintBatch;
                const squashedMap = SquashMerger.merge(result.items ?? [], {
                    log: (msg) => Logger.info(MODULE_LABEL, msg)
                });
                for (const entry of squashedMap.values()) {
                    const resolved = await ItemResolutionPipeline.resolve(entry, mintBatch);
                    pileItems.push(ItemResolutionPipeline.stampQuantity(resolved, entry._totalQty ?? 1));
                }
                const containerName = result.container?.name ?? "Loot Cache";
                const containerImg = result.container?.img ?? "icons/containers/chest/chest-worn-oak-tan.webp";
                await this._populateExistingContainer(targetToken, result, pileItems, containerName, containerImg);
                return;
            }

            const { actorId } = await CacheGenerator._createLootActor(result);
            if (!actorId) return;

            const actor = game.actors.get(actorId);
            if (!actor) return;

            const levelPlacement = this._resolveActiveLevelPlacement();
            const tokenDoc = await actor.getTokenDocument({ x, y, ...levelPlacement }, { parent: canvas.scene });
            const tokenObj = typeof tokenDoc.toObject === "function" ? tokenDoc.toObject() : { ...tokenDoc };
            if (levelPlacement.level) tokenObj.level = levelPlacement.level;
            if (levelPlacement.elevation !== undefined) tokenObj.elevation = levelPlacement.elevation;
            const createdTokens = await canvas.scene.createEmbeddedDocuments("Token", [tokenObj]);
            const placedTokenDoc = Array.isArray(createdTokens) ? createdTokens[0] : null;
            const placedToken = placedTokenDoc?.object ?? canvas.tokens?.get(placedTokenDoc?.id ?? "");

            const isPf2eFamily = game.system?.id === "pf2e" || game.system?.id === "sf2e";
            const piles = !isPf2eFamily && game.modules?.get("item-piles")?.active ? game.itempiles?.API : null;
            if (placedToken && piles && typeof piles.turnTokensIntoItemPiles === "function") {
                try {
                    const containerImg = result.container?.img ?? actor.img;
                    await piles.turnTokensIntoItemPiles([placedToken], {
                        pileSettings: {
                            type: "container",
                            displayOne: false,
                            showItemName: false,
                            isContainer: true,
                            canStackItems: true,
                            canInspectItems: true,
                            deleteWhenEmpty: "yes",
                            shareCurrenciesEnabled: false,
                            openedImage: containerImg,
                            closedImage: containerImg,
                            lockedImage: containerImg,
                            emptyImage: containerImg
                        }
                    });
                } catch (pileErr) {
                    Logger.warn(MODULE_LABEL, "Item Piles initialization on loot actor token skipped:", pileErr);
                }
            }
        } catch (e) {
            Logger.error(MODULE_LABEL, "Loot actor placement failed:", e);
            ui.notifications.error("Failed to place loot actor. Check console.");
        }
    }

    // ── Add to Items (fallback, no Item Piles) ────────────────────────────────

    async _onAddToItems(event) {
        event.preventDefault();
        if (!this._currentResult) return;

        const btn = $(event.currentTarget);
        btn.prop("disabled", true).html(`<i class="fas fa-spinner fa-spin"></i> ${game.i18n.localize("ionrift-quartermaster.cacheGenerator.btnAdding")}`);

        try {
            await CacheGenerator._addToItems(this._currentResult);
            btn.html(`<i class="fas fa-check"></i> ${game.i18n.localize("ionrift-quartermaster.cacheGenerator.btnAdded")}`);
        } catch (e) {
            Logger.error(MODULE_LABEL, "Add to items failed:", e);
            ui.notifications.error(game.i18n.localize("ionrift-quartermaster.cacheGenerator.notifyAddItemsFailed"));
            btn.prop("disabled", false).html(`<i class="fas fa-box-open"></i> ${game.i18n.localize("ionrift-quartermaster.cacheGenerator.addToItems")}`);
        }
    }

    async _onCreateLootActor(event) {
        event.preventDefault();
        if (!this._currentResult) return;

        const btn = $(event.currentTarget);
        btn.prop("disabled", true).html(`<i class="fas fa-spinner fa-spin"></i> ${game.i18n.localize("ionrift-quartermaster.cacheGenerator.btnCreating")}`);

        try {
            const { actorId } = await CacheGenerator._createLootActor(this._currentResult);
            btn.html(`<i class="fas fa-check"></i> ${game.i18n.localize("ionrift-quartermaster.cacheGenerator.btnCreated")}`);
            if (actorId) {
                const actor = game.actors.get(actorId);
                actor?.sheet?.render(true);
            }
        } catch (e) {
            Logger.error(MODULE_LABEL, "Create loot actor failed:", e);
            ui.notifications.error(game.i18n.localize("ionrift-quartermaster.cacheGenerator.notifyCreateLootActorFailed"));
            btn.prop("disabled", false).html(`<i class="fas fa-treasure-chest"></i> ${game.i18n.localize("ionrift-quartermaster.cacheGenerator.btnCreateLootActor")}`);
        }
    }
}

export function applyCacheGeneratorCanvasMethods(TargetClass) {
    for (const key of Object.getOwnPropertyNames(CacheGeneratorCanvasMethods.prototype)) {
        if (key === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(CacheGeneratorCanvasMethods.prototype, key);
        if (desc) Object.defineProperty(TargetClass.prototype, key, desc);
    }
}
