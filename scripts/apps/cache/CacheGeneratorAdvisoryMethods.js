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

export class CacheGeneratorAdvisoryMethods {
    async _refreshCursedPool(tier = 1) {
        const reg = getActiveCursedRegistry();

        try {
            if (typeof reg.ensureDefaultCursedPoolIfEmpty === "function") {
                await reg.ensureDefaultCursedPoolIfEmpty();
            }
            this._cursedPool = await reg.getPool(tier, ADVISORY_EPHEMERAL_FETCH);
            // Compendium draw can be empty while the ledger pool still has rows
            if (!this._cursedPool.length && typeof reg.getCursedPool === "function") {
                const stored = await reg.getCursedPool();
                const t = Math.max(1, Math.min(4, Number(tier) || 1));
                const eligible = (stored ?? []).filter(r => (r.tier ?? 1) <= t);
                if (eligible.length) {
                    const shuffled = [...eligible].sort(() => Math.random() - 0.5);
                    this._cursedPool = shuffled.slice(0, ADVISORY_EPHEMERAL_FETCH);
                }
            }
            this._cursedPlanned = await reg.getCursedPlanned?.() ?? [];

            // Live-resolve display names from the forged pack via shared service.
            // Pool entries store names at load-time and go stale after a recompile.
            this._cursedPool = await CursedItemResolver.resolvePoolDisplayNames(this._cursedPool);

        } catch (err) {
            Logger.warn(MODULE_LABEL, "Cursed pool refresh failed:", err.message);
            this._cursedPool = [];
            this._cursedPlanned = [];
        }
        this._cursedPoolLoaded = true;
        return this._cursedPool;
    }


    /**
     * Refresh the ephemeral party shelf pool from compendiums.
     * Tier-gated by rarityMax so the suggestions fit the cache tier.
     */
    async _refreshPartyShelfPool(tier = 1) {
        try {
            this._partyShelfPool = await PartyShelfPool.getPool(tier, ADVISORY_EPHEMERAL_FETCH);
        } catch {
            this._partyShelfPool = [];
        }
        this._partyShelfPoolLoaded = true;
        return this._partyShelfPool;
    }

    /**
     * Recompute ProgressionAdvisor output from the live cache so scrolls, shelf,
     * and signature priority stay aligned with the current item list.
     * Also redraws ephemeral party shelf + cursed compendium samples (same cadence
     * as scrolls from advise) so strips repopulate after pulls or removals.
     */
    async _refreshAdvisoryForCurrentCache() {
        if (!this._currentResult) return;
        const adapter = getQuartermasterAdapter();
        if (!adapter.supports(QM_FEATURES.SIGNATURE_LEDGER) && !adapter.supports(QM_FEATURES.SRD_CURSES)) {
            this._advisory = null;
            return;
        }
        const tier = this._currentResult.meta?.tier
            ?? game.settings?.get(MODULE_ID, "defaultCacheTier")
            ?? 1;
        try {
            const [next] = await Promise.all([
                ProgressionAdvisor.advise(tier, this._currentResult),
                this._refreshPartyShelfPool(tier),
                this._refreshCursedPool(tier)
            ]);
            this._advisory = next;
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Advisory refresh failed:", e.message);
        }
    }

    /**
     * Compendium UUIDs (lowercase) already sitting in the current cache preview.
     * Used to hide the same cursed (or shelf) advisory row until the item is removed.
     */
    _compendiumUuidsInCurrentCache() {
        const set = new Set();
        for (const i of this._currentResult?.items ?? []) {
            if (typeof i.uuid === "string" && i.uuid.includes("Item.")) {
                set.add(i.uuid.trim().toLowerCase());
                continue;
            }
            const sc = i.sourceCompendium;
            const id = i._compendiumId;
            if (sc && id) {
                set.add(`Compendium.${sc}.Item.${id}`.toLowerCase());
            }
        }
        return set;
    }

