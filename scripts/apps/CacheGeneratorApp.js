import { CacheGenerator } from "../services/CacheGenerator.js";
import { ItemMaskingHelper } from "../services/ItemMaskingHelper.js";
import { ItemPoolResolver } from "../services/ItemPoolResolver.js";
import { LootPoolCompiler } from "../services/LootPoolCompiler.js";
import { PartyShelfPool } from "../services/PartyShelfPool.js";
import { ProgressionAdvisor } from "../services/ProgressionAdvisor.js";
import { SignatureLedger } from "../services/SignatureLedger.js";
import { StandalonePoolRegistry, getActiveCursedRegistry } from "../services/StandalonePoolRegistry.js";
import { takeVisibleCapped } from "../services/AdvisoryStripUtils.js";
import { CursedItemResolver } from "../services/CursedItemResolver.js";
import { ItemResolutionPipeline } from "../services/ItemResolutionPipeline.js";
import { SquashMerger } from "../services/SquashMerger.js";
import { TerrainDataRegistry } from "../services/TerrainDataRegistry.js";
import { Logger, MODULE_LABEL } from "../_logger.js";
import { roundCoinGp, formatCoinPrice, withCoinPriceLabel } from "../services/CoinFormat.js";

const MODULE_ID = "ionrift-quartermaster";

/** Foundry compendium / sidebar item drags (v12 and v13). */
function getFoundryDragData(event) {
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    return TE?.getDragEventData?.(event) ?? null;
}

/** Rows shown in Party Shelf and Cursed Pool strips (ledger + pool combined). */
const ADVISORY_SIDE_POOL_CAP = 2;

/** When Scroll Plan has no pins, those strips are hidden; shelf + cursed use one extra row. */
const ADVISORY_SIDE_POOL_CAP_NO_SCROLLS = ADVISORY_SIDE_POOL_CAP + 1;

/** Ephemeral compendium draw size before cache visibility filter (must exceed cap). */
const ADVISORY_EPHEMERAL_FETCH = 12;

/** Discrete budget windows per tier (click a segment to select). */
const TIER_BUDGET_BRACKETS = {
    1: [
        { min: 50, max: 150 },
        { min: 150, max: 300 },
        { min: 300, max: 450 },
        { min: 450, max: 500 }
    ],
    2: [
        { min: 200, max: 450 },
        { min: 450, max: 750 },
        { min: 750, max: 1100 },
        { min: 1100, max: 1500 }
    ],
    3: [
        { min: 800, max: 1800 },
        { min: 1800, max: 3200 },
        { min: 3200, max: 4200 },
        { min: 4200, max: 5000 }
    ],
    4: [
        { min: 2000, max: 5000 },
        { min: 5000, max: 8000 },
        { min: 8000, max: 11000 },
        { min: 11000, max: 15000 }
    ]
};

function formatGpShort(gp) {
    if (gp >= 1000) {
        const k = gp / 1000;
        return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
    }
    return `${gp}`;
}

function formatBracketLabel(min, max) {
    return `${formatGpShort(min)}-${formatGpShort(max)} gp`;
}

function bracketMidpoint(bracket) {
    return (bracket.min + bracket.max) / 2;
}

function nearestBracketIndex(brackets, gp) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < brackets.length; i++) {
        const dist = Math.abs(gp - bracketMidpoint(brackets[i]));
        if (dist < bestDist) {
            bestDist = dist;
            best = i;
        }
    }
    return best;
}


/**
 * Cache Generator UI.
 * Three-column layout when Progression Advisory has data:
 *   Left   -- read-only advisory: character milestone cards (passive reference).
 *   Center -- configure tier/terrain/owner, generate, reroll items.
 *   Right  -- matched container card; drag to canvas to place (Item Piles),
 *             or "Add to Items" button as fallback.
 * Falls back to two-column (center + right) when advisory is empty.
 * GM-only.
 */
