import { MODULE_ID } from "../../data/moduleId.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { ScrollForge } from "../scroll/ScrollForge.js";
import { ItemMaskingHelper } from "../identify/ItemMaskingHelper.js";

/** SRD scroll price by spell level (gp). */
export const SCROLL_PRICES_BY_LEVEL = {
    1: 60, 2: 120, 3: 200, 4: 320, 5: 640, 6: 1280, 7: 2560, 8: 5120, 9: 10240
};

/** Minimum spell level for cache scroll slots by party tier. */
export const TIER_SCROLL_MIN_LEVEL = [0, 1, 2, 3, 5];

/** Max distinct scroll lines after consolidation, by tier. */
export const TIER_SCROLL_MAX_UNIQUES = [0, 2, 4, 5, 6];

/** Max scroll slots in one cache (arcana / apothecary / default), by tier. */
export const SCROLL_SLOT_CAP = {
    arcana:      [0, 3, 5, 6, 7],
    apothecary:  [0, 2, 4, 5, 5],
    default:     [0, 2, 3, 4, 5]
};

export class CacheScrollLogic {

    static _tierScrollMinLevel(tier) {
        return TIER_SCROLL_MIN_LEVEL[tier] ?? 1;
    }

    static _maxScrollUniques(tier) {
        return TIER_SCROLL_MAX_UNIQUES[tier] ?? 4;
    }

    /**
     * @param {number} tier
     * @param {string} ownerTheme
     * @returns {number}
     */
    static _scrollSlotCap(tier, ownerTheme) {
        const table = SCROLL_SLOT_CAP[ownerTheme] ?? SCROLL_SLOT_CAP.default;
        return table[tier] ?? table[1] ?? 3;
    }

    /**
     * Max stack size for one scroll line at a given spell level.
     *
     * @param {number} spellLevel
     * @param {object} tierData
     * @returns {number}
     */
    static _scrollStackCap(spellLevel, tierData) {
        const tier = tierData._tier ?? 1;
        const minLevel = this._tierScrollMinLevel(tier);
        const maxLevel = tierData.scrollLevelMax ?? 2;
        const lvl = spellLevel ?? minLevel;
        if (lvl >= maxLevel - 1) return 2;
        const mid = minLevel + Math.max(1, Math.floor((maxLevel - minLevel) / 2));
        if (lvl >= mid) return 4;
        return 5;
    }

    /**
     * Replace excess scroll slots with other pool types so Arcana caches
     * do not ship a dozen unique one-offs.
     *
     * @param {string[]} drawnSlots
     * @param {number} tier
     * @param {string} ownerTheme
     * @param {Object} pool
     * @param {Object} host - CacheGenerator instance (provides _weightedPoolDraw)
     */
    static _trimExcessScrollSlots(drawnSlots, tier, ownerTheme, pool, host) {
        const cap = this._scrollSlotCap(tier, ownerTheme);
        let scrollCount = drawnSlots.filter(s => s === "scroll").length;
        if (scrollCount <= cap) return;

        const altPool = { ...pool };
        delete altPool.scroll;
        if (!Object.keys(altPool).length) altPool.consumable = 1;

        while (scrollCount > cap) {
            let replaced = false;
            for (let i = drawnSlots.length - 1; i >= 0; i--) {
                if (drawnSlots[i] !== "scroll") continue;
                drawnSlots[i] = host._weightedPoolDraw(altPool);
                scrollCount--;
                replaced = true;
                break;
            }
            if (!replaced) break;
        }
    }

    /**
     * Quantity for a newly picked scroll (stacks lower circles more often).
     *
     * @param {number} spellLevel
     * @param {object} tierData
     * @param {number} priceCeiling
     * @returns {number}
     */
    static _resolveScrollQuantity(spellLevel, tierData, priceCeiling = Infinity) {
        const stackCap = this._scrollStackCap(spellLevel, tierData);
        const unit = SCROLL_PRICES_BY_LEVEL[spellLevel] ?? 60;
        const maxByBudget = unit > 0 ? Math.max(1, Math.floor(priceCeiling / unit)) : 1;
        const maxLevel = tierData.scrollLevelMax ?? 2;
        const minLevel = this._tierScrollMinLevel(tierData._tier ?? 1);

        if (spellLevel >= maxLevel - 1) {
            const roll = 1 + Math.floor(Math.random() * 2);
            return Math.max(1, Math.min(roll, maxByBudget, stackCap));
        }

        const lowInCohort = spellLevel <= minLevel + 1;
        const minQty = lowInCohort ? 2 : 1;
        const roll = minQty + Math.floor(Math.random() * (stackCap - minQty + 1));
        return Math.max(1, Math.min(stackCap, maxByBudget, roll));
    }