    /**
     * Build advisory context for the left-column. Includes character milestone cards,
     * party shelf items (Enrich Hoard domain list), and the cursed pool (Curse Cache domain list).
     * Returns null only if ALL three sections are empty.
     */
    _buildAdvisoryContext() {
        const adv = this._advisory;
        const cacheUuidSet = this._compendiumUuidsInCurrentCache();
        const rowUuid = row => (row.uuid ?? "").trim().toLowerCase();
        /** Hide shelf / cursed row when that compendium UUID is already in the cache preview. */
        const rowNotInCachePreview = row => {
            const u = rowUuid(row);
            if (!u) return true;
            return !cacheUuidSet.has(u);
        };

        const signatureAltNotInCachePreview = alt => {
            const u = (alt?.uuid ?? "").trim().toLowerCase();
            if (!u) return true;
            return !cacheUuidSet.has(u);
        };

        // Signatures: walk full powerBalance ranking; show up to VISIBLE_SIGNATURE_CARD_CAP
        // actors who still have at least one planned pin not already in this cache.
        const cap = ProgressionAdvisor.VISIBLE_SIGNATURE_CARD_CAP ?? 2;
        const characters = [];
        for (const row of adv?.powerBalance ?? []) {
            if (characters.length >= cap) break;
            const alts = row.alternatives ?? [];
            const plannedItemRaw = alts.find(signatureAltNotInCachePreview) ?? null;
            if (!plannedItemRaw) continue;
            characters.push({
                actorId:   row.actorId,
                actorName: row.actorName,
                actorImg:  row.actorImg,
                reason:    this._buildSignatureReason(row, plannedItemRaw),
                plannedItem: {
                    name:  plannedItemRaw.name,
                    img:   plannedItemRaw.img,
                    level: plannedItemRaw.level,
                    uuid:  plannedItemRaw.uuid ?? ""
                }
            });
        }

        const partyLevelAvg = adv?.partyLevelAvg ?? 1;
        const scrollPlanHasPins = (adv?.scrolls?.length ?? 0) > 0;
        const sidePoolCap = scrollPlanHasPins ? ADVISORY_SIDE_POOL_CAP : ADVISORY_SIDE_POOL_CAP_NO_SCROLLS;

        // Party shelf: full ranked ledger + ephemeral pool, then first N rows that
        // are not already in the cache (takeVisibleCapped; do not pre-slice ledger).
        const shelfOrdered = ProgressionAdvisor.sortRipeFirstThenLevelDesc(
            adv?.partyShelf ?? [],
            partyLevelAvg
        );
        // When the GM manually rerolled this panel, skip planned/recipe pins and show
        // only fresh ephemeral suggestions from the compendium pool.
        const shelfRerollMode = this._poolRerollMode?.has("partyShelf");
        const ledgerShelf = shelfRerollMode ? [] : shelfOrdered.map(entry => ({
            name:             entry.name,
            img:              entry.img ?? "icons/equipment/chest/chest-wooden-simple.webp",
            level:            entry.level,
            uuid:             entry.uuid ?? "",
            _compendiumId:    entry._compendiumId ?? "",
            sourceCompendium: entry.sourceCompendium ?? "",
            isPlanned:        true,
            isRipe:           entry.isRipe ?? false
        }));
        const ephemeralShelf = (this._partyShelfPool ?? []).map(entry => ({
            name:             entry.name,
            img:              entry.img ?? "icons/equipment/chest/chest-wooden-simple.webp",
            level:            entry.level,
            uuid:             entry.uuid ?? "",
            _compendiumId:    entry._compendiumId ?? "",
            sourceCompendium: entry.sourceCompendium ?? "",
            isPlanned:        false,
            isRipe:           false
        }));
        const partyShelfCombined = ProgressionAdvisor.sortRipeFirstThenLevelDesc(
            [...ledgerShelf, ...ephemeralShelf],
            partyLevelAvg
        );
        const partyShelf = takeVisibleCapped(
            partyShelfCombined,
            rowNotInCachePreview,
            sidePoolCap
        );

        // Cursed: planned block (sorted) then pool; one visibility pass + cap (same as party shelf).
        // When the GM manually rerolled this panel, skip planned/recipe pins and show
        // only fresh random suggestions from the compendium pool.
        const cursedRerollMode = this._poolRerollMode?.has("cursedPool");
        const plannedCursed = cursedRerollMode ? [] : (this._cursedPlanned ?? [])
            .filter(c => !(c.used || c.delivered))
            .map(c => ({
                name:             c.name,
                img:              c.img ?? DEFAULT_ITEM_ICON,
                uuid:             c.uuid ?? "",
                _compendiumId:    c._compendiumId ?? "",
                sourceCompendium: c.sourceCompendium ?? "",
                curseType:        c.curseType ?? "unknown",
                decoyAppearance:  c.decoyAppearance ?? "",
                trueNature:       c.trueNature ?? "",
                level:            c.level,
                isPlanned:        true,
                isRipe:           (c.level ?? 99) <= partyLevelAvg
            }));
        const plannedCursedOrdered = ProgressionAdvisor.sortRipeFirstThenLevelDesc(
            plannedCursed,
            partyLevelAvg
        );
        const poolCursed = (this._cursedPool ?? []).map(entry => ({
            name:             entry.name,
            img:              entry.img ?? DEFAULT_ITEM_ICON,
            uuid:             entry.uuid ?? "",
            _compendiumId:    entry._compendiumId ?? "",
            sourceCompendium: entry.sourceCompendium ?? "",
            curseType:        entry.curseType ?? "unknown",
            decoyAppearance:  entry.decoyAppearance ?? "",
            trueNature:       entry.trueNature ?? "",
            isPlanned:        false,
            isRipe:           false
        }));
        const cursedPool = takeVisibleCapped(
            [...plannedCursedOrdered, ...poolCursed],
            rowNotInCachePreview,
            sidePoolCap
        );

        // Scroll Plan: advisor list is already cache-filtered; cap with shared helper.
        const scrollRows = takeVisibleCapped(
            adv?.scrolls ?? [],
            () => true,
            ADVISORY_SIDE_POOL_CAP
        ).map(s => ({
            uuid:        s.uuid ?? "",
            spellName:   s.spellName ?? "",
            spellLevel:  s.spellLevel ?? s.level ?? 0,
            level:       s.level,
            img:         s.img ?? "icons/magic/symbols/runes-star-pentagon-orange.webp",
            canInject:   !!s.canInject && !!(s.uuid ?? "").trim(),
            isRipe:      (s.level ?? 99) <= partyLevelAvg
        }));

        // Only render advisory if at least one section has content
        if (characters.length === 0 && partyShelf.length === 0 && cursedPool.length === 0 && scrollRows.length === 0) {
            return null;
        }

        // Dice reroll button should only appear when there is something random to surface.
        // If every visible row is already a planned+ripe pin, rerolling would show the same items.
        const partyShelfCanReroll = partyShelf.some(i => !i.isPlanned)
            || (this._partyShelfPool?.length > partyShelf.length);
        const cursedCanReroll = cursedPool.some(i => !i.isPlanned)
            || (this._cursedPool?.length > cursedPool.length);
        // Scrolls: only useful to reroll when the advisor has more pins than the visible cap.
        const scrollCanReroll = (adv?.scrolls?.length ?? 0) > scrollRows.length;

        return {
            characters,
            partyShelf,
            cursedPool,
            scrolls:          scrollRows,
            overdueCount:     characters.length,
            hasPartyShelf:    partyShelf.length > 0,
            hasCursedPool:    cursedPool.length > 0,
            hasScrolls:       scrollRows.length > 0,
            partyShelfCanReroll,
            cursedCanReroll,
            scrollCanReroll
        };
    }

