/**
 * ProgressionSeeder.js
 *
 * Suggestive auto-population heuristics for the Progression Registry.
 * Both seedSignatures() and seedScrolls() return plain data arrays;
 * they do not mutate the ledger. The caller is responsible for saving.
 *
 * These heuristics are intentionally approximate. The GM reviews and
 * adjusts the suggestions; the seeder just provides a reasonable starting point.
 */

import { SignatureLedger } from "./SignatureLedger.js";
import { ScrollForge } from "./ScrollForge.js";

// ── Positional Curves ────────────────────────────────────────────────────────
// Indexed by milestone position (0-5), not character level.
// At runtime, mapped onto whichever milestone levels the active profile uses.

const RARITY_CURVE = [
    ["common", "uncommon"],   // position 0 - earliest
    ["rare"],                 // position 1
    ["rare", "veryRare"],     // position 2
    ["veryRare"],             // position 3
    ["veryRare"],             // position 4
    ["legendary"]             // position 5 - capstone
];

/** Derive scroll spell-level range from a milestone's actual character level. */
function _scrollLevelsForMilestone(charLevel) {
    const maxSpell = Math.min(9, Math.ceil(charLevel / 2));
    const minSpell = Math.max(1, maxSpell - 1);
    const range = [];
    for (let l = minSpell; l <= maxSpell; l++) range.push(l);
    return range;
}

/** Build level-keyed lookup tables from the active milestone profile. */
function _buildMilestoneTables() {
    const ms = SignatureLedger.MILESTONES;
    const rarity = Object.fromEntries(ms.map((lv, i) => [lv, RARITY_CURVE[i] ?? ["uncommon"]]));
    const scroll = Object.fromEntries(ms.map(lv => [lv, _scrollLevelsForMilestone(lv)]));
    return { milestones: ms, rarity, scroll };
}

// ── Class Role Classification ────────────────────────────────────────────────

const MARTIAL_CLASSES     = ["fighter", "barbarian", "rogue"];
const HALF_CASTER_CLASSES = ["paladin", "ranger", "artificer"];
const FULL_CASTER_CLASSES = ["wizard", "sorcerer", "warlock", "bard", "cleric", "druid"];
const DIVINE_CLASSES      = ["cleric", "druid"];
const MONK_CLASS          = "monk";

// Item type affinity by role (kept for scroll/shelf filtering)
const _MARTIAL_TYPES     = ["weapon", "equipment"];
const _HALF_CASTER_TYPES = ["weapon", "equipment"];
const _FULL_CASTER_TYPES = ["equipment"];

// Known-spell casters: look for gap spells. Prepared casters: situational picks.
const KNOWN_SPELL_CASTERS = ["wizard", "sorcerer", "warlock", "bard"];

// ── Slot Archetypes (positional) ─────────────────────────────────────────────
// Indexed by position 0-5, mapped onto active milestones at runtime.
// Each entry is [primary (70%), secondary (30%)] item category.

const ARCHETYPE_CURVE = {
    martial:       [["weapon","wondrous"],["wondrous","weapon"],["armor","wondrous"],["wondrous","armor"],["weapon","wondrous"],["weapon","armor"]],
    "half-caster": [["weapon","wondrous"],["wondrous","focus"],["armor","wondrous"],["wondrous","weapon"],["weapon","armor"],["weapon","wondrous"]],
    caster:        [["wondrous","focus"],["wondrous","wondrous"],["focus","wondrous"],["wondrous","focus"],["focus","wondrous"],["wondrous","focus"]],
    divine:        [["wondrous","armor"],["armor","wondrous"],["wondrous","focus"],["focus","wondrous"],["armor","wondrous"],["wondrous","armor"]],
    monk:          [["wondrous","wondrous"],["wondrous","wondrous"],["wondrous","wondrous"],["wondrous","wondrous"],["wondrous","weapon"],["wondrous","wondrous"]],
    hybrid:        [["weapon","wondrous"],["wondrous","focus"],["armor","wondrous"],["wondrous","focus"],["weapon","wondrous"],["weapon","wondrous"]]
};

