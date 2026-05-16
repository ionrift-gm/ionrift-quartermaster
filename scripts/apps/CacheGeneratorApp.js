import { CacheGenerator } from "../services/CacheGenerator.js";
import { ItemMaskingHelper } from "../services/ItemMaskingHelper.js";
import { PartyShelfPool } from "../services/PartyShelfPool.js";
import { ProgressionAdvisor } from "../services/ProgressionAdvisor.js";
import { SignatureLedger } from "../services/SignatureLedger.js";
import { StandalonePoolRegistry } from "../services/StandalonePoolRegistry.js";
import { takeVisibleCapped } from "../services/AdvisoryStripUtils.js";
import { Logger, MODULE_LABEL } from "../_logger.js";

const MODULE_ID = "ionrift-quartermaster";

/** Rows shown in Party Shelf and Cursed Pool strips (ledger + pool combined). */
const ADVISORY_SIDE_POOL_CAP = 2;

/** When Scroll Plan has no pins, those strips are hidden; shelf + cursed use one extra row. */
const ADVISORY_SIDE_POOL_CAP_NO_SCROLLS = ADVISORY_SIDE_POOL_CAP + 1;

/** Ephemeral compendium draw size before cache visibility filter (must exceed cap). */
const ADVISORY_EPHEMERAL_FETCH = 12;

/** Same registry Quartermaster uses: Cursewright when present, else QM settings + SRD pool. */
function getCursedPoolRegistry() {
    return game.ionrift?.cursewright?.registry ?? StandalonePoolRegistry;
}

/**
 * Healing-potion surface names that participate in infected-stack squash (clean + poison vials).
 * Keep in sync with ionrift-cursewright `CurseEngine.POTION_CURSE_TIERS` decoy names (pre-masking).
 */
const POISON_STACK_DECOY_NAME_RX = [
    /^Potion of Healing( \(Basic\))?$/i,
    /^Potion of Greater Healing$/i,
    /^Potion of Superior Healing$/i,
    /^Potion of Supreme Healing$/i
];

/**
 * @param {object} item - Ephemeral cache row from `result.items` (Pass B).
 * @returns {boolean} True when this cursed row should contribute to `_infectedCount` / infectedRate.
 */