export class CacheGeneratorApp extends Application {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ionrift-cache-generator",
            title: "Loot Cache Generator",
            template: `modules/${MODULE_ID}/templates/cache-generator.hbs`,
            // Match three-column layout width up front so opening empty and
            // opening after Generate do not resize (advisory column is 960px wide).
            width: 960,
            height: 720,
            classes: ["ionrift-window", "glass-ui"],
            resizable: true
        });
    }

    constructor(options = {}) {
        super(options);
        this._currentResult    = null;
        this._generating       = false;
        this._advisory         = null;
        // Default collapsed; restore last state if setting exists
        this._advisoryCollapsed = game.settings?.get(MODULE_ID, "advisoryCollapsed") ?? true;
        this._cursedPool       = [];      // random compendium-drawn cursed items for left panel
        this._cursedPlanned    = [];      // ledger cursedPlanned (milestone-pinned)
        this._partyShelfPool   = [];      // ephemeral party shelf from compendiums
        // Bound reference so we can remove it after use
        this._boundCanvasDrop = this._onCanvasDrop.bind(this);
        this._cursedPoolLoaded = false; // [EA] guards against re-fetch loop
        this._advisoryRerollState = new Map();
        // Tracks pools manually rerolled via dice button: suppresses isPlanned (recipe) items.
        // Reset on _onGenerate so fresh generation restores milestone priority.
        this._poolRerollMode = new Set();
        // Budget segment state (null = use saved bracket or tier default)
        this._budgetMin = null;
        this._budgetMax = null;
        this._budgetBracketIndex = null;
        this._sliderDebounce = null;
        this._sliderPersistTimer = null;
        this._dragEnterCount = 0;
        /** @type {number|undefined} Pool row index to refocus after a qty-step re-render. */
        this._qtyStepFocusIndex = undefined;
    }

    /**
     * Preserve `.cache-results` scroll (and optional qty input focus) across re-renders.
     * Without this, each quantity click rebuilds the list and jumps to the top.
     */
    async render(force = false, options = {}) {
        const results = this.element?.[0]?.querySelector(".cache-results");
        const scrollTop = results?.scrollTop ?? 0;
        const focusIndex = this._qtyStepFocusIndex;
        this._qtyStepFocusIndex = undefined;

        await super.render(force, options);

        if (scrollTop <= 0 && focusIndex === undefined) return;

        requestAnimationFrame(() => {
            this._constrainResultsHeight();
            requestAnimationFrame(() => {
                const nextResults = this.element?.[0]?.querySelector(".cache-results");
                if (nextResults && scrollTop > 0) nextResults.scrollTop = scrollTop;
                if (focusIndex !== undefined && Number.isFinite(focusIndex)) {
                    const input = this.element?.[0]?.querySelector(
                        `.cache-qty-input[data-index="${focusIndex}"]`
                    );
                    input?.focus({ preventScroll: true });
                }
            });
        });
    }

    getData() {
        const tier  = this._currentResult?.meta?.tier  ?? game.settings?.get(MODULE_ID, "defaultCacheTier")  ?? 1;
        const theme = this._currentResult?.meta?.theme ?? game.settings?.get(MODULE_ID, "defaultCacheTheme") ?? "dungeon";

        const themeOptionGroups = TerrainDataRegistry.getTerrainOptionGroups(theme);
        const themes = TerrainDataRegistry.getTerrainList()
            .map(t => ({ ...t, selected: t.id === theme }));

        const themeObj = themes.find(t => t.selected) ?? themes[0];

        // Container panel data
        const container = this._currentResult?.container ?? null;
        const fillPct        = container?.fillPercent ?? 0;
        const overweightClass = container?.isOverweight ? "overweight" : "";
        const capacityLabel  = container
            ? `${Number(container.contentWeightLbs ?? 0).toFixed(1)} / ${container.capacityLbs} lb`
            : "";
        const statsLabel = container
            ? `Empty: ${container.emptyWeightLbs ?? 0} lb  |  Cap: ${container.capacityLbs} lb`
            : "";

        const itemPilesActive = !!(game.modules?.get("itempilesdnd5e")?.active);

        const currentOwnerTheme = this._currentResult?.meta?.ownerTheme
            ?? game.settings?.get(MODULE_ID, "defaultCacheOwnerTheme")
            ?? "unspecified";

        // Compact labels for the secondary context strip
        const tierLabels = { 1: "T1", 2: "T2", 3: "T3", 4: "T4" };
        const tierLabel = tierLabels[tier] ?? `T${tier}`;

        const ownerThemes = [
            { id: "unspecified", label: "Unspecified", desc: "A general cache. Balanced distribution." },
            { id: "arcana",      label: "Arcana",      desc: "A spellcaster's reserves. Scrolls, reagents, and arcane curiosities." },
            { id: "apothecary",  label: "Apothecary",  desc: "A healer's stock or alchemist's shelf. Potions, elixirs, and medicinal supplies." },
            { id: "armaments",   label: "Armaments",   desc: "Military surplus or a warrior's stash. Weapons, armor, and practical gear." },
            { id: "implements",  label: "Implements",  desc: "A crafter's workshop or cult supplies. Tools, reagents, and utility items." },
            { id: "relics",      label: "Relics",      desc: "Remnants of the dead or divine. Ancient coins, holy relics, and cursed objects." },
            { id: "abandoned",   label: "Abandoned",   desc: "Forgotten junk. Mostly worthless, occasionally surprising." }
        ].map(t => ({ ...t, selected: t.id === currentOwnerTheme }));

        const brackets = TIER_BUDGET_BRACKETS[tier] ?? TIER_BUDGET_BRACKETS[1];
        const bracketIndex = this._resolveBudgetBracketIndex(tier, brackets);
        const activeBracket = brackets[bracketIndex];
        const budgetMin = this._budgetMin ?? activeBracket.min;
        const budgetMax = this._budgetMax ?? activeBracket.max;
        const budgetBrackets = brackets.map((b, i) => ({
            min: b.min,
            max: b.max,
            label: formatBracketLabel(b.min, b.max),
            selected: i === bracketIndex
        }));
        const budgetRangeLabel = formatBracketLabel(budgetMin, budgetMax);

        // Detect whether any loot pool compendium is configured. When empty the
        // Generate button is replaced with a nudge so the GM sets up sources first.
        const hasLootPool = ItemPoolResolver.getEnabledSources().length > 0;

        // Forge status pip -- shown inline next to Generate when a compiled pool
        // is stale or missing so the GM can act without leaving the generator.
        // Only surfaced when 2024 architecture is present (i.e. compilation matters).
        const forgeStatus     = LootPoolCompiler.is2024ArchitecturePresent()
            ? LootPoolCompiler.getStatus()
            : null;
        const forgeStalePip   = forgeStatus === "stale" || forgeStatus === "error";
        const forgeNeverPip   = forgeStatus === "never";

        return {
            tier,
            theme,
            tierIs1: tier === 1,
            tierIs2: tier === 2,
            tierIs3: tier === 3,
            tierIs4: tier === 4,
            tierLabel,
            themeLabel: themeObj.label,
            themes,
            themeOptionGroups,
            ownerThemes,
            currentOwnerTheme,
            result:    this._currentResult,
            generating: this._generating,
            hasResult: !!this._currentResult,
            hasLootPool,
            forgeStalePip,
            forgeNeverPip,

            container,
            fillPct,
            overweightClass,
            capacityLabel,
            statsLabel,
            itemPilesActive,
            advisory:         this._buildAdvisoryContext(),
            advisoryCollapsed: this._advisoryCollapsed,
            budgetMin,
            budgetMax,
            budgetBrackets,
            budgetRangeLabel,
            ...(this._currentResult ? this._groupItems(this._currentResult) : {})
        };
    }

    /**
     * Refresh cursed data for the left panel: random compendium pool + ledger planned.
     * Called after generation so the pool reflects the current tier.
     */
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
                img:              c.img ?? "icons/svg/item-bag.svg",
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
            img:              entry.img ?? "icons/svg/item-bag.svg",
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

        // Items that land in the Special Items section: anything injected from the
        // advisory panels (party shelf, cursed, signature) or auto-injected via RNG.
        // Generator-native signature stubs also belong here.
        const isSpecialSection = i => i._specialSection || i.isSignature;
        const isScroll         = i => !!i.spellName && !isSpecialSection(i);
        const isConsumable     = i => i.type === "consumable" && !i.spellName && !isSpecialSection(i);
        const isWeapon         = i => (i.type === "weapon" || i.type === "equipment") && !isSpecialSection(i);
        // Kind matchers accept either the runtime _qmKind tag (set by the
        // cache generator when picking from any QM role pool, including
        // overlay-materialised packs) or a legacy role-named compendium
        // suffix. Without _qmKind, items shipped via the kind-first overlay
        // path (world.quartermaster-core, world.quartermaster-bone-dust,
        // etc.) would fall through to the mundane section and render under
        // the Trade Goods header.
        const qmKindOrSuffix = (i, kind, suffix) =>
            i._qmKind === kind
            || (!!i.sourceCompendium && i.sourceCompendium.endsWith(`.${suffix}`));
        const isGemstone = i => qmKindOrSuffix(i, "gemstones", "quartermaster-gemstones") && !isSpecialSection(i);
        const isTreasure = i => qmKindOrSuffix(i, "treasure",  "quartermaster-treasure")  && !isSpecialSection(i);
        const isTrinket  = i => qmKindOrSuffix(i, "trinkets",  "quartermaster-trinkets")  && !isSpecialSection(i);
        const isMundane        = i => !isScroll(i) && !isSpecialSection(i) && !isConsumable(i)
                                      && !isWeapon(i) && !isGemstone(i) && !isTreasure(i) && !isTrinket(i)
                                      && (i.type === "loot" || i.type === "tool" || !i.type);

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

    activateListeners(html) {
        super.activateListeners(html);

        html.find(".action-generate").click(this._onGenerate.bind(this));

        // Loot pool nudge: opens CompendiumForgeApp on the Loot Pool tab so the
        // GM can configure sources before attempting generation.
        html.find(".action-open-pool-compiler, .action-open-forge-from-pip").click(async () => {
            const { CompendiumForgeApp } = await import("./CompendiumForgeApp.js");
            new CompendiumForgeApp({}, { activeTab: "lootPool" }).render(true);
        });
        html.find(".action-reroll-slot").click(this._onRerollSlot.bind(this));
        html.find(".action-remove-slot").click(this._onRemoveSlot.bind(this));
        html.find(".action-qty-up").click(this._onQtyStep.bind(this, 1));
        html.find(".action-qty-down").click(this._onQtyStep.bind(this, -1));
        html.find(".cache-qty-input").on("change", this._onEditQuantity.bind(this));
        html.find(".cache-qty-input").on("blur", this._onQtyInputBlur.bind(this));
        html.find(".action-reroll-container").click(this._onRerollContainer.bind(this));
        html.find(".action-inject-signature").click(this._onInjectSignature.bind(this));
        html.find(".action-add-items").click(this._onAddToItems.bind(this));
        html.find(".action-clear-gold").click(this._onClearGold.bind(this));
        html.find(".action-reroll-gold").click(this._onRerollGold.bind(this));

        // Advisory panel toggle
        html.find(".action-toggle-advisory").click(this._onToggleAdvisory.bind(this));
        // Section collapse toggles in the left panel
        html.find(".advisory-section-toggle").click(this._onToggleAdvisorySection.bind(this));
        // Panel pool reroll dice buttons (scroll plan / party shelf / cursed pool)
        html.find(".action-reroll-panel-pool").click(this._onRerollPanelPool.bind(this));

        // Auto-persist tier and theme selects on change; reroll if a result is already showing
        html.find("select[name='tier']").change(e => {
            game.settings.set(MODULE_ID, "defaultCacheTier", parseInt(e.target.value) || 1);
            // Reset budget segment when tier changes so the new tier picks a fresh bracket
            this._budgetMin = null;
            this._budgetMax = null;
            this._budgetBracketIndex = null;
            if (this._currentResult) this._onGenerate();
        });
        html.find("select[name='theme']").change(e => {
            game.settings.set(MODULE_ID, "defaultCacheTheme", e.target.value);
            if (this._currentResult) this._onGenerate();
        });

        // Live update guidance text for owner theme + persist + auto-reroll
        html.find("select[name='ownerTheme']").change(e => {
            const val = e.target.value;
            html.find(".guidance-text").hide();
            html.find(`.guidance-text.guidance-${val}`).css("display", "inline");
            game.settings.set(MODULE_ID, "defaultCacheOwnerTheme", val);
            if (this._currentResult) this._onGenerate();
        });

        html.find(".budget-segment").click(this._onBudgetSegmentClick.bind(this));

        html.find(".cache-item-row").on("click", ".cache-item-icon, .cache-item-name", this._onInspectItem.bind(this));

        // Drag-to-canvas: container card is the drag handle when Item Piles is active
        const card = html.find(".container-card[draggable='true']")[0];
        if (card) {
            card.addEventListener("dragstart", this._onDragContainerStart.bind(this));
            card.addEventListener("dragend", this._onDragContainerEnd.bind(this));
        }

        // Left-panel drags: signatures, party shelf, scroll plan, cursed pool (shared handler).
        html[0].querySelectorAll(".advisory-card-item[draggable=\"true\"], .shelf-item[draggable=\"true\"]").forEach(el => {
            el.addEventListener("dragstart", this._onLeftPanelItemDragStart.bind(this));
        });

        // Cache results list + the full right panel: accept drops from left-panel items.
        // Using the right panel as the outer drop zone means the GM can drop anywhere
        // in the preview area (container card, drag-hint, etc.) not just the item list.
        // Uses a dragEnter counter to avoid flickering when the cursor
        // crosses child-element boundaries within the drop zone.
        const resultsEl = html.find(".cache-results")[0];
        if (resultsEl) {
            resultsEl.addEventListener("dragenter",  this._onCacheResultsDragEnter.bind(this));
            resultsEl.addEventListener("dragover",   this._onCacheResultsDragOver.bind(this));
            resultsEl.addEventListener("dragleave",  this._onCacheResultsDragLeave.bind(this));
            resultsEl.addEventListener("drop",       this._onCacheResultsDrop.bind(this));
        }

        // Extend drop zone to the full right panel (container/loot preview area)
        const rightEl = html.find("#cache-right-drop-zone")[0];
        if (rightEl) {
            rightEl.addEventListener("dragenter",  this._onCacheResultsDragEnter.bind(this));
            rightEl.addEventListener("dragover",   this._onCacheResultsDragOver.bind(this));
            rightEl.addEventListener("dragleave",  this._onCacheResultsDragLeave.bind(this));
            rightEl.addEventListener("drop",       this._onCacheResultsDrop.bind(this));
        }

        // Constrain results height so overflow-y scroll is reliable
        requestAnimationFrame(() => this._constrainResultsHeight());

        if (this._currentResult) {
            html.find(".cache-results").addClass("visible");
        }

        // Eager advisory + pools: populate all three left-panel sections on
        // first open so the GM sees Signatures, Party Shelf, and Cursed Pool.
        const tier = this._currentResult?.meta?.tier ?? game.settings?.get(MODULE_ID, "defaultCacheTier") ?? 1;
        const pending = [];

        if (!this._advisory) {
            pending.push(
                ProgressionAdvisor.advise(tier, this._currentResult).then(adv => {
                    this._advisory = adv;
                })
            );
        }

        if (this._partyShelfPool.length === 0) {
            pending.push(this._refreshPartyShelfPool(tier));
        }

        if (!this._cursedPoolLoaded) {
            pending.push(this._refreshCursedPool(tier));
        }

        if (pending.length) {
            Promise.all(pending).then(() => this.render());
        }
    }

    // ── Budget segment selection ─────────────────────────────────────────────

    _resolveBudgetBracketIndex(tier, brackets) {
        if (this._budgetBracketIndex !== null && this._budgetBracketIndex !== undefined) {
            return Math.max(0, Math.min(brackets.length - 1, this._budgetBracketIndex));
        }

        const savedIdx = game.settings?.get(MODULE_ID, "cacheBudgetBracketIndex") ?? -1;
        if (savedIdx >= 0) {
            return Math.max(0, Math.min(brackets.length - 1, savedIdx));
        }

        const savedAnchorPct = game.settings?.get(MODULE_ID, "cacheBudgetAnchorPct") ?? -1;
        if (savedAnchorPct >= 0) {
            const low = brackets[0].min;
            const high = brackets[brackets.length - 1].max;
            const approxGp = low + savedAnchorPct * (high - low);
            return nearestBracketIndex(brackets, approxGp);
        }

        return 0;
    }

    _onBudgetSegmentClick(event) {
        event.preventDefault();
        const btn = event.currentTarget;
        const min = parseInt(btn.dataset.min, 10);
        const max = parseInt(btn.dataset.max, 10);
        const index = parseInt(btn.dataset.index, 10);
        if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(index)) return;

        this._budgetMin = min;
        this._budgetMax = max;
        this._budgetBracketIndex = index;

        const html = $(this.element);
        html.find(".budget-segment").removeClass("is-selected");
        btn.classList.add("is-selected");
        html.find("[name='budgetMin']").val(min);
        html.find("[name='budgetMax']").val(max);
        html.find(".budget-range-display").text(formatBracketLabel(min, max));

        if (this._currentResult) {
            CacheGenerator.applyBudgetFloor(this._currentResult, min, max);
            this._syncBudgetDisplay();
        }

        this._persistBudgetBracket(index);
        this._debouncedBudgetReroll();
    }

    // ── Scroll constraint (set maxHeight on results so overflow-y works) ────

    _constrainResultsHeight() {
        const elem = this.element[0];
        if (!elem) return;
        const center  = elem.querySelector(".cache-center");
        const results = elem.querySelector(".cache-results");
        if (!center || !results) return;

        const centerH = center.getBoundingClientRect().height;
        if (centerH === 0) return; // not yet painted

        // Sum height of all .cache-center direct children EXCEPT .cache-results
        let taken = 0;
        for (const child of center.children) {
            if (child !== results) taken += child.getBoundingClientRect().height;
        }

        const available = Math.max(80, centerH - taken);
        results.style.maxHeight = `${available}px`;
        results.style.overflowY  = "auto";
    }

    /** Re-constrain after the user resizes the window */
    _onResize(event) {
        super._onResize(event);
        requestAnimationFrame(() => this._constrainResultsHeight());
    }

    // ── Generate ─────────────────────────────────────────────────────────────

    /** Debounce budget segment reroll after a segment click. */
    _debouncedBudgetReroll() {
        if (!this._currentResult) return;
        clearTimeout(this._sliderDebounce);
        this._sliderDebounce = setTimeout(() => {
            if (this._generating) {
                this._debouncedBudgetReroll();
                return;
            }
            this._onGenerate();
        }, 400);
    }

    _persistBudgetBracket(index) {
        if (!Number.isFinite(index)) return;
        clearTimeout(this._sliderPersistTimer);
        this._sliderPersistTimer = setTimeout(() => {
            game.settings?.set(MODULE_ID, "cacheBudgetBracketIndex", index).catch(() => {});
        }, 200);
    }

    async _onGenerate(event) {
        event?.preventDefault();
        if (this._generating) return;

        const form = this.element.find("form")[0];
        if (!form) return;

        const formData = Object.fromEntries(new FormData(form));
        const tier       = parseInt(formData.tier)       || 1;
        const theme      = formData.theme                || "dungeon";
        const ownerTheme = formData.ownerTheme           || "unspecified";

        // Budget overrides: explicit drag state → form hidden inputs → tier defaults.
        // The footer (hidden inputs) doesn't exist on first generate, so we always
        // have a tier-appropriate fallback to ensure the pill position is respected.
        const tierBudgetDefaults = {
            1: { min: 50,   max: 500   },
            2: { min: 200,  max: 1500  },
            3: { min: 800,  max: 5000  },
            4: { min: 2000, max: 15000 }
        };
        const tbd = tierBudgetDefaults[tier] ?? tierBudgetDefaults[2];
        const budgetMin = this._budgetMin ?? (formData.budgetMin ? parseInt(formData.budgetMin) : tbd.min);
        const budgetMax = this._budgetMax ?? (formData.budgetMax ? parseInt(formData.budgetMax) : tbd.max);


        this._generating = true;
        this._advisory   = null;
        this._poolRerollMode?.clear();  // Fresh generate restores milestone priority
        this._setGeneratingUi(true);

        try {
            this._currentResult = await CacheGenerator.generate({
                tier, theme, ownerTheme, silent: true,
                budgetMin, budgetMax
            });
            [this._advisory] = await Promise.all([
                ProgressionAdvisor.advise(tier, this._currentResult),
                this._refreshPartyShelfPool(tier),
                this._refreshCursedPool(tier)
            ]);
        } catch (e) {
            Logger.error(MODULE_LABEL, "Generation failed:", e);
            ui.notifications.error("Cache generation failed.");
        } finally {
            this._generating = false;
            this._setGeneratingUi(false);
            this.render();
        }
    }

    // ── Left Panel Item Drag ──────────────────────────────────────────────────

    /**
     * Fired when the GM begins dragging an item from the advisory, party shelf,
     * or cursed pool panel. Sets the transfer payload to the item's UUID so the
     * cache results list can resolve and inject it on drop.
     */
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

    // ── Coinage controls ──────────────────────────────────────────────────────

    _onClearGold(event) {
        event.preventDefault();
        if (!this._currentResult) return;
        CacheGenerator.clearCacheGold(this._currentResult);
        this.render();
    }

    async _onRerollGold(event) {
        event.preventDefault();
        if (!this._currentResult) return;
        await CacheGenerator.rerollCacheGold(this._currentResult);
        this.render();
    }

    // ── Advisory Panel ────────────────────────────────────────────────────────

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

    /** Generic reroll handler - advance the index for the row key in reroll state. */
    _onRerollAdvisoryRow(event) {
        event.preventDefault();
        const key = event.currentTarget.dataset.rerollKey;
        if (!key) return;
        const current = this._advisoryRerollState.get(key) ?? 0;
        this._advisoryRerollState.set(key, current + 1);
        this.render();
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

    async _onInjectPowerItem(event) {
        event.preventDefault();
        const actorId = event.currentTarget.dataset.actorId;
        const row     = this._advisory?.powerBalance?.find(r => r.actorId === actorId);
        if (!row) return;

        const key    = `powerBalance|${actorId}`;
        const raw    = this._advisoryRerollState.get(key) ?? 0;
        const idx    = raw % row.alternatives.length;
        const planned = row.alternatives[idx];
        if (!planned) return;

        await this._injectItem(planned, { badge: "Power Balance", treatAsSignature: true });
    }

    async _onInjectShelfItem(event) {
        event.preventDefault();
        const alts  = this._advisory?.partyShelf ?? [];
        const raw   = this._advisoryRerollState.get("partyShelf") ?? 0;
        const idx   = raw % (alts.length || 1);
        const entry = alts[idx];
        if (!entry) return;

        await this._injectItem(entry, { badge: "Party Shelf", markDelivered: true });
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
                name:        `Spell Scroll of ${spellName}`,
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
            const qmFlags = resolvedDoc?.flags?.["ionrift-quartermaster"] ?? {};

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

        const isSpecial = treatAsSignature || markCursed || badge === "Party Shelf";
        if (isSpecial) {
            itemData._specialSection = true;
            itemData._specialType    = markCursed       ? "cursed"
                                     : badge === "Party Shelf" ? "partyShelf"
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
                itemData.flags["ionrift-quartermaster"] = { isSignature: true };
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

    // ── Enrich Hoard ─────────────────────────────────────────────────────────

    /**
     * Inject a significant wondrous item from party actor inventories.
     * "Party shelf" = items on player characters that look notable (uncommon+,
     * equipment type, not already in the cache). GM picks which one lands.
     */
    async _onEnrichHoard(event) {
        event.preventDefault();
        if (!this._currentResult) return;

        // Gather notable items from all player-owned actors
        const playerActors = game.ionrift?.library?.party?.getMembers()
            ?? game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
        const shelf = [];
        for (const actor of playerActors) {
            for (const item of actor.items) {
                const rarity = (item.system?.rarity ?? "").toLowerCase();
                if (!["uncommon","rare","veryrare","legendary"].includes(rarity)) continue;
                if (!["equipment","weapon","consumable","loot"].includes(item.type)) continue;
                shelf.push({
                    name:            item.name,
                    img:             item.img,
                    type:            item.type,
                    price:           item.system?.price?.value ?? 0,
                    rarity,
                    sourceCompendium: item.sourceId?.split(".Item.")[0]?.replace("Compendium.","") ?? "",
                    _compendiumId:   item.sourceId?.split(".Item.")[1] ?? "",
                    uuid:            item.uuid,
                    ownerName:       actor.name,
                });
            }
        }

        if (shelf.length === 0) {
            ui.notifications.info("No notable items found on party members. Add some magic gear first.");
            return;
        }

        // Build a simple dialog for the GM to pick one
        const options = shelf.map((item, i) =>
            `<option value="${i}">[${item.ownerName}] ${item.name} (${item.rarity})</option>`
        ).join("");

        const content = `
            <div style="padding: 4px 0;">
                <p style="margin:0 0 8px; opacity:0.8; font-size:0.9em;">Select an item to inject as a significant find in this cache.</p>
                <select id="enrich-item-pick" style="width:100%">${options}</select>
            </div>`;

        new Dialog({
            title: "Enrich Hoard",
            content,
            buttons: {
                inject: {
                    icon: "<i class='fas fa-star'></i>",
                    label: "Inject",
                    callback: async (html) => {
                        const idx = parseInt(html.find("#enrich-item-pick").val());
                        const entry = shelf[idx];
                        if (!entry) return;
                        await this._injectItem(entry, { badge: "Enriched" });
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "inject"
        }).render(true);
    }

    // ── Curse Cache ─────────────────────────────────────────────────────────

    /**
     * Run the curse injection pipeline over the current result and re-render.
     * Equivalent to what generate() does automatically when forceCurse is set,
     * but applied to an already-generated cache on demand.
     */
    async _onCurseCache(event) {
        event.preventDefault();
        if (!this._currentResult) return;

        const btn = $(event.currentTarget);
        btn.prop("disabled", true).html("<i class='fas fa-spinner fa-spin'></i> Cursing...");

        try {
            const didCurse = await CacheGenerator.applyCacheCurses(this._currentResult, { forceCurse: true });
            this.render();
            if (didCurse) {
                ui.notifications.info("A curse has been woven into the cache.");
            } else {
                ui.notifications.warn("No suitable items to curse. Add a Potion of Healing first.");
            }
        } catch (e) {
            Logger.error(MODULE_LABEL, "Curse injection failed:", e);
            ui.notifications.warn("Curse injection failed. Check console.");
        } finally {
            btn.prop("disabled", false).html("<i class='fas fa-skull'></i> Curse Cache");
        }
    }

    // ── Reroll individual slot ────────────────────────────────────────────────

    async _onRerollSlot(event) {
        event.preventDefault();
        if (!this._currentResult) return;

        const slotType   = event.currentTarget.dataset.slot;
        const stackName  = event.currentTarget.dataset.stackName;
        const stackCount = parseInt(event.currentTarget.dataset.stackCount ?? "1");
        const index      = parseInt(event.currentTarget.dataset.index);
        const items      = this._currentResult.items;

        const tables   = await CacheGenerator._loadTables();
        const tierData = tables.tiers[String(this._currentResult.meta.tier)];
        if (tables.tiers) {
            for (const [key, td] of Object.entries(tables.tiers)) td._tier = parseInt(key);
        }
        const theme = this._currentResult.meta.theme;

        // Helper: pick one replacement (routed through _pickItem for masking)
        const pickOne = async () => {
            if (slotType === "signature") {
                return CacheGenerator._generateSignatureStub(this._currentResult.meta.tier, theme);
            }
            return CacheGenerator._pickItem(slotType, theme, tierData, tables);
        };

        if (stackCount > 1 && stackName) {
            // Reroll all instances of this stacked item in parallel
            const allIndices = items
                .map((item, i) => item.name === stackName ? i : -1)
                .filter(i => i >= 0);
            const replacements = await Promise.all(allIndices.map(() => pickOne()));
            allIndices.forEach((idx, i) => {
                if (replacements[i]) items[idx] = replacements[i];
            });
        } else {
            if (index < 0 || index >= items.length) return;
            const replacement = await pickOne();
            if (replacement) items[index] = replacement;
        }

        await this._refreshAdvisoryForCurrentCache();
        this.render();
    }

    // ── Quantity edit (cache preview) ─────────────────────────────────────────

    /** Keep line price aligned with quantity edits in the preview list. */
    _recalcLinePrice(item) {
        const qty = Math.max(1, Number(item.quantity) || 1);
        if (item._unitPrice == null) {
            const basisQty = Math.max(1, Number(item._priceBasisQty) || qty);
            item._unitPrice = (item.price ?? 0) / basisQty;
        }
        item._priceBasisQty = qty;
        item.price = roundCoinGp(item._unitPrice * qty);
    }

    /** Update gold chips and the footer estimate without rebuilding the item list. */
    _syncBudgetDisplay() {
        if (!this._currentResult) return;
        const grouped = this._groupItems(this._currentResult);
        const root = this.element?.[0];
        if (!root) return;

        const chips = root.querySelector(".cache-gold-chips");
        if (chips) chips.innerHTML = this._buildGoldChipsHtml(grouped);

        const totalEl = root.querySelector(".cache-total strong");
        if (totalEl) totalEl.textContent = grouped.totalValueLabel;
    }

    _buildGoldChipsHtml({ gold, coinage }) {
        if (!gold) {
            return '<span class="cache-gold-empty">No coinage</span>';
        }

        const chip = (cls, amount, label) =>
            `<span class="coin-chip ${cls}"><i class="fas fa-circle"></i> ${amount} ${label}</span>`;

        if (coinage) {
            let html = "";
            if (coinage.pp) html += chip("coin-pp", coinage.pp, "pp");
            if (coinage.gp) html += chip("coin-gp", coinage.gp, "gp");
            if (coinage.ep) html += chip("coin-ep", coinage.ep, "ep");
            if (coinage.sp) html += chip("coin-sp", coinage.sp, "sp");
            if (coinage.cp) html += chip("coin-cp", coinage.cp, "cp");
            if (html) return html;
        }

        return chip("coin-gp", gold, "gp");
    }

    _setGeneratingUi(active) {
        const root = this.element?.[0];
        if (!root) return;

        for (const btn of root.querySelectorAll(".action-generate")) {
            btn.disabled = active;
            if (active) {
                if (!btn.dataset.prevHtml) btn.dataset.prevHtml = btn.innerHTML;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
            } else if (btn.dataset.prevHtml) {
                btn.innerHTML = btn.dataset.prevHtml;
                delete btn.dataset.prevHtml;
            }
        }
    }

    _onQtyStep(delta, event) {
        event.preventDefault();
        event.stopPropagation();
        if (!this._currentResult) return;
        const index = parseInt(event.currentTarget.dataset.index, 10);
        if (!Number.isFinite(index) || index < 0 || index >= this._currentResult.items.length) return;
        const item = this._currentResult.items[index];
        const current = Number(item.quantity) || 1;
        const next = Math.max(1, Math.min(99, current + delta));
        if (next === current) return;
        item.quantity = next;
        this._recalcLinePrice(item);
        this._qtyStepFocusIndex = index;
        this.render();
    }

    /** Restore blank quantity fields to the last known stack size (no commit). */
    _onQtyInputBlur(event) {
        const el = event.currentTarget;
        const v = String(el.value ?? "").trim();
        if (v !== "") return;
        const fallback = parseInt(el.dataset.stackCount || "1", 10) || 1;
        el.value = String(Math.max(1, Math.min(99, fallback)));
    }

    /**
     * Direct quantity edit on cache preview rows. Supports stacked same-name
     * lines by growing or shrinking the underlying item list.
     */
    _onEditQuantity(event) {
        event.stopPropagation();
        if (!this._currentResult) return;

        const el = event.currentTarget;
        const items = this._currentResult.items;
        const stackName = (el.dataset.stackName || "").trim();
        const stackCount = parseInt(el.dataset.stackCount || "1", 10) || 1;
        const index = parseInt(el.dataset.index, 10);

        let raw = parseInt(String(el.value).trim(), 10);
        if (!Number.isFinite(raw)) {
            el.value = String(Math.max(1, Math.min(99, stackCount)));
            return;
        }
        const target = Math.max(1, Math.min(99, raw));

        const groupIdx = stackName
            ? items.map((it, i) => (it.name === stackName ? i : -1)).filter(i => i >= 0)
            : [];

        if (stackName && groupIdx.length > 1) {
            const cur = groupIdx.length;
            if (target > cur) {
                const proto = items[groupIdx[0]];
                for (let i = cur; i < target; i++) {
                    items.push(foundry.utils.deepClone(proto));
                }
            } else if (target < cur) {
                const removeIdx = groupIdx.slice(target).sort((a, b) => b - a);
                for (const i of removeIdx) items.splice(i, 1);
            }
            for (const idx of items.map((it, i) => (it.name === stackName ? i : -1)).filter(i => i >= 0)) {
                items[idx].quantity = 1;
                this._recalcLinePrice(items[idx]);
            }
        } else if (Number.isFinite(index) && index >= 0 && index < items.length) {
            items[index].quantity = target;
            this._recalcLinePrice(items[index]);
        } else if (groupIdx.length === 1) {
            items[groupIdx[0]].quantity = target;
            this._recalcLinePrice(items[groupIdx[0]]);
        }

        el.value = String(target);
        if (Number.isFinite(index)) this._qtyStepFocusIndex = index;
        void this._refreshAdvisoryForCurrentCache().then(() => this.render());
    }

    // ── Remove individual slot ────────────────────────────────────────────────

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
        if (!this._currentResult || !game.modules?.get("itempilesdnd5e")?.active) {
            event.preventDefault();
            return;
        }

        // Serialise result for the canvas drop handler
        event.dataTransfer.setData("text/plain", JSON.stringify({
            type: "ionrift-cache",
            result: this._currentResult
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
        if (data?.type !== "ionrift-cache" || !data.result) return;

        const result = data.result;

        // Convert browser client coords to canvas world coordinates, then snap to grid
        const t = canvas.stage.worldTransform;
        const rawX = (event.clientX - t.tx) / canvas.stage.scale.x;
        const rawY = (event.clientY - t.ty) / canvas.stage.scale.y;
        const snapped = canvas.grid.getSnappedPoint({ x: rawX, y: rawY }, { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX });
        const x = snapped?.x ?? rawX;
        const y = snapped?.y ?? rawY;

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
            const QM_FLAG = "ionrift-quartermaster";
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

            const currencyOverrides = {};
            if (result.coinage) {
                for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
                    currencyOverrides[`system.currency.${denom}`] = result.coinage[denom] ?? 0;
                }
            } else {
                currencyOverrides["system.currency.gp"] = result.gold ?? 0;
            }

            await game.itempiles.API.createItemPile({
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
                    sight:           { enabled: false }
                },
                actorOverrides: {
                    name: containerName,
                    img: containerImg,
                    ...currencyOverrides
                }
            });
        } catch (e) {
            Logger.error(MODULE_LABEL, "Item Piles createItemPile failed:", e);
            ui.notifications.error("Failed to place cache. Check console for details.");
        }
    }

    // ── Add to Items (fallback, no Item Piles) ────────────────────────────────

    async _onAddToItems(event) {
        event.preventDefault();
        if (!this._currentResult) return;

        const btn = $(event.currentTarget);
        btn.prop("disabled", true).html('<i class="fas fa-spinner fa-spin"></i> Adding...');

        try {
            await CacheGenerator._addToItems(this._currentResult);
            btn.html('<i class="fas fa-check"></i> Added');
        } catch (e) {
            Logger.error(MODULE_LABEL, "Add to items failed:", e);
            ui.notifications.error("Failed to add items. Check console.");
            btn.prop("disabled", false).html('<i class="fas fa-box-open"></i> Add to Items');
        }
    }
}