/** Build a level-keyed SLOT_ARCHETYPES map from the active milestone profile. */
function _buildArchetypeTables() {
    const ms = SignatureLedger.MILESTONES;
    const out = {};
    for (const [role, curve] of Object.entries(ARCHETYPE_CURVE)) {
        out[role] = Object.fromEntries(ms.map((lv, i) => [lv, curve[i] ?? ["wondrous", "wondrous"]]));
    }
    return out;
}

// ── Proficiency Rejection Filters ────────────────────────────────────────────

const FOCUS_SUBTYPES = new Set(["rod", "staff", "wand"]);

// Matches "Requires attunement by a cleric, druid, or warlock" in item descriptions.
// Strips HTML tags so it works against both plain and rich-text descriptions.
const ATTUNEMENT_CLASS_RE = /requires\s+attunement\s+by\s+(?:a\s+)?([^.<]+)/i;

/**
 * Returns the Set of class names that are explicitly allowed to attune to this
 * item, parsed from its description text. Returns null if no restriction found.
 */
function _parseAttunementClasses(description) {
    if (!description) return null;
    // Strip HTML tags before matching
    const plain = description.replace(/<[^>]*>/g, " ");
    const match = ATTUNEMENT_CLASS_RE.exec(plain);
    if (!match) return null;

    // Split the matched clause on commas, "or", "and" - grab recognised class names
    const ALL_CLASSES = new Set([
        "barbarian", "bard", "cleric", "druid", "fighter", "monk",
        "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard", "artificer"
    ]);
    const words = match[1].toLowerCase().split(/[\s,]+/);
    const found = new Set(words.filter(w => ALL_CLASSES.has(w)));
    return found.size > 0 ? found : null;
}

/**
 * Returns true if the item should be REJECTED for this class set.
 * Broad strokes - prevents clearly-wrong suggestions (Splint on Wizard).
 */
function _isRejectedByProficiency(item, classNames) {
    const armorType  = item.armorType;
    const weaponType = item.weaponType;

    for (const cls of classNames) {
        if (armorType === "heavy" && ["wizard", "sorcerer", "warlock", "bard", "monk", "rogue", "ranger", "druid"].includes(cls)) return true;
        if (armorType === "medium" && ["wizard", "sorcerer", "warlock", "monk"].includes(cls)) return true;
        if (armorType === "shield" && ["wizard", "sorcerer", "warlock", "monk", "rogue"].includes(cls)) return true;
        if (weaponType?.startsWith("martial") && ["wizard", "sorcerer"].includes(cls)) return true;
        if (FOCUS_SUBTYPES.has(item.subtype) && ["fighter", "barbarian", "rogue", "monk"].includes(cls)) return true;
    }
    return false;
}

/**
 * Returns true if the item has a class-specific attunement requirement that
 * NONE of the character's classes satisfy.
 */
function _isRejectedByAttunementRestriction(item, classNames) {
    const allowed = _parseAttunementClasses(item.description);
    if (!allowed) return false;  // no restriction - open attunement
    return !classNames.some(cls => allowed.has(cls));
}

// ── Item Categorisation ──────────────────────────────────────────────────────

function _categoriseItem(item) {
    if (item.itemType === "weapon") return "weapon";
    if (item.armorType) return "armor";
    if (FOCUS_SUBTYPES.has(item.subtype)) return "focus";
    return "wondrous";
}
// ── Generic Item Filter ──────────────────────────────────────────────────────
// Signature items should have narrative identity. Reject stat-stick variants
// like "Longsword +1" or "Chain Mail +2" - those belong on the Party Shelf.

const GENERIC_BONUS_PATTERN = /\+\d\b/;

// ── Trait-item synergy (signature pick weighting) ───────────────────────────

const TRAIT_PENALTIES = [
    { trait: "darkvision", pattern: /goggles of night/i, penalty: 0.9 },
    { trait: "fire-resistance", pattern: /ring of fire resistance/i, penalty: 0.9 },
    { trait: "poison-resistance", pattern: /periapt of proof against poison/i, penalty: 0.9 },
    { trait: "charmed-immunity", pattern: /medallion of thoughts/i, penalty: 0.5 }
];

/**
 * Weight multiplier for signature pick lottery (1.0 = neutral, lower = redundant with actor).
 * Each matching trait+pattern subtracts its penalty; never below 0.05.
 */
