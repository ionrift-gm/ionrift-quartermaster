import { MODULE_ID } from "../../data/moduleId.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";

export class SignatureLedger {

    static get LEDGER_NAME() { return "Ionrift: Signature Ledger"; }

    static get PROFILES() {
        return {
            full:     { label: "Full Campaign (1\u201320)",   milestones: [3, 5, 8, 12, 16, 20] },
            tier2:    { label: "Tier 2 Campaign (1\u201312)", milestones: [2, 4, 6, 8, 10, 12] },
            tier3:    { label: "Tier 3 Campaign (1\u201316)", milestones: [3, 5, 8, 11, 14, 16] },
            chapter1: { label: "Chapter 1 (1\u201310)",       milestones: [2, 3, 5, 7, 8, 10] },
            chapter2: { label: "Chapter 2 (11\u201320)",      milestones: [11, 13, 15, 17, 18, 20] },
        };
    }

    static get MILESTONES() {
        const key = game.settings?.get?.(MODULE_ID, "milestoneProfile") ?? "full";
        return (this.PROFILES[key] ?? this.PROFILES.full).milestones;
    }

    static get POWER_WEIGHTS() {
        return {
            rarity: { common: 1, uncommon: 3, rare: 8, veryRare: 15, legendary: 25, artifact: 40 },
            attunement: 1.5,
            charges: 0.3,
            flatBonus: 2.0
        };
    }

    /** Item types eligible for power-score computation (persistent gear, not consumables). */
    static get POWER_ITEM_TYPES() {
        return new Set(["weapon", "equipment", "tool", "container"]);
    }

    // ── Party Resolution ──────────────────────────────────────────────────────

    /**
     * Resolve the active party members via the library kernel.
     * Delegates to game.ionrift.library.party.getMembers() which respects
     * the GM-curated roster (or falls back to all player-owned characters).
     * @returns {Actor[]}
     */
    static _resolvePartyMembers() {
        const libParty = game.ionrift?.library?.party;
        if (libParty) return libParty.getMembers();
        // Defensive fallback - should not reach here since QM requires library ≥ 2.0.0
        return game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
    }

    // ── Journal Entry Access ──────────────────────────────────────────────────

    static async getOrCreateLedger() {
        let entry = game.journal.find(j => j.getFlag(MODULE_ID, "isLedger"));
        if (!entry) {
            entry = await JournalEntry.create({
                name: this.LEDGER_NAME,
                ownership: { default: 0 },
                flags: {
                    [MODULE_ID]: {
                        isLedger: true,
                        characters:  {},
                        scrollPlan:  {},
                        partyShelf:  [],
                        banList:     [],
                        lastSignatureTimestamp: 0
                    }
                },
                pages: [{
                    name: "Signature Ledger Data",
                    type: "text",
                    text: { content: "<p>Storage hook for the Quartermaster Progression Registry. Do not delete.</p>" }
                }]
            });
        }
        return entry;
    }

    // ── Signatures ────────────────────────────────────────────────────────────

    static async getLedgerData() {
        const entry = await this.getOrCreateLedger();
        return entry.getFlag(MODULE_ID, "characters") || {};
    }

    static async setLedgerData(data) {
        for (const id of Object.keys(data)) {
            if (data[id]?.plannedItems) {
                data[id].plannedItems = this.sanitizePlannedItems(data[id].plannedItems);
            }
        }
        const entry = await this.getOrCreateLedger();
        await entry.setFlag(MODULE_ID, "characters", data);
    }

    /** Sync character rows with current party. Adds new, preserves existing. */
    static async syncWithParty(partyActors) {
        const data = await this.getLedgerData();
        for (const actor of partyActors) {
            if (!data[actor.id]) {
                data[actor.id] = { name: actor.name, rvp: 0, plannedItems: [] };
            } else {
                data[actor.id].name = actor.name;
            }
        }
        await this.setLedgerData(data);
        return data;
    }

    // ── Scroll Plan: Pinned (milestone-assigned scrolls, 2 per milestone) ────
    //
    // Format: [{ spellName, spellLevel, level, slotOrder, img, uuid, source,
    //            delivered, locked }]
    // Semantics: these are GM-pinned scrolls the cache generator must include
    // when the party reaches the assigned milestone. Mirrors cursedPlanned.

    static async getScrollPinned() {
        const entry = await this.getOrCreateLedger();
        await this._migrateScrollData(entry);
        return entry.getFlag(MODULE_ID, "scrollPinned") || [];
    }

    static async setScrollPinned(data) {
        const entry = await this.getOrCreateLedger();
        await entry.setFlag(MODULE_ID, "scrollPinned", data);
    }

