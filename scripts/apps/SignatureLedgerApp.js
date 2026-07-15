import { SignatureLedger } from "../services/SignatureLedger.js";
import { ProgressionSeeder }  from "../services/ProgressionSeeder.js";
import { Logger, MODULE_LABEL } from "../utils/Logger.js";
import { getCurseAdapter } from "../services/getCurseAdapter.js";
import { StandalonePoolRegistry, getActiveCursedRegistry } from "../services/StandalonePoolRegistry.js";
import { CursedSourcesApp, CURSED_POOL_DATA_HOOK } from "./CursedSourcesApp.js";
import { CursedItemResolver } from "../services/CursedItemResolver.js";
import { LootGenerationConfigApp } from "./LootGenerationConfigApp.js";

const MODULE_ID = "ionrift-quartermaster";

/** Always read fresh so profile changes take effect without reload. */
function MILESTONES() { return SignatureLedger.MILESTONES; }

/** Canonical curse type descriptions for UI tooltips and filter labels. */
const CURSE_TYPE_DESCRIPTIONS = {
    compulsion:    "Forces or restricts social behaviour",
    psychological: "Affects mental state or perception",
    physical:      "Bodily transformation, aging, weakness",
    interference:  "Disrupts item use, spellcasting, or economy",
    narrative:     "Creates story complications (surveillance, reputation)",
    deceptive:     "Item is not what it appears",
    haunting:      "Spectral presence, whispers, or ghostly manifestations",
    behavioral:    "Forces or restricts social behaviour",
    surveillance:  "Creates story complications (surveillance, reputation)",
    social:        "Affects social standing or relationships",
    political:     "Creates political entanglements or obligations",
    practical:     "Disrupts item use, spellcasting, or economy",
    aging:         "Bodily transformation, aging, weakness"
};

/** @returns {string|undefined} Pack ID for the cursed items compendium (CW or fallback). */
function getCursedItemsPackId() {
    return game.ionrift?.cursewright?.CURSED_ITEMS_PACK_ID
        ?? "ionrift-cursewright.cursewright-items";
}

/** Active pool registry: CurseRegistry when Cursewright is installed, else QM settings. */

/** @param {number} tier @returns {{ curseTier: number }} */
function cursePoolTierViewFields(tier) {
    return { curseTier: Math.max(1, Math.min(4, Number(tier) || 1)) };
}


/**
 * Width (0-100) of the “level reached” band across the milestone strip: full columns
 * for completed milestones, plus a fractional segment into the next column (by level).
 */
function computeLevelRangeBarPct(level, milestones) {
    const n = milestones.length;
    if (n < 1) return 0;
    const colW = 100 / n;
    const lv   = Math.max(0, Number(level) || 0);

    if (lv >= milestones[n - 1]) return 100;
    if (lv < milestones[0]) {
        const denom = Math.max(1, milestones[0]);
        return Math.min(colW, (lv / denom) * colW);
    }
    for (let i = 0; i < n - 1; i++) {
        if (lv >= milestones[i] && lv < milestones[i + 1]) {
            const span = milestones[i + 1] - milestones[i];
            const t    = span > 0 ? (lv - milestones[i]) / span : 0;
            return Math.min(100, ((i + 1) + t) * colW);
        }
    }
    return 100;
}

/**
 * 0-1 vibrancy vs level band tip on the strip (same space as levelRangeBarPct).
 * Full color once the tip is at least 25% into this column, or past it.
 * About one column before the tip reaches the slot: ~0.5. Farther: falls to 0 (grayscale in CSS).
 */
function computeReachBlendFromBar(barPct, columnIndex, milestoneCount) {
    const n = Math.max(1, Number(milestoneCount) || 1);
    const edge = Math.max(0, Math.min(100, Number(barPct) || 0));
    const colW = 100 / n;
    const left = columnIndex * colW;
    const right = (columnIndex + 1) * colW;
    if (colW <= 0) return 1;

    const penetration = (edge - left) / colW;
    const penetrationFull = 0.25;

    if (edge >= right || penetration >= penetrationFull) return 1;

    if (penetration >= 0) {
        return 0.5 + 0.5 * (penetration / penetrationFull);
    }

    const slotsBefore = (left - edge) / colW;
    if (slotsBefore <= 1) return 0.5;

    const falloffSlots = 2;
    return Math.max(0, 0.5 * (1 - (slotsBefore - 1) / falloffSlots));
}

/** 0-1: band penetration into this column (0 until tip enters, ~1 across the slot). */
function computeReachGlowPenetration(barPct, columnIndex, milestoneCount) {
    const n = Math.max(1, Number(milestoneCount) || 1);
    const edge = Math.max(0, Math.min(100, Number(barPct) || 0));
    const colW = 100 / n;
    const left = columnIndex * colW;
    if (colW <= 0) return 0;
    const penetration = (edge - left) / colW;
    if (penetration < 0) return 0;
    return Math.max(0, Math.min(1, penetration));
}

/**
 * Level band across the milestone strip plus current/next milestone flags.
 * refLevel is per-actor level (signatures) or party aggregate (planned curses).
 */
function computeMilestoneStripContext(refLevel) {
    const lv = Math.max(0, Number(refLevel) || 0);
    const ms = MILESTONES();
    const levelRangeBarPct = Math.round(computeLevelRangeBarPct(lv, ms) * 100) / 100;
    const currentMs = ms.reduce((best, m) => (m <= lv ? m : best), ms[0]);
    const nextMs = ms.find(m => m > lv) ?? null;
    const nMs = ms.length;
    return { refLevel: lv, levelRangeBarPct, currentMs, nextMs, nMs };
}

/**
 * Header label fade per milestone column from reach-band tip proximity.
 * Shared by scroll pinned, party shelf, and cursed planned strips.
 */
function buildMilestoneLabelFades(levelRangeBarPct, milestones = MILESTONES()) {
    const nMs = milestones.length;
    const colW = 100 / Math.max(1, nMs);
    return milestones.map((ms, colIdx) => {
        const center = (colIdx + 0.5) * colW;
        const dist   = Math.abs(levelRangeBarPct - center);
        const radius = colW * 0.78;
        const t      = Math.min(1, dist / radius);
        const labelFade = Math.round((0.1 + 0.9 * t) * 1000) / 1000;
        return { level: ms, labelFade };
    });
}

/**
 * Per-column reach visuals shared by signature slots and planned curse slots.
 */
function computeSlotReachForMilestone({
    levelRangeBarPct,
    colIdx,
    nMs,
    ms,
    refLevel,
    filled,
    delivered,
    overdue,
    ripeEmptyGlow = false,
    isNext = false
}) {
    const reachBlend =
        Math.round(computeReachBlendFromBar(levelRangeBarPct, colIdx, nMs) * 1000) / 1000;
    const pen =
        Math.round(computeReachGlowPenetration(levelRangeBarPct, colIdx, nMs) * 1000) / 1000;
    const NEXT_FLOOR = 0.65;
    let reachGlow = 0;
    if (filled && !delivered && !overdue) {
        if (ms <= refLevel) reachGlow = 1;
        else reachGlow = isNext ? Math.max(NEXT_FLOOR, pen) : pen;
    } else if (ripeEmptyGlow && !filled && !delivered && !overdue) {
        if (ms <= refLevel) {
            const colW = 100 / Math.max(1, nMs);
            const right = (colIdx + 1) * colW;
            const overshoot = Math.max(0, (levelRangeBarPct - right) / colW);
            reachGlow = Math.max(0, 0.2 * (1 - overshoot));
        } else {
            reachGlow = isNext ? Math.max(NEXT_FLOOR, pen) : pen;
        }
    }
    const emptyRipeness = 0.07;
    const reachGlowActive = filled
        ? reachGlow > 0.001
        : Boolean(ripeEmptyGlow && reachGlow >= emptyRipeness);
    return { reachBlend, reachGlow, reachGlowActive };
}

function milestoneColumnFlags(ms, refLevel, currentMs, nextMs) {
    return {
        isPast:    ms <= refLevel,
        isFuture:  ms > refLevel,
        isCurrent: ms === currentMs,
        isNext:    ms === nextMs
    };
}

// Handlebars helper: equality check for tab conditionals
Handlebars.registerHelper("eq", (a, b) => a === b);