    /**
     * Derive a short reason string for a signature advisory card from the
     * composite priority data produced by ProgressionAdvisor.
     * @param {object|null} visiblePlanned  First planned alt shown in the card (excludes cache preview).
     */
    _buildSignatureReason(row, visiblePlanned = null) {
        const pct = Math.round((row.powerNeed ?? 0) * 100);
        const lv  = visiblePlanned?.level ?? row.earliestPlannedLevel;

        if (pct > 10 && lv) return `${pct}% below avg, Lv${lv} overdue`;
        if (pct > 10)       return `${pct}% below party avg power`;
        if (lv)             return `Lv${lv} signature pending`;
        return "Planned item available";
    }

    _groupItems(result) {
        const items = result.items ?? [];
        items.forEach((item, i) => item._origIdx = i);

        const mintBatch = result.meta?.mintBatch;
        const curseEntry = mintBatch ? (game.ionrift?.cursewright?.registry?.get(mintBatch) ?? null) : null;
        if (curseEntry) {
            for (const item of items) {
                // Only badge items that were explicitly injected as cursed (advisory panel).
                // Regular consumables with the same display name are clean - do not badge them.
                if (item._specialSection && item._specialType === "cursed" && item.name === curseEntry.decoyName) {
                    item.cursed = true;
                    item.cursedAs = curseEntry.trueItem;
                }
            }
        }

        // Classification is delegated to a pure classifier (single source of
        // truth for preview + deployment). See CacheItemClassifier.js. The
        // predicates below just adapt bucket names to the local `isXxx`
        // shape that this method's downstream `items.filter(...)` calls
        // and the special-item sub-bucket split expect.
        const isSpecialSection = i => i._specialSection || i.isSignature;
        const bucketOf         = i => classifyCacheItem(i);
        const isScroll         = i => bucketOf(i) === "scroll";
        const isConsumable     = i => bucketOf(i) === "consumable";
        const isWeapon         = i => bucketOf(i) === "weapon";
        const isGemstone       = i => bucketOf(i) === "gemstone";
        const isTreasure       = i => bucketOf(i) === "treasure";
        const isTrinket        = i => bucketOf(i) === "trinket";
        const isMundane        = i => bucketOf(i) === "mundane";

        // Merge same-name items into stacks
        const squash = (arr) => {
            const seen = new Map();
            for (const item of arr) {
                if (seen.has(item.name)) {
                    const existing = seen.get(item.name);
                    existing.quantity += item.quantity ?? 1;
                    existing.price = roundCoinGp((existing.price ?? 0) + (item.price ?? 0));
                } else {
                    seen.set(item.name, { ...item, quantity: item.quantity ?? 1 });
                }
            }
            return [...seen.values()].map(i => withCoinPriceLabel({
                ...i,
                stacked: i.quantity > 1,
                _isMagical: i._isMagical ?? false,
                _baseItemName: i._baseItemName ?? null
            }));
        };

        // Special Items sub-groups
        const specialSigs   = squash(items.filter(i => isSpecialSection(i) && (i.isSignature || i._specialType === "signature")));
        const specialShelf  = squash(items.filter(i => isSpecialSection(i) && i._specialType === "partyShelf"));
        const specialCursed = squash(items.filter(i => isSpecialSection(i) && i._specialType === "cursed"));
        const hasSpecial    = specialSigs.length > 0 || specialShelf.length > 0 || specialCursed.length > 0;

        const itemsTotal = items.reduce((sum, i) => sum + (i.price ?? 0), 0);
        const totalValueRaw = result.gold + itemsTotal;

        return {
            gold:        result.gold,
            coinage:     result.coinage ?? null,
            // Special Items section (signatures + injected shelf/cursed)
            hasSpecial,
            specialSigs,
            specialShelf,
            specialCursed,
            // Regular loot sections (special items excluded)
            scrolls:     squash(items.filter(isScroll)),
            weapons:     squash(items.filter(isWeapon)),
            gemstones:   squash(items.filter(isGemstone)),
            treasures:   squash(items.filter(isTreasure)),
            consumables: squash(items.filter(isConsumable)),
            trinkets:    squash(items.filter(isTrinket)),
            mundane:     squash(items.filter(isMundane)),
            totalValue:  roundCoinGp(totalValueRaw),
            totalValueLabel: formatCoinPrice(totalValueRaw),
            signatureOpportunity: result.signatureOpportunity ? {
                ...result.signatureOpportunity,
                isNegative: result.signatureOpportunity.powerDeviation < 0
            } : null,
            itemCount:   items.length,
            meta:        result.meta,
            container:   result.container
        };
    }

