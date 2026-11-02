import { SignatureLedger } from "../../services/progression/SignatureLedger.js";
import { ProgressionSeeder }  from "../../services/progression/ProgressionSeeder.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { getCurseAdapter } from "../../services/curse/getCurseAdapter.js";
import { StandalonePoolRegistry, getActiveCursedRegistry } from "../../services/loot/StandalonePoolRegistry.js";
import { CursedSourcesApp, CURSED_POOL_DATA_HOOK } from "../forge/CursedSourcesApp.js";
import { CursedItemResolver } from "../../services/curse/CursedItemResolver.js";
import { LootGenerationConfigApp } from "../config/loot/LootGenerationConfigApp.js";
import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";

/** Always read fresh so profile changes take effect without reload. */
export function MILESTONES() { return SignatureLedger.MILESTONES; }

/** Canonical curse type descriptions for UI tooltips and filter labels. */
export const CURSE_TYPE_DESCRIPTIONS = {
    get compulsion()    { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.compulsion"); },
    get psychological() { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.psychological"); },
    get physical()      { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.physical"); },
    get interference()  { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.interference"); },
    get narrative()     { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.narrative"); },
    get deceptive()     { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.deceptive"); },
    get haunting()      { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.haunting"); },
    get behavioral()    { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.compulsion"); },
    get surveillance()  { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.narrative"); },
    get social()        { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.social"); },
    get political()     { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.political"); },
    get practical()     { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.interference"); },
    get aging()         { return game.i18n.localize("ionrift-quartermaster.ledger.curseType.physical"); }
};

/** @returns {string|undefined} Pack ID for the cursed items compendium (CW or fallback). */
/** Active pool registry: CurseRegistry when Cursewright is installed, else QM settings. */


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


export class SignatureLedgerViewModelMethods {
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
        const partyLevel = (this.constructor?._partyMedianLevel ? this.constructor : this)._partyMedianLevel(partyActors);

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

    static _removeScrollPin(pinned, level, uuid) {
        return pinned.filter(p => !(p.level === level && p.uuid === uuid));
    }


    /** Move or swap pinned scroll between slots (same or different milestone). */
    async _swapOrMoveScrollPinned(fromLevel, fromUuid, toLevel, toSlotIdx) {
        const pinned = await SignatureLedger.getScrollPinned();
        const pin = pinned.find(p => p.level === fromLevel && p.uuid === fromUuid);
        if (!pin || pin.locked) return;

        const fromSlotIdx = Math.min(2, Math.max(0, Number(pin.slotOrder) || 0));
        const toIdx       = Math.min(2, Math.max(0, toSlotIdx));
        if (fromLevel === toLevel && fromSlotIdx === toIdx) return;

        const destOcc = (this.constructor?._partyMedianLevel ? this.constructor : this)._slotOccupant(pinned, toLevel, toIdx, 3);
        if (destOcc?.locked) return;

        if (!destOcc || destOcc.uuid === pin.uuid) {
            const merged = (this.constructor?._partyMedianLevel ? this.constructor : this)._mergeSlot(
                (this.constructor?._partyMedianLevel ? this.constructor : this)._removeScrollPin(pinned, fromLevel, fromUuid),
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
        const step = (this.constructor?._partyMedianLevel ? this.constructor : this)._mergeSlot(rest, toLevel, toIdx, 3, {
            ...pin, level: toLevel, delivered: !!pin.delivered
        });
        const merged = (this.constructor?._partyMedianLevel ? this.constructor : this)._mergeSlot(step, fromLevel, fromSlotIdx, 3, {
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
        const partyLevel = (this.constructor?._partyMedianLevel ? this.constructor : this)._partyMedianLevel(partyActors);

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
        const shelf = await SignatureLedger.getPartyShelf();
        const pin = shelf.find(p => p.level === fromLevel && p.uuid === fromUuid);
        if (!pin) return;

        const fromSlotIdx = Math.min(2, Math.max(0, Number(pin.slotOrder) || 0));
        const toIdx       = Math.min(2, Math.max(0, toSlotIdx));
        if (fromLevel === toLevel && fromSlotIdx === toIdx) return;

        const destOcc = (this.constructor?._partyMedianLevel ? this.constructor : this)._slotOccupant(shelf, toLevel, toIdx, 3);

        if (!destOcc || destOcc.uuid === pin.uuid) {
            const merged = (this.constructor?._partyMedianLevel ? this.constructor : this)._mergeSlot(
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
        const step = (this.constructor?._partyMedianLevel ? this.constructor : this)._mergeSlot(rest, toLevel, toIdx, 3, { ...pin });
        const merged = (this.constructor?._partyMedianLevel ? this.constructor : this)._mergeSlot(step, fromLevel, fromSlotIdx, 3, { ...destOcc });
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
            { rarity: "uncommon", get label() { return game.i18n.localize("ionrift-quartermaster.ledger.rarity.uncommon"); }, base: 6, cssClass: "rarity-uncommon" },
            { rarity: "rare",     get label() { return game.i18n.localize("ionrift-quartermaster.ledger.rarity.rare"); },     base: 3, cssClass: "rarity-rare" },
            { rarity: "veryRare", get label() { return game.i18n.localize("ionrift-quartermaster.ledger.rarity.veryRare"); }, base: 1, cssClass: "rarity-veryRare" }
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
            wondrous: { get label() { return game.i18n.localize("ionrift-quartermaster.ledger.category.wondrous"); }, cssClass: "cat-wondrous" },
            focus:    { get label() { return game.i18n.localize("ionrift-quartermaster.ledger.category.focus"); },    cssClass: "cat-focus" },
            armor:    { get label() { return game.i18n.localize("ionrift-quartermaster.ledger.category.armor"); },    cssClass: "cat-armor" },
            weapon:   { get label() { return game.i18n.localize("ionrift-quartermaster.ledger.category.weapon"); },   cssClass: "cat-weapon" }
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
                        weightTooltip: game.i18n.format("ionrift-quartermaster.ledger.curseWeightTooltip", { tier: col.tier, weight: weightPct })
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

}

export function applySignatureLedgerViewModelMethods(TargetClass) {
    for (const key of Object.getOwnPropertyNames(SignatureLedgerViewModelMethods.prototype)) {
        if (key === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(SignatureLedgerViewModelMethods.prototype, key);
        if (desc) Object.defineProperty(TargetClass.prototype, key, desc);
    }
    for (const key of Object.getOwnPropertyNames(SignatureLedgerViewModelMethods)) {
        if (key === "length" || key === "name" || key === "prototype") continue;
        const desc = Object.getOwnPropertyDescriptor(SignatureLedgerViewModelMethods, key);
        if (desc) Object.defineProperty(TargetClass, key, desc);
    }
}