export class SignatureLedgerApp extends Application {

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id:       "ionrift-signature-ledger",
            title:    "Quartermaster",
            template: "modules/ionrift-quartermaster/templates/signature-ledger.hbs",
            width:    1000,
            height:   740,
            classes:  ["ionrift-window", "glass-ui"],
            resizable: true,
            scrollY:  [".ledger-scroll-area", ".party-panel-scroll", ".banlist-scroll-area"],
            dragDrop: [{
                dropSelector:
                    ".grid-slot, .sig-slots-strip, .party-slots-strip, .ban-drop-zone"
            }]
        });
    }

    constructor(options = {}) {
        super(options);
        this._activeTab       = "signatures";
        this._tooltipCache    = new Map();  // uuid → item doc
        this._tooltipTimer     = null;
        this._tooltipEl        = null;
        this._tooltipAnchorEl  = null;
        this._sigDragActorId  = null;  // actorId of the slot currently being dragged
        this._sigDragInFlight = false; // true briefly after a drag ends, suppresses next click
        /** @type {null | "planned" | "pool"} */
        this._cursedDragType   = null;
        this._cursedDragInFlight = false;
        /** @type {null | "pinned" | "pool"} */
        this._scrollDragType   = null;
        this._scrollDragInFlight = false;
        this._partyDragType    = null;
        this._partyDragInFlight = false;
        this._scrollTrackerExpanded = false;
        this._partyTrackerExpanded  = false;
        this._cursedPoolHookRegistered = false;
        this._onCursedPoolDataExternalUpdate = () => {
            if (!this.rendered) return;
            this.render(false);
        };
    }

    async close(options = {}) {
        if (this._cursedPoolHookRegistered) {
            Hooks.off(CURSED_POOL_DATA_HOOK, this._onCursedPoolDataExternalUpdate);
            this._cursedPoolHookRegistered = false;
        }
        return super.close(options);
    }

    /**
     * Drop hover cards when the template re-renders. Removing a slot does not fire
     * mouseleave on the destroyed node, so the body-mounted tooltip must be cleared here.
     */
    render(force = false, options = {}) {
        this._tooltipAnchorEl = null;
        this._hideItemTooltip();
        return super.render(force, options);
    }

    async _render(force, options) {
        const partialPath = "modules/ionrift-quartermaster/templates/partials/slot-cell.hbs";
        if (!Handlebars.partials[partialPath]) {
            try { await loadTemplates([partialPath]); }
            catch (e) { Logger.error(MODULE_LABEL, "slot-cell partial load failed:", e); }
        }
        return super._render(force, options);
    }

    // ── getData ───────────────────────────────────────────────────────────────

    async getData() {
        const partyActors = SignatureLedger._resolvePartyMembers();

        const [sigData, scrollPinnedRaw, partyShelf, banList] = await Promise.all([
            SignatureLedger.syncWithParty(partyActors),
            SignatureLedger.getScrollPinned(),
            SignatureLedger.getPartyShelf(),
            SignatureLedger.getBanList()
        ]);

        // Cursed Pool tab is always shown - works standalone (SRD stubs via
        // SrdCurseAdapter) or with Cursewright for the full premium experience.
        const curseSystemEnabled = true;
        const cwPresent = !!game.ionrift?.cursewright;

        let curseData = {};
        {
            const reg = getActiveCursedRegistry();
            if (game.user.isGM) await reg.ensureDefaultCursedPoolIfEmpty?.();

            // ── One-time migration: promote any cursedPlanned entries into the pool ──
            // Planned entries become high-priority pool items (prepended at top of their tier).
            if (typeof reg.getCursedPlanned === "function") {
                try {
                    const planned = await reg.getCursedPlanned();
                    if (planned.length > 0 && typeof reg.getCursedPool === "function" && typeof reg.setCursedPool === "function" && typeof reg.setCursedPlanned === "function") {
                        const pool = await reg.getCursedPool();
                        const poolUuids = new Set(pool.map(e => (e.uuid || "").toLowerCase()));
                        const toAdd = planned
                            .filter(p => p.uuid && !poolUuids.has(p.uuid.toLowerCase()))
                            .map(p => ({
                                uuid:            p.uuid,
                                name:            p.name || "",
                                img:             p.img || "icons/svg/item-bag.svg",
                                curseType:       p.curseType ?? "unknown",
                                decoyAppearance: p.decoyAppearance ?? "",
                                trueNature:      p.trueNature ?? "",
                                tier:            p.tier ?? 1
                            }));
                        if (toAdd.length > 0) {
                            // Prepend to pool so they surface at high priority
                            await reg.setCursedPool([...toAdd, ...pool]);
                            await reg.setCursedPlanned([]);
                            Logger.info(MODULE_LABEL, `Cursed planner migration: promoted ${toAdd.length} item(s) into the pool.`);
                        } else {
                            // Planned all already in pool — clear the stale planned list
                            await reg.setCursedPlanned([]);
                        }
                    }
                } catch (e) {
                    Logger.warn(MODULE_LABEL, "Cursed planned migration failed (non-fatal):", e.message);
                }
            }

            const cursedPoolRaw = await reg.getCursedPool();

            // Resolve display names live (pool entries go stale after pack recompile)
            const cursedPoolResolved = await CursedItemResolver.resolvePoolDisplayNames(cursedPoolRaw);

            // Per-source counts for footer
            const cwPoolCount  = cursedPoolResolved.filter(p => (p.uuid || "").includes("ionrift-cursewright-forged")).length;
            const srdPoolCount = cursedPoolResolved.filter(p => (p.uuid || "").includes("ionrift-srd-cursed")).length;

            // Pack existence flags
            const hasSrdPack    = !!game.packs.get("world.ionrift-srd-cursed");
            const hasCurseForge = !!game.packs.get("world.ionrift-cursewright-forged")
                                || !!game.packs.get("world.ionrift-forged-cursed");

            // T3/T4 enabled flags
            const t3Enabled = reg.getTierEnabled?.(3) ?? (game.settings.get(MODULE_ID, "cursedT3Enabled") ?? true);
            const t4Enabled = reg.getTierEnabled?.(4) ?? (game.settings.get(MODULE_ID, "cursedT4Enabled") ?? true);

            // Build priority columns: T1-T4, max 5 per column, preserve array order
            const PRIORITY_COL_CAP = 5;
            const priorityColumns = SignatureLedgerApp._buildCursedPriorityColumns(
                cursedPoolResolved, t3Enabled, t4Enabled, PRIORITY_COL_CAP
            );

            // Tier distribution chart
            const partyLevel = SignatureLedgerApp._partyMedianLevel(partyActors);
            const cursedTierDistribution = SignatureLedgerApp._buildCursedTierDistribution(
                partyLevel, t3Enabled, t4Enabled
            );

            curseData = {
                cwPresent,
                hasSrdPack,
                hasCurseForge,
                cwPoolCount,
                srdPoolCount,
                t3Enabled,
                t4Enabled,
                partyLevel,
                priorityColumns,
                cursedTierDistribution,
                cursedPoolCount: cursedPoolResolved.length,
                priorityColCap: PRIORITY_COL_CAP
            };
        }


        const scrollPinned = SignatureLedger.sanitizeScrollPinned(scrollPinnedRaw);

        // Auto-detect delivered signature items by scanning party inventories
        await this._syncSignatureDelivery(sigData, partyActors);

        // Auto-detect delivered items by scanning party inventories
        const syncedShelf = await this._syncDeliveryStatus(partyShelf, partyActors);

        const shelfConcentration   = game.settings?.get("ionrift-quartermaster", "shelfConcentration") ?? 3;
        const shelfAttunementBias  = game.settings?.get("ionrift-quartermaster", "shelfAttunementBias") ?? 1;
        const shelfCategoryWeights = game.settings?.get("ionrift-quartermaster", "shelfCategoryWeights")
            ?? '{"wondrous":{"w":70,"on":true},"focus":{"w":15,"on":true},"armor":{"w":10,"on":true},"weapon":{"w":5,"on":true}}';
        const scrollFloor      = game.settings?.get("ionrift-quartermaster", "scrollFloor") ?? 1;
        const scrollUpperReach = game.settings?.get("ionrift-quartermaster", "scrollUpperReach") ?? 2;
        const scrollConcentration = game.settings?.get("ionrift-quartermaster", "scrollConcentration") ?? 2;
        const scrollOffset     = game.settings?.get("ionrift-quartermaster", "scrollOffset") ?? -1;

        const hasParty = partyActors.length > 0;

        // --- Policy Dashboard Data (Bell-Curve Distribution) ---
        const partyMedian = SignatureLedgerApp._partyMedianLevel(partyActors);
        const optimalLevel = Math.max(1, Math.min(9, Math.ceil(partyMedian / 2) + scrollOffset));
        const distribution = SignatureLedgerApp._computeScrollDistribution(
            optimalLevel, scrollFloor, scrollUpperReach, scrollConcentration
        );

        const scrollPolicyData = {
            partyLevel: partyMedian,
            optimalLevel,
            scrollFloor,
            scrollUpperReach,
            scrollConcentration,
            scrollOffset,
            offsetLabel: scrollOffset > 0 ? `+${scrollOffset}` : `${scrollOffset}`,
            distribution
        };

        // --- Party Shelf Policy Dashboard Data ---
        const shelfPolicyData = {
            partyLevel: partyMedian,
            distribution: SignatureLedgerApp._computeShelfRarityDistribution(shelfConcentration),
            categoryMix:  SignatureLedgerApp._computeCategoryMix(shelfCategoryWeights),
            attunementBias: shelfAttunementBias,
            attunementLabel: ["LOW", "MED", "HIGH"][shelfAttunementBias] ?? "MED"
        };

        return {
            activeTab:       this._activeTab,
            milestones:      MILESTONES(),
            hasParty,
            curseSystemEnabled,
            shelfConcentration,
            shelfAttunementBias,
            shelfCategoryWeights,
            scrollFloor,
            scrollUpperReach,
            scrollConcentration,
            scrollOffset,
            scrollTrackerExpanded: this._scrollTrackerExpanded,
            partyTrackerExpanded:  this._partyTrackerExpanded,
            scrollPolicyData,
            shelfPolicyData,
            banCount:        banList.length,
            banList,

            // Signatures tab
            ...this._buildSignatureData(partyActors, sigData),

            // Scroll tab: pinned strip
            scrollPinnedRow: this._buildScrollPinnedStrip(partyActors, scrollPinned),

            // Party shelf tab
            partyShelfRow: this._buildPartyShelfStrip(partyActors, syncedShelf),

            // Cursed tab (empty when feature flag is off)
            ...curseData
        };
    }


    // ── Shared: Milestone slot view-model builder ─────────────────────────────

    _buildSlotViewModels(refLevel, getPinAt, { slotsPerMilestone = 1, ripeEmptyGlow = false } = {}) {
        const stripContext = computeMilestoneStripContext(refLevel);
        const { levelRangeBarPct, currentMs, nextMs, nMs } = stripContext;

        const columns = MILESTONES().map((ms, colIdx) => {
            const slots = Array.from({ length: slotsPerMilestone }, (_, slotIdx) => {
                const pin = getPinAt(ms, slotIdx);
                const filled    = !!pin;
                const delivered = pin?.delivered ?? pin?.used ?? false;
                const overdue   = (ms <= refLevel) && filled && !delivered;
                const colFlags  = milestoneColumnFlags(ms, refLevel, currentMs, nextMs);
                const { reachBlend, reachGlow, reachGlowActive } = computeSlotReachForMilestone({
                    levelRangeBarPct, colIdx, nMs, ms,
                    refLevel, filled, delivered, overdue,
                    ripeEmptyGlow, isNext: colFlags.isNext
                });
                return {
                    level: ms, slotIdx, filled,
                    name:  pin?.name || "", img: pin?.img || "", uuid: pin?.uuid || "",
                    ...colFlags, delivered, isOverdue: overdue,
                    reachBlend, reachGlow, reachGlowActive
                };
            });
            return { level: ms, slots };
        });

        return { columns, stripContext };
    }

    // ── Signature Panel ───────────────────────────────────────────────────────

    _buildSignatureData(partyActors, sigData) {
        const actors   = [];
        let   totalRvp = 0;
        const partyIds = new Set(partyActors.map(a => a.id));

        for (const [id, data] of Object.entries(sigData)) {
            if (!partyIds.has(id)) continue;
            const actor = game.actors.get(id);
            if (!actor) continue;

            const level      = (game.ionrift?.library?.system?.getLevel(actor)) || 1;
            const classes    = (game.ionrift?.library?.system?.getClassNames(actor) ?? Object.values(actor.classes || {}).map(c => c.name)).join("/") || "Unknown";
            const powerScore = SignatureLedger.computePowerScore(actor);
            totalRvp        += data.rvp;

            const plannedItems = data.plannedItems || [];
            const BUDGET = 4;
            const budgetUsed = plannedItems.length;
            const budgetFull = budgetUsed >= BUDGET;

            const getPinAt = (ms) => {
                const p = plannedItems.find(i => i.level === ms);
                return p ? { ...p, delivered: p.delivered || false } : null;
            };
            const { columns: sigCols, stripContext } = this._buildSlotViewModels(level, getPinAt);
            const { levelRangeBarPct } = stripContext;
            const slots = sigCols.map(col => {
                const base = col.slots[0];
                const planned = plannedItems.find(p => p.level === base.level);
                return {
                    ...base,
                    actorId: id,
                    disabled: !planned && budgetFull && !base.filled,
                    rarity:  planned?.rarity || "",
                    source:  planned?.source || "",
                    locked:  planned?.locked || false
                };
            });
            const budgetPips = Array.from({ length: BUDGET }, (_, i) => ({ filled: i < budgetUsed }));
            const hasAnyItems = plannedItems.length > 0;
            const hasEmptySlots = budgetUsed < BUDGET;
            actors.push({
                id,
                name:       data.name,
                img:        actor.img,
                level,
                classes,
                rvp:        data.rvp,
                powerScore,
                slots,
                hasAnyItems,
                hasEmptySlots,
                budgetUsed,
                budgetTotal: BUDGET,
                budgetFull,
                budgetPips,
                levelRangeBarPct
            });
        }

        const avgRvp    = actors.length ? Math.round(totalRvp / actors.length) : 0;
        const maxPower  = Math.max(...actors.map(a => a.powerScore), 1);
        const totalPwr  = actors.reduce((s, a) => s + a.powerScore, 0);
        const avgPower  = actors.length ? Math.round((totalPwr / actors.length) * 10) / 10 : 0;

        for (const a of actors) {
            const dev = maxPower > 1 ? ((a.powerScore - avgPower) / maxPower) * 100 : 0;
            a.powerDeviation = Math.round(dev);
            // Centered bar: each half of the track represents 50% deviation.
            // A ±50% deviation fills its half completely; larger values clamp.
            a.powerBarHalfPct = Math.min(50, Math.abs(a.powerDeviation));
            a.powerSign = a.powerDeviation > 0 ? "pos" : a.powerDeviation < 0 ? "neg" : "zero";
            if      (dev >  40) { a.powerTier = "power-hot";  a.powerLabel = `+${a.powerDeviation}%`; }
            else if (dev >  15) { a.powerTier = "power-warm"; a.powerLabel = `+${a.powerDeviation}%`; }
            else if (dev < -30) { a.powerTier = "power-cold"; a.powerLabel = `${a.powerDeviation}%`; }
            else if (dev < -10) { a.powerTier = "power-cool"; a.powerLabel = `${a.powerDeviation}%`; }
            else                { a.powerTier = "power-even"; a.powerLabel = "0"; }
            a.isBehind = a.powerDeviation < -30;
            a.showStat = true;
        }

        actors.sort((a, b) => a.name.localeCompare(b.name));
        return { actors, avgRvp, avgPower };
    }

    // ── Scroll Pinned Strip (mirrors cursed planned strip) ─────────────────────

    /**
     * One row: left "Party" cell + 6 milestone stacks of 3 grid-slots each,
     * with a level-reach band (party median level).
     */
    _buildScrollPinnedStrip(partyActors, scrollPinned) {
        const CAP = 3;
        const partyLevel = SignatureLedgerApp._partyMedianLevel(partyActors);

        const pinIndex = new Map();
        for (const ms of MILESTONES()) {
            const atLevelRaw = scrollPinned
                .filter(p => p.level === ms)
                .sort((a, b) =>
                    (a.slotOrder ?? 0) - (b.slotOrder ?? 0) ||
                    (a.uuid || "").localeCompare(b.uuid || "")
                )
                .slice(0, CAP);
            const slots = Array.from({ length: CAP }, () => null);
            for (const p of atLevelRaw) {
                const idx = Math.min(CAP - 1, Math.max(0, Number(p.slotOrder) || 0));
                if (!slots[idx]) slots[idx] = p;
                else {
                    const free = slots.findIndex(s => s === null);
                    if (free >= 0) slots[free] = p;
                }
            }
            pinIndex.set(ms, slots);
        }

        const getPinAt = (ms, slotIdx) => {
            const pair = pinIndex.get(ms);
            const pin = pair?.[slotIdx];
            return pin?.uuid ? { ...pin, delivered: pin.delivered || false } : null;
        };

        const { columns, stripContext } = this._buildSlotViewModels(partyLevel, getPinAt, {
            slotsPerMilestone: CAP,
            ripeEmptyGlow: true
        });
        const { levelRangeBarPct } = stripContext;

        for (const col of columns) {
            for (const slot of col.slots) {
                const pair = pinIndex.get(slot.level);
                const pin = pair?.[slot.slotIdx];
                slot.disabled   = false;
                slot.spellName  = pin?.spellName || "";
                slot.spellLevel = pin?.spellLevel ?? null;
                slot.locked     = pin?.locked || false;
            }
        }

        const milestoneLabels = buildMilestoneLabelFades(levelRangeBarPct);

        return {
            partyLevel,
            partyLevelLabel: `Median Lv ${partyLevel}`,
            levelRangeBarPct,
            milestoneLabels,
            columns
        };
    }

    /**
     * Merge a drop onto a pinned scroll slot.
     */
    static _mergeScrollPinnedSlot(pinned, level, slotIdx, newEntry) {
        const CAP = 3;
        const others = pinned.filter(p => p.level !== level);
        const pins = pinned.filter(p => p.level === level).slice(0, CAP);
        const slots = Array.from({ length: CAP }, () => null);
        for (const p of pins) {
            const idx = Math.min(CAP - 1, Math.max(0, Number(p.slotOrder) || 0));
            if (!slots[idx]) slots[idx] = p;
            else {
                const free = slots.findIndex(s => s === null);
                if (free >= 0) slots[free] = p;
            }
        }
        slots[slotIdx] = { ...newEntry, level, slotOrder: slotIdx };
        const merged = slots.filter(Boolean);
        return [...others, ...merged];
    }

    static _scrollPinnedOccupantAtSlot(pinned, level, slotIdx) {
        const CAP = 3;
        const pins = pinned.filter(p => p.level === level).slice(0, CAP);
        const slots = Array.from({ length: CAP }, () => null);
        for (const p of pins) {
            const idx = Math.min(CAP - 1, Math.max(0, Number(p.slotOrder) || 0));
            if (!slots[idx]) slots[idx] = p;
            else {
                const free = slots.findIndex(s => s === null);
                if (free >= 0) slots[free] = p;
            }
        }
        return slots[slotIdx] ?? undefined;
    }

    static _removeScrollPin(pinned, level, uuid) {
        return pinned.filter(p => !(p.level === level && p.uuid === uuid));
    }


    /** Move or swap pinned scroll between slots (same or different milestone). */
    async _swapOrMoveScrollPinned(fromLevel, fromUuid, toLevel, toSlotIdx) {
        let pinned = await SignatureLedger.getScrollPinned();
        const pin = pinned.find(p => p.level === fromLevel && p.uuid === fromUuid);
        if (!pin || pin.locked) return;

        const fromSlotIdx = Math.min(2, Math.max(0, Number(pin.slotOrder) || 0));
        const toIdx       = Math.min(2, Math.max(0, toSlotIdx));
        if (fromLevel === toLevel && fromSlotIdx === toIdx) return;

        const destOcc = SignatureLedgerApp._slotOccupant(pinned, toLevel, toIdx, 3);
        if (destOcc?.locked) return;

        if (!destOcc || destOcc.uuid === pin.uuid) {
            const merged = SignatureLedgerApp._mergeSlot(
                SignatureLedgerApp._removeScrollPin(pinned, fromLevel, fromUuid),
                toLevel,
                toIdx,
                3,
                { ...pin, level: toLevel, delivered: !!pin.delivered }
            );
            await SignatureLedger.setScrollPinned(merged);
            return;
        }

        if (fromLevel === toLevel) {
            pin.slotOrder = toIdx;
            destOcc.slotOrder = fromSlotIdx;
            await SignatureLedger.setScrollPinned(pinned);
            return;
        }

        const rest = pinned.filter(
            p => !((p.level === fromLevel && p.uuid === fromUuid) ||
                (p.level === toLevel && p.uuid === destOcc.uuid))
        );
        const step = SignatureLedgerApp._mergeSlot(rest, toLevel, toIdx, 3, {
            ...pin, level: toLevel, delivered: !!pin.delivered
        });
        const merged = SignatureLedgerApp._mergeSlot(step, fromLevel, fromSlotIdx, 3, {
            ...destOcc, level: fromLevel, delivered: !!destOcc.delivered
        });
        await SignatureLedger.setScrollPinned(merged);
    }

    // ── Party Shelf Panel ─────────────────────────────────────────────────────

    /**
     * Party Shelf milestone strip: 3 slots per milestone, with reach band.
     * Mirrors _buildScrollPinnedStrip.
     */
    _buildPartyShelfStrip(partyActors, partyShelf) {
        const CAP = 3;
        const partyLevel = SignatureLedgerApp._partyMedianLevel(partyActors);

        const pinIndex = new Map();
        for (const ms of MILESTONES()) {
            const atLevel = partyShelf
                .filter(p => p.level === ms)
                .sort((a, b) =>
                    (a.slotOrder ?? 0) - (b.slotOrder ?? 0) ||
                    (a.name || "").localeCompare(b.name || "")
                )
                .slice(0, CAP);
            const slots = Array.from({ length: CAP }, () => null);
            for (let i = 0; i < atLevel.length; i++) {
                const idx = Math.min(CAP - 1, Math.max(0, Number(atLevel[i].slotOrder) || i));
                if (!slots[idx]) slots[idx] = atLevel[i];
                else {
                    const free = slots.findIndex(s => s === null);
                    if (free >= 0) slots[free] = atLevel[i];
                }
            }
            pinIndex.set(ms, slots);
        }

        const getPinAt = (ms, slotIdx) => {
            const arr = pinIndex.get(ms);
            const pin = arr?.[slotIdx];
            return pin?.uuid ? { ...pin, delivered: pin.delivered || false } : null;
        };

        const { columns, stripContext } = this._buildSlotViewModels(partyLevel, getPinAt, {
            slotsPerMilestone: CAP,
            ripeEmptyGlow: true
        });
        const { levelRangeBarPct } = stripContext;

        for (const col of columns) {
            for (const slot of col.slots) {
                const arr = pinIndex.get(slot.level);
                const pin = arr?.[slot.slotIdx];
                slot.disabled = false;
                slot.locked   = pin?.locked ?? false;
                slot.isAuto   = pin?.source === "auto";
            }
        }

        const milestoneLabels = buildMilestoneLabelFades(levelRangeBarPct);

        return {
            partyLevel,
            partyLevelLabel: `Median Lv ${partyLevel}`,
            levelRangeBarPct,
            milestoneLabels,
            columns
        };
    }

    async _swapOrMovePartyShelf(fromLevel, fromUuid, toLevel, toSlotIdx) {
        let shelf = await SignatureLedger.getPartyShelf();
        const pin = shelf.find(p => p.level === fromLevel && p.uuid === fromUuid);
        if (!pin) return;

        const fromSlotIdx = Math.min(2, Math.max(0, Number(pin.slotOrder) || 0));
        const toIdx       = Math.min(2, Math.max(0, toSlotIdx));
        if (fromLevel === toLevel && fromSlotIdx === toIdx) return;

        const destOcc = SignatureLedgerApp._slotOccupant(shelf, toLevel, toIdx, 3);

        if (!destOcc || destOcc.uuid === pin.uuid) {
            const merged = SignatureLedgerApp._mergeSlot(
                shelf.filter(p => !(p.level === fromLevel && p.uuid === fromUuid)),
                toLevel,
                toIdx,
                3,
                { ...pin }
            );
            await SignatureLedger.setPartyShelf(merged);
            return;
        }

        if (fromLevel === toLevel) {
            pin.slotOrder = toIdx;
            destOcc.slotOrder = fromSlotIdx;
            await SignatureLedger.setPartyShelf(shelf);
            return;
        }

        const rest = shelf.filter(
            p => !((p.level === fromLevel && p.uuid === fromUuid) ||
                   (p.level === toLevel && p.uuid === destOcc.uuid))
        );
        const step = SignatureLedgerApp._mergeSlot(rest, toLevel, toIdx, 3, { ...pin });
        const merged = SignatureLedgerApp._mergeSlot(step, fromLevel, fromSlotIdx, 3, { ...destOcc });
        await SignatureLedger.setPartyShelf(merged);
    }

    // ── Cursed: Planned (single strip, 2 slots per milestone, party median band) ─

    /** Party level for the planned-curses progress band: median character level. */
    static _partyMedianLevel(partyActors) {
        if (!partyActors?.length) return 1;
        const systemAdapter = game.ionrift?.library?.system;
        const sorted = partyActors
            .map(a => systemAdapter?.getLevel(a) || 1)
            .sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 1
            ? sorted[mid]
            : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    }

    /**
     * Compute a bell-curve probability distribution for scroll spell levels.
     * Produces an array of { level, percent, isOptimal, barHeight } objects
     * for rendering the bar chart visualization.
     *
     * @param {number} optimal      Most likely scroll level (derived from party median)
     * @param {number} floor        Absolute minimum spell level (setting)
     * @param {number} upperReach   Max levels above optimal (setting, replaces jitter)
     * @param {number} concentration How tightly peaked (1=flat, 5=sharp)
     * @returns {Array<{level: number, percent: number, isOptimal: boolean, barHeight: number}>}
     */
    static _computeScrollDistribution(optimal, floor, upperReach, concentration) {
        const minLv = Math.max(1, Math.min(floor, optimal));
        const maxLv = Math.min(9, optimal + upperReach);
        if (minLv > maxLv) return [{ level: optimal, percent: 100, isOptimal: true, barHeight: 100 }];

        // Build raw weights using a distance-from-optimal falloff
        // shaped by concentration (higher = sharper peak)
        const weights = {};
        for (let lv = minLv; lv <= maxLv; lv++) {
            const dist = Math.abs(lv - optimal);
            // Exponential falloff: weight = concentration ^ (-dist)
            // At dist=0 (optimal): weight=1. At dist=1: 1/conc. At dist=2: 1/conc^2. etc.
            weights[lv] = Math.pow(concentration, -dist);
        }

        const total = Object.values(weights).reduce((a, b) => a + b, 0);
        if (total <= 0) return [{ level: optimal, percent: 100, isOptimal: true, barHeight: 100 }];

        const result = [];
        let maxPct = 0;
        for (let lv = minLv; lv <= maxLv; lv++) {
            const pct = Math.round((weights[lv] / total) * 1000) / 10; // one decimal
            if (pct > maxPct) maxPct = pct;
            result.push({
                level: lv,
                percent: pct,
                isOptimal: lv === optimal
            });
        }

        // Normalise bar heights so the tallest bar = 100%
        for (const entry of result) {
            entry.barHeight = maxPct > 0 ? Math.round((entry.percent / maxPct) * 100) : 0;
        }

        return result;
    }

    /**
     * Compute a rarity probability distribution for the Party Shelf bar chart.
     * Uses concentration to shape how peaked the distribution is around Uncommon.
     *
     * @param {number} concentration  1=flat, 5=sharply peaked at Uncommon
     * @returns {Array<{rarity: string, label: string, percent: number, barHeight: number, isOptimal: boolean, cssClass: string}>}
     */
    static _computeShelfRarityDistribution(concentration) {
        const tiers = [
            { rarity: "uncommon", label: "Uncommon", base: 6, cssClass: "rarity-uncommon" },
            { rarity: "rare",     label: "Rare",     base: 3, cssClass: "rarity-rare" },
            { rarity: "veryRare", label: "Very Rare", base: 1, cssClass: "rarity-veryRare" }
        ];

        const factor = Math.max(1, concentration) / 3;
        const weights = tiers.map(t => Math.pow(t.base, factor));
        const total = weights.reduce((a, b) => a + b, 0);

        let maxPct = 0;
        const result = tiers.map((t, i) => {
            const pct = Math.round((weights[i] / total) * 1000) / 10;
            if (pct > maxPct) maxPct = pct;
            return { ...t, percent: pct, isOptimal: i === 0 };
        });

        for (const entry of result) {
            entry.barHeight = maxPct > 0 ? Math.round((entry.percent / maxPct) * 100) : 0;
        }
        return result;
    }

    /**
     * Parse category weights JSON and normalise enabled categories to 100%.
     *
     * @param {string} jsonStr  Serialised category weights object
     * @returns {Array<{category: string, label: string, percent: number, enabled: boolean, weight: number, cssClass: string}>}
     */
    static _computeCategoryMix(jsonStr) {
        const CATEGORY_META = {
            wondrous: { label: "Wondrous", cssClass: "cat-wondrous" },
            focus:    { label: "Focus",    cssClass: "cat-focus" },
            armor:    { label: "Armor",    cssClass: "cat-armor" },
            weapon:   { label: "Weapon",   cssClass: "cat-weapon" }
        };

        let parsed;
        try { parsed = JSON.parse(jsonStr); } catch { parsed = {}; }

        const result = [];
        let enabledTotal = 0;

        for (const [cat, meta] of Object.entries(CATEGORY_META)) {
            const entry = parsed[cat] ?? { w: 0, on: false };
            const enabled = !!entry.on;
            const weight  = Math.max(0, Number(entry.w) || 0);
            if (enabled) enabledTotal += weight;
            result.push({ category: cat, ...meta, weight, enabled, percent: 0 });
        }

        for (const entry of result) {
            entry.percent = entry.enabled && enabledTotal > 0
                ? Math.round((entry.weight / enabledTotal) * 1000) / 10
                : 0;
        }

        return result;
    }

    /**
     * Tier drop probability distribution for the cursed pool chart.
     * Party level drives the weights: low level = T1/T2 dominant; higher level opens T3/T4.
     * T3/T4 are gated by their enabled flags.
     *
     * Curve: base weight = exp(-decay * (tier - 1)) where decay softens as party levels up.
     * Disabled tiers get weight 0 and a greyed bar.
     *
     * @param {number}  partyLevel
     * @param {boolean} t3Enabled
     * @param {boolean} t4Enabled
     * @returns {Array<{tier, label, percent, barHeight, isDisabled}>}
     */
    static _buildCursedTierDistribution(partyLevel, t3Enabled, t4Enabled) {
        const lv = Math.max(1, Number(partyLevel) || 1);
        // Decay reduces as party levels up, opening higher tiers
        const decay = Math.max(0.3, 1.2 - (lv / 20) * 0.9);
        const tierMeta = [
            { tier: 1, label: "T1",  enabled: true },
            { tier: 2, label: "T2",  enabled: true },
            { tier: 3, label: "T3",  enabled: t3Enabled },
            { tier: 4, label: "T4",  enabled: t4Enabled }
        ];
        const rawWeights = tierMeta.map(m =>
            m.enabled ? Math.exp(-decay * (m.tier - 1)) : 0
        );
        const total = rawWeights.reduce((a, b) => a + b, 0) || 1;
        const percents = rawWeights.map(w => Math.round((w / total) * 1000) / 10);
        const maxPct = Math.max(...percents, 1);
        return tierMeta.map((m, i) => ({
            tier:       m.tier,
            label:      m.label,
            percent:    percents[i],
            barHeight:  Math.round((percents[i] / maxPct) * 72),
            isDisabled: !m.enabled
        }));
    }

    /**
     * Build four priority columns (T1-T4) from the pool.
     * Each column holds up to `cap` items in their stored array order (= priority).
     * Disabled tiers still show their column but mark it locked.
     *
     * @param {object[]} pool
     * @param {boolean}  t3Enabled
     * @param {boolean}  t4Enabled
     * @param {number}   cap   Max items per column
     * @returns {Array<{tier, label, laneHead, enabled, items, count, isFull}>}
     */
    static _buildCursedPriorityColumns(pool, t3Enabled, t4Enabled, cap = 5) {
        const tierEnabledMap = { 1: true, 2: true, 3: t3Enabled, 4: t4Enabled };
        const cols = [
            { tier: 1, label: "T1", laneHead: "T1 · Lv 3-5" },
            { tier: 2, label: "T2", laneHead: "T2 · Lv 8-12" },
            { tier: 3, label: "T3", laneHead: "T3 · Lv 16" },
            { tier: 4, label: "T4", laneHead: "T4 · Lv 20" }
        ];
        return cols.map(col => {
            // Items for this tier, preserving their pool array order (= priority)
            const items = pool
                .filter(e => (e.tier ?? 1) === col.tier)
                .slice(0, cap)
                .map((e, posInCol, arr) => {
                    const n = arr.length;
                    const weightSum = (n * (n + 1)) / 2;
                    const w = n - posInCol;
                    const weightPct = weightSum > 0 ? Math.round((w / weightSum) * 100) : 100;
                    return {
                        ...e,
                        posInCol,
                        curseTypeDesc: CURSE_TYPE_DESCRIPTIONS[(e.curseType || "").toLowerCase()] || "",
                        weightPct,
                        weightTooltip: `Draw weight within T${col.tier}: ${weightPct}% - drag to reorder`
                    };
                });
            const enabled = tierEnabledMap[col.tier] ?? true;
            return {
                ...col,
                enabled,
                items,
                count: items.length,
                isFull: items.length >= cap
            };
        });
    }

    /**
     * Config-driven drag-drop engine shared by signature and cursed tabs.
     */
    _initSlotDragDrop(form, config) {
        const overClass = config.overClass || "sig-drag-over";
        const clearOver = () => {
            form.querySelectorAll(`.${overClass}`).forEach(s => s.classList.remove(overClass));
        };

        for (const src of config.sources) {
            form.querySelectorAll(src.selector).forEach(el => {
                if (src.skipEl?.(el)) return;
                el.setAttribute("draggable", "true");
                el.addEventListener("dragstart", ev => {
                    if (ev.target.closest("button")) { ev.preventDefault(); return; }
                    this._hideItemTooltip();
                    config.onDragStart(el);
                    ev.dataTransfer.effectAllowed = "move";
                    ev.dataTransfer.setData("text/plain", JSON.stringify(src.buildPayload(el)));
                    setTimeout(() => {
                        el.classList.add(src.dragClass || "sig-dragging");
                        form.classList.add(config.formDragClass);
                    }, 0);
                });
                el.addEventListener("dragend", ev => {
                    el.classList.remove(src.dragClass || "sig-dragging");
                    form.classList.remove(config.formDragClass);
                    const px = ev.clientX;
                    const py = ev.clientY;
                    setTimeout(() => {
                        config.onDragCleanup();
                        clearOver();
                        if (config.afterDragRestore) {
                            requestAnimationFrame(() => {
                                requestAnimationFrame(() => config.afterDragRestore(px, py));
                            });
                        }
                    }, 120);
                });
            });
        }

        for (const zone of config.dropZones) {
            form.querySelectorAll(zone.selector).forEach(target => {
                target.addEventListener("dragover", ev => {
                    if (!config.isDragging()) return;
                    if (zone.canDrop && !zone.canDrop(target)) return;
                    ev.preventDefault();
                    ev.dataTransfer.dropEffect = "move";
                    clearOver();
                    target.classList.add(overClass);
                });
                target.addEventListener("dragleave", ev => {
                    if (!target.contains(ev.relatedTarget)) target.classList.remove(overClass);
                });
                target.addEventListener("drop", async ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    ev.stopImmediatePropagation();
                    target.classList.remove(overClass);
                    let payload;
                    try { payload = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
                    await zone.onDrop(target, payload);
                });
            });

            if (zone.slotSelector && zone.nearestSlotFn) {
                form.querySelectorAll(zone.slotSelector).forEach(strip => {
                    strip.addEventListener("dragover", ev => {
                        if (!config.isDragging()) return;
                        if (ev.target.closest(zone.selector)) return;
                        const slot = zone.nearestSlotFn(strip, ev.clientX, ev.clientY);
                        if (!slot) return;
                        if (zone.canDrop && !zone.canDrop(slot)) return;
                        ev.preventDefault();
                        ev.dataTransfer.dropEffect = "move";
                        clearOver();
                        slot.classList.add(overClass);
                    });
                    strip.addEventListener("dragleave", ev => {
                        if (strip.contains(ev.relatedTarget)) return;
                        clearOver();
                    });
                    strip.addEventListener("drop", async ev => {
                        if (ev.target.closest(zone.selector)) return;
                        const slot = zone.nearestSlotFn(strip, ev.clientX, ev.clientY);
                        clearOver();
                        if (!slot) return;
                        ev.preventDefault();
                        ev.stopPropagation();
                        ev.stopImmediatePropagation();
                        let payload;
                        try { payload = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
                        await zone.onDrop(slot, payload);
                    });
                });
            }
        }

        for (const rec of (config.extraReceivers || [])) {
            const el = form.querySelector(rec.selector);
            if (!el) continue;
            el.addEventListener("drop", async ev => {
                let payload;
                try {
                    const raw = ev.dataTransfer.getData("text/plain");
                    if (raw) payload = JSON.parse(raw);
                } catch { /* */ }
                if (!rec.acceptPayload(payload)) return;
                ev.preventDefault();
                ev.stopPropagation();
                ev.stopImmediatePropagation();
                await rec.onDrop(payload);
            });
        }
    }

    /**
     * Priority-pool drag-drop.
     * Handles two interactions:
     *   1. Reorder within a column: drag a .curse-priority-card to a new position in the same
     *      or different tier column. Saves new order via setPriorityOrder.
     *   2. External drop from compendium/sidebar: add item to column (blocked if full).
     */
    _initCursedDragDrop(html) {
        const form = html[0];
        const CAP = 5;

        /** Resolve a Foundry drag-event data object from text/plain or standard Foundry DragData. */
        const parseDragPayload = (ev) => {
            try {
                const raw = ev.dataTransfer.getData("text/plain");
                if (raw) return JSON.parse(raw);
            } catch { /* fall through */ }
            return null;
        };

        /** Visual: highlight column on dragover; clear on leave/drop. */
        const setColHighlight = (colEl, on) => {
            colEl?.classList.toggle("curse-col-drag-over", on);
        };

        // ── Draggable priority cards (internal reorder) ───────────────────────
        form.querySelectorAll(".curse-priority-card[data-uuid]").forEach(card => {
            card.setAttribute("draggable", "true");
            card.addEventListener("dragstart", ev => {
                if (ev.target.closest(".curse-priority-card-remove")) { ev.preventDefault(); return; }
                this._cursedDragType = "pool";
                this._cursedDragInFlight = false;
                ev.dataTransfer.effectAllowed = "move";
                ev.dataTransfer.setData("text/plain", JSON.stringify({
                    type:     "cursed-priority-move",
                    uuid:     card.dataset.uuid,
                    tier:     parseInt(card.dataset.tier, 10),
                    posInCol: parseInt(card.dataset.posInCol, 10)
                }));
                setTimeout(() => card.classList.add("curse-priority-card--dragging"), 0);
            });
            card.addEventListener("dragend", () => {
                card.classList.remove("curse-priority-card--dragging");
                form.querySelectorAll(".curse-col-drag-over").forEach(el => el.classList.remove("curse-col-drag-over"));
                setTimeout(() => {
                    this._cursedDragType = null;
                    this._cursedDragInFlight = false;
                }, 120);
            });
        });

        // ── Drop zones: tier columns ──────────────────────────────────────────
        form.querySelectorAll(".curse-priority-col").forEach(col => {
            const tierNum = parseInt(col.dataset.tier, 10);

            col.addEventListener("dragover", ev => {
                ev.preventDefault();
                ev.dataTransfer.dropEffect = "move";
                setColHighlight(col, true);
            });
            col.addEventListener("dragleave", ev => {
                if (!col.contains(ev.relatedTarget)) setColHighlight(col, false);
            });

            col.addEventListener("drop", async ev => {
                ev.preventDefault();
                ev.stopPropagation();
                setColHighlight(col, false);

                const payload = parseDragPayload(ev);
                const reg = getActiveCursedRegistry();

                if (payload?.type === "cursed-priority-move") {
                    // ── Reorder within/between tier columns ──────────────────
                    const fromUuid = payload.uuid;
                    const fromTier = payload.tier;

                    const pool = await reg.getCursedPool();

                    // Determine drop target position from cursor Y vs card midpoints
                    const cards = [...col.querySelectorAll(".curse-priority-card")];
                    let insertBefore = null;
                    for (const c of cards) {
                        const rect = c.getBoundingClientRect();
                        if (ev.clientY < rect.top + rect.height / 2) { insertBefore = c; break; }
                    }
                    const insertBeforeUuid = insertBefore?.dataset.uuid ?? null;

                    // Build new ordered UUID list for this tier
                    const tierItems = pool
                        .filter(e => (e.tier ?? 1) === tierNum && (e.uuid || "") !== fromUuid)
                        .map(e => e.uuid);

                    // Moving from another tier: check cap
                    if (fromTier !== tierNum) {
                        const currentCount = tierItems.length;
                        if (currentCount >= CAP) {
                            ui.notifications.warn(`T${tierNum} column is full (max ${CAP} items). Remove one before adding another.`);
                            return;
                        }
                        // Also update the source tier to remove the item from there
                        const sourceTierItems = pool
                            .filter(e => (e.tier ?? 1) === fromTier && (e.uuid || "") !== fromUuid)
                            .map(e => e.uuid);
                        // Find the entry and update its tier
                        const movingEntry = pool.find(e => (e.uuid || "") === fromUuid);
                        if (movingEntry) movingEntry.tier = tierNum;
                        if (typeof reg.setPriorityOrder === "function") {
                            await reg.setPriorityOrder(fromTier, sourceTierItems);
                        }
                    }

                    // Insert at cursor position
                    const insertIdx = insertBeforeUuid
                        ? tierItems.indexOf(insertBeforeUuid)
                        : -1;
                    if (insertIdx >= 0) {
                        tierItems.splice(insertIdx, 0, fromUuid);
                    } else {
                        tierItems.push(fromUuid);
                    }

                    if (typeof reg.setPriorityOrder === "function") {
                        await reg.setPriorityOrder(tierNum, tierItems);
                    }
                    this.render();
                    return;
                }

                // ── External drop: add new item from compendium/sidebar ───────
                let uuid = payload?.uuid;
                if (!uuid) {
                    // Try Foundry v12/v13 standard drag data
                    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
                    const foundryData = TE?.getDragEventData?.(ev) ?? null;
                    uuid = foundryData?.uuid;
                }
                if (!uuid) return;

                const pool = await reg.getCursedPool();
                const tierItems = pool.filter(e => (e.tier ?? 1) === tierNum);
                if (tierItems.length >= CAP) {
                    ui.notifications.warn(`T${tierNum} column is full (max ${CAP} items). Remove one first.`);
                    return;
                }
                if (pool.some(e => (e.uuid || "").toLowerCase() === uuid.toLowerCase())) {
                    ui.notifications.info("That item is already in the cursed pool.");
                    return;
                }

                // Resolve item doc for metadata
                let doc;
                try { doc = await fromUuid(uuid); } catch { /* */ }
                if (!doc) return;

                const meta = doc.flags?.[MODULE_ID]?.cursedMeta ?? {};
                const newEntry = {
                    uuid,
                    name:            doc.name ?? "Unknown",
                    img:             doc.img ?? "icons/svg/item-bag.svg",
                    curseType:       meta.curseType ?? "unknown",
                    decoyAppearance: meta.decoyAppearance ?? "",
                    trueNature:      meta.trueNature ?? "",
                    tier:            meta.tier ?? tierNum
                };

                await reg.setCursedPool([...pool, newEntry]);
                this.render();
            });
        });
    }

    // ── Delivery Auto-Sync ────────────────────────────────────────────────────

    /**
     * Scan party inventories and auto-mark shelf items as delivered when
     * a matching item is found on any character. Persists changes only if
     * the delivery status actually changed.
     *
     * Match policy: case-insensitive name comparison with apostrophe
     * normalisation (dnd5e compendium uses unicode right single quotes).
     *
     * @param {Array}   shelf        Current party shelf entries
     * @param {Actor[]} partyActors  Active party members
     * @returns {Array} Updated shelf (same reference if unchanged)
     */
    async _syncDeliveryStatus(shelf, partyActors) {
        if (!shelf.length || !partyActors.length) return shelf;

        // Build a Set of all item names across all party inventories
        const ownedNames = new Set();
        for (const actor of partyActors) {
            for (const item of actor.items) {
                ownedNames.add(this._normaliseNameForMatch(item.name));
            }
        }

        let changed = false;
        for (const entry of shelf) {
            const normalised = this._normaliseNameForMatch(entry.name);
            const isOwned = ownedNames.has(normalised);

            if (isOwned && !entry.delivered) {
                entry.delivered = true;
                changed = true;
            }
            // Don't auto-undeliver: if a GM manually marked something delivered
            // but the item was consumed/sold, that's intentional history.
        }

        if (changed) {
            await SignatureLedger.setPartyShelf(shelf);
        }

        return shelf;
    }

    /**
     * Normalise an item name for fuzzy matching.
     * Lowercases, trims, and collapses unicode apostrophe variants.
     */
    _normaliseNameForMatch(name) {
        return (name ?? "")
            .toLowerCase()
            .trim()
            .replace(/[\u2018\u2019\u2032\u0060\u00B4]/g, "'");
    }

    // ── Signature Delivery Sync ──────────────────────────────────────────────

    /**
     * Scan party inventories and auto-mark signature items as delivered when
     * a matching item is found on the assigned character. Persists changes
     * only if delivery status actually changed.
     *
     * Same sticky-delivery policy as Party Shelf: once owned, delivered stays
     * true even if the item is later sold/discarded. GM can manually toggle.
     */
    async _syncSignatureDelivery(sigData, partyActors) {
        let changed = false;
        for (const actor of partyActors) {
            const entry = sigData[actor.id];
            if (!entry?.plannedItems?.length) continue;

            const ownedNames = new Set(
                actor.items.map(i => this._normaliseNameForMatch(i.name))
            );

            for (const planned of entry.plannedItems) {
                const isOwned = ownedNames.has(this._normaliseNameForMatch(planned.name));
                if (isOwned && !planned.delivered) {
                    planned.delivered = true;
                    changed = true;
                }
                // Sticky: never auto-undeliver
            }
        }
        if (changed) await SignatureLedger.setLedgerData(sigData);
        return sigData;
    }

    // ── Listeners ─────────────────────────────────────────────────────────────

    activateListeners(html) {
        super.activateListeners(html);

        if (!this._cursedPoolHookRegistered) {
            Hooks.on(CURSED_POOL_DATA_HOOK, this._onCursedPoolDataExternalUpdate);
            this._cursedPoolHookRegistered = true;
        }

        // Tab switching
        html.find(".registry-tab").click(this._onSwitchTab.bind(this));

        // Toggle trackers
        html.find(".action-toggle-scroll-tracker").click(ev => {
            ev.preventDefault();
            this._scrollTrackerExpanded = !this._scrollTrackerExpanded;
            this.render(false);
        });
        html.find(".action-toggle-party-tracker").click(ev => {
            ev.preventDefault();
            this._partyTrackerExpanded = !this._partyTrackerExpanded;
            this.render(false);
        });
        // Scroll Policy slider live updates
        const _updateSliderFill = (el) => {
            const min = parseFloat(el.min) || 0;
            const max = parseFloat(el.max) || 1;
            const val = parseFloat(el.value) || 0;
            const pct = ((val - min) / (max - min)) * 100;
            el.style.setProperty("--pct", `${pct}%`);
        };

        // Initialise fill on render
        html.find(".policy-slider").each((_, el) => _updateSliderFill(el));

        // Update fill live while dragging (input), save on release (change)
        html.find(".action-update-scroll-floor").on("input", ev => _updateSliderFill(ev.currentTarget));
        html.find(".action-update-scroll-floor").change(async ev => {
            const val = parseInt(ev.currentTarget.value, 10);
            if (!Number.isNaN(val)) {
                await game.settings.set("ionrift-quartermaster", "scrollFloor", val);
                this.render(false);
            }
        });
        html.find(".action-update-scroll-upper-reach").on("input", ev => _updateSliderFill(ev.currentTarget));
        html.find(".action-update-scroll-upper-reach").change(async ev => {
            const val = parseInt(ev.currentTarget.value, 10);
            if (!Number.isNaN(val)) {
                await game.settings.set("ionrift-quartermaster", "scrollUpperReach", val);
                this.render(false);
            }
        });
        html.find(".action-update-scroll-concentration").on("input", ev => _updateSliderFill(ev.currentTarget));
        html.find(".action-update-scroll-concentration").change(async ev => {
            const val = parseInt(ev.currentTarget.value, 10);
            if (!Number.isNaN(val)) {
                await game.settings.set("ionrift-quartermaster", "scrollConcentration", val);
                this.render(false);
            }
        });
        html.find(".action-update-scroll-offset").on("input", ev => _updateSliderFill(ev.currentTarget));
        html.find(".action-update-scroll-offset").change(async ev => {
            const val = parseInt(ev.currentTarget.value, 10);
            if (!Number.isNaN(val)) {
                await game.settings.set("ionrift-quartermaster", "scrollOffset", val);
                this.render(false);
            }
        });
        html.find(".action-reset-scroll-defaults").click(async ev => {
            ev.preventDefault();
            await game.settings.set("ionrift-quartermaster", "scrollFloor", 1);
            await game.settings.set("ionrift-quartermaster", "scrollUpperReach", 2);
            await game.settings.set("ionrift-quartermaster", "scrollConcentration", 2);
            await game.settings.set("ionrift-quartermaster", "scrollOffset", -1);
            ui.notifications.info("Scroll distribution settings reset to defaults.");
            this.render(false);
        });


        // Party manager (delegates to library PartyRoster UI)
        html.find(".btn-manage-party").click(this._onManageParty.bind(this));

        // Signatures tab
        html.find(".slot-filled[data-actor-id]").click(ev => this._openItemSheetFromSlot(ev, {
            dragGuard: () => this._sigDragInFlight,
            ignoreSelector: ".slot-btn"
        }));
        html.find(".action-clear-slot").click(this._onClearSignatureSlot.bind(this));
        html.find(".action-reroll-slot").click(this._onRerollSlot.bind(this));
        html.find(".action-toggle-sig-delivered").click(this._onToggleSignatureDelivered.bind(this));
        html.find(".action-seed-signatures").click(this._onSeedSignatures.bind(this));

        // Internal signature slot drag-and-drop (swap / move)
        this._initSignatureDragDrop(html);

        // Scroll tab: pinned strip
        html.find(".scroll-slot.slot-filled[data-uuid]").click(ev => this._openItemSheetFromSlot(ev, {
            dragGuard: () => this._scrollDragInFlight,
            ignoreSelector: ".slot-btn"
        }));
        html.find(".action-remove-scroll-pin").click(this._onRemoveScrollPin.bind(this));
        html.find(".action-toggle-scroll-delivered").click(this._onToggleScrollDelivered.bind(this));
        // Scroll tab: open compendium / compile
        html.find(".action-open-forged-scrolls").click(this._onOpenForgedScrolls.bind(this));
        html.find(".action-compile-scroll-forge").click(this._onCompileScrollForge.bind(this));

        // Party shelf tab
        html.find(".party-slot.slot-filled[data-uuid]").click(ev => this._openItemSheetFromSlot(ev, {
            dragGuard: () => this._partyDragInFlight,
            ignoreSelector: ".slot-btn"
        }));
        html.find(".action-remove-party-item").click(this._onRemovePartyItem.bind(this));
        html.find(".action-toggle-delivered").click(this._onToggleDelivered.bind(this));
        html.find(".action-seed-shelf").click(this._onSeedPartyShelf.bind(this));
        html.find(".action-curate-shelf").click(this._onCurateShelfSources.bind(this));

        // Party shelf policy sliders
        html.find(".party-category-slider").each((_, el) => _updateSliderFill(el));
        html.find(".action-update-shelf-concentration").on("input", ev => _updateSliderFill(ev.currentTarget));
        html.find(".action-update-shelf-concentration").change(async ev => {
            const val = parseInt(ev.currentTarget.value, 10);
            if (!Number.isNaN(val)) {
                await game.settings.set("ionrift-quartermaster", "shelfConcentration", val);
                this.render(false);
            }
        });
        html.find(".action-update-shelf-attunement").on("input", ev => _updateSliderFill(ev.currentTarget));
        html.find(".action-update-shelf-attunement").change(async ev => {
            const val = parseInt(ev.currentTarget.value, 10);
            if (!Number.isNaN(val)) {
                await game.settings.set("ionrift-quartermaster", "shelfAttunementBias", val);
                this.render(false);
            }
        });

        // Category mix checkboxes + weight sliders
        html.find(".action-toggle-category").change(async ev => {
            const cat = ev.currentTarget.dataset.category;
            if (!cat) return;
            const raw = game.settings?.get("ionrift-quartermaster", "shelfCategoryWeights")
                ?? '{"wondrous":{"w":70,"on":true},"focus":{"w":15,"on":true},"armor":{"w":10,"on":true},"weapon":{"w":5,"on":true}}';
            let parsed;
            try { parsed = JSON.parse(raw); } catch { parsed = {}; }
            if (parsed[cat]) parsed[cat].on = ev.currentTarget.checked;
            await game.settings.set("ionrift-quartermaster", "shelfCategoryWeights", JSON.stringify(parsed));
            this.render(false);
        });
        html.find(".action-update-category-weight").on("input", ev => {
            _updateSliderFill(ev.currentTarget);
            const row = ev.currentTarget.closest(".party-category-row");
            const valEl = row?.querySelector(".party-category-weight");
            if (valEl) valEl.textContent = `${ev.currentTarget.value}%`;
        });
        html.find(".action-update-category-weight").change(async ev => {
            const cat = ev.currentTarget.dataset.category;
            if (!cat) return;
            const raw = game.settings?.get("ionrift-quartermaster", "shelfCategoryWeights")
                ?? '{"wondrous":{"w":70,"on":true},"focus":{"w":15,"on":true},"armor":{"w":10,"on":true},"weapon":{"w":5,"on":true}}';
            let parsed;
            try { parsed = JSON.parse(raw); } catch { parsed = {}; }
            if (parsed[cat]) parsed[cat].w = parseInt(ev.currentTarget.value, 10) || 0;
            await game.settings.set("ionrift-quartermaster", "shelfCategoryWeights", JSON.stringify(parsed));
            this.render(false);
        });
        html.find(".action-open-loot-generation-config").click(ev => {
            ev.preventDefault();
            new LootGenerationConfigApp().render(true);
        });
        html.find(".action-reset-party-defaults").click(async ev => {
            ev.preventDefault();
            await game.settings.set("ionrift-quartermaster", "shelfConcentration", 3);
            await game.settings.set("ionrift-quartermaster", "shelfAttunementBias", 1);
            await game.settings.set("ionrift-quartermaster", "shelfCategoryWeights", JSON.stringify({
                wondrous: { w: 70, on: true },
                focus:    { w: 15, on: true },
                armor:    { w: 10, on: true },
                weapon:   { w: 5,  on: true }
            }));
            ui.notifications.info("Party shelf policy settings reset to defaults.");
            this.render(false);
        });

        // Ban list tab
        html.find(".action-remove-ban").click(this._onRemoveBan.bind(this));
        this._initBanDropZoneVisuals(html);
        this._initCardSearchFilter(html, {
            inputSelector:   ".ban-search-input",
            cardSelector:    ".ban-card",
            noMatchSelector: ".ban-no-matches",
            emptySelector:   ".ban-empty-state"
        });

        // Cursed tab: CurseRegistryPanel launch (Curse Tracker button in header)
        html.find(".action-open-curse-registry").click(ev => {
            ev.preventDefault();
            const cw = game.ionrift?.cursewright;
            if (!cw) { ui.notifications.warn("Cursewright is not installed."); return; }
            new cw.CurseRegistryPanel().render(true);
        });

        // Lock toggle (signatures, scrolls)
        html.find(".action-toggle-lock").click(this._onToggleLock.bind(this));

        // Cursed tab: priority pool cards — click to open sheet
        html.find(".curse-priority-card[data-uuid]").click(ev => {
            if (ev.target.closest(".curse-priority-card-remove")) return;
            if (this._cursedDragInFlight) return;
            const uuid = ev.currentTarget.dataset.uuid;
            if (uuid) fromUuid(uuid).then(doc => doc?.sheet?.render(true));
        });

        // Remove from priority pool
        html.find(".curse-priority-card-remove").click(this._onRemovePoolItem.bind(this));

        // T3/T4 tier enable toggles
        html.find(".action-toggle-t3").change(async ev => {
            const enabled = ev.currentTarget.checked;
            const reg = getActiveCursedRegistry();
            if (typeof reg.setTierEnabled === "function") await reg.setTierEnabled(3, enabled);
            else await game.settings.set(MODULE_ID, "cursedT3Enabled", enabled);
            this.render(false);
        });
        html.find(".action-toggle-t4").change(async ev => {
            const enabled = ev.currentTarget.checked;
            const reg = getActiveCursedRegistry();
            if (typeof reg.setTierEnabled === "function") await reg.setTierEnabled(4, enabled);
            else await game.settings.set(MODULE_ID, "cursedT4Enabled", enabled);
            this.render(false);
        });

        // Source footer actions
        html.find(".action-compile-curse-forge").click(this._onRebuildCursedPool.bind(this));
        html.find(".action-compile-srd-cursed").click(this._onLoadSrdCursedItems.bind(this));
        // Delegated handler for source footer inline buttons
        html.find(".curse-source-footer").on("click", "[data-action]", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const action = ev.currentTarget.dataset.action;
            if (action === "compile-srd-cursed")  this._onLoadSrdCursedItems(ev);
            if (action === "compile-curse-forge") this._onRebuildCursedPool(ev);
        });

        if (this._activeTab === "cursed") this._initCursedDragDrop(html);
        if (this._activeTab === "scrolls") this._initScrollDragDrop(html);
        if (this._activeTab === "party") this._initPartyDragDrop(html);

        // Tooltip hover cards (all tabs)
        this._initTooltipListeners(html);
    }

    _initScrollDragDrop(html) {
        const form = html[0];
        const scrollDropHandler = async (target, payload) => {
            const toLevel = parseInt(target.dataset.level, 10);
            const toIdx   = parseInt(target.dataset.slotIdx || "0", 10);
            if (Number.isNaN(toLevel)) return;
            if (payload?.type !== "scroll-pinned-move") return;
            await this._swapOrMoveScrollPinned(payload.level, payload.uuid, toLevel, toIdx);
            this.render();
        };

        this._initSlotDragDrop(form, {
            formDragClass: "scroll-drag-in-progress",
            isDragging:    () => !!this._scrollDragType,
            onDragStart:   () => {
                this._scrollDragType = "pinned";
                this._scrollDragInFlight = false;
            },
            onDragCleanup: () => {
                this._scrollDragType = null;
                this._scrollDragInFlight = false;
            },
            afterDragRestore: (px, py) => {
                this._tryRestoreTooltipAfterDrag(px, py,
                    ".scroll-slot.slot-filled[data-uuid]");
            },
            sources: [
                {
                    selector: ".scroll-slot.slot-filled[data-uuid]",
                    skipEl: el => el.classList.contains("slot-locked"),
                    buildPayload: el => ({
                        type: "scroll-pinned-move",
                        level: parseInt(el.dataset.level, 10),
                        slotIdx: parseInt(el.dataset.slotIdx || "0", 10),
                        uuid: el.dataset.uuid
                    })
                }
            ],
            dropZones: [
                {
                    selector: ".scroll-slot",
                    slotSelector: ".scroll-slots-strip",
                    nearestSlotFn: (strip, x, y) => {
                        const s = SignatureLedgerApp._nearestCursedSlot(strip, x, y);
                        return s?.classList.contains("scroll-slot") ? s : null;
                    },
                    onDrop: scrollDropHandler
                }
            ]
        });
    }

    _initPartyDragDrop(html) {
        const form = html[0];
        const partyDropHandler = async (target, payload) => {
            const toLevel = parseInt(target.dataset.level, 10);
            const toIdx   = parseInt(target.dataset.slotIdx || "0", 10);
            if (Number.isNaN(toLevel)) return;
            if (payload?.type !== "party-slot-move") return;
            await this._swapOrMovePartyShelf(payload.level, payload.uuid, toLevel, toIdx);
            this.render();
        };

        this._initSlotDragDrop(form, {
            formDragClass: "party-drag-in-progress",
            isDragging:    () => !!this._partyDragType,
            onDragStart:   () => {
                this._partyDragType = "shelf";
                this._partyDragInFlight = false;
            },
            onDragCleanup: () => {
                this._partyDragType = null;
                this._partyDragInFlight = false;
            },
            afterDragRestore: (px, py) => {
                this._tryRestoreTooltipAfterDrag(px, py,
                    ".party-slot.slot-filled[data-uuid]");
            },
            sources: [{
                selector: ".party-slot.slot-filled[data-uuid]",
                skipEl: el => el.classList.contains("slot-locked"),
                buildPayload: el => ({
                    type: "party-slot-move",
                    level: parseInt(el.dataset.level, 10),
                    slotIdx: parseInt(el.dataset.slotIdx || "0", 10),
                    uuid: el.dataset.uuid
                })
            }],
            dropZones: [{
                selector: ".party-slot",
                slotSelector: ".party-slots-strip",
                nearestSlotFn: (strip, x, y) => {
                    const s = SignatureLedgerApp._nearestCursedSlot(strip, x, y);
                    return s?.classList.contains("party-slot") ? s : null;
                },
                onDrop: partyDropHandler
            }]
        });
    }

    _onSwitchTab(event) {
        this._activeTab = event.currentTarget.dataset.tab;
        this.render();
    }

    /**
     * Opens the library's PartyRosterApp for managing party membership.
     * Membership changes propagate automatically via the ionrift.partyChanged hook.
     */
    _onManageParty(event) {
        event.preventDefault();
        const PartyRosterApp = game.ionrift?.library?.PartyRosterApp;
        if (PartyRosterApp) {
            new PartyRosterApp().render(true);
        } else {
            // Defensive fallback - should not reach here with library >= 2.0.0
            ui.notifications.warn("Party Roster requires Ionrift Library v2.0.0 or later.");
        }
    }

    // ── Signature Actions ─────────────────────────────────────────────────────

    async _openItemSheetFromSlot(event, { dragGuard, ignoreSelector }) {
        if (dragGuard()) return;
        if (event.target.closest(ignoreSelector)) return;
        event.preventDefault();
        const uuid = event.currentTarget.dataset.uuid;
        if (!uuid) return;
        try {
            const doc = await fromUuid(uuid);
            doc?.sheet?.render(true);
        } catch { /* uuid may be stale */ }
    }

    async _onClearSignatureSlot(event) {
        event.preventDefault();
        event.stopPropagation();
        const slotEl  = $(event.currentTarget).closest(".grid-slot");
        const actorId = slotEl.data("actorId");
        const level   = parseInt(slotEl.data("level"));
        const data    = await SignatureLedger.getLedgerData();
        if (data[actorId]) {
            const pin = (data[actorId].plannedItems || []).find(i => i.level === level);
            if (pin?.locked) return;
            data[actorId].plannedItems = (data[actorId].plannedItems || []).filter(i => i.level !== level);
            await SignatureLedger.setLedgerData(data);
            this.render();
        }
    }

    async _onToggleSignatureDelivered(event) {
        event.preventDefault();
        event.stopPropagation();
        const btn     = event.currentTarget;
        const actorId = btn.dataset.actorId;
        const level   = parseInt(btn.dataset.level, 10);
        const data    = await SignatureLedger.getLedgerData();
        if (!data[actorId]) return;
        const pin = (data[actorId].plannedItems || []).find(i => i.level === level);
        if (!pin) return;
        pin.delivered = !pin.delivered;
        await SignatureLedger.setLedgerData(data);
        this.render();
    }

    async _onToggleLock(event) {
        event.preventDefault();
        event.stopPropagation();
        const btn     = event.currentTarget;
        const actorId = btn.dataset.actorId;
        const level   = parseInt(btn.dataset.level, 10);
        const uuid    = btn.dataset.uuid;
        const variant = btn.dataset.variant;  // "scroll", "party", "cursed", or undefined (sig)

        if (actorId) {
            const data = await SignatureLedger.getLedgerData();
            if (!data[actorId]) return;
            const pin = (data[actorId].plannedItems || []).find(i => i.level === level);
            if (!pin) return;
            pin.locked = !pin.locked;
            await SignatureLedger.setLedgerData(data);
        } else if (variant === "scroll") {
            const pinned = await SignatureLedger.getScrollPinned();
            const pin = pinned.find(p => p.level === level && p.uuid === uuid);
            if (!pin) return;
            pin.locked = !pin.locked;
            await SignatureLedger.setScrollPinned(pinned);
        } else if (variant === "party") {
            const shelf = await SignatureLedger.getPartyShelf();
            const pin = shelf.find(p => p.level === level && p.uuid === uuid);
            if (!pin) return;
            pin.locked = !pin.locked;
            await SignatureLedger.setPartyShelf(shelf);
        } else {
            const planned = await getActiveCursedRegistry().getCursedPlanned();
            const pin = planned.find(p => p.level === level && p.uuid === uuid);
            if (!pin) return;
            pin.locked = !pin.locked;
            await getActiveCursedRegistry().setCursedPlanned(planned);
        }
        this.render();
    }

    async _onRerollSlot(event) {
        event.preventDefault();
        event.stopPropagation();
        const slotEl  = $(event.currentTarget).closest(".grid-slot");
        const actorId = slotEl.data("actorId");
        const level   = parseInt(slotEl.data("level"));
        const actor   = game.actors.get(actorId);
        if (!actor) return;

        const banSet     = await SignatureLedger.getBanSet();
        const ledgerData = await SignatureLedger.getLedgerData();
        if (!ledgerData[actorId]) return;
        const locked = (ledgerData[actorId].plannedItems || []).find(i => i.level === level);
        if (locked?.locked) return;

        // Remove the current item from this slot
        const existing = ledgerData[actorId].plannedItems || [];
        const oldItem  = existing.find(i => i.level === level);

        ledgerData[actorId].plannedItems = existing.filter(i => i.level !== level);

        // Build exclusion sets: all other characters' items + this character's remaining items
        const partyUsedNames = new Set();
        for (const [otherId, otherData] of Object.entries(ledgerData)) {
            for (const item of (otherData.plannedItems || [])) {
                partyUsedNames.add(item.name.toLowerCase());
            }
        }
        // Also exclude the old item so a different one is picked
        if (oldItem) partyUsedNames.add(oldItem.name.toLowerCase());

        // Seed ONLY this milestone slot using forceMilestones
        const partyAllocations = new Map();
        const planned = await ProgressionSeeder.seedSignatures(actor, banSet, partyAllocations, partyUsedNames, [level]);
        const rerolled = planned[0];

        if (rerolled) {
            ledgerData[actorId].plannedItems.push(rerolled);
            await SignatureLedger.setLedgerData(ledgerData);
            ui.notifications.info(`Re-rolled: ${rerolled.name} for ${actor.name} at Lv ${level}.`);
        } else {
            // Restore old item if no replacement found
            if (oldItem) ledgerData[actorId].plannedItems.push(oldItem);
            await SignatureLedger.setLedgerData(ledgerData);
            ui.notifications.warn(`No alternative found for ${actor.name} at Lv ${level}.`);
        }
        this.render();
    }

    // ── Internal Signature Slot Drag-and-Drop ─────────────────────────────────

    _initSignatureDragDrop(html) {
        const form = html[0];

        const sigDropHandler = async (target, payload) => {
            if (payload?.type !== "sig-slot-move") return;
            const { actorId: srcActorId, level: srcLevel } = payload;
            const dstActorId = target.dataset.actorId;
            const dstLevel   = parseInt(target.dataset.level);
            if (srcActorId === dstActorId && srcLevel === dstLevel) return;
            if (target.classList.contains("slot-disabled") && srcActorId !== dstActorId) return;
            await this._swapSignatureSlots(srcActorId, srcLevel, dstActorId, dstLevel);
        };

        this._initSlotDragDrop(form, {
            formDragClass: "sig-drag-in-progress",
            isDragging:    () => !!this._sigDragActorId,
            onDragStart:   (el) => {
                this._sigDragActorId  = el.dataset.actorId;
                this._sigDragInFlight = false;
            },
            onDragCleanup: () => {
                this._sigDragActorId  = null;
                this._sigDragInFlight = false;
            },
            afterDragRestore: (px, py) => {
                this._tryRestoreTooltipAfterDrag(px, py, ".grid-slot.slot-filled[data-uuid]");
            },
            sources: [{
                selector: ".grid-slot.slot-filled[data-actor-id]",
                skipEl: el => el.classList.contains("slot-locked"),
                buildPayload: el => ({
                    type: "sig-slot-move",
                    actorId: el.dataset.actorId,
                    level: parseInt(el.dataset.level),
                    uuid: el.dataset.uuid
                })
            }],
            dropZones: [{
                selector: ".grid-slot[data-actor-id]",
                slotSelector: ".sig-slots-strip:not(.cursed-slots-strip)",
                nearestSlotFn: SignatureLedgerApp._nearestSlot,
                canDrop: (target) => {
                    const isSameChar = target.dataset.actorId === this._sigDragActorId;
                    return !target.classList.contains("slot-disabled") || isSameChar;
                },
                onDrop: sigDropHandler
            }]
        });
    }


    /** Nearest `.grid-slot` inside a strip by Euclidean distance from cursor. */
    static _nearestSlot(strip, x, y) {
        let best = null, bestDist = Infinity;
        for (const slot of strip.querySelectorAll(".grid-slot")) {
            const r = slot.getBoundingClientRect();
            const dx = x - (r.left + r.right) / 2;
            const dy = y - (r.top + r.bottom) / 2;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; best = slot; }
        }
        return best;
    }

    /**
     * Planned curse strip: pick column by X, then slot by Y (two stacked slots per column).
     * Avoids Euclidean bias that favoured the wrong row when columns are narrow.
     */
    static _nearestCursedSlot(strip, clientX, clientY) {
        const stacks = strip.querySelectorAll(".cursed-milestone-stack");
        if (!stacks.length) return SignatureLedgerApp._nearestSlot(strip, clientX, clientY);

        let bestStack = null;
        let bestStackDist = Infinity;
        for (const stack of stacks) {
            const r = stack.getBoundingClientRect();
            const midX = (r.left + r.right) / 2;
            const distX = Math.abs(clientX - midX);
            if (clientX >= r.left && clientX <= r.right) {
                bestStack = stack;
                bestStackDist = 0;
                break;
            }
            if (distX < bestStackDist) {
                bestStackDist = distX;
                bestStack = stack;
            }
        }
        if (!bestStack) return null;

        const slots = [...bestStack.querySelectorAll(".grid-slot")];
        if (!slots.length) return null;

        for (const slot of slots) {
            const sr = slot.getBoundingClientRect();
            if (clientY >= sr.top && clientY <= sr.bottom) return slot;
        }

        let best = slots[0];
        let bestDy = Infinity;
        for (const slot of slots) {
            const sr = slot.getBoundingClientRect();
            const cy = (sr.top + sr.bottom) / 2;
            const dy = Math.abs(clientY - cy);
            if (dy < bestDy) {
                bestDy = dy;
                best = slot;
            }
        }
        return best;
    }

    /**
     * Canonical occupant lookup: find the entry at (level, slotIdx) using raw slotOrder.
     * Do NOT bucket-rebuild - that is for view-model only.
     */
    static _slotOccupant(pins, level, slotIdx, cap) {
        const idx = Math.min(cap - 1, Math.max(0, Number(slotIdx) || 0));
        return pins.find(p => p.level === level && (p.slotOrder ?? 0) === idx) ?? undefined;
    }

    /**
     * Canonical slot merge: replace the entry at (level, slotIdx) with newEntry.
     * Returns a new array; does not mutate pins.
     */
    static _mergeSlot(pins, level, slotIdx, cap, newEntry) {
        const idx = Math.min(cap - 1, Math.max(0, Number(slotIdx) || 0));
        const others = pins.filter(p => !(p.level === level && (p.slotOrder ?? 0) === idx));
        return [...others, { ...newEntry, level, slotOrder: idx }];
    }

    /**
     * Move or swap signature items between two slots.
     * Handles same-character and cross-character cases.
     * Budget is re-validated: moving within same-char is always fine;
     * cross-char is allowed only if the destination character has budget.
     */
    async _swapSignatureSlots(srcActorId, srcLevel, dstActorId, dstLevel) {
        const BUDGET     = 4;
        const ledgerData = await SignatureLedger.getLedgerData();
        if (!ledgerData[srcActorId] || !ledgerData[dstActorId]) return;

        const srcItems = ledgerData[srcActorId].plannedItems || [];
        const dstItems = ledgerData[dstActorId].plannedItems || [];

        const srcEntry = srcItems.find(i => i.level === srcLevel);
        const dstEntry = dstItems.find(i => i.level === dstLevel);

        if (!srcEntry) return;
        if (srcEntry.locked || dstEntry?.locked) return;

        const isSameChar = srcActorId === dstActorId;

        if (!isSameChar && !dstEntry) {
            // Cross-character move: destination char must have budget
            const dstBudgetUsed = dstItems.length;
            if (dstBudgetUsed >= BUDGET) {
                ui.notifications.warn(
                    `${ledgerData[dstActorId].name} has no budget remaining (${BUDGET} items). ` +
                    `Clear a slot there first.`
                );
                return;
            }
        }

        if (isSameChar) {
            // ── Same character: move or swap by changing the level field ──
            for (const item of srcItems) {
                if (item.level === srcLevel) item.level = dstLevel;
                else if (item.level === dstLevel) item.level = srcLevel;
            }
        } else {
            // ── Cross-character: extract both entries, reassign ──
            ledgerData[srcActorId].plannedItems = srcItems.filter(i => i.level !== srcLevel);
            if (dstEntry) {
                ledgerData[dstActorId].plannedItems = dstItems.filter(i => i.level !== dstLevel);
            }

            // Move src → dst
            ledgerData[dstActorId].plannedItems.push({ ...srcEntry, level: dstLevel });
            // Move dst → src (if there was something there)
            if (dstEntry) {
                ledgerData[srcActorId].plannedItems.push({ ...dstEntry, level: srcLevel });
            }
        }

        await SignatureLedger.setLedgerData(ledgerData);

        const srcName = ledgerData[srcActorId].name;
        const dstName = ledgerData[dstActorId].name;
        if (isSameChar) {
            ui.notifications.info(`Moved ${srcEntry.name} to Lv ${dstLevel} for ${srcName}.`);
        } else if (dstEntry) {
            ui.notifications.info(`Swapped ${srcEntry.name} ↔ ${dstEntry.name} between ${srcName} and ${dstName}.`);
        } else {
            ui.notifications.info(`Moved ${srcEntry.name} from ${srcName} → ${dstName} at Lv ${dstLevel}.`);
        }

        this.render();
    }

    async _onSeedSignatures(event) {
        event.preventDefault();
        const actorId = event.currentTarget.dataset.actorId;
        const actor   = game.actors.get(actorId);
        if (!actor) return;

        const banSet     = await SignatureLedger.getBanSet();
        const ledgerData = await SignatureLedger.getLedgerData();
        if (!ledgerData[actorId]) return;

        const existing = ledgerData[actorId].plannedItems || [];
        const BUDGET   = 4;

        if (existing.length >= BUDGET) {
            ui.notifications.warn(`${actor.name} already has ${BUDGET} signatures planned.`);
            return;
        }

        const usedLevels     = new Set(existing.map(p => p.level));
        const partyUsedNames = new Set();
        const myRole         = ProgressionSeeder._detectRole(actor);
        const partyAllocations = new Map();

        for (const [otherId, otherData] of Object.entries(ledgerData)) {
            if (otherId === actorId) continue;
            for (const item of (otherData.plannedItems || [])) {
                partyUsedNames.add(item.name.toLowerCase());
            }
            const otherActor = game.actors.get(otherId);
            if (!otherActor) continue;
            if (ProgressionSeeder._detectRole(otherActor) !== myRole) continue;
            for (const item of (otherData.plannedItems || [])) {
                if (item.source !== "auto") continue;
                if (!partyAllocations.has(item.level)) {
                    partyAllocations.set(item.level, item._category || null);
                }
            }
        }

        for (const item of existing) {
            partyUsedNames.add(item.name.toLowerCase());
        }

        const planned = await ProgressionSeeder.seedSignatures(actor, banSet, partyAllocations, partyUsedNames);

        const budgetLeft = BUDGET - existing.length;
        const newItems   = planned
            .filter(p => !usedLevels.has(p.level))
            .slice(0, Math.max(0, budgetLeft));
        ledgerData[actorId].plannedItems = [...existing, ...newItems];

        await SignatureLedger.setLedgerData(ledgerData);
        ui.notifications.info(`Filled ${newItems.length} empty slot(s) for ${actor.name}.`);
        this.render();
    }

    async _assignSignature(actorId, level, itemData) {
        const BUDGET = 4;
        const ledgerData = await SignatureLedger.getLedgerData();
        if (!ledgerData[actorId]) return;
        if (!ledgerData[actorId].plannedItems) ledgerData[actorId].plannedItems = [];

        const existing    = ledgerData[actorId].plannedItems;
        const occupant    = existing.find(i => i.level === level);
        if (occupant?.locked) return;
        const alreadyFilled = !!occupant;

        // Replacing an existing slot is always allowed (swap, not addition).
        // Adding to a full budget is blocked.
        if (!alreadyFilled && existing.length >= BUDGET) {
            ui.notifications.warn(
                `Signature budget full (${BUDGET} items). Clear a slot to assign a different one.`
            );
            return;
        }

        ledgerData[actorId].plannedItems = existing.filter(i => i.level !== level);
        ledgerData[actorId].plannedItems.push({ uuid: itemData.uuid, name: itemData.name, img: itemData.img, rarity: itemData.rarity || "uncommon", level, source: "manual" });
        await SignatureLedger.setLedgerData(ledgerData);
        this.render();
    }

    // ── Scroll Pinned Actions ──────────────────────────────────────────────────

    async _onRemoveScrollPin(event) {
        event.preventDefault();
        event.stopPropagation();
        const level = parseInt(event.currentTarget.dataset.level);
        const uuid  = event.currentTarget.dataset.uuid;
        const pinned = await SignatureLedger.getScrollPinned();
        const pin = pinned.find(p => p.level === level && p.uuid === uuid);
        if (pin?.locked) return;
        await SignatureLedger.setScrollPinned(
            pinned.filter(p => !(p.level === level && p.uuid === uuid))
        );
        this.render();
    }

    async _onToggleScrollDelivered(event) {
        event.preventDefault();
        event.stopPropagation();
        const level = parseInt(event.currentTarget.dataset.level);
        const uuid  = event.currentTarget.dataset.uuid;
        const pinned = await SignatureLedger.getScrollPinned();
        const pin = pinned.find(p => p.level === level && p.uuid === uuid);
        if (pin) {
            pin.delivered = !pin.delivered;
            await SignatureLedger.setScrollPinned(pinned);
            this.render();
        }
    }

    /** Opens the forged spell scroll compendium. */
    async _onOpenForgedScrolls(event) {
        event.preventDefault();
        const { ScrollForge } = await import("../services/ScrollForge.js");
        ScrollForge.openForgedPack();
    }

    /** Launches the Scroll Forge source-selection dialog, then re-renders. */
    async _onCompileScrollForge(event) {
        event.preventDefault();
        const { CompendiumForgeApp } = await import("./CompendiumForgeApp.js");
        const app = new CompendiumForgeApp({}, { activeTab: "scrollForge" });
        app.render(true);
        Hooks.once("closeCompendiumForgeApp", () => this.render());
    }

    // ── Party Shelf Actions ───────────────────────────────────────────────────

    async _onClickAddPartyItem(event) {
        event.preventDefault();
        const level  = parseInt(event.currentTarget.dataset.level);
        const chosen = await this._searchAndPick(`Plan Party Item for Level ${level}`);
        if (!chosen) return;

        const shelf = await SignatureLedger.getPartyShelf();
        shelf.push({ uuid: chosen.uuid, name: chosen.name, img: chosen.img, rarity: chosen.rarity || "uncommon", level, delivered: false });
        await SignatureLedger.setPartyShelf(shelf);
        this.render();
    }

    async _onRemovePartyItem(event) {
        event.preventDefault();
        event.stopPropagation();
        const level = parseInt(event.currentTarget.dataset.level);
        const uuid  = event.currentTarget.dataset.uuid;
        const shelf = await SignatureLedger.getPartyShelf();
        await SignatureLedger.setPartyShelf(
            shelf.filter(p => !(p.level === level && p.uuid === uuid))
        );
        this.render();
    }

    async _onToggleDelivered(event) {
        event.preventDefault();
        event.stopPropagation();
        const level = parseInt(event.currentTarget.dataset.level);
        const uuid  = event.currentTarget.dataset.uuid;
        const shelf = await SignatureLedger.getPartyShelf();
        const item  = shelf.find(p => p.level === level && p.uuid === uuid);
        if (item) {
            item.delivered = !item.delivered;
            await SignatureLedger.setPartyShelf(shelf);
            this.render();
        }
    }

    async _onSeedPartyShelf(event) {
        event.preventDefault();
        ui.notifications.info("Seeding party shelf…");

        const partyActors = SignatureLedger._resolvePartyMembers();
        const banSet      = await SignatureLedger.getBanSet();
        const existing    = await SignatureLedger.getPartyShelf();

        const kept = existing.filter(e => e.source !== "auto" || e.locked);
        const usedNames = new Set(kept.map(e => e.name.toLowerCase()));

        const seeded = await ProgressionSeeder.seedPartyShelf(partyActors, banSet);
        const fresh  = seeded.filter(s => !usedNames.has(s.name.toLowerCase()));

        if (!fresh.length && kept.length === existing.length) {
            ui.notifications.warn("No new items to suggest. All candidates are already on the shelf or banned.");
            return;
        }

        const CAP = 3;
        const merged = [...kept];
        for (const item of fresh) {
            const atLevel = merged.filter(p => p.level === item.level);
            if (atLevel.length >= CAP) continue;
            item.slotOrder = atLevel.length;
            merged.push(item);
        }
        await SignatureLedger.setPartyShelf(merged);
        const replaced = existing.length - kept.length;
        const added    = merged.length - kept.length;
        ui.notifications.info(`Randomised party shelf: ${added} suggestion(s)${replaced ? `, replaced ${replaced} previous` : ""}.`);
        this.render();
    }

    async _onCurateShelfSources(event) {
        event.preventDefault();
        const { CompendiumForgeApp } = await import("./CompendiumForgeApp.js");
        const app = new CompendiumForgeApp({}, { activeTab: "lootPool" });
        app.render(true);
        Hooks.once("closeCompendiumForgeApp", () => this.render());
    }

    // ── Cursed: Pool Management ─────────────────────────────────────────

    async _onLoadSrdCursedItems(event) {
        event.preventDefault();
        if (!game.user.isGM) return;
        // SRD items are superseded when Cursewright is loaded. Block silently so
        // any programmatic caller doesn't pollute the pool with obsolete items.
        if (game.ionrift?.cursewright) {
            ui.notifications.warn("Cursewright is active — use Compile CW to refresh the cursed pool. SRD items are not used when Cursewright is loaded.");
            return;
        }

        ui.notifications.info("Quartermaster: compiling SRD cursed items...");
        await getCurseAdapter().compile({ forceRecompile: true });

        const srdPack = game.packs.get(getCurseAdapter().worldCollectionId);
        if (!srdPack) {
            ui.notifications.warn("SRD cursed items could not be found. Check your D&D 5e system installation.");
            return;
        }

        let docs;
        try { docs = await srdPack.getDocuments(); }
        catch (e) { Logger.error(MODULE_LABEL, "_onLoadSrdCursedItems: could not read SRD pack", e); return; }

        // Strip any existing SRD items from the pool first.
        // Their UUIDs become stale after a recompile (compendium is destroyed + recreated).
        // Replacing is correct Refresh behaviour; non-SRD items are untouched.
        let pool = await getActiveCursedRegistry().getCursedPool();
        pool = pool.filter(p => !(p.uuid || "").includes("ionrift-srd-cursed"));
        const before = pool.length;

        for (const item of docs) {
            const meta = item.flags?.["ionrift-quartermaster"]?.cursedMeta ?? {};
            pool.push({
                uuid:      item.uuid,
                name:      item.name,
                img:       item.img || "icons/svg/item-bag.svg",
                curseType: meta.curseType || "",
                tier:      meta.tier ?? 1
            });
        }

        await getActiveCursedRegistry().setCursedPool(pool);
        Hooks.callAll(CURSED_POOL_DATA_HOOK);
        const added = pool.length - before;
        ui.notifications.info(`SRD cursed items refreshed: ${docs.length} item${docs.length !== 1 ? "s" : ""} in pool.`);
        this.render();
    }

    /**
     * "Load Cursewright" / "Refresh Cursewright" button.
     * Silently compiles from auto-detected dnd5e packs (no picker dialog)
     * then seeds the pool from the resulting world pack.
     */
    async _onRebuildCursedPool(event) {
        event.preventDefault();
        if (!game.user.isGM) return;

        const cw = game.ionrift?.cursewright;
        if (!cw) {
            // Fallback: if CW button somehow fires without CW, load SRD instead
            return this._onLoadSrdCursedItems(event);
        }

        // Silent compile - no dialog, auto-detected packs
        const { CurseForge } = await import(`/modules/ionrift-cursewright/scripts/services/CurseForge.js`);

        // If the world pack was deleted manually the CW hash setting is stale -
        // compile() will see "hash unchanged" and no-op, leaving the pack missing.
        // Detect this and clear the hash so compile() runs in full.
        const cwPackId = CurseForge.worldCollectionId;
        if (!game.packs.get(cwPackId)) {
            Logger.warn(MODULE_LABEL, "_onRebuildCursedPool: world pack missing - clearing hash to force recompile.");
            try { await game.settings.set("ionrift-cursewright", CurseForge.SETTING_HASH, ""); }
            catch (e) { /* setting may not exist yet - that's fine */ }
        }

        ui.notifications.info("Cursewright: compiling cursed items from D&D 5e sources...");
        await CurseForge.compile({ force: true });
        CurseForge.enforceOwnership();

        await this._seedPoolFromForgedPack();
        this.render();
    }

    /**
     * Imports every item from the Cursewright forged world pack into the pool.
     * Strip-then-replace: removes existing CW items (stale UUIDs after recompile)
     * then adds all fresh items from the newly compiled pack.
     */
    async _seedPoolFromForgedPack() {
        const cw = game.ionrift?.cursewright;
        const forgedPackId = cw?.forge?.worldCollectionId ?? "world.ionrift-cursewright-forged";
        const pack = game.packs.get(forgedPackId);
        if (!pack) {
            Logger.warn(MODULE_LABEL, "_seedPoolFromForgedPack: forged pack not found after compile.");
            return;
        }

        let docs;
        try {
            const all = await pack.getDocuments();
            // The forged pack now contains paired lure + identified-twin docs
            // for non-deceptive recipes. Twins are GM audit references only;
            // the pool must contain LURES exclusively.
            docs = all.filter(d => d.flags?.["ionrift-cursewright"]?.role !== "identified");
        }
        catch (e) { Logger.error(MODULE_LABEL, "_seedPoolFromForgedPack: could not read forged pack", e); return; }

        // Strip existing CW items - their UUIDs are invalidated when the pack is rebuilt.
        let pool = await getActiveCursedRegistry().getCursedPool();
        pool = pool.filter(p => !(p.uuid || "").includes("ionrift-cursewright-forged"));

        for (const item of docs) {
            const meta = item.flags?.["ionrift-quartermaster"]?.cursedMeta ?? {};
            pool.push({
                uuid:            item.uuid,
                name:            item.name,
                img:             item.img || "icons/svg/item-bag.svg",
                curseType:       meta.curseType       || "",
                decoyAppearance: meta.decoyAppearance || "",
                trueNature:      meta.trueNature      || "",
                tier:            meta.tier ?? 1
            });
        }

        await getActiveCursedRegistry().setCursedPool(pool);
        if (typeof getActiveCursedRegistry().rematchLedgerCursedUuids === "function") {
            await getActiveCursedRegistry().rematchLedgerCursedUuids(docs);
        }
        Hooks.callAll(CURSED_POOL_DATA_HOOK);
        ui.notifications.info(`Cursewright: ${docs.length} item${docs.length !== 1 ? "s" : ""} in pool.`);
    }

    // ── Cursed: Pool Actions ──────────────────────────────────────────────

    async _onRemovePoolItem(event) {
        event.preventDefault();
        // Use UUID for removal - data-index carries posInCol (a within-tier ordinal),
        // NOT a global pool array index. Splicing by posInCol would delete the wrong
        // item when tiers 1/2 have entries ahead of the target tier in the pool array.
        const uuid = event.currentTarget.dataset.uuid;
        if (!uuid) return;
        const pool = await getActiveCursedRegistry().getCursedPool();
        const next = pool.filter(e => (e.uuid || "") !== uuid);
        if (next.length === pool.length) return; // nothing matched - bail
        await getActiveCursedRegistry().setCursedPool(next);
        Hooks.callAll(CURSED_POOL_DATA_HOOK);
        this.render();
    }


    _initCardSearchFilter(html, { inputSelector, cardSelector, noMatchSelector, emptySelector }) {
        const input = html[0]?.querySelector(inputSelector);
        if (!input) return;

        /** Shared filter runner - called by both text input and type dropdown. */
        const runFilter = () => {
            const query = input.value.toLowerCase().trim();
            const typeSelect = html[0]?.querySelector(".cursed-pool-type-filter");
            const typeFilter = typeSelect?.value?.toLowerCase() || "";
            const cards = html[0].querySelectorAll(cardSelector);
            const noMatches = html[0].querySelector(noMatchSelector);
            const emptyState = html[0].querySelector(emptySelector);
            let visible = 0;

            cards.forEach(card => {
                const name = (card.dataset.name || "").toLowerCase();
                const type = (card.dataset.curseType || "").toLowerCase();
                const matchText = !query || name.includes(query);
                const matchType = !typeFilter || type === typeFilter;
                const show = matchText && matchType;
                card.style.display = show ? "" : "none";
                if (show) visible++;
            });

            const hasFilter = query || typeFilter;
            if (noMatches) noMatches.style.display = (hasFilter && visible === 0) ? "" : "none";
            if (emptyState) emptyState.style.display = (!hasFilter && cards.length === 0) ? "" : "none";
        };

        input.addEventListener("input", runFilter);
    }

    // ── Ban List Actions ──────────────────────────────────────────────────────

    async _onRemoveBan(event) {
        event.preventDefault();
        const idx  = parseInt(event.currentTarget.dataset.index);
        const list = await SignatureLedger.getBanList();
        list.splice(idx, 1);
        await SignatureLedger.setBanList(list);
        this.render();
    }

    /**
     * Wire dragover/dragleave visuals on the ban drop zone. The actual drop
     * is handled by Foundry's dragDrop config routing to _onDrop.
     */
    _initBanDropZoneVisuals(html) {
        const zone = html[0]?.querySelector(".ban-drop-zone");
        if (!zone) return;

        zone.addEventListener("dragover", ev => {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "copy";
            zone.classList.add("ban-drop-active");
        });
        zone.addEventListener("dragleave", ev => {
            if (!zone.contains(ev.relatedTarget)) zone.classList.remove("ban-drop-active");
        });
        zone.addEventListener("drop", () => {
            zone.classList.remove("ban-drop-active");
        });
    }

    // ── Shared: Search Compendiums ────────────────────────────────────────────

    async _searchAndPick(title, typeFilter = null) {
        const query = await new Promise(resolve => {
            new Dialog({
                title,
                content: `
                    <div style="margin-bottom:12px;">
                        <input type="text" id="sig-item-search" placeholder="Search items…"
                               style="width:100%;padding:6px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.2);color:#eee;border-radius:4px;" />
                    </div>
                `,
                buttons: {
                    search: { icon: '<i class="fas fa-search"></i>', label: "Search", callback: html => resolve(html.find("#sig-item-search").val()) },
                    cancel: { icon: '<i class="fas fa-times"></i>',  label: "Cancel", callback: () => resolve(null) }
                },
                default: "search",
                render: html => setTimeout(() => html.find("#sig-item-search").focus(), 50)
            }, { classes: ["ionrift-window", "glass-ui"], width: 400 }).render(true);
        });

        if (!query?.trim()) return null;
        const results = await this._searchCompendiums(query.trim(), typeFilter);
        if (!results.length) { ui.notifications.warn(`No items found matching "${query}".`); return null; }
        return this._showResultsPicker(results, title);
    }

    async _searchCompendiums(query, typeFilter = null) {
        const results   = [];
        const lowerQ    = query.toLowerCase();

        for (const pack of game.packs) {
            if (pack.documentName !== "Item") continue;
            const index = await pack.getIndex({ fields: ["system.rarity", "system.level", "type", "img"] });
            for (const entry of index) {
                if (!entry.name.toLowerCase().includes(lowerQ)) continue;
                if (typeFilter && entry.type !== typeFilter) continue;
                results.push({
                    uuid:       `Compendium.${pack.collection}.Item.${entry._id}`,
                    name:       entry.name,
                    img:        entry.img || "icons/svg/item-bag.svg",
                    rarity:     entry.system?.rarity || "common",
                    spellLevel: entry.system?.level  || null,
                    pack:       pack.metadata.label,
                    type:       entry.type
                });
                if (results.length >= 20) break;
            }
            if (results.length >= 20) break;
        }

        // World items
        for (const item of game.items) {
            if (!item.name.toLowerCase().includes(lowerQ)) continue;
            if (typeFilter && item.type !== typeFilter) continue;
            results.push({ uuid: item.uuid, name: item.name, img: item.img, rarity: item.system?.rarity || "common", pack: "World Items", type: item.type });
        }

        return results.slice(0, 20);
    }

    async _showResultsPicker(results, title) {
        return new Promise(resolve => {
            const listHtml = results.map((r, i) => `
                <div class="sig-result-row" data-index="${i}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.05);transition:background 0.15s;">
                    <img src="${r.img}" style="width:28px;height:28px;border-radius:3px;border:1px solid rgba(255,255,255,0.15);" />
                    <div style="flex:1;overflow:hidden;">
                        <div style="font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.name}</div>
                        <div style="font-size:0.8em;color:rgba(255,255,255,0.4);">${r.pack} &middot; ${r.type}${r.spellLevel ? ` &middot; Lv${r.spellLevel}` : ""}</div>
                    </div>
                </div>
            `).join("");

            new Dialog({
                title,
                content: `<div style="max-height:350px;overflow-y:auto;margin-bottom:10px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:rgba(0,0,0,0.2);">${listHtml}</div>`,
                buttons: { cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel", callback: () => resolve(null) } },
                default: "cancel",
                render: html => {
                    html.find(".sig-result-row")
                        .hover(function() { $(this).css("background", "rgba(255,255,255,0.08)"); },
                               function() { $(this).css("background", "transparent"); })
                        .on("click", function() {
                            resolve(results[parseInt(this.dataset.index)]);
                            html.closest(".app").find(".header-button.close").click();
                        });
                }
            }, { classes: ["ionrift-window", "glass-ui"], width: 420, height: "auto" }).render(true);
        });
    }

    // ── Drag-Drop (item compendium drag onto slots) ───────────────────────────

    async _onDrop(event) {
        // ── Guard: internal sig-slot-move is handled entirely in _initSignatureDragDrop.
        // If stopPropagation worked, this won't fire. Belt-and-suspenders check:
        try {
            const raw = event.dataTransfer.getData("text/plain");
            if (raw) {
                const peek = JSON.parse(raw);
                if (peek?.type === "sig-slot-move") return;
                if (peek?.type === "scroll-pinned-move") return;
                if (peek?.type === "party-slot-move") return;
            }
        } catch { /* not our payload */ }

        const data = TextEditor.getDragEventData(event);
        if (!data || data.type !== "Item" || !data.uuid) return;

        // ── Ban list drop zone ──────────────────────────────────
        const banZone = event.target.closest(".ban-drop-zone");
        if (banZone) {
            const item = await fromUuid(data.uuid);
            if (!item) return;
            const list = await SignatureLedger.getBanList();
            const key = data.uuid.toLowerCase();
            if (list.some(b => (b.uuid || "").toLowerCase() === key) ||
                list.some(b => b.name.toLowerCase() === item.name.toLowerCase())) {
                ui.notifications.warn(`"${item.name}" is already on the ban list.`);
                return;
            }
            list.push({ name: item.name, img: item.img || null, uuid: data.uuid, reason: "" });
            await SignatureLedger.setBanList(list);
            ui.notifications.info(`"${item.name}" added to the ban list.`);
            this.render();
            return;
        }

        // Identify which slot was dropped on (fall back to nearest column if cursor hit the strip gap)
        let slotEl = event.target.closest(".grid-slot");
        if (!slotEl) {
            const strip = event.target.closest(".sig-slots-strip");
            if (strip) slotEl = SignatureLedgerApp._nearestSlot(strip, event.clientX, event.clientY);
        }
        if (!slotEl) {
            const cursedStrip = event.target.closest(".cursed-slots-strip");
            if (cursedStrip) {
                slotEl = SignatureLedgerApp._nearestCursedSlot(cursedStrip, event.clientX, event.clientY);
            }
        }
        if (!slotEl) {
            const scrollStrip = event.target.closest(".scroll-slots-strip");
            if (scrollStrip) {
                slotEl = SignatureLedgerApp._nearestCursedSlot(scrollStrip, event.clientX, event.clientY);
            }
        }
        if (!slotEl) {
            const partyStrip = event.target.closest(".party-slots-strip");
            if (partyStrip) {
                slotEl = SignatureLedgerApp._nearestCursedSlot(partyStrip, event.clientX, event.clientY);
            }
        }
        if (!slotEl) return;

        // Refuse drops onto budget-exhausted empty slots (filled slots always accept replacements)
        if (slotEl.classList.contains("slot-disabled") && !slotEl.classList.contains("slot-filled")) return;

        const isParty    = slotEl.classList.contains("party-slot");
        const isScroll   = slotEl.classList.contains("scroll-slot");
        const actorId    = slotEl.dataset.actorId;
        const level      = parseInt(slotEl.dataset.level);
        if (isNaN(level)) return;

        const item = await fromUuid(data.uuid);
        if (!item) return;

        const base = { uuid: data.uuid, name: item.name, img: item.img, rarity: item.system?.rarity || "uncommon" };

        if (isParty) {
            const shelf = await SignatureLedger.getPartyShelf();
            const slotIdx = parseInt(slotEl.dataset.slotIdx || "0", 10);
            const occupant = shelf.find(p => p.level === level && (p.slotOrder ?? 0) === slotIdx);
            const next = occupant
                ? shelf.filter(p => !(p.level === level && (p.slotOrder ?? 0) === slotIdx))
                : [...shelf];
            next.push({ ...base, level, slotOrder: slotIdx, delivered: false });
            await SignatureLedger.setPartyShelf(next);
        } else if (isScroll) {
            if (slotEl.classList.contains("slot-locked")) return;
            const pinned = await SignatureLedger.getScrollPinned();
            const nameKey = (item.name || "").toLowerCase();
            if (pinned.some(s => (s.spellName || "").toLowerCase() === nameKey)) {
                ui.notifications.warn(`${item.name} is already pinned in the Scroll Plan.`);
                return;
            }
            const slotIdx = Math.min(2, Math.max(0, parseInt(slotEl.dataset.slotIdx || "0", 10)));
            const newEntry = {
                uuid:       data.uuid,
                spellName:  item.name,
                spellLevel: item.system?.level ?? 1,
                img:        item.img,
                source:     "drag",
                school:     item.system?.school || "",
                level,
                slotOrder:  slotIdx,
                delivered:  false,
                locked:     false
            };
            const merged = SignatureLedgerApp._mergeScrollPinnedSlot(pinned, level, slotIdx, newEntry);
            await SignatureLedger.setScrollPinned(merged);
        } else if (actorId) {
            await this._assignSignature(actorId, level, base);
            return; // _assignSignature calls render()
        }

        this.render();
    }
}

