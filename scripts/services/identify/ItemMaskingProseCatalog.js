import { MODULE_ID } from "../../data/moduleId.js";
/**
 * ItemMaskingHelper
 *
 * Applies dnd5e identification masking to magical items from the Cache
 * Generator. Strips magical identity from names, generates mundane
 * descriptions with subtle quality hints scaled by rarity.
 *
 * All descriptive text is original. No publisher prose is retained.
 *
 * Near-term: uses `system.identified` flag.
 * Backlog: server-authoritative pattern not client-inspectable.
 */

import { TerrainDataRegistry } from "../loot/TerrainDataRegistry.js";
import { applyAuthoredDisguise } from "./AuthoredDisguise.js";

/**
 * Base prices, mundane name/description tables, and sensory hint catalogs
 * for ItemMaskingHelper.
 */
export class ItemMaskingProseCatalog {
    // ── Base Item Price Lookup ───────────────────────────────────────

    /**
     * Best-effort base-price lookup. Exact fidelity is not the goal;
     * we want the masked price to sit in the mundane range so a magical
     * Greataxe doesn't stand out next to a mundane Greataxe in the
     * same cache.
     *
     * Precedence:
     *   1. dnd5e baseItem id (weapons, armor)
     *   2. Category heuristic by type + derived base name
     *   3. null (keep existing price)
     */
    static _lookupBasePrice(baseItemKey, type, baseItemName) {
        if (baseItemKey && this._BASE_ITEM_PRICES[baseItemKey]) {
            return this._BASE_ITEM_PRICES[baseItemKey];
        }

        const nameLower = (baseItemName || "").toLowerCase();
        const t = (type || "").toLowerCase();

        if (t === "weapon") return { value: 15, denomination: "gp" };
        if (t === "armor" || t === "equipment") {
            if (/\bshield\b/.test(nameLower)) return { value: 10, denomination: "gp" };
            if (/\bring\s+mail\b/.test(nameLower)) {
                return this._BASE_ITEM_PRICES.ringmail ?? { value: 30, denomination: "gp" };
            }
            if (/\b(?:cloak|robe|hat|belt|boots|gloves|gauntlets|bracers|circlet|hood)\b/.test(nameLower)) {
                return { value: 5, denomination: "gp" };
            }
            if (/\b(?:ring|amulet|pendant|necklace)\b/.test(nameLower)) {
                return { value: 5, denomination: "gp" };
            }
            return { value: 20, denomination: "gp" };
        }
        if (t === "consumable") {
            if (/potion|elixir|philter|draught/.test(nameLower)) return { value: 50, denomination: "gp" };
            if (/scroll/.test(nameLower)) return { value: 25, denomination: "gp" };
            return { value: 10, denomination: "gp" };
        }
        if (t === "loot" || t === "tool") return { value: 5, denomination: "gp" };

        return null;
    }

    // Base-item prices drawn from dnd5e SRD reference values. Not meant
    // to be exhaustive - anything missing falls through to the category
    // heuristic above, which only needs to land in the "looks mundane"
    // range to do its job.
    static _BASE_ITEM_PRICES = {
        longsword:      { value: 15, denomination: "gp" },
        shortsword:     { value: 10, denomination: "gp" },
        greatsword:     { value: 50, denomination: "gp" },
        rapier:         { value: 25, denomination: "gp" },
        scimitar:       { value: 25, denomination: "gp" },
        dagger:         { value: 2,  denomination: "gp" },
        handaxe:        { value: 5,  denomination: "gp" },
        battleaxe:      { value: 10, denomination: "gp" },
        greataxe:       { value: 30, denomination: "gp" },
        waraxe:         { value: 30, denomination: "gp" },
        warhammer:      { value: 15, denomination: "gp" },
        lighthammer:    { value: 2,  denomination: "gp" },
        maul:           { value: 10, denomination: "gp" },
        morningstar:    { value: 15, denomination: "gp" },
        mace:           { value: 5,  denomination: "gp" },
        club:           { value: 1,  denomination: "sp" },
        greatclub:      { value: 2,  denomination: "sp" },
        quarterstaff:   { value: 2,  denomination: "sp" },
        flail:          { value: 10, denomination: "gp" },
        glaive:         { value: 20, denomination: "gp" },
        halberd:        { value: 20, denomination: "gp" },
        pike:           { value: 5,  denomination: "gp" },
        spear:          { value: 1,  denomination: "gp" },
        javelin:        { value: 5,  denomination: "sp" },
        trident:        { value: 5,  denomination: "gp" },
        warpick:        { value: 5,  denomination: "gp" },
        shortbow:       { value: 25, denomination: "gp" },
        longbow:        { value: 50, denomination: "gp" },
        handcrossbow:   { value: 75, denomination: "gp" },
        lightcrossbow:  { value: 25, denomination: "gp" },
        heavycrossbow:  { value: 50, denomination: "gp" },
        sling:          { value: 1,  denomination: "sp" },
        blowgun:        { value: 10, denomination: "gp" },
        whip:           { value: 2,  denomination: "gp" },
        net:            { value: 1,  denomination: "gp" },
        lance:          { value: 10, denomination: "gp" },
        padded:         { value: 5,   denomination: "gp" },
        leather:        { value: 10,  denomination: "gp" },
        studdedleather: { value: 45,  denomination: "gp" },
        hide:           { value: 10,  denomination: "gp" },
        chainshirt:     { value: 50,  denomination: "gp" },
        scalemail:      { value: 50,  denomination: "gp" },
        breastplate:    { value: 400, denomination: "gp" },
        halfplate:      { value: 750, denomination: "gp" },
        ringmail:       { value: 30,  denomination: "gp" },
        chainmail:      { value: 75,  denomination: "gp" },
        splint:         { value: 200, denomination: "gp" },
        plate:          { value: 1500, denomination: "gp" },
        shield:         { value: 10,  denomination: "gp" }
    };