function _scoreSynergy(item, traits) {
    let mult = 1;
    for (const { trait, pattern, penalty } of TRAIT_PENALTIES) {
        if (traits.has(trait) && pattern.test(item.name)) {
            mult -= penalty;
        }
    }
    return Math.max(0.05, mult);
}

// ── Signature demote list (utility / niche - soft weight in lottery) ───────

const SIGNATURE_DEMOTE = new Set([
    "wand of secrets",
    "ring of swimming",
    "ring of water walking",
    "cap of water breathing",
    "cloak of the manta ray",
    "decanter of endless water",
    "driftglobe",
    "lantern of revealing",
    "rope of climbing",
    "immovable rod",
    "alchemy jug",
    "eversmoking bottle",
    "bag of holding",
    "hat of disguise",
    "goggles of night",
    "ring of jumping",
    "boots of elvenkind",
    "cloak of elvenkind",
    "eyes of minute seeing",
    "gloves of thievery",
    "sending stones",
    "ring of mind shielding"
]);

function _isGenericItem(name) {
    return GENERIC_BONUS_PATTERN.test(name);
}

// ═════════════════════════════════════════════════════════════════════════════

export class ProgressionSeeder {

    // ── Public Constants ──────────────────────────────────────────────────────

    /** Exposed so SignatureLedgerApp can pass rarity hints to the template. */
    static get MILESTONE_RARITY() { return _buildMilestoneTables().rarity; }

    // ── Signature Seeding ─────────────────────────────────────────────────────