// ── Tooltip Engine ──────────────────────────────────────────────────────────
// Appended outside the class to keep it a module-level utility block
// but scoped to SignatureLedgerApp via assignment on the prototype.

const LEDGER_ITEM_TOOLTIP_DELAY_MS = 220;

/** Queue the hover card for a uuid-bearing anchor (shared by hover and post-drag restore). */
SignatureLedgerApp.prototype._queueLedgerItemTooltip = function(anchorEl) {
    if (!anchorEl?.dataset?.uuid) return;
    if (anchorEl.classList.contains("grid-slot") && this._sigDragActorId) return;
    if (anchorEl.classList.contains("curse-priority-card") && this._cursedDragType) return;

    clearTimeout(this._tooltipTimer);
    this._tooltipTimer = setTimeout(async () => {
        const uuid = anchorEl.dataset.uuid;
        if (!uuid) return;

        let item = this._tooltipCache.get(uuid);
        if (!item) {
            try { item = await fromUuid(uuid); } catch { /* compendium may not be loaded */ }
            if (item) this._tooltipCache.set(uuid, item);
        }

        if (!item && anchorEl.classList.contains("curse-priority-card")) {
            const imgEl = anchorEl.querySelector(".slot-item-img, .curse-priority-card-img");
            item = {
                name:   anchorEl.dataset.name || "Cursed Item",
                img:    imgEl?.src || "",
                type:   "equipment",
                system: { rarity: "uncommon", description: { value: "" } },
                _cursedFallback: true
            };
        }
        if (!item) return;

        this._showItemTooltip(item, anchorEl);
    }, LEDGER_ITEM_TOOLTIP_DELAY_MS);
};