    // ── Scroll Plan: Pool (spell-level classified reservoir) ──────────────────
    //
    // Format: [{ spellName, spellLevel, img, uuid, source, school }]
    // Semantics: soft suggestions the engine can draw from. Not milestone-bound.

    /**
     * One-time migration: if the ledger has a flat `scrollPlan` array but no
     * `scrollPinned` flag, move those entries into scrollPinned with slotOrder
     * and leave scrollPool empty. Mirrors _migrateCursedData.
     */
    static async _migrateScrollData(entry) {
        if (entry._scrollMigrated) return;
        entry._scrollMigrated = true;

        const hasNew = entry.getFlag(MODULE_ID, "scrollPinned");
        if (hasNew !== undefined) return;

        const oldPlan = entry.getFlag(MODULE_ID, "scrollPlan") || [];
        let flat = oldPlan;
        if (!Array.isArray(flat)) {
            flat = Object.values(flat).flatMap(v => v.scrolls ?? []);
        }

        if (flat.length) {
            // Assign slotOrders per milestone (0 then 1, cap 2)
            const pinned = [];
            const counts = {};
            for (const s of flat) {
                const lv = Number(s.level);
                if (!lv) continue;
                counts[lv] = (counts[lv] || 0);
                if (counts[lv] >= 2) continue;
                pinned.push({
                    ...s,
                    level: lv,
                    slotOrder: counts[lv],
                    delivered: false,
                    locked: false
                });
                counts[lv]++;
            }
            await entry.setFlag(MODULE_ID, "scrollPinned", pinned);
            await entry.setFlag(MODULE_ID, "scrollPool", []);
            Logger.log(MODULE_LABEL, `Migrated ${pinned.length} scroll entries from scrollPlan to scrollPinned.`);
        } else {
            await entry.setFlag(MODULE_ID, "scrollPinned", []);
            await entry.setFlag(MODULE_ID, "scrollPool", []);
        }
    }

    /**
     * Keep at most 3 pinned scrolls per milestone with non-empty uuid.
     * Deduplicates by spellName (case-insensitive). Mirrors sanitizeCursedPlanned.
     */
    static sanitizeScrollPinned(pinned) {
        const _CAP = 3;
        const out = [];
        for (const ms of this.MILESTONES) {
            const row = pinned
                .filter(p => Number(p.level) === ms && (p.uuid || "").trim())
                .sort((a, b) =>
                    (a.slotOrder ?? 0) - (b.slotOrder ?? 0) ||
                    (a.uuid || "").localeCompare(b.uuid || "")
                );
            const seen = new Set();
            const slots = Array.from({ length: _CAP }, () => null);
            for (const p of row) {
                const k = (p.spellName || "").toLowerCase();
                if (!k || seen.has(k)) continue;
                seen.add(k);
                const idx = Math.min(_CAP - 1, Math.max(0, Number(p.slotOrder) || 0));
                if (!slots[idx]) {
                    slots[idx] = { ...p, level: ms, slotOrder: idx, delivered: !!p.delivered };
                } else {
                    const free = slots.findIndex(s => s === null);
                    if (free >= 0) slots[free] = { ...p, level: ms, slotOrder: free, delivered: !!p.delivered };
                }
                if (slots.every(s => s !== null)) break;
            }
            for (const s of slots) { if (s) out.push(s); }
        }
        return out;
    }

    /** Stub: cursed plan sanitization lives in Cursewright. */
    static sanitizeCursedPlanned(planned) {
        return planned ?? [];
    }

    /**
     * @deprecated Use getScrollPinned instead.
     * Kept for backward compat with ProgressionAdvisor.
     */
    static async getScrollPlan() {
        return this.getScrollPinned();
    }

    // ── Party Shelf ───────────────────────────────────────────────────────────

    static async getPartyShelf() {
        const entry = await this.getOrCreateLedger();
        return entry.getFlag(MODULE_ID, "partyShelf") || [];
    }

    static async setPartyShelf(data) {
        const entry = await this.getOrCreateLedger();
        await entry.setFlag(MODULE_ID, "partyShelf", data);
    }