    /**
     * Suggest signature items for one actor across all milestones.
     *
     * Model: 4 total signatures per character.
     *   - Lv 20 capstone: ALWAYS filled
     *   - 3 additional from the remaining 5 milestones (weighted random)
     *
     * Items are categorised (weapon/armor/wondrous/focus) and picked according
     * to role-specific slot archetypes with 70/30 primary/secondary jitter.
     * Proficiency filters reject items the class cannot equip.
     * Party-aware dedup prevents two same-role characters from receiving the
     * same item category at the same milestone.
     *
     * @param {Actor}   actor            The character to seed for
     * @param {Set}     banSet           Lowercase banned item names
     * @param {Map}     partyAllocations Map<milestone, category> of already-seeded
     *                                   same-role picks (for dedup). Optional.
     * @param {Set}     partyUsedNames   Lowercase item names already claimed by
     *                                   other party members (cross-character dedup).
     * @param {number[]} forceMilestones If provided, seed ONLY these milestones
     *                                   instead of the random selection. Used by reroll.
     * @returns {Array} plannedItems array suitable for ledger storage
     */
    static async seedSignatures(actor, banSet = new Set(), partyAllocations = new Map(), partyUsedNames = new Set(), forceMilestones = null) {
        const role       = this._detectRole(actor);
        const classNames = this._getClassNames(actor);
        const archetypes = _buildArchetypeTables();
        const archetype  = archetypes[role] ?? archetypes.martial;
        const { milestones: ms, rarity: MILESTONE_RARITY } = _buildMilestoneTables();
        const planned    = [];

        // Fetch enriched candidates from compendium
        const candidates = await this._fetchCandidates(classNames, banSet);

        const SA = game.ionrift?.library?.system;
        const actorTraits = SA ? SA.getTraits(actor) : new Set();

        let activeSlots;

        if (forceMilestones) {
            activeSlots = forceMilestones;
        } else {
            // Capstone = last milestone in profile; pick 3 from the rest with spread
            const capstone = ms[ms.length - 1];
            const rest = ms.slice(0, -1); // positions 0-4
            const half = Math.ceil(rest.length / 2);
            const earlyTier = rest.slice(0, half).sort(() => Math.random() - 0.5);
            const midTier   = rest.slice(half).sort(() => Math.random() - 0.5);

            const guaranteed = [earlyTier[0], midTier[0]];
            const remaining  = [...earlyTier.slice(1), ...midTier.slice(1)]
                .sort(() => Math.random() - 0.5);
            const selectedSlots = [...guaranteed, remaining[0]];

            activeSlots = [capstone, ...selectedSlots].sort((a, b) => a - b);
        }

        // Merge party-level exclusions with per-character tracking
        const usedNames = new Set(partyUsedNames);
        let lastCategory = null;

        for (const milestone of activeSlots) {
            const rarities = MILESTONE_RARITY[milestone] ?? ["uncommon"];

            // Determine category via archetype (70/30 primary/secondary)
            const [primary, secondary] = archetype[milestone] ?? ["wondrous", "wondrous"];
            let targetCategory;

            // Party-aware dedup: if same-role already has this category here, force secondary
            const partyCategory = partyAllocations.get(milestone);
            if (partyCategory && partyCategory === primary) {
                targetCategory = secondary;
            } else {
                targetCategory = Math.random() < 0.7 ? primary : secondary;
            }

            // Consecutive-category dedup: don't repeat the same category back-to-back
            if (lastCategory && targetCategory === lastCategory && primary !== secondary) {
                targetCategory = targetCategory === primary ? secondary : primary;
            }

            // Filter pool: rarity + category + proficiency + attunement class + no generic +N items
            const pool = candidates.filter(c => {
                if (!rarities.includes(c.rarity)) return false;
                if (_categoriseItem(c) !== targetCategory) return false;
                if (usedNames.has(c.name.toLowerCase())) return false;
                if (_isRejectedByProficiency(c, classNames)) return false;
                if (_isRejectedByAttunementRestriction(c, classNames)) return false;
                if (_isGenericItem(c.name)) return false;
                return true;
            });

            // Fallback: try the alternative category
            let finalPool = pool;
            if (!pool.length) {
                const altCategory = targetCategory === primary ? secondary : primary;
                finalPool = candidates.filter(c => {
                    if (!rarities.includes(c.rarity)) return false;
                    if (_categoriseItem(c) !== altCategory) return false;
                    if (usedNames.has(c.name.toLowerCase())) return false;
                    if (_isRejectedByProficiency(c, classNames)) return false;
                    if (_isRejectedByAttunementRestriction(c, classNames)) return false;
                    if (_isGenericItem(c.name)) return false;
                    return true;
                });
                if (finalPool.length) targetCategory = altCategory;
            }

            // Last resort: any proficiency-safe named item at the right rarity
            if (!finalPool.length) {
                finalPool = candidates.filter(c => {
                    if (!rarities.includes(c.rarity)) return false;
                    if (usedNames.has(c.name.toLowerCase())) return false;
                    if (_isRejectedByProficiency(c, classNames)) return false;
                    if (_isRejectedByAttunementRestriction(c, classNames)) return false;
                    if (_isGenericItem(c.name)) return false;
                    return true;
                });
            }

            if (!finalPool.length) continue;

            // Weighted pick: synergy × 10 tickets, attunement boost, demote list
            const weights = finalPool.map(c => {
                let w = Math.max(1, Math.floor(_scoreSynergy(c, actorTraits) * 10));
                if (c.requiresAttunement) w *= 3;
                if (SIGNATURE_DEMOTE.has(c.name.toLowerCase())) w = Math.max(1, Math.floor(w * 0.1));
                return w;
            });
            let ticket = Math.floor(Math.random() * weights.reduce((a, b) => a + b, 0));
            let pick     = finalPool[0];
            for (let i = 0; i < finalPool.length; i++) {
                ticket -= weights[i];
                if (ticket < 0) {
                    pick = finalPool[i];
                    break;
                }
            }

            usedNames.add(pick.name.toLowerCase());
            partyUsedNames.add(pick.name.toLowerCase()); // propagate to other characters

            // Record allocation for party dedup + consecutive tracking
            const pickedCategory = _categoriseItem(pick);
            lastCategory = pickedCategory;
            partyAllocations.set(milestone, pickedCategory);

            planned.push({
                uuid:   pick.uuid,
                name:   pick.name,
                img:    pick.img,
                rarity: pick.rarity,
                level:  milestone,
                source: "auto"
            });
        }

        return planned;
    }

    // ── Scroll Seeding ────────────────────────────────────────────────────────