    // ── Name Derivation ──────────────────────────────────────────────

    /**
     * Priority:
     *   1. Named-item override map (compound magical names to base type)
     *   2. Consumable type masking (potions, scrolls, wands, rods)
     *   3. system.type.baseItem field
     *   4. Strip "of X" suffixes, "+N", and magical prefixes
     *   5. Wondrous type map on the stripped label (equipment lacking baseItem)
     *   6. Stripped label fallback
     */
    static _deriveBaseItemName(itemMeta) {
        const rawName = (itemMeta.name || "").trim();
        const nameLower = rawName.toLowerCase();
        const type = (itemMeta.type || "").toLowerCase();
        const baseItem = itemMeta._baseItem
            || itemMeta.baseItem
            || itemMeta.system?.baseItem
            || itemMeta.system?.type?.baseItem
            || "";
        const subtype = this._consumableSubtype(itemMeta);

        // 1. Named-item overrides (famous magical items -> base weapon/armor type)
        for (const [pattern, base] of this._NAMED_ITEM_OVERRIDES) {
            if (pattern.test(nameLower)) return base;
        }

        // 2. Consumable masking: potions, scrolls, oils get generic names
        const consumableMask = this._maskConsumableName(nameLower, type, subtype);
        if (consumableMask) return consumableMask;

        // 3. Wand/rod/staff masking (type or name-based)
        const obscureMagicalItems = game?.settings?.get(MODULE_ID, "obscureMagicalItems") ?? true;
        if (obscureMagicalItems) {
            const focusMask = this._maskFocusName(nameLower, type);
            if (focusMask) return focusMask;
        }

        // 4. Explicit baseItem field (with terse-ID expansion and self-reference guard)
        if (baseItem && typeof baseItem === "string") {
            const baseKey = baseItem.toLowerCase().trim();
            const compactKey = baseKey.replace(/[-_\s]/g, "");
            const expanded = this._BASE_ITEM_NAMES[baseKey] ?? this._BASE_ITEM_NAMES[compactKey];
            if (expanded) return expanded;

            const humanised = this._capitalise(baseItem);
            const humanLower = humanised.toLowerCase();
            const isSelfReferential = (humanLower === nameLower && /\s/.test(rawName))
                || /\bof\b/i.test(humanised)
                || /(?:['’]s|s['’])\s+/i.test(humanised);
            if (!isSelfReferential) {
                return humanised;
            }
        }

        // 5. Strip parentheticals, "+N", "of X" suffixes, possessives, and magical prefixes
        let strippedName = rawName;
        strippedName = strippedName.replace(/\s*\([^)]*\)\s*/g, " ").trim();
        strippedName = strippedName.replace(/\s*\+\d+\b\s*/g, " ").replace(/,\s*\+\d+\b/g, "").trim();
        if (!this._PRESERVED_OF_PHRASES_RE.test(strippedName)) {
            strippedName = strippedName.replace(/\s+of\s+.+$/i, "").trim();
        }
        if (!this._PRESERVED_POSSESSIVE_RE.test(strippedName)) {
            const dePossessed = strippedName.replace(/^.+?(?:['’]s|s['’])\s+/i, "").trim();
            if (dePossessed.length >= 3) strippedName = dePossessed;
        }
        for (const pattern of this._PREFIX_PATTERNS) {
            const next = strippedName.replace(pattern, "").trim();
            if (next.length > 2) strippedName = next;
        }
        strippedName = strippedName.replace(/\s{2,}/g, " ").trim();
        const strippedLower = strippedName.toLowerCase();

        // 6. Wondrous / physical archetype map on stripped label, then full name if needed
        if (type === "equipment" || type === "armor" || type === "loot" || type === "backpack" || /\bhandwraps?\b/i.test(strippedLower)) {
            const wondrousMask = this._matchWondrousType(strippedLower)
                ?? (strippedLower !== nameLower ? this._matchWondrousType(nameLower) : null);
            if (wondrousMask) return wondrousMask;
        }