/**
 * After a drag ends, the browser may not emit mouseenter on the
 * slot under the pointer. Re-resolve from the drop/release coordinates.
 */
SignatureLedgerApp.prototype._tryRestoreTooltipAfterDrag = function(clientX, clientY, selector) {
    if (clientX === null || clientX === undefined || clientY === null || clientY === undefined) return;
    const under  = document.elementFromPoint(clientX, clientY);
    const anchor = under?.closest?.(selector);
    if (!anchor) return;
    this._queueLedgerItemTooltip(anchor);
};

SignatureLedgerApp.prototype._initTooltipListeners = function(html) {
    const repositionFromAnchor = () => {
        if (this._tooltipEl && this._tooltipAnchorEl) {
            this._positionTooltip(this._tooltipAnchorEl);
        }
    };

    // Slots: open the hover card from the portrait only so corner controls stay
    // unobstructed (native title tips and hit testing no longer compete with lock).
    html.find(".grid-slot.slot-filled[data-uuid]").each((_, slot) => {
        const img = slot.querySelector(".slot-item-img");
        if (img) {
            img.addEventListener("mouseenter", () => {
                this._queueLedgerItemTooltip(slot);
            });
        }
        slot.addEventListener("mouseleave", (ev) => {
            if (slot.contains(ev.relatedTarget)) return;
            clearTimeout(this._tooltipTimer);
            this._tooltipAnchorEl = null;
            this._hideItemTooltip();
        });
    });

    const otherHover = [
        ".party-item-row[title]",
        ".scroll-drag-item[data-uuid]",
        ".curse-priority-card[data-uuid]"
    ].join(", ");

    html.find(otherHover).each((_, el) => {
        el.addEventListener("mouseenter", () => {
            this._queueLedgerItemTooltip(el);
        });

        el.addEventListener("mouseleave", () => {
            clearTimeout(this._tooltipTimer);
            this._tooltipAnchorEl = null;
            this._hideItemTooltip();
        });
    });

    html.find(".ledger-scroll-area").each((_, scrollEl) => {
        scrollEl.addEventListener("scroll", repositionFromAnchor, { passive: true });
    });
};