    /**
     * Keep at most BUDGET signature pins per character with non-empty uuid,
     * one per milestone, no duplicates. Normalizes field presence.
     *
     * @param {Object[]} items
     * @param {object} [options]
     * @param {number} [options.budget=4]
     * @returns {Object[]}
     */
    static sanitizePlannedItems(items, { budget = 4 } = {}) {
        if (!Array.isArray(items)) return [];
        const seen = new Set();
        const out = [];
        for (const ms of this.MILESTONES) {
            if (out.length >= budget) break;
            const pin = items.find(p => Number(p.level) === ms && (p.uuid || "").trim());
            if (!pin) continue;
            const key = (pin.uuid || "").toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                level:     ms,
                name:      pin.name || "",
                img:       pin.img || "",
                uuid:      pin.uuid || "",
                rarity:    pin.rarity || "",
                source:    pin.source || "",
                delivered: !!pin.delivered,
                locked:    !!pin.locked
            });
        }
        return out;
    }

    // ── Ban List ──────────────────────────────────────────────────────────────

    static async getBanList() {
        const entry = await this.getOrCreateLedger();
        return entry.getFlag(MODULE_ID, "banList") || [];
    }

    static async setBanList(data) {
        const entry = await this.getOrCreateLedger();
        await entry.setFlag(MODULE_ID, "banList", data);
    }

    /**
     * Returns a Set<string> of lowercase banned item names for fast cache-gen lookup.
     * Synchronous - expects the ban list to have been pre-cached (see getBanSet()).
     */
    static async getBanSet() {
        const list = await this.getBanList();
        return new Set(list.map(b => b.name.toLowerCase()));
    }

    // ── Power Score ───────────────────────────────────────────────────────────

    static computePowerScore(actor) {
        if (!actor) return 0;
        let score = 0;
        const adapter = game.ionrift?.quartermaster?.adapter;
        const eligible = adapter?.getPowerScoreItemTypes?.() ?? this.POWER_ITEM_TYPES;
        const items = actor.items.filter(i => eligible.has(i.type));
        for (const item of items) {
            const contribution = adapter?.getPowerScoreContribution?.(item, this.POWER_WEIGHTS)
                ?? game.ionrift?.library?.system?.getPowerScoreContribution?.(item, this.POWER_WEIGHTS)
                ?? 0;
            score += contribution;
        }
        return Math.round(score * 10) / 10;
    }

    // ── Fairness Engine (Round-Robin) ──────────────────────────────────────────

    /**
     * Suggests the next character to receive a signature item.
     * Uses round-robin: least recently rewarded character first,
     * tie-broken by character level (higher level = more overdue).
     * Only suggests characters who have planned items at or below their level.
     */
    static async getSuggestedRecipient(partyActors) {
        const data = await this.getLedgerData();
        const SA = game.ionrift?.library?.system;

        const tracked = partyActors
            .filter(a => data[a.id])
            .map(a => {
                const entry = data[a.id];
                const level = SA?.getLevel(a) ?? 1;
                return {
                    actor: a,
                    entry,
                    lastReward: entry.lastSignatureLevel ?? 0,
                    level,
                    viableItems: (entry.plannedItems ?? [])
                        .filter(p => p.level <= level && !p.delivered)
                        .sort((x, y) => y.level - x.level)
                };
            })
            .filter(t => t.viableItems.length > 0); // Only suggest if something is planned

        if (!tracked.length) return null;

        // Pacing check (session tracker -- optional lib dependency)
        if (game.ionrift?.library?.sessions) {
            const ST = game.ionrift.library.sessions;
            const entry = await this.getOrCreateLedger();
            const lastTimestamp = entry.getFlag(MODULE_ID, "lastSignatureTimestamp") || 0;
            const sessionsSince = ST.getSessionsSince(lastTimestamp);
            const baseCadence   = 12;
            const targetCadence = Math.round(baseCadence * (tracked.length / 4));
            const jitter        = 3;
            if (sessionsSince < (targetCadence - jitter)) {
                return { actorId: null, isSuppressed: true, waitCount: targetCadence - sessionsSince };
            }
        }

        // Round-robin: least recently rewarded first, tie-break by level desc
        tracked.sort((a, b) => a.lastReward - b.lastReward || b.level - a.level);
        const candidate = tracked[0];

        return {
            actorId:     candidate.actor.id,
            actorName:   candidate.entry.name,
            plannedItem: candidate.viableItems[0] ?? null,
            isSuppressed: false
        };
    }

    /**
     * Records that a character received a signature item at a given level.
     * Replaces the old RVP-based logWindfall.
     */
    static async logSignatureDelivery(actorId, level) {
        const data = await this.getLedgerData();
        if (!data[actorId]) return false;
        data[actorId].lastSignatureLevel = level;
        const entry = await this.getOrCreateLedger();
        await entry.setFlag(MODULE_ID, "lastSignatureTimestamp", Date.now());
        await this.setLedgerData(data);
        return true;
    }

    /**
     * @deprecated Use logSignatureDelivery instead. Kept for backward compat.
     */
    static async logWindfall(actorId, _rarity) {
        const actorForWindfall = game.actors?.get(actorId);
        const level = (game.ionrift?.library?.system?.getLevel(actorForWindfall)) ?? 1;
        return this.logSignatureDelivery(actorId, level);
    }
}