    /**
     * Suggest scrolls for one caster actor across all milestones.
     * For non-casters, returns an empty array.
     *
     * @param {Actor}   actor       The character to seed for
     * @param {Set}     banSet      Lowercase banned item names
     * @returns {Array} scrolls array suitable for storing in ledger.scrollPlan[id].scrolls
     */
    static async seedScrolls(actor, banSet = new Set()) {
        const classes   = this._getClassNames(actor);
        const isCaster  = classes.some(c =>
            FULL_CASTER_CLASSES.includes(c) || HALF_CASTER_CLASSES.includes(c)
        );
        if (!isCaster) return [];

        const isKnownSpell = classes.some(c => KNOWN_SPELL_CASTERS.includes(c));

        const knownSpells = new Set(
            actor.items
                .filter(i => i.type === "spell")
                .map(i => i.name.toLowerCase())
        );

        const classSpellPool = await this._fetchClassSpells(classes, banSet);
        const scrolls = [];
        const { milestones: _ms, scroll: MILESTONE_SCROLL_LEVEL } = _buildMilestoneTables();

        for (const milestone of _ms) {
            if (Math.random() > 0.7) continue;

            const spellLevels = MILESTONE_SCROLL_LEVEL[milestone] ?? [1];
            const pool = classSpellPool.filter(s => {
                if (!spellLevels.includes(s.spellLevel)) return false;
                if (knownSpells.has(s.name.toLowerCase())) return false;
                return true;
            });
            if (!pool.length) continue;

            const usedNames = new Set(scrolls.map(s => s.spellName));
            const fresh = pool.filter(s => !usedNames.has(s.name));
            if (!fresh.length) continue;

            const pick = this._pickSpell(fresh, isKnownSpell);
            if (!pick) continue;

            scrolls.push({
                spellName:  pick.name,
                spellLevel: pick.spellLevel,
                level:      milestone,
                img:        pick.img,
                uuid:       pick.uuid ?? null,
                source:     "auto"
            });
        }

        return scrolls;
    }

    // ── Role Detection ────────────────────────────────────────────────────────

    static _detectRole(actor) {
        const classes = this._getClassNames(actor);
        const isMonk        = classes.includes(MONK_CLASS);
        const isDivine      = classes.some(c => DIVINE_CLASSES.includes(c));
        const hasFullCaster = classes.some(c => FULL_CASTER_CLASSES.includes(c));
        const hasMartial    = classes.some(c => MARTIAL_CLASSES.includes(c));
        const hasHalf       = classes.some(c => HALF_CASTER_CLASSES.includes(c));

        if (isMonk) return "monk";
        if (hasFullCaster && hasMartial) return "hybrid";
        if (isDivine) return "divine";
        if (hasFullCaster) return "caster";
        if (hasHalf)       return "half-caster";
        return "martial";
    }

    static _getClassNames(actor) {
        const SA = game.ionrift?.library?.system;
        if (SA) return SA.getClassNames(actor).map(c => c.toLowerCase().trim());
        return Object.values(actor.classes || {}).map(c => (c.name || "").toLowerCase().trim());
    }

    // ── Compendium Queries ────────────────────────────────────────────────────

    /**
     * Pull magic items from dnd5e compendium with enriched type data.
     * Returns { uuid, name, img, rarity, itemType, subtype, armorType, weaponType,
     *            description, requiresAttunement }.
     */
    static async _fetchCandidates(classNames, banSet) {
        const pack = game.packs.get("dnd5e.items");
        if (!pack) return this._fallbackSignaturePool(classNames);

        const index = await pack.getIndex({
            fields: [
                "system.rarity", "type", "img",
                "system.type.value",
                "system.armor.type",
                "system.type.baseItem",
                "system.attunement",
                "system.description.value"
            ]
        });
        const results = [];

        const allowedRarities = new Set([
            "uncommon", "rare", "veryRare", "legendary", "very rare"
        ]);

        for (const entry of index) {
            if (!entry.system?.rarity) continue;
            const rarity = entry.system.rarity.toLowerCase().replace(" ", "");
            if (!allowedRarities.has(rarity) && !allowedRarities.has(entry.system.rarity)) continue;
            if (!["weapon", "equipment"].includes(entry.type)) continue;
            if (banSet.has(entry.name.toLowerCase())) continue;

            const normalRarity = entry.system.rarity === "very rare" ? "veryRare" : entry.system.rarity;

            const subtype    = entry.system?.type?.value || "";
            const armorType  = entry.system?.armor?.type || "";
            const weaponType = entry.type === "weapon" ? subtype : "";

            // Resolve effective armor type: armor.type takes priority,
            // then type.value for equipment with armor-like subtypes
            const effectiveArmorType = armorType
                || (entry.type === "equipment" && ["light", "medium", "heavy", "shield"].includes(subtype) ? subtype : "");

            const att = entry.system?.attunement;
            const requiresAttunement = att === "required" || att === "optional";

            results.push({
                uuid:                 `Compendium.dnd5e.items.Item.${entry._id}`,
                name:                 entry.name,
                img:                  entry.img || "icons/svg/item-bag.svg",
                rarity:               normalRarity,
                itemType:             entry.type,
                subtype:              subtype,
                armorType:            effectiveArmorType,
                weaponType:           weaponType,
                description:          entry.system?.description?.value ?? "",
                requiresAttunement
            });
        }

        return results;
    }

