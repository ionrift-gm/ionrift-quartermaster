import { SignatureLedger } from "./SignatureLedger.js";

/**
 * ProgressionAdvisor
 *
 * Reads Progression Registry data and produces advisory lists
 * for a given cache tier. Pure computation, no rendering.
 *
 * Tier level cap mapping:
 *   T1 = 4, T2 = 10, T3 = 16, T4 = 20
 *
 * Return shape:
 * {
 *   hasAny:        boolean,
 *   partyLevelAvg: number,
 *   powerBalance:  [{ actorId, actorName, actorImg, compositeScore, powerNeed, schedulePressure, alternatives[] }],
 *   partyShelf:    [{ uuid, name, img, level, isPlanned, isRipe, alternatives[] }],
 *   scrolls:       [{ uuid, spellName, spellLevel, level, img, canInject }],
 * }
 */
export class ProgressionAdvisor {

    /** Cards visible at once in the Loot Cache Generator Signatures strip. */
    static VISIBLE_SIGNATURE_CARD_CAP = 2;

    // Composite score tolerance: characters within this band are shuffled randomly
    static SCORE_TOLERANCE = 0.05;

    static TIER_LEVEL_CAP = { 1: 4, 2: 10, 3: 16, 4: 20 };

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Compute advisory suggestions for the given cache tier.
     * @param {number} tier          1‒4
     * @param {object} cacheResult   The current _currentResult from CacheGeneratorApp
     * @returns {Promise<object>}
     */
    static async advise(tier, cacheResult) {
        const levelCap      = this.TIER_LEVEL_CAP[tier] ?? 10;
        const partyLevelAvg = this._getPartyLevelAvg();
        const banSet        = await SignatureLedger.getBanSet();

        const [ledger, shelf, scrollPlan] = await Promise.all([
            SignatureLedger.getLedgerData(),
            SignatureLedger.getPartyShelf(),
            SignatureLedger.getScrollPlan()
        ]);

        const powerBalance = this._buildPowerBalance(ledger, levelCap, banSet, partyLevelAvg);
        const partyShelf   = this._buildPartyShelf(shelf, levelCap, banSet, partyLevelAvg);
        const scrolls      = this._buildScrolls(scrollPlan, levelCap, cacheResult, banSet, partyLevelAvg);

        return {
            hasAny:       powerBalance.length > 0 || partyShelf.length > 0 || scrolls.length > 0,
            partyLevelAvg,
            powerBalance,
            partyShelf,
            scrolls,
            levelCap
        };
    }

    /** Average level of active party members, or 1 if none found. */
    static _getPartyLevelAvg() {
        const SA      = game.ionrift?.library?.system;
        const members = game.ionrift?.library?.party?.getMembers()
            ?? game.actors?.filter(a => a.hasPlayerOwner && a.type === "character")
            ?? [];
        if (!members.length) return 1;
        const levels  = members.map(a => SA?.getLevel(a) ?? 1);
        return levels.reduce((s, v) => s + v, 0) / levels.length;
    }

    // ── Signature Priority (Power + Schedule composite) ────────────────────────

    static _buildPowerBalance(ledger, levelCap, banSet, partyLevelAvg = 1) {
        const candidates = [];
        const SA = game.ionrift?.library?.system;

        for (const [id, data] of Object.entries(ledger)) {
            const actor = game.actors?.get(id);
            if (!actor) continue;

            const level = SA?.getLevel(actor) ?? 1;
            const powerScore = SignatureLedger.computePowerScore(actor);

            const plannedFiltered = (data.plannedItems ?? [])
                .filter(p => p.level <= levelCap && !p.delivered && !banSet.has((p.name ?? "").toLowerCase()));

            if (!plannedFiltered.length) continue;

            const planned = this.sortRipeFirstThenLevelDesc(plannedFiltered, partyLevelAvg);
            const earliestPlannedLevel = Math.min(...planned.map(p => p.level));

            candidates.push({
                actorId:            id,
                actorName:          data.name ?? actor.name,
                actorImg:           actor.img,
                level,
                powerScore,
                earliestPlannedLevel,
                alternatives:       planned
            });
        }

        if (!candidates.length) return [];

        const avgPower = candidates.reduce((s, c) => s + c.powerScore, 0) / candidates.length;

        for (const c of candidates) {
            c.powerNeed       = avgPower > 0 ? (avgPower - c.powerScore) / avgPower : 0;
            c.schedulePressure = levelCap > 0 ? (levelCap - c.earliestPlannedLevel) / levelCap : 0;
            c.compositeScore  = c.powerNeed + c.schedulePressure;
        }

        candidates.sort((a, b) => b.compositeScore - a.compositeScore);

        const ordered = this._applyToleranceShuffle(candidates, this.SCORE_TOLERANCE);
        // Full ranked pool: UI picks the first N cards that still have a visible pin
        // (CacheGeneratorApp), so exhausted actors do not block lower-priority ones.
        return ordered;
    }