    _onToggleAdvisory(event) {
        event.preventDefault();
        this._advisoryCollapsed = !this._advisoryCollapsed;
        game.settings?.set(MODULE_ID, "advisoryCollapsed", this._advisoryCollapsed);
        this.render();
    }

    /** Toggle individual advisory section collapse (signatures / partyShelf / cursedPool). */
    _onToggleAdvisorySection(event) {
        event.preventDefault();
        const btn     = event.currentTarget;
        const section = btn.closest(".advisory-sub-section");
        if (!section) return;
        const body = section.querySelector(".advisory-sub-body");
        if (!body) return;
        const isCollapsed = body.style.display === "none";
        body.style.display = isCollapsed ? "" : "none";
        btn.querySelector("i")?.classList.toggle("fa-chevron-down", isCollapsed);
        btn.querySelector("i")?.classList.toggle("fa-chevron-up", !isCollapsed);
    }

    /**
     * Reroll a specific advisory pool section (scroll plan, party shelf, or cursed pool).
     * Ignores "ripe" gating - pulls a fresh random slice from the full pool.
     * For cursed pool: bypasses recipe-only items and draws anything from the full pool.
     */
    async _onRerollPanelPool(event) {
        event.preventDefault();
        const pool = event.currentTarget.dataset.pool;
        const tier = this._currentResult?.meta?.tier
            ?? game.settings?.get(MODULE_ID, "defaultCacheTier")
            ?? 1;

        // Mark pool as reroll-mode: planned/recipe pins will be suppressed
        this._poolRerollMode.add(pool);

        if (pool === "partyShelf") {
            // Force a fresh ephemeral draw - re-shuffle by clearing current pool first
            this._partyShelfPool = [];
            await this._refreshPartyShelfPool(tier);
            // Rotate through the pool so repeated clicks surface different rows
            if (this._partyShelfPool.length > 1) {
                const shift = this._partyShelfPool.splice(0, 1);
                this._partyShelfPool.push(...shift);
            }
        } else if (pool === "cursedPool") {
            // Route through _refreshCursedPool so the forged name map is applied
            // (same path as first-load and post-generate). The inline reg.getPool()
            // call that previously lived here bypassed CursedItemResolver.buildForgedNameMap(),
            // causing items to revert to their masked "Unidentified Consumable" names on reroll.
            await this._refreshCursedPool(tier);
            // Shuffle the already name-resolved pool so repeated rerolls surface
            // different rows (mirrors the variety goal of the old * 2 fetch).
            if (this._cursedPool.length > 1) {
                this._cursedPool = [...this._cursedPool].sort(() => Math.random() - 0.5);
            }
        } else if (pool === "scroll") {
            // Shuffle the advisory scrolls array in-place to surface a different subset.
            // Do NOT call _refreshAdvisoryForCurrentCache() - that would re-fetch all pools
            // and cause partyShelf and cursedPool to randomise as a side-effect.
            if (this._advisory?.scrolls?.length > 1) {
                this._advisory.scrolls = [...this._advisory.scrolls].sort(() => Math.random() - 0.5);
            }
        }

        this.render();
    }