    /**
     * @param {object} scroll
     */
    static _recalcScrollLinePrice(scroll) {
        const qty = Math.max(1, scroll.quantity ?? 1);
        const currentUnit = Number(scroll.unitPrice) > 0
            ? Number(scroll.unitPrice)
            : null;
        const unit = currentUnit
            ?? SCROLL_PRICES_BY_LEVEL[scroll.spellLevel]
            ?? (Number(scroll.price) > 0 ? Number(scroll.price) / qty : 60);
        scroll.quantity = qty;
        scroll.price = Math.round(unit * qty * 100) / 100;
        return scroll;
    }

    /**
     * Merge duplicate scrolls and cap how many unique lines remain.
     *
     * @param {object[]} items
     * @param {object} tierData
     * @returns {object[]}
     */
    static _consolidateScrollStacks(items, tierData) {
        if (!items?.length) return items;

        const scrolls = [];
        const other = [];
        for (const it of items) {
            if (it.spellName) {
                scrolls.push({ ...it, quantity: it.quantity ?? 1 });
            } else {
                other.push(it);
            }
        }
        if (scrolls.length <= 1) return items;

        const byKey = new Map();
        for (const s of scrolls) {
            const key = (s.spellName || s.name || "").toLowerCase().trim();
            if (!key) continue;
            if (byKey.has(key)) {
                const ex = byKey.get(key);
                ex.quantity += s.quantity ?? 1;
            } else {
                byKey.set(key, { ...s });
            }
        }

        const pool = [...byKey.values()].map(s => this._recalcScrollLinePrice(s));

        for (const s of pool) {
            const cap = this._scrollStackCap(s.spellLevel, tierData);
            if ((s.quantity ?? 1) > cap) {
                s.quantity = cap;
                this._recalcScrollLinePrice(s);
            }
        }

        pool.sort((a, b) => (b.spellLevel ?? 0) - (a.spellLevel ?? 0));
        return [...other, ...pool];
    }

    /**
     * Spell level for a Scroll Forge / compendium index entry.
     * Forged dnd5e scrolls often keep template system.level at 1; scrollMeta
     * and dnd5e.spellLevel carry the real circle.
     *
     * @param {object} entry
     * @returns {number|null}
     */
    static _resolveScrollLevel(entry) {
        const qm = entry.flags?.[MODULE_ID]?.scrollMeta?.spellLevel;
        if (Number.isFinite(qm) && qm >= 1) return qm;

        const dnd = entry.flags?.dnd5e?.spellLevel?.value;
        if (Number.isFinite(dnd) && dnd >= 1) return dnd;

        const pf2eLvl = entry.system?.level?.value;
        if (Number.isFinite(pf2eLvl) && pf2eLvl >= 1) return pf2eLvl;

        const sys = entry.system?.level;
        if (typeof sys === "number" && sys >= 1) return sys;

        return null;
    }

    /**
     * Scroll price in gp, preferring the forged item's system data when present.
     *
     * D&D scrolls fall back to Quartermaster's SRD table; PF2e forged scrolls
     * carry PF2e treasure-table prices in system.price.
     *
     * @param {object} entry
     * @param {number} spellLevel
     * @returns {number}
     */
    static _resolveScrollPrice(entry, spellLevel) {
        const price = entry?.system?.price;
        const raw = price?.value ?? price;

        if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
            return raw;
        }

        if (raw && typeof raw === "object") {
            const gp = Number(raw.gp ?? 0);
            const sp = Number(raw.sp ?? 0);
            const cp = Number(raw.cp ?? 0);
            const pp = Number(raw.pp ?? 0);
            const total = (Number.isFinite(pp) ? pp * 10 : 0)
                + (Number.isFinite(gp) ? gp : 0)
                + (Number.isFinite(sp) ? sp / 10 : 0)
                + (Number.isFinite(cp) ? cp / 100 : 0);
            if (total > 0) return total;
        }