SignatureLedgerApp.prototype._showItemTooltip = function(item, anchorEl) {
    this._hideItemTooltip();

    const rarity      = item.system?.rarity || "common";
    const type        = item.type || "";
    const subtype     = item.system?.type?.value || "";
    const attunement  = item.system?.attunement > 0;
    const rawDesc     = item.system?.description?.value || "";
    let   desc        = this._stripHtml(rawDesc).slice(0, 300).trim();

    // DnD5e SRD artefact: descriptions often open with the item type as a label
    // ("Wand. This wand has..." -> after HTML strip -> "Wand This wand...")
    // Strip the leading word if it matches the subtype or the item name's first word.
    const firstWord   = desc.split(/[\s.]/)[0]?.toLowerCase();
    const matchWords  = [subtype, type, item.name.split(" ")[0]]
        .filter(Boolean).map(w => w.toLowerCase());
    if (firstWord && matchWords.includes(firstWord)) {
        desc = desc.replace(/^\S+[\s.]+/, "").trim();
    }
    desc = desc.slice(0, 240);

    const rarityLabel = rarity === "veryRare" ? "Very Rare" : (rarity.charAt(0).toUpperCase() + rarity.slice(1));

    const isCursed   = anchorEl?.classList?.contains("curse-priority-card");
    const curseType  = anchorEl?.dataset?.curseType || "";
    const curseLabel = curseType && curseType !== "unknown"
        ? curseType.charAt(0).toUpperCase() + curseType.slice(1) : "";
    const isFallback = !!item._cursedFallback;

    // Enriched cursed context: tier badge + type description + detection hints
    let cursedEnrichment = "";
    if (isCursed) {
        const cursedMeta = item.flags?.["ionrift-quartermaster"]?.cursedMeta || item.flags?.cursedMeta || null;
        const tier = cursedMeta?.tier ?? (anchorEl?.dataset?.tier ? Number(anchorEl.dataset.tier) : null);
        const ctKey = (curseType || "").toLowerCase();
        const typeDesc = CURSE_TYPE_DESCRIPTIONS[ctKey] || "";
        const hints = cursedMeta?.detection?.hints;

        const tierColors = { 1: "#6ee7b7", 2: "#60a5fa", 3: "#c084fc", 4: "#f87171" };
        const tierBadge = tier
            ? `<span class="sig-tooltip-tier-badge" style="color:${tierColors[tier] || "#ccc"}; border-color:${tierColors[tier] || "#555"};">T${tier}</span>`
            : "";

        const typeDescHtml = typeDesc
            ? `<div class="sig-tooltip-curse-desc">${typeDesc}</div>`
            : "";

        const hintHtml = Array.isArray(hints) && hints.length
            ? `<div class="sig-tooltip-curse-hints"><i class="fas fa-eye" aria-hidden="true"></i> ${hints[0]}</div>`
            : "";

        cursedEnrichment = `${tierBadge}${typeDescHtml}${hintHtml}`;
    }

    const el = document.createElement("div");
    el.className = "sig-tooltip" + (isCursed ? " sig-tooltip-cursed" : "");
    el.innerHTML = `
        <div class="sig-tooltip-accent ${isCursed ? "cursed" : rarity}"></div>
        <div class="sig-tooltip-body">
            <div class="sig-tooltip-name">${item.name}</div>
            <div class="sig-tooltip-meta">
                ${isCursed && curseLabel ? `<span class="sig-tooltip-curse-type">${curseLabel}</span>` : ""}
                <span class="sig-tooltip-rarity ${rarity}">${rarityLabel}</span>
                ${type && !isFallback ? `<span class="sig-tooltip-type">${subtype || type}</span>` : ""}
                ${attunement ? `<span class="sig-tooltip-attunement">Requires Attunement</span>` : ""}
            </div>
            ${cursedEnrichment}
            ${desc ? `<div class="sig-tooltip-desc">${desc}</div>` : ""}
            <div class="sig-tooltip-hint">${isFallback ? "Compendium item" : "Click to open sheet"}</div>
        </div>
    `;

    document.body.appendChild(el);
    this._tooltipEl = el;
    this._tooltipAnchorEl = anchorEl;
    this._positionTooltip(anchorEl);
};