    /**
     * Push a scroll-plan pin into the current cache, then refresh advisory from
     * ProgressionAdvisor (same path as shelf/cursed after cache changes).
     */
    async _injectAdvisoryScroll(entry) {
        if (!this._currentResult) return;

        const uuid = (entry.uuid ?? "").trim();
        const spellName = (entry.spellName ?? "").trim();
        if (!uuid || !spellName) return;

        const spellLevelRaw = entry.spellLevel;
        const spellLevel = Number.isFinite(Number(spellLevelRaw))
            ? Number(spellLevelRaw)
            : 0;

        let itemData;
        try {
            const doc = await fromUuid(uuid);
            if (doc) {
                itemData = doc.toObject();
                itemData.spellName  = spellName;
                itemData.spellLevel = spellLevel;
                itemData._injected  = true;
                itemData._badgeLabel = "Scroll Unlocked";
            }
        } catch { /* fall through */ }

        if (!itemData) {
            itemData = {
                name:        game.i18n.format("ionrift-quartermaster.cacheGenerator.spellScrollOf", { spellName }),
                type:        "loot",
                img:         entry.img || "icons/magic/symbols/runes-star-pentagon-orange.webp",
                spellName,
                spellLevel,
                _injected:   true,
                _badgeLabel: "Scroll Unlocked"
            };
        }

        const mask = ItemMaskingHelper.detectMagical({
            name: itemData.name,
            rarity: itemData.system?.rarity ?? "",
            type: itemData.type ?? "consumable",
            _baseItem: itemData.system?.type?.baseItem
        });
        if (mask.isMagical) {
            itemData._isMagical    = true;
            itemData._baseItemName = mask.baseItemName;
            itemData._mundaneDesc  = mask.mundaneDesc;
            if (mask.obscuredImg) {
                itemData._maskSourceImg = itemData.img;
                itemData._obscuredImg   = mask.obscuredImg;
                itemData.img            = mask.obscuredImg;
            }
        }

        this._currentResult.items.push(itemData);
        await this._refreshAdvisoryForCurrentCache();
        this._recalcContainerCapacity();
    }