        return SCROLL_PRICES_BY_LEVEL[spellLevel] ?? 60;
    }

    /**
     * Effective gp ceiling for one scroll slot. Uses scroll-slot budget share and
     * aims at the upper mid-band of the tier, not only the tier floor price.
     *
     * @param {object} tierData
     * @param {number} slotPriceCeiling
     * @param {object} [opts]
     * @param {number} [opts.scrollSlotsRemaining]
     * @param {number} [opts.remainingBudget]
     * @returns {number}
     */
    static _scrollPriceCeiling(tierData, slotPriceCeiling, opts = {}) {
        const minLevel = this._tierScrollMinLevel(tierData._tier ?? 1);
        const maxLevel = tierData.scrollLevelMax ?? 2;
        const minPrice = SCROLL_PRICES_BY_LEVEL[minLevel] ?? 60;
        const aspireLevel = Math.min(
            maxLevel,
            minLevel + Math.max(1, Math.floor((maxLevel - minLevel) * 0.55))
        );
        const aspirePrice = SCROLL_PRICES_BY_LEVEL[aspireLevel] ?? minPrice;

        if (!Number.isFinite(slotPriceCeiling)) {
            return aspirePrice;
        }

        const scrollShare = Number.isFinite(opts.remainingBudget)
            ? opts.remainingBudget / Math.max(1, opts.scrollSlotsRemaining ?? 1)
            : slotPriceCeiling;

        const band = Math.min(aspirePrice, scrollShare);
        return Math.max(minPrice, band);
    }

    /**
     * Pick a scroll from a compendium index (testable without Foundry packs).
     *
     * @param {object[]|Collection} index
     * @param {object} tierData
     * @param {number} [priceCeiling]
     * @param {object} [opts]
     * @param {number} [opts.scrollSlotsRemaining]
     * @param {number} [opts.remainingBudget]
     * @returns {object|null}
     */
    static _pickScrollFromIndex(index, tierData, priceCeiling = Infinity, opts = {}) {
        const tier = tierData._tier ?? 1;
        const minLevel = this._tierScrollMinLevel(tier);
        let maxLevel = tierData.scrollLevelMax ?? 2;
        maxLevel = Math.max(minLevel, maxLevel);

        const effectiveCeiling = this._scrollPriceCeiling(tierData, priceCeiling, opts);

        const level = this._weightedScrollLevel(maxLevel, minLevel, tier);
        const entries = index?.contents ?? (Array.isArray(index) ? index : Array.from(index ?? []));

        const withinBudget = (e) => {
            const spellLevel = this._resolveScrollLevel(e);
            if (!spellLevel) return false;
            return this._resolveScrollPrice(e, spellLevel) <= effectiveCeiling;
        };

        const bandFilter = (e, targetLevel) => {
            const spellLevel = this._resolveScrollLevel(e);
            return spellLevel
                && spellLevel >= minLevel
                && spellLevel <= targetLevel
                && withinBudget(e);
        };

        let eligible = entries.filter(e => {
            const spellLevel = this._resolveScrollLevel(e);
            return spellLevel === level && spellLevel >= minLevel && withinBudget(e);
        });
        for (let tryLevel = level - 1; eligible.length === 0 && tryLevel >= minLevel; tryLevel--) {
            eligible = entries.filter(e => this._resolveScrollLevel(e) === tryLevel && withinBudget(e));
        }
        if (eligible.length === 0) {
            eligible = entries.filter(e => bandFilter(e, level));
        }

        if (eligible.length === 0) {
            if (game.settings?.get(MODULE_ID, "debug") === true) {
                Logger.log(MODULE_LABEL, "scroll pick failed", {
                    tier, minLevel, maxLevel, rolledLevel: level,
                    priceCeiling, effectiveCeiling, poolSize: entries.length
                });
            }
            return null;
        }

        const partySpells = this._getPartyKnownSpells();
        const novel = eligible.filter(e => {
            const spellName = e.flags?.[MODULE_ID]?.scrollMeta?.spellName;
            return spellName && !partySpells.has(spellName.toLowerCase());
        });
        const finalPool = novel.length > 0 ? novel : eligible;

        const pick = this._pickScrollFromEligible(finalPool, level, minLevel);
        if (!pick) return null;

        const scrollMeta = pick.flags?.[MODULE_ID]?.scrollMeta ?? {};
        const pickedLevel = this._resolveScrollLevel(pick) ?? minLevel;
        const pickedPrice = this._resolveScrollPrice(pick, pickedLevel);
        return {
            name: pick.name,
            type: "consumable",
            img: pick.img ?? ItemMaskingHelper._genericIconFor("scroll"),
            price: pickedPrice,
            weight: 0.1,
            rarity: pickedLevel <= 2 ? "common" : pickedLevel <= 4 ? "uncommon" : "rare",
            quantity: 1,
            unitPrice: pickedPrice,
            spellLevel: pickedLevel,
            spellName: scrollMeta.spellName,
            _compendiumId: pick._id,
            sourceCompendium: pick.sourceCompendium ?? `world.${ScrollForge.WORLD_PACK_NAME}`
        };
    }

    static async _pickScroll(tierData, priceCeiling = Infinity, opts = {}) {
        const tier = tierData._tier ?? 1;
        const minLevel = this._tierScrollMinLevel(tier);

        try {
            const forgedId = `world.${ScrollForge.WORLD_PACK_NAME}`;
            const pack = game.packs.get(forgedId);
            if (pack) {
                const index = await pack.getIndex({
                    fields: ["name", "img", "system.price", "system.level", "flags"]
                });
                const item = this._pickScrollFromIndex(index, tierData, priceCeiling, opts);
                if (item) {
                    item.sourceCompendium = forgedId;
                    return item;
                }
            }
        } catch (e) {
            Logger.warn(MODULE_LABEL, "Scroll compendium query failed:", e.message);
        }

        Logger.warn(MODULE_LABEL,
            `No scroll available (tier ${tier}, min ${minLevel}) - ` +
            `ensure Scroll Forge is compiled with spell sources enabled.`
        );
        return null;
    }

    /**
     * Pick one scroll from a filtered pool, favoring the target level and
     * higher circles when falling back.
     *
     * @param {object[]} eligible
     * @param {number} targetLevel
     * @param {number} [minLevel=1]
     * @returns {object|undefined}
     */
    static _pickScrollFromEligible(eligible, targetLevel, minLevel = 1) {
        if (!eligible.length) return undefined;

        const pool = eligible.filter(e => {
            const lvl = this._resolveScrollLevel(e);
            return lvl && lvl >= minLevel;
        });
        if (!pool.length) return undefined;

        const atTarget = pool.filter(e => this._resolveScrollLevel(e) === targetLevel);
        if (atTarget.length > 0) {
            return atTarget[Math.floor(Math.random() * atTarget.length)];
        }

        const withLevel = pool
            .map(e => ({ entry: e, lvl: this._resolveScrollLevel(e) }))
            .filter(x => x.lvl);
        if (!withLevel.length) return undefined;

        const maxLvl = Math.max(...withLevel.map(x => x.lvl));
        const topTier = withLevel.filter(x => x.lvl === maxLvl);
        if (topTier.length > 0 && Math.random() < 0.7) {
            return topTier[Math.floor(Math.random() * topTier.length)].entry;
        }

        const tickets = [];
        for (const { entry, lvl } of withLevel) {
            const w = Math.max(1, lvl);
            for (let i = 0; i < w; i++) tickets.push(entry);
        }
        return tickets[Math.floor(Math.random() * tickets.length)];
    }

    /**
     * Weighted scroll level selection. Mid-tier scrolls are favored over
     * edge levels (min and max) to produce a more balanced distribution.
     *
     * @param {number} maxLevel
     * @param {number} [minLevel=1]
     * @param {number} [tier=1]
     * @returns {number}
     */
    static _weightedScrollLevel(maxLevel, minLevel = 1, tier = 1) {
        if (maxLevel < 1) return 1;
        minLevel = Math.max(1, Math.min(minLevel, maxLevel));
        if (maxLevel <= minLevel) return maxLevel;

        const upperHalf = minLevel + Math.ceil((maxLevel - minLevel + 1) / 2);
        const weights = {};
        for (let i = minLevel; i <= maxLevel; i++) {
            let w = Math.min(i - minLevel + 1, maxLevel - i + 1);
            if (tier >= 2 && i >= upperHalf) w *= 2;
            if (tier >= 3 && i === maxLevel) w = Math.max(w, 3);
            weights[i] = w;
        }
        const total = Object.values(weights).reduce((a, b) => a + b, 0);
        let roll = Math.random() * total;
        for (const [lvl, w] of Object.entries(weights)) {
            roll -= w;
            if (roll <= 0) return parseInt(lvl, 10);
        }
        return maxLevel;
    }

    /**
     * Collects all known spell names from party characters.
     * Uses SystemAdapter when ionrift-lib is available, with DnD5e fallback.
     */
    static _getPartyKnownSpells() {
        const SA = game.ionrift?.library?.system;
        const known = new Set();
        const actors = game.ionrift?.library?.party?.getMembers()
            ?? game.actors.filter(a => a.hasPlayerOwner && a.type === "character");
        for (const actor of actors) {
            if (SA) {
                for (const spell of SA.getKnownSpells(actor)) known.add(spell);
            } else {
                for (const item of actor.items) {
                    if (item.type === "spell") known.add(item.name.toLowerCase());
                }
            }
        }
        return known;
    }
}

export const __testables__ = {
    SCROLL_PRICES_BY_LEVEL,
    TIER_SCROLL_MIN_LEVEL,
    TIER_SCROLL_MAX_UNIQUES,
    SCROLL_SLOT_CAP
};