    /**
     * Pull spells from the forged world scroll compendium (Scroll Forge output).
     * Returns { name, spellLevel, school, img, uuid }.
     */
    static async _fetchClassSpells(classes, banSet) {
        const forgedId = `world.${ScrollForge.WORLD_PACK_NAME}`;
        const pack = game.packs.get(forgedId);
        if (!pack) return this._fallbackScrollPool();

        const index = await pack.getIndex({
            fields: ["flags", "img", "system.type"]
        });
        const results = [];

        for (const entry of index) {
            const iw = entry.flags?.["ionrift-quartermaster"] ?? {};
            const meta = iw.scrollMeta;
            if (!meta?.spellName) continue;
            const spellLevel = meta.spellLevel;
            if (typeof spellLevel !== "number" || spellLevel < 1) continue;
            if (banSet.has(meta.spellName.toLowerCase())) continue;

            results.push({
                uuid:       `Compendium.${forgedId}.Item.${entry._id}`,
                name:       meta.spellName,
                spellLevel,
                school:     iw.school ?? "unknown",
                img:        entry.img || "icons/sundries/scrolls/scroll-writing-orange-black.webp"
            });
        }

        if (!results.length) return this._fallbackScrollPool();

        return results;
    }

    /**
     * Apply school-based weighting to pick a spell.
     * For known-spell casters: prefer utility schools (abjuration, divination, transmutation).
     * For prepared casters: prefer situational schools (conjuration, abjuration, necromancy).
     */
    static _pickSpell(pool, isKnownSpell) {
        if (!pool.length) return null;

        const utilitySchools     = new Set(["abj", "div", "trs"]);
        const situationalSchools = new Set(["con", "abj", "nec"]);
        const preferred = isKnownSpell ? utilitySchools : situationalSchools;

        const weighted = [];
        for (const spell of pool) {
            const weight = preferred.has(spell.school) ? 3 : 1;
            for (let i = 0; i < weight; i++) weighted.push(spell);
        }

        return weighted[Math.floor(Math.random() * weighted.length)];
    }

    // ── Static Fallback Pools ─────────────────────────────────────────────────

    static _fallbackSignaturePool(classNames) {
        const casterItems = [
            { uuid: null, name: "Pearl of Power",       rarity: "uncommon", img: "icons/commodities/gems/pearl-white.webp",                itemType: "equipment", subtype: "wondrous", armorType: "", weaponType: "" },
            { uuid: null, name: "Cloak of Protection",  rarity: "uncommon", img: "icons/equipment/back/cloak-collared-green.webp",          itemType: "equipment", subtype: "wondrous", armorType: "", weaponType: "" },
            { uuid: null, name: "Staff of Power",       rarity: "veryRare", img: "icons/weapons/staves/staff-ornate-purple.webp",           itemType: "equipment", subtype: "staff",    armorType: "", weaponType: "" },
            { uuid: null, name: "Ring of Spell Storing", rarity: "rare",   img: "icons/equipment/finger/ring-faceted-silver.webp",          itemType: "equipment", subtype: "ring",     armorType: "", weaponType: "" }
        ];
        const martialItems = [
            { uuid: null, name: "Flame Tongue Longsword", rarity: "rare",     img: "icons/weapons/swords/sword-guard-red.webp",            itemType: "weapon", subtype: "martialM", armorType: "", weaponType: "martialM" },
            { uuid: null, name: "Sentinel Shield",        rarity: "uncommon", img: "icons/equipment/shield/buckler-wooden-boss-steel.webp", itemType: "equipment", subtype: "shield",  armorType: "shield", weaponType: "" },
            { uuid: null, name: "Amulet of Health",       rarity: "rare",     img: "icons/equipment/neck/pendant-ruby-gold.webp",           itemType: "equipment", subtype: "wondrous", armorType: "", weaponType: "" },
            { uuid: null, name: "Vorpal Sword",           rarity: "legendary", img: "icons/weapons/swords/sword-guard-gold.webp",           itemType: "weapon", subtype: "martialM", armorType: "", weaponType: "martialM" }
        ];
        // Rough role detection from class names
        const isCaster = classNames.some(c => FULL_CASTER_CLASSES.includes(c));
        return isCaster ? casterItems : martialItems;
    }