    /** Shared inject helper - resolves UUID to item data and pushes to result. */
    async _injectItem(entry, { badge = "Advisory", markDelivered = false, treatAsSignature = false, markCursed = false } = {}) {
        if (!this._currentResult) return;

        let itemData;
        let resolvedDoc = null;

        if (entry.uuid) {
            try {
                let doc = await fromUuid(entry.uuid);
                if (!doc && entry.sourceCompendium && entry._compendiumId) {
                    doc = await ItemResolutionPipeline._resolveCompendiumDocument(entry);
                }
                if (doc) {
                    resolvedDoc = doc;
                    const raw = doc.toObject();

                    // Extract price the same way CacheGenerator does
                    const priceVal = ItemPoolResolver._extractPrice(raw);

                    // Determine compendium metadata from the UUID
                    // UUID format: "Compendium.<scope>.<packName>.Item.<id>"
                    const uuidParts = entry.uuid.split(".");
                    const compendiumId = uuidParts.at(-1) ?? "";
                    const sourceCompendium = uuidParts.length >= 4
                        ? `${uuidParts[1]}.${uuidParts[2]}`
                        : "";

                    itemData = {
                        ...raw,
                        name:              raw.name,
                        img:               raw.img,
                        type:              raw.type ?? "loot",
                        price:             priceVal,
                        weight:            raw.system?.weight?.value ?? raw.weight ?? 0,
                        rarity:            raw.system?.rarity ?? "",
                        isSignature:       treatAsSignature,
                        sourceCompendium,
                        _compendiumId:     compendiumId,
                    };

                    const mask = ItemMaskingHelper.detectMagical({
                        name: itemData.name,
                        rarity: itemData.system?.rarity ?? itemData.rarity ?? "",
                        type: itemData.type,
                        _baseItem: itemData.system?.type?.baseItem
                    });
                    if (mask.isMagical) {
                        itemData._isMagical = true;
                        itemData._baseItemName = mask.baseItemName;
                        itemData._mundaneDesc = mask.mundaneDesc;
                        if (mask.obscuredImg) {
                            itemData._maskSourceImg = itemData.img;
                            itemData._obscuredImg = mask.obscuredImg;
                            itemData.img = mask.obscuredImg;
                        }
                    }
                }
            } catch (err) {
                Logger.warn(MODULE_LABEL, "Advisory UUID resolution failed:", entry.uuid, err);
            }
        }

        // Fallback stub when UUID is missing or resolution failed
        if (!itemData) {
            itemData = {
                name:        entry.name || entry.spellName || "Unknown",
                type:        "loot",
                img:         entry.img  || "icons/magic/symbols/runes-star-pentagon-orange.webp",
                price:       0,
                rarity:      "",
                isSignature: treatAsSignature,
            };
        }

        // ── Cursed item name resolution ──────────────────────────────────────────
        // CurseForge items have system.identified=false by design - dnd5e overrides
        // .name to "Unidentified [type]" in that state. This is normal, not an error.
        // Resolve the GM-facing display name from flags and flip identified:true on
        // the preview data so the cache UI shows the real lure/item name.
        if (markCursed) {
            const qmFlags = resolvedDoc?.flags?.[MODULE_ID] ?? {};

            if (itemData.system?.identified === false) {
                // Stash the original document name (the lure surface name, e.g.
                // "Potion of Healing") BEFORE overwriting with the GM-facing name.
                // The squash merge in _onPlaceOnCanvas uses this to find the clean
                // counterpart for poison-stack merging ("Potion of Poison" ≠ "Potion
                // of Healing" so a plain name match fails without this).
                const priorName = itemData.name;
                const displayName = CursedItemResolver.resolveDisplayName(resolvedDoc ?? itemData);
                if (displayName && !displayName.startsWith("Unidentified")) {
                    itemData.name = displayName;
                    if (displayName !== priorName) {
                        itemData._lureSurfaceName = priorName;
                    }
                    CursedItemResolver.ensureIdentified(itemData);
                    Logger.info(MODULE_LABEL,
                        `[CacheGen] Cursed item "${displayName}" - resolved display name from flags (identified:false is expected). Lure surface: "${priorName}".`
                    );
                }
                // If no display name found in flags, the stored entry.name from
                // the pool is used as-is (already resolved by _refreshCursedPool).
            }

            itemData.cursed = true;
            const cm = qmFlags.cursedMeta ?? {};
            const hint = (cm.trueNature || cm.decoyAppearance || "").trim();
            itemData.cursedAs = hint || itemData.name;
            const infectedCount = qmFlags.infectedCount ?? 0;
            if (infectedCount > 0) itemData.isInfectedStack = true;
        }

        itemData._injected   = true;
        itemData._badgeLabel = badge;

        const isPartyShelf = badge === "Party Shelf" || badge === game.i18n?.localize?.("ionrift-quartermaster.cacheGenerator.badgePartyShelf");
        const isSpecial = treatAsSignature || markCursed || isPartyShelf;
        if (isSpecial) {
            itemData._specialSection = true;
            itemData._specialType    = markCursed   ? "cursed"
                                     : isPartyShelf ? "partyShelf"
                                     : "signature";
        }
        this._currentResult.items.push(itemData);

        if (markDelivered && entry.uuid) {
            try {
                const shelf = await SignatureLedger.getPartyShelf();
                const hit = shelf.find(s => s.uuid === entry.uuid && (entry.level === null || entry.level === undefined || s.level === entry.level));
                if (hit) {
                    hit.delivered = true;
                    await SignatureLedger.setPartyShelf(shelf);
                }
            } catch (e) {
                Logger.warn(MODULE_LABEL, "Party shelf delivered flag failed:", e);
            }
        }

        await this._refreshAdvisoryForCurrentCache();
        this._recalcContainerCapacity();
        this.render();
    }

