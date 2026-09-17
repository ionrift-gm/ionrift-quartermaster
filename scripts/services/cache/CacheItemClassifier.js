/**
 * Pure classifier that maps a cache generator meta-item to the preview
 * section it should render under. The Cache Generator UI and the deployment
 * paths (Item Piles drag, PF2E loot actor, sidebar "Add to Items") all use
 * the same result.items array; this classifier is the single source of
 * truth for which section a given item belongs to so preview and
 * deployment cannot drift out of sync.
 *
 * Return values:
 *   "signature" | "partyShelf" | "cursed"   – Special Items sub-buckets
 *   "scroll"                                – Spell Scrolls
 *   "weapon"                                – Weapons & Armour (all worn gear)
 *   "consumable"                            – Consumables
 *   "gemstone"                              – Gemstones (QM-tagged)
 *   "treasure"                              – Treasure (QM-tagged or native)
 *   "trinket"                               – Trinkets (QM-tagged)
 *   "mundane"                               – Trade Goods catch-all
 *   "unclassified"                          – Nothing matched; a real cache
 *                                             item hitting this is a bug and
 *                                             is what the invariant test
 *                                             (vitest) fails on.
 */
function qmKindOrSuffix(item, kind, suffix) {
    return item._qmKind === kind
        || (!!item.sourceCompendium && item.sourceCompendium.endsWith(`.${suffix}`));
}

/**
 * @param {object} item Cache generator meta-object.
 * @returns {"signature"|"partyShelf"|"cursed"|"scroll"|"weapon"|"consumable"|"gemstone"|"treasure"|"trinket"|"mundane"|"unclassified"}
 */
export function classifyCacheItem(item) {
    const isSpecial = !!(item._specialSection || item.isSignature);
    if (isSpecial) {
        if (item.isSignature || item._specialType === "signature") return "signature";
        if (item._specialType === "partyShelf") return "partyShelf";
        if (item._specialType === "cursed") return "cursed";
        // Fallback: any other special-flagged item lands in signatures.
        return "signature";
    }
    if (item.spellName) return "scroll";
    if (item.type === "consumable") return "consumable";
    // Weapons & Armour: dnd5e uses "equipment" for armour; PF2E splits the
    // wearable space into "armor", "shield", and "equipment". All of these
    // ship inside the same UI section so the preview matches what the
    // deployment embeds.
    if (item.type === "weapon"
        || item.type === "equipment"
        || item.type === "armor"
        || item.type === "shield") {
        return "weapon";
    }
    if (qmKindOrSuffix(item, "gemstones", "quartermaster-gemstones")) return "gemstone";
    // Treasure: QM-tagged treasure OR PF2E-native treasure documents (gems,
    // art objects, trade bars). Without the native-type branch the preview
    // silently drops PF2E treasure and the loot actor looks like it
    // invented rogue items.
    if (qmKindOrSuffix(item, "treasure", "quartermaster-treasure")
        || item.type === "treasure") {
        return "treasure";
    }
    if (qmKindOrSuffix(item, "trinkets", "quartermaster-trinkets")) return "trinket";
    if (item.type === "loot"
        || item.type === "tool"
        || item.type === "backpack"
        || item.type === "book"
        || !item.type) {
        return "mundane";
    }
    return "unclassified";
}