    static _fallbackScrollPool() {
        return [
            { uuid: null, name: "Shield",          spellLevel: 1, school: "abj", img: "icons/sundries/scrolls/scroll-writing-orange-black.webp" },
            { uuid: null, name: "Detect Magic",    spellLevel: 1, school: "div", img: "icons/sundries/scrolls/scroll-writing-orange-black.webp" },
            { uuid: null, name: "Misty Step",      spellLevel: 2, school: "con", img: "icons/sundries/scrolls/scroll-writing-orange-black.webp" },
            { uuid: null, name: "Counterspell",    spellLevel: 3, school: "abj", img: "icons/sundries/scrolls/scroll-writing-orange-black.webp" },
            { uuid: null, name: "Greater Invisibility", spellLevel: 4, school: "ill", img: "icons/sundries/scrolls/scroll-writing-orange-black.webp" },
            { uuid: null, name: "Telekinesis",     spellLevel: 5, school: "trs", img: "icons/sundries/scrolls/scroll-writing-orange-black.webp" }
        ];
    }

    // ── Jitter Resolution ─────────────────────────────────────────────────────

    /**
     * Map item rarity to its natural milestone floor.
     * Attunement-requiring items get bumped +1 milestone slot.
     */
    static _rarityToMilestone(rarity, attuned = false) {
        const ms = SignatureLedger.MILESTONES;
        // Map rarity to positional index: 0=common/uncommon, 1=rare, 3=veryRare, 4=legendary
        const posMap = { common: 0, uncommon: 0, rare: 1, veryRare: 3, legendary: 4 };
        const pos = posMap[rarity] ?? 0;
        const floor = ms[Math.min(pos, ms.length - 1)];
        if (!attuned) return floor;

        const idx = ms.indexOf(floor);
        return ms[Math.min(idx + 1, ms.length - 1)];
    }

    /**
     * Resolve the milestone for an auto-seeded shelf entry based on rarity.
     * Items always land at their exact rarity-based milestone.
     * Manually planned items bypass this entirely.
     *
     * @param {{ rarity: string, requiresAttunement?: boolean }} entry
     * @returns {number} resolved milestone level
     */
    static resolveJitter(entry) {
        return this._rarityToMilestone(
            entry.rarity,
            entry.requiresAttunement ?? false
        );
    }

    // ── Party Shelf Seeding ───────────────────────────────────────────────────

    /**
     * Suggest shared party-utility items across the milestone range.
     * Returns auto-placed entries (source: "auto") with pre-resolved jitter.
     *
     * Heuristic: prefers wondrous items (equipment type, not weapon) with
     * broad utility - items with charges/uses, or that benefit multiple roles.
     *
     * @param {Actor[]}  partyActors  Active party members
     * @param {Set}      banSet       Lowercase banned item names
     * @returns {Array}  Party shelf entries ready for storage
     */
    static async seedPartyShelf(partyActors, banSet = new Set()) {
        const candidates = await this._fetchShelfCandidates(banSet);
        if (!candidates.length) return [];

        const seeded = [];
        const usedNames = new Set();

        const targetCount = Math.min(candidates.length, 3 + Math.floor(Math.random() * 3));

        const shuffled = [...candidates].sort(() => Math.random() - 0.5);

        for (const item of shuffled) {
            if (seeded.length >= targetCount) break;
            if (usedNames.has(item.name.toLowerCase())) continue;

            usedNames.add(item.name.toLowerCase());

            const entry = {
                uuid:               item.uuid,
                name:               item.name,
                img:                item.img,
                rarity:             item.rarity,
                requiresAttunement: item.requiresAttunement ?? false,
                delivered:          false,
                level:              null,
                resolvedLevel:      null,
                source:             "auto"
            };

            entry.resolvedLevel = this.resolveJitter(entry);
            entry.level         = entry.resolvedLevel;
            seeded.push(entry);
        }

        return seeded;
    }

