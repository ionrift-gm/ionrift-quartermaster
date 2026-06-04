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
 * Normalise a display name for tolerant matching. The cache pool uses
 * `Potion of Healing` (canonical) but some compendium entries arrive as
 * `Potion of Healing (Common)`, `Potion of Healing (Basic)`, or with stray
 * whitespace. Strip parenthetical rarity suffixes and collapse whitespace.
 */
function _normaliseHealingName(name) {
    if (typeof name !== "string") return "";
    return name
        .replace(/\s*\((?:Common|Basic|Uncommon|Rare|Very Rare|Legendary)\)\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/**
 * Two-pass squash merge for cache items before canvas placement.
 * Extracted from CacheGeneratorApp._onCanvasDrop.
 */
export class SquashMerger {

    /**
     * @param {object} item - Ephemeral cache row from `result.items` (Pass B).
     * @returns {boolean} True when this cursed row should contribute to `_infectedCount`.
     */
    static isPoisonStackMergeSource(item) {
        if (!item) return false;
        if (item.isInfectedStack) return true;
        // Check both the GM-facing name and the lure surface name.
        // Standalone cursed potions from Cursewright have item.name set to the
        // curse identity (e.g. "Potion of Poison (Greater)") but their lure
        // surface name IS a healing potion (e.g. "Potion of Greater Healing").
        // Both must be checked to catch Apothecary-injected AND standalone entries.
        const name = (item.name || "").trim();
        const lure = (item._lureSurfaceName || "").trim();
        return POISON_STACK_DECOY_NAME_RX.some(rx => rx.test(name) || rx.test(lure));
    }

    /**
     * Two-pass squash: group identical items, merge cursed into clean counterparts.
     *
     * @param {object[]} items  Cache result items array
     * @param {object}   [logger] Optional Logger + label tuple for diagnostics
     * @returns {Map<string, object>} Squashed entries with _totalQty and _infectedCount
     */
    static merge(items, logger = null) {
        const log = logger?.log ?? (() => {});
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
        for (const item of items ?? []) {
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
        log(`[SquashMerger.passA] ${squashedMap.size} non-cursed entries: ${
            [...squashedMap.values()].map(e => `"${e.name}"×${e._totalQty}`).join(", ")
        }`);

        // Pass B: merge cursed items INTO the matching clean entry.
        // The pile must show ONE row for all potions of the same type - two
        // identical "Small Phial" entries is a dead giveaway for players.
        //
        // Architecture:
        //   clean (x2) + infected (x1) → one entry, _totalQty=3, _infectedCount=1
        //   → infectedCount=1 stamped on the pile item
        //
        // At use time, CurseEngine computes rate = infectedCount / system.quantity
        // on demand (always accurate as potions are consumed). On a poison hit the
        // count is decremented, so the total reaches zero exactly when the last
        // poisoned potion is consumed.
        //
        // We retain the CLEAN item's compendium ref so the pile contains a usable
        // SRD Potion of Healing (with a heal activity), not the Cursewright item.
        //
        // Only Apothecary-style healing decoys may carry `_infectedCount`. Other cursed
        // specials (weapons, dust, etc.) must merge by quantity without stamping infectedCount,
        // or the GM droplet badge appears on every cursed item after pile creation.
        for (const item of items ?? []) {
            if (!item._specialSection || item._specialType !== "cursed") continue;
            const qty = item.quantity ?? 1;
            const poisonMerge = SquashMerger.isPoisonStackMergeSource(item);
            // Use the lure surface name for matching when available.
            // CursedItemResolver.resolveDisplayName sets item.name to the GM-facing
            // identity (e.g. "Potion of Poison") but the clean counterpart still
            // carries the lure name ("Potion of Healing"). _lureSurfaceName is
            // stashed during _injectItem to bridge this gap.
            const matchName = item._lureSurfaceName ?? item.name;
            const matchKey  = _normaliseHealingName(matchName);
            // Tolerant match: compendium entries sometimes arrive as
            // "Potion of Healing (Common)" while the lure surface is the
            // canonical "Potion of Healing". A strict equality check splits
            // them into separate squash entries → two pile rows where the
            // GM expected one folded stack with infectedCount carried.
            const matchEntry = [...squashedMap.values()].find(e =>
                _normaliseHealingName(e.name) === matchKey
            );
            log(`[SquashMerger.passB] cursed "${item.name}" lure="${matchName}" key="${matchKey}" → ${matchEntry ? `MATCH "${matchEntry.name}" (qty ${matchEntry._totalQty})` : "STANDALONE"}`);
            if (matchEntry) {
                if (poisonMerge) {
                    matchEntry._infectedCount = (matchEntry._infectedCount ?? 0) + qty;
                }
                matchEntry._totalQty = (matchEntry._totalQty ?? 0) + qty;
            } else if (poisonMerge) {
                // No clean counterpart - standalone fully-infected healing stack.
                // Override the name with the lure surface name so resolveItemData
                // can match an SRD healing potion from the loot pool.
                // Clear the cursed compendium ref - otherwise resolveItemData
                // fetches the CurseForge item directly, which has identified:false
                // and the wrong name, bypassing the masking pipeline.
                const cleanName = item._lureSurfaceName ?? item.name;
                squashedMap.set(`cursed::${item._uid ?? item.name}`, {
                    ...item,
                    name: cleanName,
                    sourceCompendium: null,
                    _compendiumId: null,
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

        return squashedMap;
    }
}