    // ── Tolerance Grouping + Shuffle ─────────────────────────────────────────

    /**
     * Groups entries whose compositeScore falls within `tolerance` of the
     * group leader, then shuffles within each group. Preserves inter-group
     * ordering (highest-scoring group first).
     */
    static _applyToleranceShuffle(sorted, tolerance) {
        if (sorted.length <= 1) return sorted;

        const groups = [];
        let group = [sorted[0]];

        for (let i = 1; i < sorted.length; i++) {
            if (group[0].compositeScore - sorted[i].compositeScore <= tolerance) {
                group.push(sorted[i]);
            } else {
                groups.push(group);
                group = [sorted[i]];
            }
        }
        groups.push(group);

        return groups.flatMap(g => this._shuffleArray(g));
    }

    static _shuffleArray(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    /**
     * Ripe (party reached gate level) first, then higher gate level first.
     * Uses `isRipe` when set; otherwise derives from `level` and `partyLevelAvg`.
     * @param {object[]} entries
     * @param {number} partyLevelAvg
     * @returns {object[]}
     */
    static sortRipeFirstThenLevelDesc(entries, partyLevelAvg) {
        const ripeRank = (e) => {
            if (e?.isRipe === true) return 1;
            if (e?.isRipe === false) return 0;
            return (Number(e?.level) || 99) <= partyLevelAvg ? 1 : 0;
        };
        return [...entries].sort((a, b) => {
            const diff = ripeRank(b) - ripeRank(a);
            if (diff !== 0) return diff;
            return (Number(b?.level) || 0) - (Number(a?.level) || 0);
        });
    }

    // ── Party Shelf ───────────────────────────────────────────────────────────

    static _buildPartyShelf(shelf, levelCap, banSet, partyLevelAvg = 1) {
        // Undelivered items whose gate level <= tier cap
        const viable = shelf.filter(p =>
            p.level <= levelCap &&
            !p.delivered &&
            !banSet.has((p.name ?? "").toLowerCase())
        );
        const ordered = this.sortRipeFirstThenLevelDesc(viable, partyLevelAvg);

        if (!ordered.length) return [];

        return ordered.map(item => ({
            ...item,
            isPlanned: true,
            isRipe:    (item.level ?? 99) <= partyLevelAvg,
            alternatives: viable
        }));
    }

    // ── Scrolls ───────────────────────────────────────────────────────────────

    static _buildScrolls(scrollPlan, levelCap, cacheResult, banSet, partyLevelAvg = 1) {
        const alreadyInCache = new Set(
            (cacheResult?.items ?? [])
                .filter(i => i.spellName)
                .map(i => (i.spellName ?? "").toLowerCase())
        );

        const filtered = scrollPlan.filter(s =>
            s.level <= levelCap &&
            !alreadyInCache.has((s.spellName ?? "").toLowerCase()) &&
            !banSet.has((s.spellName ?? "").toLowerCase())
        );
        const ordered = this.sortRipeFirstThenLevelDesc(filtered, partyLevelAvg);

        return ordered.map(s => ({
            ...s,
            canInject: !!s.uuid // can only inject if we have a UUID
        }));
    }
}