    /**
     * Pull party-utility items from configured compendiums.
     * Reads the partyShelfSources setting; falls back to dnd5e.items.
     * Preferences:
     *   - Equipment type (wondrous), not weapons (those are signature-grade)
     *   - Items with charges (uses.max > 0) get a score boost
     *   - Uncommon-to-VeryRare range (common too weak, legendary too defining)
     */
    static async _fetchShelfCandidates(banSet) {
        const { PartyShelfSourceApp } = await import("../apps/PartyShelfSourceApp.js");
        const sourceIds = PartyShelfSourceApp.getEnabledSources();

        const results = [];
        const seen    = new Set();
        const allowedRarities = new Set(["uncommon", "rare", "veryRare", "very rare"]);

        for (const packId of sourceIds) {
            const pack = game.packs.get(packId);
            if (!pack || pack.documentName !== "Item") continue;

            const index = await pack.getIndex({
                fields: ["system.rarity", "type", "img", "system.attunement", "system.uses"]
            });

            for (const entry of index) {
                if (!entry.system?.rarity) continue;
                const rarity = entry.system.rarity.toLowerCase().replace(" ", "");
                if (!allowedRarities.has(rarity) && !allowedRarities.has(entry.system.rarity)) continue;

                if (entry.type !== "equipment") continue;

                const key = entry.name.toLowerCase();
                if (banSet.has(key) || seen.has(key)) continue;
                seen.add(key);

                const normalRarity = entry.system.rarity === "very rare" ? "veryRare" : entry.system.rarity;
                const hasCharges   = (entry.system.uses?.max ?? 0) > 0;
                const attuned      = !!entry.system.attunement;

                let score = 1;
                if (hasCharges) score += 2;
                if (normalRarity === "uncommon") score += 1;

                results.push({
                    uuid:               `Compendium.${packId}.Item.${entry._id}`,
                    name:               entry.name,
                    img:                entry.img || "icons/svg/item-bag.svg",
                    rarity:             normalRarity,
                    requiresAttunement: attuned,
                    _score:             score
                });
            }
        }

        if (!results.length) return this._fallbackShelfPool();

        results.sort((a, b) => b._score - a._score || Math.random() - 0.5);
        return results;
    }

    static _fallbackShelfPool() {
        return [
            { uuid: null, name: "Bag of Holding",       rarity: "uncommon",  requiresAttunement: false, img: "icons/containers/bags/pack-leather-tan.webp" },
            { uuid: null, name: "Cloak of Protection",  rarity: "uncommon",  requiresAttunement: true,  img: "icons/equipment/back/cloak-collared-green.webp" },
            { uuid: null, name: "Boots of Speed",       rarity: "rare",      requiresAttunement: true,  img: "icons/equipment/feet/boots-laced-simple-leather.webp" },
            { uuid: null, name: "Portable Hole",        rarity: "rare",      requiresAttunement: false, img: "icons/commodities/cloth/cloth-bolt-black.webp" },
            { uuid: null, name: "Eversmoking Bottle",   rarity: "uncommon",  requiresAttunement: false, img: "icons/containers/bottles/bottle-corked-labeled-blue.webp" }
        ];
    }
}

export const _testInternals = {
    _parseAttunementClasses,
    _isRejectedByProficiency,
    _isRejectedByAttunementRestriction,
    _categoriseItem,
    _isGenericItem,
    _buildMilestoneTables,
    _buildArchetypeTables,
    RARITY_CURVE,
    ARCHETYPE_CURVE,
    FOCUS_SUBTYPES,
    ATTUNEMENT_CLASS_RE,
};