        return strippedName || rawName;
    }

    static _PRESERVED_OF_PHRASES_RE = /^(?:ring\s+mail|(?:flask|jar|vial|phial|bottle|pouch|stick|tin|coil|pair|suit|deck)\s+of\s+(?:oil|dust|incense|salve|rope|rings|armor|cards))$/i;

    static _PRESERVED_POSSESSIVE_RE = /^(?:explorer'?s\s+clothing|filcher'?s\s+fork|alchemist'?s\s+fire)$/i;

    static _capitalise(str) {
        const words = str
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/[-_]/g, " ")
            .split(/\s+/);
        return words
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(" ");
    }

    // ── Consumable Name Masking ──────────────────────────────────────
    // PHB adventuring gear liquids (acid, holy water, alchemist's fire, antitoxin) are
    // intentionally not mapped here; see `_isObscurableConsumable`.

    /**
     * @param {string} nameLower
     * @param {string} type
     * @param {string} [subtype=""]  from `_consumableSubtype`
     */
    static _maskConsumableName(nameLower, type, subtype = "") {
        const obscureConsumables = game?.settings?.get(MODULE_ID, "obscureConsumables") ?? true;
        const obscureScrolls = game?.settings?.get(MODULE_ID, "obscureScrolls") ?? true;

        if (/scroll/i.test(nameLower)) {
            return obscureScrolls ? "Unidentified Scroll" : null;
        }

        if (!obscureConsumables) return null;

        const st = (subtype || "").toLowerCase();

        if (type === "consumable" || /potion|elixir|philter|draught|oil of/i.test(nameLower)) {
            if (/potion|elixir|philter|draught/i.test(nameLower)) return _pick(this._POTION_NAMES);
            if (/oil\s+of/i.test(nameLower))   return _pick(this._OIL_NAMES);
            if (/dust|powder/i.test(nameLower)) return "Pouch of Dust";
            if (/bead|marble/i.test(nameLower)) return "Small Bead";
            if (/candle/i.test(nameLower))      return "Tallow Candle";
            if (/incense/i.test(nameLower))     return "Stick of Incense";
            if (/salve|balm|ointment/i.test(nameLower)) return "Tin of Salve";
            if (
                st === "potion"
                && this._isObscurableConsumable({ name: nameLower, type, subtype: st })
            ) {
                return _pick(this._POTION_NAMES);
            }
        }
        return null;
    }

    static _POTION_NAMES = [
        "Sealed Vial", "Stoppered Flask", "Corked Bottle", "Small Phial"
    ];

    static _OIL_NAMES = [
        "Flask of Oil", "Sealed Oil Jar", "Stoppered Oil Flask"
    ];

    // ── Focus Item Masking (wands, rods, staves) ─────────────────────

    static _maskFocusName(nameLower, type) {
        if (/\bwand\b/i.test(nameLower))  return _pick(this._WAND_NAMES);
        if (/\brod\b/i.test(nameLower))   return _pick(this._ROD_NAMES);
        if (/\bstaff\b/i.test(nameLower) && type !== "weapon") return _pick(this._STAFF_NAMES);
        return null;
    }

    static _WAND_NAMES  = ["Carved Stick", "Thin Wooden Rod", "Tapered Stick"];
    static _ROD_NAMES   = ["Ornate Rod", "Heavy Short Rod", "Metal Rod"];
    static _STAFF_NAMES = ["Walking Staff", "Worn Wooden Staff", "Tall Staff"];

    // ── Wondrous Type Map ────────────────────────────────────────────

    static _matchWondrousType(nameLower) {
        for (const [pattern, label] of this._WONDROUS_MAP) {
            if (pattern.test(nameLower)) return label;
        }
        return null;
    }

    static _WONDROUS_MAP = [
        [/\bcrystal\s*ball\b/i,              "Glass Sphere"],
        [/\bioun\s*stone\b|\bioun\b|\baeon\s*stone\b/i, "Polished Stone"],
        [/\bhandwraps?\b|\bfist\s+wraps?\b/i, "Handwraps"],
        [/\b(?:cloak|mantle|cape)s?\b/i,     "Cloak"],
        [/\b(?:gloves|gauntlets)\b/i,        "Gloves"],
        [/\b(?:bracers|vambrace)s?\b/i,      "Bracers"],
        [/\b(?:boots|slippers)\b/i,          "Boots"],
        [/\bsandals?\b/i,                    "Sandals"],
        [/\bshoes?\b/i,                      "Shoes"],
        [/\b(?:belt|girdle|sash)(?:es|s)?\b/i, "Belt"],
        [/\b(?:amulet|periapt|pendant|medallion|brooch)s?\b/i, "Pendant"],
        [/\bnecklace\b/i,                    "Necklace"],
        [/\bring\s+mail\b/i,                 "Ring Mail"],
        [/\b(?:ring|signet)s?\b/i,           "Ring"],
        [/\b(?:robe|vestment)s?\b/i,         "Robe"],
        [/\b(?:hat|cap|hood)s?\b/i,          "Hat"],
        [/\bhelms?\b|\bhelmets?\b/i,         "Helm"],
        [/\bheadbands?\b/i,                  "Headband"],
        [/\bcirclets?\b/i,                   "Circlet"],
        [/\b(?:crown|diadem|tiara)s?\b/i,    "Crown"],
        [/\bmasks?\b/i,                      "Mask"],
        [/\b(?:goggles|lenses|eyeglasses|spectacles)\b/i, "Goggles"],
        [/\b(?:eyepiece|monocle)s?\b/i,      "Eyepiece"],
        [/^eyes\b/i,                         "Goggles"],
        [/\b(?:pouch|satchel)(?:es|s)?\b/i,  "Leather Pouch"],
        [/\b(?:backpack|rucksack|knapsack)s?\b/i, "Backpack"],
        [/\bhaversack\b|\bbag\b|\bsack\b/i,  "Leather Bag"],
        [/\b(?:tome|manual|libram)s?\b|\bbook\b/i, "Old Book"],
        [/\borb\b/i,                         "Glass Sphere"],
        [/\bfigurine\b|\bstatuette\b|\bidol\b/i, "Small Figurine"],
        [/\bmirror\b/i,                      "Hand Mirror"],
        [/\bstone\b/i,                       "Polished Stone"],
        [/\b(?:gem|jewel|opal|pearl|sapphire|ruby|emerald|diamond|amethyst|topaz|garnet|jade|onyx|quartz|prism)s?\b/i, "Cut Gemstone"],
        [/\b(?:carpet|rug)\b/i,              "Woven Rug"],
        [/\bbroom\b/i,                       "Broom"],
        [/\bcandle\b/i,                      "Candle"],
        [/\b(?:deck|cards)\b/i,              "Card Deck"],
        [/\brope\b/i,                        "Coil of Rope"],
        [/\b(?:lantern|lamp)\b/i,            "Lantern"],
        [/\b(?:censer|brazier|thurible)s?\b/i, "Censer"],
        [/\bhorn\b/i,                        "Horn"],
        [/\b(?:drum|lute|flute|harp|lyre|pipes|fiddle|mandolin)s?\b/i, "Musical Instrument"],
        [/\b(?:bottle|flask|decanter)\b/i,   "Sealed Bottle"],
        [/\bquiver\b/i,                      "Quiver"],
        [/\bbucklers?\b/i,                   "Buckler"],
        [/\bshield\b/i,                      "Shield"],
        [/\b(?:bracelet|bangle|wristband|armband)s?\b/i, "Bracelet"],
        [/\banklets?\b/i,                    "Anklets"],
        [/\b(?:choker|collar|gorget|torc)s?\b/i, "Collar"],
        [/\b(?:epaulet|epaulette|pauldron)s?\b/i, "Epaulets"],
        [/\b(?:blouse|tunic|shirt|jerkin|vest|doublet|jacket|coat)s?\b/i, "Tunic"],
        [/\b(?:sleeve|cuff)s?\b/i,           "Sleeves"],
        [/\bsaddles?\b/i,                    "Saddle"],
        [/\bhorseshoes?\b/i,                 "Horseshoes"],
        [/\b(?:shackles|manacles|fetters)\b/i, "Manacles"],
        [/\b(?:boat|skiff)s?\b/i,            "Small Boat"],
        [/\bkeys?\b/i,                       "Metal Key"],
        [/\bcompass(?:es)?\b/i,              "Compass"],
        [/\b(?:spyglass|telescope)(?:es)?\b/i, "Spyglass"],
        [/\bhourglass(?:es)?\b/i,            "Hourglass"],
        [/\b(?:chalice|goblet|tankard|stein)s?\b/i, "Goblet"],
        [/\b(?:cauldron|kettle)s?\b/i,       "Iron Pot"],
        [/\bbells?\b/i,                      "Small Bell"],
        [/\bwhistles?\b/i,                   "Whistle"],
        [/\b(?:badge|insignia|emblem)s?\b/i, "Badge"],
    ];

    // ── Named Item Overrides ─────────────────────────────────────────
    // Maps famous compound magical names to their base physical type.

    static _NAMED_ITEM_OVERRIDES = [
        [/flame\s*tongue/i,             "Longsword"],
        [/frost\s*brand/i,              "Longsword"],
        [/sun\s*blade/i,                "Longsword"],
        [/moon\s*blade/i,               "Longsword"],
        [/vicious\s+\w+/i,             null], // fall through to baseItem
        [/vorpal/i,                     "Greatsword"],
        [/dancing\s+sword/i,            "Longsword"],
        [/holy\s*avenger/i,             "Longsword"],
        [/luck\s*blade/i,               "Shortsword"],
        [/defender/i,                   "Longsword"],
        [/dragon\s*slayer/i,            "Longsword"],
        [/giant\s*slayer/i,             "Greataxe"],
        [/berserker\s*axe/i,            "Greataxe"],
        [/dwarven\s*thrower/i,          "Warhammer"],
        [/hammer\s*of\s*thunderbolts/i, "Maul"],
        [/javelin\s*of\s*lightning/i,   "Javelin"],
        [/trident\s*of\s*fish/i,        "Trident"],
        [/mace\s*of\s*(disruption|smiting|terror)/i, "Mace"],
        [/oathbow/i,                    "Longbow"],
        [/dagger\s*of\s*venom/i,        "Dagger"],
        [/sword\s*of\s*wounding/i,      "Longsword"],
        [/sword\s*of\s*sharpness/i,     "Longsword"],
        [/nine\s*lives\s*stealer/i,     "Longsword"],
        [/sword\s*of\s*life/i,          "Greatsword"],
        [/scimitar\s*of\s*speed/i,      "Scimitar"],
        [/staff\s*of/i,                 "Walking Staff"],
        [/animated\s*shield/i,          "Shield"],
        [/spell\s*guard/i,              "Shield"],
        [/arrow[\s-]*catching/i,        "Shield"],
        [/\bwayfinder\b/i,              "Brass Compass"],
        [/\bholy\s+prayer\s+beads\b/i,  "Prayer Beads"],
    ].filter(([, v]) => v !== null);

    static _PREFIX_PATTERNS = [
        /^(Greater|Major|Moderate|Superior|Supreme|Lesser|Minor|True|Mythic|Cursed)\s+/i,
    ];

    // Terse dnd5e & PF2e baseItem identifiers that need full mundane names.
    // Weapons generally capitalise fine ("longsword" -> "Longsword"),
    // but armor IDs lose their type suffix without this map.
    static _BASE_ITEM_NAMES = {
        splint:        "Splint Armor",
        splintmail:    "Splint Mail",
        plate:         "Plate Armor",
        fullplate:     "Full Plate",
        halfplate:     "Half Plate Armor",
        chainmail:     "Chain Mail",
        chainshirt:    "Chain Shirt",
        ringmail:      "Ring Mail",
        scalemail:     "Scale Mail",
        breastplate:   "Breastplate",
        leather:       "Leather Armor",
        leatherarmor:  "Leather Armor",
        studdedleather:"Studded Leather Armor",
        studdedleatherarmor: "Studded Leather Armor",
        hide:          "Hide Armor",
        hidearmor:     "Hide Armor",
        padded:        "Padded Armor",
        paddedarmor:   "Padded Armor",
        explorersclothing: "Explorer's Clothing",
        shield:        "Shield",
        steelshield:   "Steel Shield",
        woodenshield:  "Wooden Shield",
        towershield:   "Tower Shield",
        fortressshield:"Fortress Shield",
        buckler:       "Buckler",
        handwrapsofmightyblows: "Handwraps",
        handwraps:     "Handwraps",
        handcrossbow:  "Hand Crossbow",
        heavycrossbow: "Heavy Crossbow",
        lightcrossbow: "Light Crossbow",
        shortbow:      "Shortbow",
        longbow:       "Longbow",
        compositelongbow: "Composite Longbow",
        compositeshortbow: "Composite Shortbow",
        greatclub:     "Greatclub",
        greatsword:    "Greatsword",
        bastardsword:  "Bastard Sword",
        greataxe:      "Greataxe",
        battleaxe:     "Battleaxe",
        handaxe:       "Handaxe",
        lighthammer:   "Light Hammer",
        warhammer:     "Warhammer",
        waraxe:        "War Axe",
        warpick:       "War Pick",
        greatpick:     "Greatpick",
        lightpick:     "Light Pick",
        lightmace:     "Light Mace",
        morningstar:   "Morningstar",
        quarterstaff:  "Quarterstaff",
        bostaff:       "Bo Staff",
        clandagger:    "Clan Dagger",
        shortsword:    "Shortsword",
        longsword:     "Longsword",
    };

    // ── Mundane Description Assembly ─────────────────────────────────

    static _deriveMundaneDescription(itemMeta, baseItemName, rarity, terrainTag) {
        const type = (itemMeta.type || "").toLowerCase();
        const baseItem = (itemMeta._baseItem || itemMeta.baseItem || "").toLowerCase();
        const displayName = baseItemName || itemMeta.name || "item";
        const nameLower = (itemMeta.name || "").toLowerCase();
        const subtype = this._consumableSubtype(itemMeta);

        // Consumables get dedicated appearance descriptions
        const consumableDesc = this._consumableDescription(nameLower, type, subtype);
        if (consumableDesc) return consumableDesc;

        // Focus items (wand/rod/staff)
        const focusDesc = this._focusDescription(nameLower);
        if (focusDesc) return focusDesc;

        // Category physical description + quality hints
        const category = this._categorise(type, baseItem, itemMeta.name);

        // Terrain-specific description override (Layer 2).
        // Check TerrainDataRegistry first; fall back to generic pools.
        const terrainPool = terrainTag
            ? TerrainDataRegistry.getItemDescriptions(terrainTag, category)
            : [];
        const pool = terrainPool.length
            ? terrainPool
            : (this._PHYSICAL_DESCRIPTIONS[category] ?? this._PHYSICAL_DESCRIPTIONS.generic);
        const physical = _pick(pool);
        const hints = this._selectHints(rarity);

        const parts = [physical.replace(/\{name\}/g, displayName)];
        for (const h of hints) parts.push(h);

        return `<p>${parts.join(" ")}</p>`;
    }

    // ── Consumable Descriptions ──────────────────────────────────────

    /**
     * @param {string} nameLower
     * @param {string} type
     * @param {string} [subtype=""]
     */
    static _consumableDescription(nameLower, type, subtype = "") {
        const obscureScrolls = game?.settings?.get(MODULE_ID, "obscureScrolls") ?? true;
        const obscureConsumables = game?.settings?.get(MODULE_ID, "obscureConsumables") ?? true;
        const st = (subtype || "").toLowerCase();

        if (/potion|elixir|philter|draught/i.test(nameLower)) {
            if (!obscureConsumables) return null;
            return `<p>${_pick(this._POTION_APPEARANCES)}</p>`;
        }
        if (/oil\s+of/i.test(nameLower)) {
            if (!obscureConsumables) return null;
            return `<p>${_pick(this._OIL_APPEARANCES)}</p>`;
        }
        if (st === "potion" && !/potion|elixir|philter|draught/i.test(nameLower)) {
            if (!obscureConsumables) return null;
            return `<p>${_pick(this._POTION_APPEARANCES)}</p>`;
        }
        if (/scroll/i.test(nameLower) && (type === "consumable" || type === "loot")) {
            if (!obscureScrolls) return null;
            return `<p>${_pick(this._SCROLL_APPEARANCES)}</p>`;
        }
        return null;
    }

    static _POTION_APPEARANCES = [
        "A thick, ruby-coloured liquid that clings to the glass. Smells faintly sweet.",
        "Pale blue and slightly luminescent. Odourless when stoppered.",
        "Murky green with flecks of gold suspended in it. Warm to the touch.",
        "Clear as water but heavier than expected. A single bubble rises slowly.",
        "Deep amber, like old honey. Smells faintly of dried herbs.",
        "Swirling silver and grey, never quite settling. The cork is sealed with wax.",
        "Warm to the touch, with a faint rose tint. The glass is unusually smooth.",
        "Nearly black with a thin oily film on the surface. Sealed tight.",
        "Bright orange with fine sediment at the bottom. Shaking it produces tiny sparks of colour.",
        "Cloudy white, viscous. Smells of nothing, which is unusual for something this old.",
    ];

    static _OIL_APPEARANCES = [
        "A small jar of translucent oil. Slightly slippery on the outside.",
        "Dark oil in a squat flask. Smells faintly metallic.",
        "Thin, almost watery oil with a faint amber sheen.",
        "Viscous and cool to the touch. The cork is stained with drips.",
    ];

    static _SCROLL_APPEARANCES = [
        "A rolled scroll, bound with a plain strip of leather. The inner face has not been read aloud or studied yet.",
        "A sealed scroll case. Whatever is inside stays folded until someone opens it properly.",
        "Tightly rolled parchment, ink visible only at the edge. Nothing readable without unrolling it.",
        "A scroll tied with cord and wax. The hand inside could be anything until it is opened with care.",
    ];

    // ── Focus Descriptions (wand/rod/staff) ──────────────────────────

    static _focusDescription(nameLower) {
        if (/\bwand\b/i.test(nameLower)) return `<p>${_pick(this._WAND_APPEARANCES)}</p>`;
        if (/\brod\b/i.test(nameLower))  return `<p>${_pick(this._ROD_APPEARANCES)}</p>`;
        if (/\bstaff\b/i.test(nameLower)) return `<p>${_pick(this._STAFF_APPEARANCES)}</p>`;
        return null;
    }

    static _WAND_APPEARANCES = [
        "A slender wooden stick, about a foot long. Smooth and slightly warm.",
        "Tapered dark wood with a faint grain pattern. Light for its length.",
        "A thin stick with a polished tip. The wood has a slight sheen.",
        "Pale wood, gently curved. A few faint notches along one side.",
    ];

    static _ROD_APPEARANCES = [
        "A heavy short rod of dark metal. Cool to the touch. No markings.",
        "An ornate rod, about an arm's length. The grip is wrapped in worn leather.",
        "A metal rod with a flared end. Heavier than it looks.",
    ];

    static _STAFF_APPEARANCES = [
        "A tall wooden staff, smooth from years of handling. Good for walking.",
        "Dark hardwood with a slight twist to the grain. The base is iron-shod.",
        "A plain staff, shoulder height. The wood is unusually dense.",
        "A walking staff with a gnarled head. Worn but solid.",
    ];

    // ── Category Classification ──────────────────────────────────────

    static _categorise(type, baseItem, name = "") {
        const n = (name || "").toLowerCase();
        const b = (baseItem || "").toLowerCase();
        const term = b || n;

        if (type === "weapon") {
            if (/sword|rapier|scimitar|blade/i.test(term))                       return "sword";
            if (/axe|hatchet/i.test(term))                                        return "axe";
            if (/bow|crossbow/i.test(term))                                       return "ranged";
            if (/mace|club|flail|hammer|maul/i.test(term))                        return "bludgeon";
            if (/dagger|knife/i.test(term))                                       return "dagger";
            if (/spear|pike|lance|javelin|trident|glaive|halberd/i.test(term))    return "polearm";
            if (/whip/i.test(term))                                               return "whip";
            if (/staff|quarterstaff/i.test(term))                                 return "staff_weapon";
            return "weapon_generic";
        }
        if (type === "equipment" || type === "armor") {
            if (/\bshield\b/i.test(term))                                              return "shield";
            if (/plate|mail|breastplate|splint|half plate/i.test(term))                return "heavy_armor";
            if (/leather|hide|studded|chain shirt|scale/i.test(term))                  return "light_armor";
            if (/\b(?:gloves|gauntlets)\b/i.test(term))                                return "gloves";
            if (/\b(?:cloak|mantle|cape)s?\b/i.test(term))                            return "cloak";
            if (/\b(?:boots|slippers)\b/i.test(term))                                  return "boots";
            if (/\b(?:bracers|vambrace)s?\b/i.test(term))                              return "bracers";
            if (/\b(?:belt|girdle)s?\b/i.test(term))                                   return "belt";
            if (/\b(?:robe|vestment)s?\b/i.test(term))                                 return "robe";
            if (/\b(?:amulet|necklace|pendant|periapt|medallion|brooch)s?\b/i.test(term)) return "necklace";
            if (/\bhelms?\b/i.test(term))                                              return "headwear";
            if (/\b(?:headband|circlet)s?\b/i.test(term))                              return "headwear";
            if (/\bring\s+mail\b/i.test(term))                                         return "heavy_armor";
            if (/\bring\b/i.test(term))                                                return "ring";
            if (/\bhaversack\b|\bbag\b|\bsack\b/i.test(term))                          return "bag";
            return "armor_generic";
        }
        if (type === "consumable") {
            if (/potion|elixir|philter|draught/i.test(n))                          return "potion";
            if (/scroll/i.test(n))                                                 return "scroll";
            return "consumable_generic";
        }
        return "generic";
    }

    // ── Physical Descriptions (arrays, random pick) ──────────────────

    static _PHYSICAL_DESCRIPTIONS = {
        sword: [
            "A {name} with a straight blade and a leather-wrapped grip.",
            "A {name}. The edge is even and the tang is firmly set.",
            "A {name} with a simple cross-guard. The fuller runs clean.",
        ],
        axe: [
            "A {name} with a broad head and a solid haft.",
            "A {name}. Heavy and well-balanced. Built for purpose.",
            "A {name} with a thick blade and an ash handle.",
        ],
        ranged: [
            "A {name}. Well-strung and balanced. Someone maintained this.",
            "A {name} with a smooth draw. The string is fresh.",
            "A {name}. The limbs are straight and the nocking point is clean.",
        ],
        bludgeon: [
            "A {name}. Solid and heavy. Practical, if unglamorous.",
            "A {name} with a dense head and a reinforced shaft.",
            "A {name}. The striking face is flat and even.",
        ],
        dagger: [
            "A {name}. Short blade, leather-wrapped grip.",
            "A {name} with a tapered point and a simple guard.",
            "A {name}. The sheath is plain but well-fitted.",
        ],
        polearm: [
            "A {name}. Long reach and a weighted tip.",
            "A {name} with a riveted head and a hardwood shaft.",
            "A {name}. The haft is smooth, worn by use.",
        ],
        whip: [
            "A {name}. Braided leather, supple but firm.",
            "A {name} with a knotted handle and a frayed tip.",
        ],
        staff_weapon: [
            "A {name}. Hardwood, iron-shod at the base.",
            "A {name}. Smooth and dense, balanced for striking.",
        ],
        weapon_generic: [
            "A {name}. Functional and maintained.",
            "A {name}. Nothing about it demands attention.",
        ],
        shield: [
            "A {name}. Dented from use but structurally sound.",
            "A {name} with a simple boss and leather straps.",
            "A {name}. The face is scratched but the rim is true.",
        ],
        heavy_armor: [
            "A {name}. Heavy and well-fitted. Regularly maintained.",
            "A {name} with solid rivets and an even surface.",
            "A {name}. The plates overlap cleanly. Functional.",
        ],
        light_armor: [
            "A {name}. Supple and fitted. Someone wore this often.",
            "A {name} with reinforced stitching at the shoulders.",
            "A {name}. Flexible and lightly oiled.",
        ],
        armor_generic: [
            "A {name}. Serviceable protection.",
            "A {name}. Worn but intact. No obvious damage.",
        ],
        ring: [
            "A simple metal ring. Slightly tarnished.",
            "A thin band, unadorned. Smooth on the inside.",
            "A ring of dark metal. No inscription visible.",
        ],
        cloak: [
            "A {name} of plain-woven cloth. Hooded.",
            "A {name}, travel-stained but whole.",
            "A {name} with a simple clasp. The fabric is dense.",
        ],
        boots: [
            "A pair of {name}. Worn soles but intact uppers.",
            "A pair of {name}. Leather, well-fitted. Lightly scuffed.",
            "A pair of {name} with sturdy stitching.",
        ],
        gloves: [
            "A pair of {name}. Soft leather, fitted close.",
            "A pair of {name}. Flexible and lightly padded.",
        ],
        headwear: [
            "A {name}. Simple metalwork, unadorned.",
            "A {name}. Light for its size. Sits comfortably.",
        ],
        bracers: [
            "A pair of {name}. Riveted leather, well-shaped.",
            "A pair of {name}. Snug fit, reinforced at the wrist.",
        ],
        belt: [
            "A {name} of thick leather with a plain buckle.",
            "A {name}. Wide and sturdy. Several notch holes.",
        ],
        robe: [
            "A {name} of heavy cloth. Simple cut, deep hood.",
            "A {name}. The hem is clean and the seams are tight.",
        ],
        necklace: [
            "A {name} on a plain chain. No visible stone.",
            "A {name}. Simple metalwork, sits flat against the chest.",
        ],
        bag: [
            "A {name} of stitched leather. Buckled shut.",
            "A {name}. Weathered but intact. The straps are solid.",
        ],
        consumable_generic: [
            "A small item of uncertain purpose. Seems intact.",
            "A sealed container. The contents are not immediately obvious.",
        ],
        generic: [
            "A {name}. Nothing remarkable at first glance.",
            "A {name}. Ordinary in every obvious way.",
            "A {name}. Unremarkable, but well-kept.",
        ],
    };

    // ── Quality Hint System ──────────────────────────────────────────
    // Rarity scales the number and intensity of hints appended to the
    // physical description. Hints are subtle tells, not identifications.

    static _selectHints(rarity) {
        const r = (rarity || "").toLowerCase().replace(/\s+/g, "");
        switch (r) {
            case "uncommon":  return [_pick(this._HINTS_SUBTLE)];
            case "rare":      return [_pick(this._HINTS_MODERATE), _pick(this._HINTS_SENSORY)];
            case "veryrare":  return [_pick(this._HINTS_NOTABLE), _pick(this._HINTS_SENSORY)];
            case "legendary":
            case "artifact":  return [_pick(this._HINTS_NOTABLE), _pick(this._HINTS_NOTABLE_ALT)];
            default:          return [_pick(this._HINTS_SUBTLE)];
        }
    }

    static _HINTS_SUBTLE = [
        "Well-maintained, with no sign of rust or wear.",
        "Unusually clean for something found here.",
        "The craftsmanship is a cut above average.",
        "Looks almost new despite the surroundings.",
        "The stitching is tight and even throughout.",
        "Polished to a soft sheen. Someone valued this.",
        "The proportions are precise. Carefully made.",
        "No maker's mark, but the work is deliberate.",
        "Sits well in the hand. Balanced.",
        "The surface is free of blemishes.",
    ];

    static _HINTS_MODERATE = [
        "The balance feels precise, almost deliberate.",
        "Faint engravings trace the surface, too fine for casual work.",
        "The material has an unusual lustre that catches the light.",
        "Lighter than expected for its size.",
        "The fit and finish suggest a specialist workshop.",
        "No maker's mark, but the quality speaks for itself.",
        "The edges are crisp, as though it were finished yesterday.",
        "Every join is flush. No gap or seam is visible.",
        "The grain of the material runs in an unusual pattern.",
        "A faint scent clings to it, something unfamiliar.",
    ];

    static _HINTS_NOTABLE = [
        "The metal holds a faint warmth even in cold air.",
        "Reflects light in a way that seems almost intentional.",
        "The grip settles into the hand as though shaped for it.",
        "Faint patterns in the grain, barely visible unless you look closely.",
        "A resonance when tapped, like a tuning fork.",
        "The edges are impossibly sharp, with no sign of recent honing.",
        "An odd weight to it, as though the centre of gravity shifts.",
        "The surface is flawless. Not a scratch, not a mark.",
        "It feels older than it looks. Much older.",
        "There is a stillness about it. The air near it feels calm.",
    ];

    static _HINTS_NOTABLE_ALT = [
        "The material is unfamiliar. Not quite steel, not quite stone.",
        "Looking at it too long produces a faint sense of vertigo.",
        "It hums faintly when no one is touching it.",
        "Dust does not seem to settle on its surface.",
        "The temperature around it is noticeably different.",
        "It feels heavier when you are not looking at it.",
        "Light bends slightly at its edges.",
        "A faint vibration, like a heartbeat, when held.",
    ];

    static _HINTS_SENSORY = [
        "Cool to the touch, even in warm air.",
        "Faintly warm. Not from the surroundings.",
        "Smoother than the material should allow.",
        "A slight tingle where it contacts skin.",
        "Smells faintly of iron and something floral.",
        "The weight shifts subtly as you turn it.",
        "Produces a faint tone when set down on stone.",
        "The texture changes depending on how you hold it.",
    ];
}


// ── Utility ──────────────────────────────────────────────────────────

function _pick(arr) {
    if (!arr?.length) return "";
    return arr[Math.floor(Math.random() * arr.length)];
}


export function applyItemMaskingProseCatalog(TargetClass) {
    for (const key of Object.getOwnPropertyNames(ItemMaskingProseCatalog)) {
        if (key === "length" || key === "name" || key === "prototype") continue;
        const desc = Object.getOwnPropertyDescriptor(ItemMaskingProseCatalog, key);
        if (desc) Object.defineProperty(TargetClass, key, desc);
    }
}