    // ── Inject Signature Opportunity ──────────────────────────────────────────

    async _onInjectSignature(event) {
        event.preventDefault();
        if (!this._currentResult || !this._currentResult.signatureOpportunity) return;

        const opp = this._currentResult.signatureOpportunity;
        
        // If they don't have a planned item, generate a stub
        let itemData;
        if (opp.plannedItem && opp.plannedItem.uuid) {
            const item = await fromUuid(opp.plannedItem.uuid);
            if (item) {
                // Duplicate it to a plain object just like stash items
                itemData = item.toObject();
                itemData.flags = itemData.flags || {};
                itemData.flags[MODULE_ID] = { isSignature: true };
            }
        }

        if (!itemData) {
            // Generate a random stub because the uuid was bad or missing
            const tier = parseInt(this.element.find("select[name='tier']").val()) || 1;
            const theme = this.element.find("select[name='theme']").val() || "dungeon";
            itemData = CacheGenerator._generateSignatureStub(tier, theme);
        }

        // Apply metadata
        itemData.isSignature = true;
        itemData.signatureTarget = opp;
        
        // Push it
        this._currentResult.items.push(itemData);
        
        // Consume the opportunity so it doesn't show again
        this._currentResult.signatureOpportunity = null;

        await this._refreshAdvisoryForCurrentCache();
        this.render();
    }


    // ── Reroll individual slot ────────────────────────────────────────────────

}

export function applyCacheGeneratorAdvisoryMethods(TargetClass) {
    for (const key of Object.getOwnPropertyNames(CacheGeneratorAdvisoryMethods.prototype)) {
        if (key === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(CacheGeneratorAdvisoryMethods.prototype, key);
        if (desc) Object.defineProperty(TargetClass.prototype, key, desc);
    }
}