/**
 * Place the hover card beside the anchor element (signature slot, party row, etc.),
 * not at the cursor. Prefers the right edge; falls back to the left, then clamps to the viewport.
 */
SignatureLedgerApp.prototype._positionTooltip = function(anchorEl) {
    if (!this._tooltipEl || !anchorEl?.getBoundingClientRect) return;

    const PAD = 8;
    const GAP = 8;

    const anchor = anchorEl.getBoundingClientRect();
    let tip = this._tooltipEl.getBoundingClientRect();

    let left = anchor.right + GAP;
    let top  = anchor.top;

    if (left + tip.width > window.innerWidth - PAD) {
        left = anchor.left - tip.width - GAP;
    }
    if (left < PAD) {
        left = PAD;
    }
    if (left + tip.width > window.innerWidth - PAD) {
        left = Math.max(PAD, window.innerWidth - tip.width - PAD);
    }

    if (top + tip.height > window.innerHeight - PAD) {
        top = window.innerHeight - tip.height - PAD;
    }
    if (top < PAD) {
        top = PAD;
    }

    this._tooltipEl.style.left = `${left}px`;
    this._tooltipEl.style.top  = `${top}px`;
};

SignatureLedgerApp.prototype._hideItemTooltip = function() {
    if (this._tooltipTimer !== null && this._tooltipTimer !== undefined) {
        clearTimeout(this._tooltipTimer);
        this._tooltipTimer = null;
    }
    if (this._tooltipEl) {
        this._tooltipEl.remove();
        this._tooltipEl = null;
    }
    this._tooltipAnchorEl = null;
};

SignatureLedgerApp.prototype._stripHtml = function(html) {
    // Remove Foundry enricher syntax before parsing - they appear as @UUID[...]{label} or @Compendium[...]
    const noEnrichers = html
        .replace(/@(?:UUID|Compendium|Actor|Item|Scene|RollTable|JournalEntry|Macro)\[[^\]]*\]\{([^}]*)\}/g, "$1")
        .replace(/@(?:UUID|Compendium|Actor|Item|Scene|RollTable|JournalEntry|Macro)\[[^\]]*\]/g, "");

    const tmp = document.createElement("div");
    tmp.innerHTML = noEnrichers;
    return (tmp.textContent || tmp.innerText || "").replace(/\s+/g, " ").trim();
};