function _isPoisonStackMergeSource(item) {
    if (!item) return false;
    if (item.isInfectedStack) return true;
    const name = (item.name || "").trim();
    return POISON_STACK_DECOY_NAME_RX.some(rx => rx.test(name));
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
        // Budget range slider state (null = use tier default)
        this._budgetMin = null;
        this._budgetMax = null;
        this._sliderDebounce = null;
    }

    getData() {
        const tier  = this._currentResult?.meta?.tier  ?? game.settings?.get(MODULE_ID, "defaultCacheTier")  ?? 1;
        const theme = this._currentResult?.meta?.theme ?? game.settings?.get(MODULE_ID, "defaultCacheTheme") ?? "dungeon";

        const themes = [
            { id: "dungeon", label: "Dungeon"  },
            { id: "forest",  label: "Forest"   },
            { id: "swamp",   label: "Swamp"    },
            { id: "desert",  label: "Desert"   },
            { id: "urban",   label: "Urban"    },
            { id: "mountain",label: "Mountain" },
            { id: "arctic",  label: "Arctic"   }
        ].map(t => ({ ...t, selected: t.id === theme }));

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

        // Budget slider bounds: tier-specific sensible defaults
        const tierBudgetDefaults = {
            1: { min: 50,   max: 500,   sliderMin: 0,   sliderMax: 1000  },
            2: { min: 200,  max: 1500,  sliderMin: 0,   sliderMax: 3000  },
            3: { min: 800,  max: 5000,  sliderMin: 0,   sliderMax: 10000 },
            4: { min: 2000, max: 15000, sliderMin: 0,   sliderMax: 30000 }
        };
        const tbd = tierBudgetDefaults[tier] ?? tierBudgetDefaults[1];
        const budgetMin = this._budgetMin ?? tbd.min;
        const budgetMax = this._budgetMax ?? tbd.max;

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
            ownerThemes,
            currentOwnerTheme,
            result:    this._currentResult,
            generating: this._generating,
            hasResult: !!this._currentResult,
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
            budgetSliderMin: tbd.sliderMin,
            budgetSliderMax: tbd.sliderMax,
            ...(this._currentResult ? this._groupItems(this._currentResult) : {})
        };
    }

    /**
     * Refresh cursed data for the left panel: random compendium pool + ledger planned.
     * Called after generation so the pool reflects the current tier.
     */
    async _refreshCursedPool(tier = 1) {
        const reg = getCursedPoolRegistry();

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

            // Live-resolve display names from the forged pack. Pool entries
            // store names at load-time and go stale after a recompile.
            // getIndex() cannot be used here — Foundry V14 applies dnd5e's name
            // getter, so items with identified:false return "Unidentified Consumable".
            // Full documents give us _source.name and reliable flag access.
            try {
                const _fp = game.packs.get("world.ionrift-cursewright-forged")
                         ?? game.packs.get("world.ionrift-forged-cursed");
                if (_fp && this._cursedPool.length) {
                    const _docs = await _fp.getDocuments();
                    const _nm = new Map();
                    for (const doc of _docs) {
                        const _qm = doc.flags?.["ionrift-quartermaster"] ?? {};
                        _nm.set(
                            `Compendium.${_fp.collection}.Item.${doc.id}`,
                            _qm.latentMagic?.originalName ?? _qm.cursedMeta?.lureName ?? doc._source?.name ?? doc.name
                        );
                    }
                    this._cursedPool = this._cursedPool.map(entry => ({
                        ...entry,
                        name: _nm.get(entry.uuid) ?? entry.name
                    }));
                }
            } catch { /* unreadable pack — stored names are used as-is */ }

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
                // Regular consumables with the same display name are clean — do not badge them.
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
        const isGemstone       = i => i.sourceCompendium === "ionrift-quartermaster.quartermaster-gemstones" && !isSpecialSection(i);
        const isTreasure       = i => i.sourceCompendium === "ionrift-quartermaster.quartermaster-treasure" && !isSpecialSection(i);
        const isMundane        = i => !isScroll(i) && !isSpecialSection(i) && !isConsumable(i)
                                      && !isWeapon(i) && !isGemstone(i) && !isTreasure(i)
                                      && (i.type === "loot" || i.type === "tool" || !i.type);

        // Merge same-name items into stacks
        const squash = (arr) => {
            const seen = new Map();
            for (const item of arr) {
                if (seen.has(item.name)) {
                    seen.get(item.name).quantity += 1;
                } else {
                    seen.set(item.name, { ...item, quantity: item.quantity ?? 1 });
                }
            }
            return [...seen.values()].map(i => ({
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
            mundane:     squash(items.filter(isMundane)),
            totalValue:  Math.round((result.gold + items.reduce((sum, i) => sum + (i.price ?? 0), 0)) * 100) / 100,
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
        html.find(".action-reroll-slot").click(this._onRerollSlot.bind(this));
        html.find(".action-remove-slot").click(this._onRemoveSlot.bind(this));
        html.find(".action-qty-up").click(this._onQtyStep.bind(this, 1));
        html.find(".action-qty-down").click(this._onQtyStep.bind(this, -1));
        html.find(".cache-qty-input").on("change", this._onEditQuantity.bind(this));
        html.find(".cache-qty-input").on("blur", this._onQtyInputBlur.bind(this));
        html.find(".action-reroll-container").click(this._onRerollContainer.bind(this));
        html.find(".action-inject-signature").click(this._onInjectSignature.bind(this));
        html.find(".action-add-items").click(this._onAddToItems.bind(this));

        // Advisory panel toggle
        html.find(".action-toggle-advisory").click(this._onToggleAdvisory.bind(this));
        // Section collapse toggles in the left panel
        html.find(".advisory-section-toggle").click(this._onToggleAdvisorySection.bind(this));
        // Panel pool reroll dice buttons (scroll plan / party shelf / cursed pool)
        html.find(".action-reroll-panel-pool").click(this._onRerollPanelPool.bind(this));

        // Auto-persist tier and theme selects on change; reroll if a result is already showing
        html.find("select[name='tier']").change(e => {
            game.settings.set(MODULE_ID, "defaultCacheTier", parseInt(e.target.value) || 1);
            // Reset budget bracket when tier changes so slider defaults to the new tier
            this._budgetMin = null;
            this._budgetMax = null;
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

        // Budget pill — initialise drag after first paint
        requestAnimationFrame(() => this._initPillDrag(html));

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

    // ── Budget pill drag ──────────────────────────────────────────────────────

    _initPillDrag(html) {
        const track = html.find(".value-range-track")[0];
        const pill  = html.find(".budget-pill-handle")[0];
        if (!track || !pill) return;

        this._updatePillPosition(html);

        let dragging = false, startX = 0, startAnchorPct = 0;

        // Tooltip wired to pill hover
        pill.addEventListener("mouseenter", () => this._showRangeTooltip(html));
        pill.addEventListener("mouseleave", () => { if (!dragging) this._hideRangeTooltip(html); });

        pill.addEventListener("mousedown", (e) => {
            dragging = true;
            startX = e.clientX;
            const sliderMin = parseInt(track.dataset.sliderMin ?? 0);
            const sliderMax = parseInt(track.dataset.sliderMax ?? 3000);
            const anchor = this._budgetMin ?? sliderMin;
            startAnchorPct = (anchor - sliderMin) / (sliderMax - sliderMin) * 100;
            pill.classList.add("dragging");
            e.preventDefault();
        });

        const onMove = (e) => {
            if (!dragging) return;
            const trackRect = track.getBoundingClientRect();
            const sliderMin = parseInt(track.dataset.sliderMin ?? 0);
            const sliderMax = parseInt(track.dataset.sliderMax ?? 3000);
            const gpRange   = sliderMax - sliderMin;
            const pillGp    = Math.round(gpRange * 0.25);
            const pillWPct  = pillGp / gpRange * 100;
            const dxPct = (e.clientX - startX) / trackRect.width * 100;
            const newLeft = Math.max(0, Math.min(100 - pillWPct, startAnchorPct + dxPct));
            this._budgetMin = Math.round((newLeft / 100) * gpRange / 50) * 50 + sliderMin;
            this._budgetMax = Math.min(sliderMax, this._budgetMin + pillGp);
            this._updatePillPosition(html);
            this._debouncedBudgetReroll();
        };

        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            pill.classList.remove("dragging");
            this._hideRangeTooltip(html);
        };

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    }

    _updatePillPosition(html) {
        const track = html.find(".value-range-track")[0];
        if (!track) return;
        const sliderMin = parseInt(track.dataset.sliderMin ?? 0);
        const sliderMax = parseInt(track.dataset.sliderMax ?? 3000);
        const gpRange   = sliderMax - sliderMin;
        const pillGp    = Math.round(gpRange * 0.25);
        const pillWPct  = (pillGp / gpRange * 100).toFixed(1);
        // Prefer explicit drag state; fall back to the template-provided tier default (not raw sliderMin=0)
        const hiddenDefault = parseInt(html.find("[name='budgetMin']").val()) || sliderMin;
        const anchor    = this._budgetMin ?? hiddenDefault;
        const leftPct   = ((anchor - sliderMin) / gpRange * 100).toFixed(1);
        track.style.setProperty("--pill-left",      `${leftPct}%`);
        track.style.setProperty("--pill-width-pct", `${pillWPct}%`);
        // Sync hidden inputs so FormData always has current values
        html.find("[name='budgetMin']").val(anchor);
        html.find("[name='budgetMax']").val(Math.min(sliderMax, anchor + pillGp));
        // Keep tooltip fresh during drag
        const maxVal = Math.min(sliderMax, anchor + pillGp);
        this._updateRangeTooltip(html, anchor, maxVal,
            parseFloat(leftPct), parseFloat(leftPct) + parseFloat(pillWPct));
    }

    _showRangeTooltip(html) {
        const track = html.find(".value-range-track")[0];
        if (!track) return;
        const sliderMin = parseInt(track.dataset.sliderMin ?? 0);
        const sliderMax = parseInt(track.dataset.sliderMax ?? 3000);
        const hiddenDefault2 = parseInt(html.find("[name='budgetMin']").val()) || sliderMin;
        const anchor  = this._budgetMin ?? hiddenDefault2;
        const pillGp  = Math.round((sliderMax - sliderMin) * 0.25);
        const maxVal  = Math.min(sliderMax, anchor + pillGp);
        const gpRange = sliderMax - sliderMin;
        const lPct = (anchor - sliderMin) / gpRange * 100;
        const rPct = lPct + pillGp / gpRange * 100;
        this._updateRangeTooltip(html, anchor, maxVal, lPct, rPct);
        html.find(".range-tooltip").css("display", "block");
    }

    _hideRangeTooltip(html) {
        html.find(".range-tooltip").css("display", "none");
    }

    _updateRangeTooltip(html, minVal, maxVal, leftPct, rightPct) {
        const tooltip = html.find(".range-tooltip")[0];
        if (!tooltip || tooltip.style.display === "none") return;
        const fmt = (v) => v >= 1000 ? `${(v/1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : `${v}`;
        tooltip.textContent = `Gold Range: ${fmt(minVal)}gp – ${fmt(maxVal)}gp`;
        const midPct = (leftPct + rightPct) / 2;
        tooltip.style.left      = `${midPct}%`;
        tooltip.style.transform = "translateX(-50%)";
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

    /** Debounce budget slider reroll: waits 600ms after last drag movement. */
    _debouncedBudgetReroll() {
        if (!this._currentResult) return;
        clearTimeout(this._sliderDebounce);
        this._sliderDebounce = setTimeout(() => this._onGenerate(), 600);
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
        this.render();

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

            // ~20% chance to surface a ripe / eligible party shelf item automatically
            await this._tryAutoInjectShelfItem(tier);
        } catch (e) {
            Logger.error(MODULE_LABEL, "Generation failed:", e);
            ui.notifications.error("Cache generation failed.");
        } finally {
            this._generating = false;
            this.render();
        }
    }

    /**
     * On each generate, roll a ~20% chance to auto-inject one eligible party shelf
     * item into the cache as a Special Item. Only picks ledger items that are:
     *   - not yet delivered
     *   - not locked (held back by GM)
     *   - within the current tier's level cap
     * Does not mark the item as delivered; the GM confirms delivery separately.
     */
    async _tryAutoInjectShelfItem(tier = 1) {
        if (Math.random() >= 0.20) return;

        const levelCap = ProgressionAdvisor.TIER_LEVEL_CAP[tier] ?? 10;
        let shelf;
        try {
            shelf = await SignatureLedger.getPartyShelf();
        } catch {
            return;
        }

        const eligible = shelf.filter(s =>
            s.uuid &&
            !s.delivered &&
            !s.locked &&
            s.level &&
            s.level <= levelCap
        );
        if (!eligible.length) return;

        const pick = eligible[Math.floor(Math.random() * eligible.length)];

        // Resolve to item data without triggering a render mid-generate
        let itemData;
        try {
            const doc = await fromUuid(pick.uuid);
            if (doc) {
                const raw     = doc.toObject();
                const priceVal = raw.system?.price?.value ?? raw.system?.cost ?? raw.price ?? 0;
                const uuidParts = pick.uuid.split(".");
                itemData = {
                    ...raw,
                    name:             raw.name,
                    img:              raw.img,
                    type:             raw.type ?? "loot",
                    price:            priceVal,
                    rarity:           raw.system?.rarity ?? "",
                    isSignature:      false,
                    sourceCompendium: uuidParts.length >= 4 ? `${uuidParts[1]}.${uuidParts[2]}` : "",
                    _compendiumId:    uuidParts.at(-1) ?? ""
                };
            }
        } catch { /* fall through to stub */ }

        if (!itemData) {
            itemData = {
                name:  pick.name || "Party Item",
                type:  "loot",
                img:   pick.img  || "icons/svg/item-bag.svg",
                price: 0,
                rarity: pick.rarity ?? ""
            };
        }

        itemData._injected      = true;
        itemData._badgeLabel    = "Party Shelf";
        itemData._specialSection = true;
        itemData._specialType   = "partyShelf";

        this._currentResult.items.push(itemData);
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

    /**
     * Increment the drag-enter counter and activate the drop-zone highlight.
     * Using a counter (instead of just dragover/dragleave) prevents flickering
     * when the cursor crosses child-element boundaries inside the zone.
     */
    _onCacheResultsDragEnter(event) {
        if (!event.dataTransfer.types.includes("text/plain")) return;
        event.preventDefault();
        this._dragEnterCount = (this._dragEnterCount ?? 0) + 1;
        event.currentTarget.classList.add("drop-target-active");
    }

    _onCacheResultsDragOver(event) {
        // Only accept our own left-panel items
        if (!event.dataTransfer.types.includes("text/plain")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    }

    _onCacheResultsDragLeave(event) {
        this._dragEnterCount = Math.max(0, (this._dragEnterCount ?? 1) - 1);
        if (this._dragEnterCount === 0) {
            event.currentTarget.classList.remove("drop-target-active");
        }
    }

    async _onCacheResultsDrop(event) {
        event.preventDefault();
        this._dragEnterCount = 0;  // Reset counter on any drop
        event.currentTarget.classList.remove("drop-target-active");

        if (!this._currentResult) return;

        let payload;
        try {
            payload = JSON.parse(event.dataTransfer.getData("text/plain"));
        } catch { return; }

        // Accept internal left-panel drags
        if (payload?.type === "ionrift-left-panel-item" && payload.uuid) {
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
                this.render();
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
                const curseEngine = game.ionrift?.cursewright?.engine;
                if (curseEngine) {
                    await curseEngine.applyCacheCurses(this._currentResult, { forceCurse: false });
                }

                this.render();
            }
            return;
        }

        // Accept standard Foundry item drops (compendium / sidebar).
        // Check whether the dropped item matches a known shelf or cursed entry
        // so it routes to Special Items instead of generic loot.
        if (payload?.type === "Item" && payload.uuid) {
            const dropUuid = payload.uuid;
            const adv = this._buildAdvisoryContext();

            const shelfMatch   = (adv?.partyShelf ?? []).find(s => s.uuid === dropUuid);
            const cursedMatch  = (adv?.cursedPool ?? []).find(c => c.uuid === dropUuid);
            const scrollMatch  = (adv?.scrolls ?? []).find(s => s.uuid === dropUuid);

            if (scrollMatch) {
                await this._injectAdvisoryScroll({
                    uuid:        dropUuid,
                    spellName:   scrollMatch.spellName ?? "",
                    spellLevel:  scrollMatch.spellLevel ?? 0,
                    level:       scrollMatch.level,
                    img:         scrollMatch.img ?? ""
                });
                this.render();
            } else if (cursedMatch) {
                await this._injectItem(
                    { uuid: dropUuid },
                    { badge: "Cursed", markCursed: true }
                );
                await CacheGenerator._applyCurses(this._currentResult, { forceCurse: false });

                this.render();
            } else if (shelfMatch) {
                await this._injectItem(
                    { uuid: dropUuid, level: shelfMatch.level },
                    { badge: "Party Shelf", markDelivered: true }
                );
            } else {
                await this._injectItem(
                    { uuid: dropUuid },
                    { badge: "Added" }
                );
            }
            return;
        }
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

    /** Generic reroll handler — advance the index for the row key in reroll state. */
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
     * Ignores "ripe" gating — pulls a fresh random slice from the full pool.
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
            // Force a fresh ephemeral draw — re-shuffle by clearing current pool first
            this._partyShelfPool = [];
            await this._refreshPartyShelfPool(tier);
            // Rotate through the pool so repeated clicks surface different rows
            if (this._partyShelfPool.length > 1) {
                const shift = this._partyShelfPool.splice(0, 1);
                this._partyShelfPool.push(...shift);
            }
        } else if (pool === "cursedPool") {
            // Force fresh random draw from the full pool, bypassing ripe/recipe gate
            const reg = getCursedPoolRegistry();
            try {
                let raw = await reg.getPool(tier, ADVISORY_EPHEMERAL_FETCH * 2);
                if (!raw.length && typeof reg.getCursedPool === "function") {
                    const stored = await reg.getCursedPool();
                    const t = Math.max(1, Math.min(4, Number(tier) || 1));
                    raw = (stored ?? []).filter(r => (r.tier ?? 1) <= t);
                }
                // Shuffle and pick a new slice ignoring what was shown before
                const shuffled = [...raw].sort(() => Math.random() - 0.5);
                this._cursedPool = shuffled.slice(0, ADVISORY_EPHEMERAL_FETCH);
            } catch (err) {
                Logger.warn(MODULE_LABEL, "Cursed pool reroll failed:", err.message);
            }
        } else if (pool === "scroll") {
            // Shuffle the advisory scrolls array in-place to surface a different subset.
            // Do NOT call _refreshAdvisoryForCurrentCache() — that would re-fetch all pools
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

        this._currentResult.items.push(itemData);
        await this._refreshAdvisoryForCurrentCache();
    }

    /** Shared inject helper — resolves UUID to item data and pushes to result. */
    async _injectItem(entry, { badge = "Advisory", markDelivered = false, treatAsSignature = false, markCursed = false } = {}) {
        if (!this._currentResult) return;

        let itemData;
        let resolvedDoc = null;

        if (entry.uuid) {
            try {
                const doc = await fromUuid(entry.uuid);
                if (doc) {
                    resolvedDoc = doc;
                    const raw = doc.toObject();

                    // Extract price the same way CacheGenerator does
                    const priceVal = raw.system?.price?.value
                        ?? raw.system?.cost
                        ?? raw.price
                        ?? 0;

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
        // CurseForge items have system.identified=false by design — dnd5e overrides
        // .name to "Unidentified [type]" in that state. This is normal, not an error.
        // Resolve the GM-facing display name from flags and flip identified:true on
        // the preview data so the cache UI shows the real lure/item name.
        if (markCursed) {
            const qmFlags = resolvedDoc?.flags?.["ionrift-quartermaster"] ?? {};

            if (itemData.system?.identified === false) {
                const displayName = qmFlags.latentMagic?.originalName
                    ?? qmFlags.cursedMeta?.lureName
                    ?? qmFlags.cursedMeta?.lure?.name
                    ?? null;
                if (displayName) {
                    itemData.name = displayName;
                    itemData.system = { ...itemData.system, identified: true };
                    Logger.info(MODULE_LABEL,
                        `[CacheGen] Cursed item "${displayName}" — resolved display name from flags (identified:false is expected).`
                    );
                }
                // If no display name found in flags, the stored entry.name from
                // the pool is used as-is (already resolved by _refreshCursedPool).
            }

            itemData.cursed = true;
            const cm = qmFlags.cursedMeta ?? {};
            const hint = (cm.trueNature || cm.decoyAppearance || "").trim();
            itemData.cursedAs = hint || itemData.name;
            const infectedRate = qmFlags.infectedRate ?? 0;
            if (infectedRate > 0) itemData.isInfectedStack = true;
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
            const didCurse = await CacheGenerator._applyCurses(this._currentResult, { forceCurse: true });
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

        // Helper: pick one replacement
        const pickOne = async () => {
            switch (slotType) {
                case "signature":  return CacheGenerator._generateSignatureStub(this._currentResult.meta.tier, theme);
                case "scroll":     return CacheGenerator._pickScroll(tierData);
                case "consumable": return CacheGenerator._pickConsumable(theme, tierData, tables);
                case "mundane":    return CacheGenerator._pickMundane(theme, tierData, tables);
                case "mastercraft":return CacheGenerator._pickMastercraft(theme, tierData);
                case "gemstone":   return CacheGenerator._pickGemstone(tierData);
                case "treasure":   return CacheGenerator._pickTreasure(tierData);
                case "trinket":    return CacheGenerator._pickTrinket(tierData);
                default:           return null;
            }
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
        } else if (Number.isFinite(index) && index >= 0 && index < items.length) {
            items[index].quantity = target;
        } else if (groupIdx.length === 1) {
            items[groupIdx[0]].quantity = target;
        }

        el.value = String(target);
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

        const container = await CacheGenerator._pickContainer(ownerTheme, theme, contentWeightLbs);
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
        console.log("[QM|CanvasDrop] handler fired"); // [DEBUG-STACK] remove before release

        let data;
        try {
            data = JSON.parse(event.dataTransfer.getData("text/plain"));
        } catch {
            return;
        }
        if (data?.type !== "ionrift-cache" || !data.result) return;

        const result = data.result;

        // Convert browser client coords to canvas world coordinates
        const t = canvas.stage.worldTransform;
        const x = (event.clientX - t.tx) / canvas.stage.scale.x;
        const y = (event.clientY - t.ty) / canvas.stage.scale.y;

        try {
            const pileItems = [];
            const mintBatch = result.meta?.mintBatch;

            // Helper to resolve generic cache items into full Foundry Item payloads with flags
            const resolveItemData = async (metaObj) => {
                let data = null;
                if (metaObj.sourceCompendium && metaObj._compendiumId) {
                    const pack = game.packs.get(metaObj.sourceCompendium);
                    if (pack) {
                        const doc = await pack.getDocument(metaObj._compendiumId);
                        if (doc) {
                            data = doc.toObject();
                            // CurseForge items have system.identified=false by design.
                            // dnd5e preserves that raw false in toObject(), which causes
                            // IP's _transferItems to crash reading .type from unexpected
                            // object shapes. Force identified:true — the lure identity is
                            // carried by latentMagic flags, not by the identified field.
                            const qmF = data.flags?.["ionrift-quartermaster"] ?? {};
                            if (data.system && data.system.identified === false
                                    && (qmF.cursedMeta || qmF.forgedFrom)) {
                                data.system.identified = true;
                            }
                        }
                    }
                }
                if (!data) {
                    // Safe generic fallback (compendium resolution is preferred; see _pickContainer)
                    const w = Number(metaObj.weight);
                    data = {
                        name: metaObj.name,
                        type: "loot",
                        img: metaObj.img,
                        system: {
                            price: { value: metaObj.price ?? 0, denomination: "gp" },
                            weight: { value: Number.isFinite(w) ? w : 0, units: "lb" }
                        }
                    };
                    if (metaObj.capacityLbs !== undefined) {
                        data.type = "backpack";
                        data.system.capacity = { type: "weight", value: metaObj.capacityLbs };
                    }
                }

                // Vital: Stamp the mintBatch flag on all generated items so curses can be tracked
                if (mintBatch) {
                    foundry.utils.setProperty(data, "flags.ionrift-quartermaster.mintBatch", mintBatch);
                }

                // For infected entries: strip Cursewright meta BEFORE the masking check.
                // This is critical for standalone cursed items (Cursewright item as resolution
                // source) which have latentMagic set — if we check hasLatentMagic before
                // stripping, masking is skipped and the lure name is revealed immediately.
                // Stamp infectedRate at the same time.
                const isInfected = !!(metaObj._infectedCount && metaObj._totalQty);
                if (isInfected) {
                    const infectedRate = metaObj._infectedCount / metaObj._totalQty;
                    foundry.utils.setProperty(data, "flags.ionrift-quartermaster.infectedRate", infectedRate);
                    if (data.flags?.["ionrift-quartermaster"]) {
                        delete data.flags["ionrift-quartermaster"].latentMagic;
                        delete data.flags["ionrift-quartermaster"].cursedMeta;
                        delete data.flags["ionrift-quartermaster"].forgedFrom;
                    }
                    // Do NOT set system.identified = true here.
                    // QM design: mask by renaming, not by identified=false.
                }

                // Apply identification masking for magical items.
                // Infected entries are always treated as magical.
                const hasLatentMagic = !!(data.flags?.["ionrift-quartermaster"]?.latentMagic);
                if ((metaObj._isMagical || isInfected) && !hasLatentMagic) {
                    const obscuredFallback = ItemMaskingHelper.detectMagical({
                        name: data.name,
                        rarity: data.system?.rarity ?? metaObj.rarity ?? "",
                        type: data.type ?? metaObj.type ?? "loot",
                        _baseItem: data.system?.type?.baseItem
                    }).obscuredImg;
                    ItemMaskingHelper.applyMask(data, {
                        baseItemName: metaObj._baseItemName,
                        mundaneDesc: metaObj._mundaneDesc,
                        obscuredImg: metaObj._obscuredImg ?? obscuredFallback,
                        sourceImg: metaObj._maskSourceImg
                    });
                }

                // Stamp canStack "yes" on masked items (IP maps string keys; boolean is ignored).
                // IP checks flags["item-piles"].item.canStack before merging stacks.
                // Without an explicit stackable stamp, IP runs a normalisation pass that touches
                // system.identified, triggering _guardIdentify and causing the
                // alternating Corked Bottle / Potion of Healing reveal bug.
                if (data.flags?.["ionrift-quartermaster"]?.latentMagic) {
                    data.flags["item-piles"] = data.flags["item-piles"] ?? {};
                    data.flags["item-piles"].item = data.flags["item-piles"].item ?? {};
                    data.flags["item-piles"].item.canStack = "yes";
                }

                // Strip compendium source references from masked items.
                // IP uses flags.core.sourceId to re-resolve from compendium.
                // Without it, IP transfers our masked data as-is.
                if (data.flags?.["ionrift-quartermaster"]?.latentMagic) {
                    if (data.flags?.core?.sourceId) delete data.flags.core.sourceId;
                    if (data._stats?.compendiumSource) delete data._stats.compendiumSource;
                }

                return data;
            };

            // Item Piles _createItemPile flattens { item, quantity } to item data only and drops the
            // wrapper quantity — stack size must live on the item payload (dnd5e: system.quantity).
            const stampPileQuantity = (itemData, qty) => {
                const q = Math.max(1, Math.floor(Number(qty)) || 1);
                foundry.utils.setProperty(itemData, "system.quantity", q);
                // Assign a unique _id so Item Piles doesn't collapse distinct entries into one row.
                itemData._id = foundry.utils.randomID();
                return itemData;
            };

            // Container appearance is applied via tokenOverrides (name, texture, lockRotation).
            // We do NOT add the container as a pile item — only the actual loot contents appear.

            // 2. Two-pass squash
            //
            // Diagnostic finding: dnd5e 2024 PHB resolves "Potion of Healing" → "Corked Bottle".
            // The Cursewright item resolves as "Potion of Healing" (lure surface name).
            // Without squashing, the pile has two rows with different names that can't merge.
            //
            // Fix: group by generator display name BEFORE resolution. When a cursed item
            // matches a clean item by name, override the clean item's compendium ref with the
            // cursed item's ref so resolution uses the lure surface ("Potion of Healing").
            // The clean items contribute only their quantity to the merged total.

            // Pass A: collect non-cursed items, grouped by compendium key or display name
            const squashedMap = new Map();
            for (const item of result.items ?? []) {
                if (item._specialSection && item._specialType === "cursed") continue;
                const key = (item.sourceCompendium && item._compendiumId)
                    ? `${item.sourceCompendium}::${item._compendiumId}`
                    : item.name;
                if (squashedMap.has(key)) {
                    squashedMap.get(key)._totalQty += (item.quantity ?? 1);
                } else {
                    squashedMap.set(key, { ...item, _totalQty: item.quantity ?? 1 });
                }
            }

            // Pass B: merge cursed items INTO the matching clean entry.
            // The pile must show ONE row for all potions of the same type — two
            // identical "Small Phial" entries is a dead giveaway for players.
            //
            // Architecture:
            //   clean (x2) + infected (x1) → one entry, _totalQty=3, _infectedCount=1
            //   → infectedRate = 1/3 ≈ 0.33
            //
            // Each use in preUseActivity rolls Math.random() < infectedRate independently.
            // The rate is probabilistic, not a counter — so even if Item Piles merges
            // this with existing clean potions on the player's inventory, every use
            // still has the correct chance of being poisoned.
            //
            // We retain the CLEAN item's compendium ref so the pile contains a usable
            // SRD Potion of Healing (with a heal activity), not the Cursewright item.
            //
            // Only Apothecary-style healing decoys may carry `_infectedCount`. Other cursed
            // specials (weapons, dust, etc.) must merge by quantity without stamping infectedRate,
            // or the GM droplet badge appears on every cursed item after pile creation.
            for (const item of result.items ?? []) {
                if (!item._specialSection || item._specialType !== "cursed") continue;
                const qty = item.quantity ?? 1;
                const poisonMerge = _isPoisonStackMergeSource(item);
                const matchEntry = [...squashedMap.values()].find(e => e.name === item.name);
                if (matchEntry) {
                    if (poisonMerge) {
                        matchEntry._infectedCount = (matchEntry._infectedCount ?? 0) + qty;
                    }
                    matchEntry._totalQty = (matchEntry._totalQty ?? 0) + qty;
                } else if (poisonMerge) {
                    // No clean counterpart — standalone fully-infected healing stack.
                    squashedMap.set(`cursed::${item._uid ?? item.name}`, {
                        ...item,
                        _totalQty:      qty,
                        _infectedCount: qty
                    });
                } else {
                    squashedMap.set(`cursed::${item._uid ?? item.name}`, {
                        ...item,
                        _totalQty: qty
                    });
                }
            }


            // 3. Resolve squashed entries into final pile items
            for (const entry of squashedMap.values()) {
                pileItems.push(stampPileQuantity(await resolveItemData(entry), entry._totalQty ?? 1));
            }

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
                    // Currency sharing disabled — players can take as much as they want
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

            ui.notifications.info(`Placed "${result.container?.name ?? "Loot Cache"}" on the canvas.`);
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
