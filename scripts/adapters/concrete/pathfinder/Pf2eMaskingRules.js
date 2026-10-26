import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../../data/moduleId.js";
import { TerrainDataRegistry } from "../../../services/loot/TerrainDataRegistry.js";
import { ItemMaskingHelper } from "../../../services/identify/ItemMaskingHelper.js";

// Talisman mundane icons mapped by surface name
const TALISMAN_ICONS = {
    "Small Stone":      "icons/commodities/gems/gem-rough-cushion-grey.webp",
    "Crystal Fragment": "icons/commodities/gems/gem-shattered-grey.webp",
    "Inscribed Chip":   "icons/commodities/currency/coin-embossed-bronze.webp",
    "Etched Disc":      "icons/commodities/currency/coin-engraved-sun-copper.webp",
};

// ── Rune & Prefix Stripping ──────────────────────────────────────────────

const PARENTHETICAL_RE = /\s*\([^)]*\)\s*/g;
const POTENCY_RE = /\s*\+[1-3]\b\s*/g;
const STRIKING_RE = /\b(?:Mythic |Major |Greater )?Striking\b\s*/gi;
const RESILIENT_RE = /\b(?:Mythic |Major |Greater )?Resilient\b\s*/gi;
const REINFORCING_RE = /\b(?:Supreme |Major |Greater |Moderate |Lesser |Minor )?Reinforcing\b\s*/gi;

const PROPERTY_RUNE_NAMES = [
    "Anarchic", "Astral", "Authorized", "Axiomatic", "Bane", "Bloodbane",
    "Bloodthirsty", "Brilliant", "Called", "Coating", "Conducting", "Corrosive",
    "Crushing", "Cunning", "Dancing", "Deathdrinking", "Decaying", "Demolishing",
    "Disrupting", "Earthbinding", "Energizing", "Extending", "Fanged", "Fearsome",
    "Flaming", "Frost", "Ghost Touch", "Giant-Killing", "Greater", "Grievous",
    "Hauling", "Holy", "Hooked", "Hopeful", "Impactful", "Impossible", "Keen",
    "Kin-Warding", "Merciful", "Nightmare", "Pacifying", "Returning", "Rooting",
    "Serrating", "Shifting", "Shock", "Shockwave", "Soft-Landing", "Spell-Storing",
    "Speed", "Swarming", "Thundering", "Underwater", "Unholy", "Vitalizing",
    "Vorpal", "Wounding",
    // Armor & Shield property runes
    "Acid-Resistant", "Advancing", "Aim-Aiding", "Antimagic", "Assisting",
    "Bitter", "Cold-Resistant", "Deathless", "Dread", "Electricity-Resistant",
    "Energy-Adaptive", "Energy-Resistant", "Ethereal", "Fire-Resistant",
    "Fortification", "Glamered", "Gliding", "Implacable", "Invisibility",
    "Magnetizing", "Malleable", "Misleading", "Portable", "Quenching",
    "Raiment", "Ready", "Rock-Braced", "Shadow", "Sinister Knight",
    "Slick", "Soaring", "Spellbastion", "Stanching", "Swallow-Spike",
    "True-Stanching", "Winged", "Catching", "Deflecting", "Launching",
];

const PROPERTY_RUNE_RE = new RegExp(
    `\\b(?:True |Major |Greater |Moderate |Lesser |Minor )?(?:${PROPERTY_RUNE_NAMES.join("|")})\\b\\s*`,
    "gi"
);

const MATERIAL_NAMES = [
    "Adamantine", "Cold Iron", "Dawnsilver", "Darkwood", "Duskwood", "Mithral",
    "Orichalcum", "Silver", "Sisterstone-Dusk", "Sisterstone-Scarlet", "Sisterstone",
    "Sovereign Steel", "Warpglass", "Abysium", "Djezet", "Inubrix", "Noqual",
    "Peachwood", "Siccatite", "Keep Stone", "Sloughstone", "Throneglass", "Dragonhide",
];

const MATERIAL_RE = new RegExp(
    `\\b(?:High-Grade |Standard-Grade |Low-Grade )?(?:${MATERIAL_NAMES.join("|")})\\b\\s*`,
    "gi"
);

const TIER_QUALIFIER_RE = /^(?:Major|Greater|Moderate|Lesser|Minor|Superior|Supreme|True|Mythic|Cursed)\s+|\s+(?:Major|Greater|Moderate|Lesser|Minor|Superior|Supreme|True)$/gi;

// ── Named Item Overrides ─────────────────────────────────────────────────
// Famous PF2e magical items → mundane base name

const NAMED_ITEM_OVERRIDES = [
    [/\bstaff\s+of\b/i,                 "Wooden Staff"],
    [/\bdoubling\s+rings?\b/i,          "Pair of Rings"],
    [/\bhandwraps?\s+of\b/i,            "Handwraps"],
    [/\bring\s+of\b/i,                  "Ring"],
    [/\bbracers?\s+of\b/i,             "Bracers"],
    [/\bboots?\s+of\b/i,               "Boots"],
    [/\bcloak\s+of\b/i,                "Cloak"],
    [/\bcirclet\s+of\b/i,              "Circlet"],
    [/\bamulet\s+of\b/i,               "Amulet"],
    [/\bbelt\s+of\b/i,                 "Belt"],
    [/\bgloves?\s+of\b/i,             "Gloves"],
    [/\bgoggles?\s+of\b/i,            "Goggles"],
    [/\bhat\s+of\b/i,                  "Hat"],
    [/\bhelm\s+of\b/i,                 "Helm"],
    [/\bmask\s+of\b/i,                 "Mask"],
    [/\bnecklace\s+of\b/i,            "Necklace"],
    [/\bmantle\s+of\b/i,              "Cloak"],
    [/\bwand\s+of\b/i,                "Carved Stick"],
    [/\bwayfinder\b/i,                 "Brass Compass"],
    [/\bholy\s+prayer\s+beads\b/i,     "Prayer Beads"],
];

// ── PF2e Usage Slot & Group Fallbacks ────────────────────────────────────

const USAGE_SLOT_NAMES = {
    wornamulet:           "Amulet",
    wornanklets:          "Anklets",
    wornarmbands:         "Bracers",
    wornbackpack:         "Backpack",
    wornbarding:          "Barding",
    wornbelt:             "Belt",
    wornbeltpouch:        "Belt Pouch",
    wornboots:            "Boots",
    wornbracelet:         "Bracelet",
    wornbracers:          "Bracers",
    worncap:              "Hat",
    worncape:             "Cloak",
    worncirclet:          "Circlet",
    worncloak:            "Cloak",
    wornclothing:         "Garment",
    worncollar:           "Collar",
    worncrown:            "Crown",
    wornepaulet:          "Epaulets",
    worneyeglasses:       "Goggles",
    worneyepiece:         "Eyepiece",
    wornfootwear:         "Boots",
    worngarment:          "Garment",
    worngloves:           "Gloves",
    wornheadwear:         "Headgear",
    wornhorseshoes:       "Horseshoes",
    wornmask:             "Mask",
    wornnecklace:         "Necklace",
    wornring:             "Ring",
    wornsaddle:           "Saddle",
    wornsandles:          "Sandals",
    wornshoes:            "Shoes",
    wornwrist:            "Bracelet",
    "tattooed-on-the-body": "Tattoo",
    implanted:            "Implant",
};

const GROUP_NAMES = {
    sword:      "Sword",
    axe:        "Axe",
    bow:        "Bow",
    brawling:   "Gauntlet",
    club:       "Club",
    crossbow:   "Crossbow",
    dart:       "Dart",
    firearm:    "Firearm",
    flail:      "Flail",
    hammer:     "Hammer",
    knife:      "Blade",
    pick:       "Pick",
    polearm:    "Polearm",
    shield:     "Shield",
    sling:      "Sling",
    spear:      "Spear",
    plate:      "Plate Armor",
    chain:      "Chain Armor",
    composite:  "Armor",
    leather:    "Leather Armor",
    cloth:      "Garment",
    wood:       "Wooden Armor",
    skeletal:   "Armor",
};

// Known mundane weapon, armor, and shield base names (single-word or standard compound)
const MUNDANE_WEAPON_ARMOR_RE = new RegExp(
    "^(?:" +
    // Standard multi-word mundane armor & shields
    "(?:Full|Half)\\s+Plate(?:\\s+Armor)?|" +
    "(?:Chain|Scale|Ring|Splint|Banded)\\s+(?:Mail|Shirt|Armor)|" +
    "(?:Padded|Leather|Studded\\s+Leather|Hide|Plate|Splint|Wood|Wooden|Leaf|Coral|Ceramic|Bastion|Fortress|Lattice|Lamellar|Quilted)\\s+Armor|" +
    "Studded\\s+Leather|Padded\\s+Leather|Explorer'?s\\s+Clothing|" +
    "(?:Steel|Wooden|Tower|Fortress|Heavy|Light|Hide|Buckler|Targe|Pavise|Meteor|Salvo|Razor|Klar)\\s+Shield|" +
    // Standard multi-word mundane weapons
    "(?:Bastard|Dueling|Aldori\\s+Dueling|Temple|Butterfly|Hook|Great|Long|Short|Broad|Two-Bladed|Nine-Ring|Wish|Rhoka|Sawtooth)\\s+(?:Sword|Blade|Saber|Sabre)|" +
    "(?:Composite\\s+)?(?:Long|Short|Horn|Daikyu|Gakgung|Reflex)\\s*Bow|" +
    "(?:Heavy|Light|Hand|Repeating(?:\\s+Hand|\\s+Heavy)?|Rotary|Sukgung|Gauntlet|Alchemical|Arbalest|Taw\\s+Launcher)\\s*Crossbow|" +
    "(?:Light|Heavy|War|Great|Gnome\\s+Hooked|Meteor|Earthbreaker)\\s*(?:Hammer|Mace|Pick|Flail|Club|Axe)|" +
    "(?:Clan|Parrying|Main-Gauche|Wish|Fighting|Throwing|Katar)\\s+(?:Dagger|Knife)|" +
    "(?:Bo|Fighting|Halfling\\s+Sling)\\s+Staff|" +
    "(?:Spiked|Bladed|Free-Hand|Fangwire)\\s+(?:Chain|Gauntlet)|" +
    "(?:Dueling|Flintlock|Dragon\\s+Mouth|Coat|Slide|Double-Barreled|Clan)\\s+(?:Pistol|Musket|Arquebus|Blunderbuss)|" +
    "(?:Elven\\s+Curve\\s+Blade|Elven\\s+Branched\\s+Spear|Dwarven\\s+Waraxe|Orc\\s+Necksplitter|Filcher'?s\\s+Fork|Dogslicer|Horsechopper)|" +
    // Single-word mundane weapons, armor, shields & handwraps
    "Longsword|Shortsword|Greatsword|Rapier|Scimitar|Falchion|Katana|Wakizashi|Nodachi|Khopesh|Macuahuitl|Sword|Blade|Saber|Sabre|" +
    "Dagger|Knife|Kukri|Starknife|Katar|Sai|Kama|Sickle|" +
    "Handaxe|Battleaxe|Greataxe|Hatchet|Axe|" +
    "Warhammer|Maul|Morningstar|Mace|Club|Greatclub|Flail|Hammer|Pick|Greatpick|Sap|Nunchaku|" +
    "Quarterstaff|Staff|Glaive|Halberd|Guisarme|Ranseur|Scythe|Pike|Spear|Longspear|Javelin|Trident|Lance|Naginata|Polearm|" +
    "Shortbow|Longbow|Crossbow|Bow|Sling|Blowgun|Whip|Net|Dart|Bola|Boomerang|Shuriken|Chakram|" +
    "Pistol|Musket|Arquebus|Blunderbuss|Firearm|Gun|Rifle|" +
    "Handwraps|Gauntlet|Gauntlets|" +
    "Breastplate|Chainmail|Platemail|Hauberk|Cuirass|Brigandine|Gambeson|Armor|" +
    "Buckler|Shield" +
    ")$",
    "i"
);

// Extracts the trailing physical head noun from a specific weapon/armor/shield name (e.g. "Smoking Sword" → "Sword", "Sturdy Shield" → "Shield")
const WEAPON_ARMOR_HEAD_NOUN_RE = /\b(Longsword|Shortsword|Greatsword|Bastard\s+Sword|Rapier|Scimitar|Falchion|Katana|Wakizashi|Sword|Blade|Saber|Sabre|Dagger|Knife|Kukri|Starknife|Katar|Sai|Kama|Sickle|Handaxe|Battleaxe|Greataxe|Hatchet|Axe|Warhammer|Maul|Morningstar|Mace|Club|Greatclub|Flail|Hammer|Greatpick|Pick|Quarterstaff|Staff|Glaive|Halberd|Guisarme|Ranseur|Scythe|Pike|Longspear|Spear|Javelin|Trident|Lance|Naginata|Shortbow|Longbow|Crossbow|Bow|Sling|Blowgun|Whip|Net|Pistol|Musket|Arquebus|Blunderbuss|Handwraps|Gauntlets|Gauntlet|Breastplate|Chainmail|Hauberk|Cuirass|Armor|Buckler|Shield|Weapon)$/i;

// Known single-word or canonical mundane nouns that are safe as final output
const SAFE_MUNDANE_NOUN_RE = /^(?:Amulet|Pendant|Necklace|Collar|Ring|Pair\s+of\s+Rings|Bracelet|Bracers|Anklets|Gloves|Handwraps|Boots|Sandals|Shoes|Belt|Belt\s+Pouch|Leather\s+Pouch|Leather\s+Bag|Backpack|Cloak|Robe|Tunic|Garment|Sleeves|Epaulets|Hat|Helm|Headband|Headgear|Circlet|Crown|Mask|Goggles|Eyepiece|Glass\s+Sphere|Polished\s+Stone|Cut\s+Gemstone|Small\s+Figurine|Hand\s+Mirror|Old\s+Book|Woven\s+Rug|Broom|Candle|Card\s+Deck|Coil\s+of\s+Rope|Lantern|Censer|Horn|Musical\s+Instrument|Sealed\s+Bottle|Quiver|Saddle|Horseshoes|Manacles|Small\s+Boat|Metal\s+Key|Compass|Brass\s+Compass|Spyglass|Hourglass|Goblet|Iron\s+Pot|Small\s+Bell|Whistle|Badge|Prayer\s+Beads|Wooden\s+Staff|Carved\s+Stick|Ornate\s+Rod|Unidentified\s+Scroll|Sealed\s+Vial|Stoppered\s+Flask|Corked\s+Bottle|Small\s+Phial|Flask\s+of\s+Oil|Sealed\s+Oil\s+Jar|Stoppered\s+Oil\s+Flask|Small\s+Stone|Crystal\s+Fragment|Inscribed\s+Chip|Etched\s+Disc|Tattoo|Implant|Barding|Trinket|Curio|Weapon|Armor|Shield|Item)$/i;

// ── Consumable Masking ───────────────────────────────────────────────────

const POTION_NAMES  = ["Sealed Vial", "Stoppered Flask", "Corked Bottle", "Small Phial"];
const OIL_NAMES     = ["Flask of Oil", "Sealed Oil Jar", "Stoppered Oil Flask"];
const TALISMAN_NAMES = ["Small Stone", "Crystal Fragment", "Inscribed Chip", "Etched Disc"];

function _pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// ── Mundane Description Templates ────────────────────────────────────────

const QUALITY_HINTS = {
    common:   ["ordinary", "standard-issue", "unremarkable"],
    uncommon: ["well-made", "finely crafted", "above average"],
    rare:     ["exceptional quality", "masterfully forged", "exquisitely worked"],
    unique:   ["a masterwork of extraordinary craft", "breathtaking workmanship", "unlike anything you have seen"],
};

const WEAPON_FLAVOUR = [
    "The grip is wrapped in worn leather, shaped by many hands.",
    "The balance feels natural, suggesting quality construction.",
    "A serviceable weapon, well-maintained by its previous owner.",
];

const BLADED_WEAPON_FLAVOUR = [
    "The blade shows signs of regular use but remains sharp.",
    "The grip is wrapped in worn leather, shaped by many hands.",
    "The balance feels natural, suggesting quality construction.",
    "A serviceable weapon, well-maintained by its previous owner.",
    "The metal has a slight sheen, free of pitting or corrosion.",
];

const UNARMED_WRAPS_FLAVOUR = [
    "The cloth strips are tightly woven and worn smooth at the knuckles.",
    "Sturdy fabric wraps, broken in by regular practice and kept clean.",
    "The bindings are supple and tear-free, ready to be wound around the hands.",
];

const ARMOR_FLAVOUR = [
    "The straps are well-oiled and the fittings secure.",
    "Scuff marks on the surface suggest it has seen use.",
    "The padding is intact and the fit seems adjustable.",
    "A practical piece of protection, competently made.",
];

const EQUIPMENT_FLAVOUR = [
    "A curious item, its purpose not immediately obvious.",
    "Compact and well-made, it sits comfortably in the hand.",
    "The craftsmanship is evident, though the function is unclear.",
];

const CONSUMABLE_FLAVOUR = [
    "The liquid catches the light with a faint shimmer.",
    "The seal is intact and the contents appear fresh.",
    "A faint herbal scent escapes around the stopper.",
];

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Detect whether a PF2e item is magical and should be masked.
 *
 * @param {object} itemMeta  Pool entry or item-like object
 * @param {object} [ctx]
 * @param {string} [ctx.terrainTag]  Terrain tag for description flavour
 * @returns {{ isMagical: boolean, baseItemName: string|null,
 *             mundaneDesc: string|null, obscuredImg: string|null }}
 */
export function detectPf2eMagical(itemMeta, { terrainTag } = {}) {
    if (!itemMeta) {
        return { isMagical: false, baseItemName: null, mundaneDesc: null, obscuredImg: null };
    }

    const nameLower = (itemMeta.name || "").toLowerCase();
    const type = (itemMeta.type || "").toLowerCase();
    const category = (itemMeta.system?.category ?? "").toLowerCase();

    // Read masking settings (match DnD5e adapter setting names)
    const obscureConsumables = game?.settings?.get(MODULE_ID, "obscureConsumables") ?? true;
    const obscureScrolls = game?.settings?.get(MODULE_ID, "obscureScrolls") ?? true;
    const obscureMagicalItems = game?.settings?.get(MODULE_ID, "obscureMagicalItems") ?? true;

    // Rarity check: PF2e stores rarity on system.traits.rarity
    const rarity = _getPf2eRarity(itemMeta);
    const rarityMagical = rarity !== "" && rarity !== "common" && rarity !== "none";

    // Trait check: look for "magical" in system.traits.value[]
    const traits = _getTraitValues(itemMeta);
    const hasMagicalTrait = traits.includes("magical");

    // Consumable classification
    const isScroll = type === "consumable" && category === "scroll";
    const isPotion = type === "consumable" && (category === "potion" || /\bpotion\b/i.test(nameLower));
    const isElixir = type === "consumable" && (category === "elixir" || /\belixir\b/i.test(nameLower));
    const isOil = type === "consumable" && (category === "oil" || /\boil\s+of\b/i.test(nameLower));
    const isTalisman = type === "consumable" && category === "talisman";
    const isConsumable = isPotion || isElixir || isOil || isTalisman;

    // Snares are excluded from masking per design decision
    const isSnare = type === "consumable" && category === "snare";
    if (isSnare) {
        return { isMagical: false, baseItemName: null, mundaneDesc: null, obscuredImg: null };
    }

    // Check for runes or potency prefix on equipment/weapons/armor
    const runes = itemMeta.system?.runes;
    const potencyVal = runes?.potency || itemMeta.system?.potencyRune?.value;
    const strikingVal = runes?.striking || itemMeta.system?.strikingRune?.value;
    const resilientVal = runes?.resilient || itemMeta.system?.resiliencyRune?.value;
    const hasRunes = Boolean(
        (potencyVal && Number(potencyVal) > 0)
        || (strikingVal && Number(strikingVal) > 0)
        || (resilientVal && Number(resilientVal) > 0)
        || (Array.isArray(runes?.property) && runes.property.length > 0)
        || /\+[1-3]\b/.test(itemMeta.name || "")
        || /\b(?:Major |Greater )?Striking\b/i.test(itemMeta.name || "")
        || /\b(?:Major |Greater )?Resilient\b/i.test(itemMeta.name || "")
    );

    // Determine magical status
    const isMagical = rarityMagical || hasMagicalTrait || isScroll || isConsumable || hasRunes;

    if (!isMagical) {
        return { isMagical: false, baseItemName: null, mundaneDesc: null, obscuredImg: null };
    }

    // Apply settings gates (same logic as DnD5e)
    const isGearMagic = (rarityMagical || hasRunes) && !isScroll && !isConsumable;
    if (isGearMagic && !obscureMagicalItems) {
        return { isMagical: false, baseItemName: null, mundaneDesc: null, obscuredImg: null };
    }
    if (isScroll && !obscureScrolls) {
        return { isMagical: true, baseItemName: null, mundaneDesc: null, obscuredImg: null };
    }
    if (isConsumable && !obscureConsumables) {
        return { isMagical: true, baseItemName: null, mundaneDesc: null, obscuredImg: null };
    }

    const baseItemName = derivePf2eBaseItemName(itemMeta);
    const mundaneDesc = derivePf2eMundaneDescription(itemMeta, baseItemName, rarity, terrainTag);
    const obscuredImg = _resolvePf2eObscuredIcon(itemMeta, baseItemName);

    return { isMagical, baseItemName, mundaneDesc, obscuredImg };
}

/**
 * Apply the hybrid PF2e mask: set PF2e identification to unidentified
 * and stash price/rarity/traits in QM latentMagic flags.
 *
 * @param {object} itemData   Full Foundry Item data object (mutated)
 * @param {object} maskInfo   { baseItemName, mundaneDesc, obscuredImg, sourceImg }
 */
export function applyPf2eMask(itemData, maskInfo) {
    if (!itemData || !maskInfo?.baseItemName) return;

    itemData.system ??= {};

    // Skip items with authored curse disguises (same as DnD5e)
    const qmFlags = itemData.flags?.[MODULE_ID] ?? {};
    if (qmFlags.cursedMeta?.lure) return;
    if (qmFlags.forgedFrom && qmFlags.latentMagic) return;

    const latent = _stripPf2eToLatent(itemData, maskInfo);

    if (latent) {
        itemData.flags ??= {};
        itemData.flags[MODULE_ID] ??= {};
        itemData.flags[MODULE_ID].latentMagic = latent;
    }
}

// ── Name Derivation ──────────────────────────────────────────────────────

/**
 * Derive a mundane base item name from a PF2e magical item name.
 *
 * Stripping order:
 *   "+1 Greater Striking Flaming Adamantine Longsword"
 *   → strip potency  → "Greater Striking Flaming Adamantine Longsword"
 *   → strip striking  → "Flaming Adamantine Longsword"
 *   → strip property   → "Adamantine Longsword"
 *   → strip material   → "Longsword"
 *
 * @param {object} itemMeta
 * @returns {string}
 */
export function derivePf2eBaseItemName(itemMeta) {
    const rawName = (itemMeta.name || "").trim();
    const nameLower = rawName.toLowerCase();
    const type = (itemMeta.type || "").toLowerCase();
    const category = (itemMeta.system?.category ?? "").toLowerCase();
    const baseItem = itemMeta._baseItem
        || itemMeta.baseItem
        || itemMeta.system?.baseItem
        || "";

    // 1. Named item overrides
    for (const [pattern, base] of NAMED_ITEM_OVERRIDES) {
        if (pattern.test(nameLower)) return base;
    }

    // 2. Scroll masking
    if (type === "consumable" && category === "scroll") {
        return "Unidentified Scroll";
    }

    // 3. Consumable masking
    if (type === "consumable") {
        if (category === "potion" || /\bpotion\b/i.test(nameLower)) return _pick(POTION_NAMES);
        if (category === "elixir" || /\belixir\b/i.test(nameLower) || /\bmutagen\b/i.test(nameLower)) return _pick(POTION_NAMES);
        if (category === "oil" || /\boil\s+of\b/i.test(nameLower)) return _pick(OIL_NAMES);
        if (category === "talisman") return _pick(TALISMAN_NAMES);
        if (category === "ammo") return "Ammunition";
        if (/\bpoison\b/i.test(nameLower) || category === "poison") return "Sealed Vial";
        // Generic consumable fallback
        return _pick(POTION_NAMES);
    }

    // 4. Wand/rod/staff masking by name
    if (/\bwand\b/i.test(nameLower)) return "Carved Stick";
    if (/\brod\b/i.test(nameLower) && type !== "weapon") return "Ornate Rod";
    if (/\bstaff\b/i.test(nameLower) && type !== "weapon") return "Wooden Staff";

    // 5. Structural baseItem resolution (with self-reference guard)
    if (baseItem && typeof baseItem === "string") {
        const baseKey = baseItem.toLowerCase().trim();
        const compactKey = baseKey.replace(/[-_\s]/g, "");
        const expanded = ItemMaskingHelper._BASE_ITEM_NAMES?.[baseKey]
            ?? ItemMaskingHelper._BASE_ITEM_NAMES?.[compactKey];
        if (expanded) return expanded;

        const humanised = ItemMaskingHelper._capitalise(baseItem);
        const humanLower = humanised.toLowerCase();
        const isSelfReferential = (humanLower === nameLower && /\s/.test(rawName))
            || /\bof\b/i.test(humanised)
            || /(?:['’]s|s['’])\s+/i.test(humanised);
        if (!isSelfReferential) {
            return humanised;
        }
    }

    // 6. Parenthetical, rune, material, and tier stripping
    let stripped = rawName;
    stripped = stripped.replace(PARENTHETICAL_RE, " ").trim();
    stripped = stripped.replace(POTENCY_RE, " ").trim();
    stripped = stripped.replace(STRIKING_RE, " ").trim();
    stripped = stripped.replace(RESILIENT_RE, " ").trim();
    stripped = stripped.replace(REINFORCING_RE, " ").trim();
    stripped = stripped.replace(PROPERTY_RUNE_RE, " ").trim();
    stripped = stripped.replace(MATERIAL_RE, " ").trim();
    stripped = stripped.replace(TIER_QUALIFIER_RE, "").trim();
    stripped = stripped.replace(/\s{2,}/g, " ").trim();

    const runeStrippedName = stripped;

    // 7. Grammatical decomposition: prepositional "of <Effect>" and possessive "<Owner>'s <Noun>"
    if (!ItemMaskingHelper._PRESERVED_OF_PHRASES_RE.test(stripped)) {
        stripped = stripped.replace(/\s+of\s+.+$/i, "").trim();
    }
    if (!ItemMaskingHelper._PRESERVED_POSSESSIVE_RE.test(stripped)) {
        const dePossessed = stripped.replace(/^.+?(?:['’]s|s['’])\s+/i, "").trim();
        if (dePossessed.length >= 3) stripped = dePossessed;
    }
    stripped = stripped.replace(TIER_QUALIFIER_RE, "").replace(/\s{2,}/g, " ").trim();

    // 8. Known mundane weapon / armor / shield check (e.g. "Longsword", "Full Plate", "Handwraps")
    if (MUNDANE_WEAPON_ARMOR_RE.test(stripped)) {
        return stripped;
    }

    // 9. Wondrous / Wearable physical archetype resolution (e.g. "Coyote Cloak" → "Cloak", "Demon Mask" → "Mask")
    const strippedLower = stripped.toLowerCase();
    if (type === "equipment" || type === "armor" || type === "backpack" || type === "treasure" || type === "kit" || /\bhandwraps?\b/i.test(strippedLower)) {
        if (SAFE_MUNDANE_NOUN_RE.test(stripped)) {
            return ItemMaskingHelper._capitalise(stripped);
        }
        const wondrous = ItemMaskingHelper._matchWondrousType(strippedLower)
            ?? (strippedLower !== nameLower ? ItemMaskingHelper._matchWondrousType(nameLower) : null);
        if (wondrous) return wondrous;
    }

    // 10. Weapon / Armor / Shield head-noun extraction (e.g. "Smoking Sword" → "Sword", "Sturdy Shield" → "Shield")
    if (type === "weapon" || type === "armor" || type === "shield") {
        const headMatch = stripped.match(WEAPON_ARMOR_HEAD_NOUN_RE) ?? rawName.match(WEAPON_ARMOR_HEAD_NOUN_RE);
        if (headMatch) {
            return ItemMaskingHelper._capitalise(headMatch[1]);
        }
    }

    // 11. No-Identity-Leak Invariant & Structural Metadata Fallback
    // If candidate is empty, too short, or not a recognised physical mundane noun,
    // resolve from PF2e structural metadata (usage slot → weapon/armor group → item type).
    const isRecognisedPhysicalNoun = SAFE_MUNDANE_NOUN_RE.test(stripped)
        || MUNDANE_WEAPON_ARMOR_RE.test(stripped);

    if (!stripped || stripped.length < 3 || !isRecognisedPhysicalNoun) {
        return _resolvePf2eStructuralFallback(itemMeta);
    }

    return stripped;
}

/**
 * Resolve a mundane base name from PF2e structural metadata (`usage.value`, `group`, `category`, `type`).
 * Guarantees that specific/proper-noun items never leak their magical name.
 *
 * @param {object} itemMeta
 * @returns {string}
 */
function _resolvePf2eStructuralFallback(itemMeta) {
    const type = (itemMeta.type || "").toLowerCase();
    const category = (itemMeta.system?.category ?? "").toLowerCase();
    const group = (itemMeta.system?.group ?? "").toLowerCase();
    const rawUsage = (itemMeta.system?.usage?.value ?? "").toLowerCase().trim();

    if (type === "weapon" && (category === "unarmed" || rawUsage === "worngloves")) {
        return "Handwraps";
    }
    if (rawUsage && USAGE_SLOT_NAMES[rawUsage]) {
        return USAGE_SLOT_NAMES[rawUsage];
    }
    if (group && GROUP_NAMES[group]) {
        return GROUP_NAMES[group];
    }
    if (type === "shield") return "Shield";
    if (type === "armor") return "Armor";
    if (type === "weapon") return "Weapon";
    if (type === "backpack") return "Backpack";
    if (type === "equipment") return "Trinket";
    if (type === "treasure") return "Curio";
    return _capitaliseType(type);
}

// ── Mundane Description ──────────────────────────────────────────────────

const PLURAL_BASE_NOUN_RE = /\b(?:handwraps|gloves|gauntlets|boots|sandals|shoes|slippers|bracers|goggles|eyeglasses|spectacles|epaulets|anklets|sleeves|horseshoes|manacles|shackles|beads|rings)\b/i;

/**
 * Generate a mundane description with subtle quality hints scaled by rarity.
 *
 * @param {object} itemMeta
 * @param {string} baseItemName
 * @param {string} rarity
 * @param {string} [terrainTag]
 * @returns {string}
 */
export function derivePf2eMundaneDescription(itemMeta, baseItemName, rarity, terrainTag) {
    const type = (itemMeta.type || "").toLowerCase();
    const category = (itemMeta.system?.category ?? "").toLowerCase();
    const hints = QUALITY_HINTS[rarity] ?? QUALITY_HINTS.common;
    const hint = _pick(hints);
    const baseLower = (baseItemName || "item").toLowerCase();

    let flavour;
    switch (type) {
        case "weapon":
            if (category === "unarmed" || /\bhandwraps?\b/i.test(baseLower)) {
                flavour = _pick(UNARMED_WRAPS_FLAVOUR);
            } else if (/\b(?:sword|blade|dagger|knife|kukri|axe|rapier|scimitar|falchion|katana|glaive|halberd|scythe)\b/i.test(baseLower)) {
                flavour = _pick(BLADED_WEAPON_FLAVOUR);
            } else {
                flavour = _pick(WEAPON_FLAVOUR);
            }
            break;
        case "armor":
        case "shield":
            flavour = _pick(ARMOR_FLAVOUR);
            break;
        case "consumable":
            flavour = _pick(CONSUMABLE_FLAVOUR);
            break;
        default:
            flavour = _pick(EQUIPMENT_FLAVOUR);
            break;
    }

    let terrainNote = "";
    if (terrainTag) {
        try {
            const registry = TerrainDataRegistry?.getInstance?.();
            const terrain = registry?.getTerrainByTag?.(terrainTag);
            if (terrain?.label) {
                terrainNote = ` It was found in ${terrain.label.toLowerCase()} terrain.`;
            }
        } catch { /* TerrainDataRegistry not available */ }
    }

    const isPlural = PLURAL_BASE_NOUN_RE.test(baseLower) && !/^pair\s+of\b/i.test(baseLower);
    const article = /^[aeiou]/i.test(hint) && !/^a\s+/i.test(hint) ? "An" : "A";
    const leadPhrase = isPlural
        ? `A pair of ${hint.replace(/^a\s+/i, "")} ${baseLower}`
        : `${/^a\s+/i.test(hint) ? _capitaliseType(hint) + ", a" : `${article} ${hint}`} ${baseLower}`;

    return `<p>${leadPhrase}. ${flavour}${terrainNote}</p>`;
}

// ── Icon Resolution ──────────────────────────────────────────────────────

/**
 * Resolve a diegetic mundane icon for an obscured PF2e item.
 * Never uses PF2e's default question-mark unidentified icons.
 *
 * @param {object} itemMeta
 * @param {string} [baseItemName]
 * @returns {string}
 */
function _resolvePf2eObscuredIcon(itemMeta, baseItemName) {
    const type = (itemMeta.type || "").toLowerCase();
    const category = (itemMeta.system?.category ?? "").toLowerCase();
    const nameLower = (itemMeta.name || "").toLowerCase();

    // 1. Scrolls: clean parchment scroll
    if (type === "consumable" && category === "scroll") {
        return "icons/sundries/scrolls/scroll-worn-beige.webp";
    }

    // 2. Talismans: clean gem/stone/coin art
    if (type === "consumable" && category === "talisman") {
        return TALISMAN_ICONS[baseItemName] ?? "icons/commodities/gems/gem-rough-cushion-grey.webp";
    }

    // 3. Consumables (potions, elixirs, oils, poisons, drugs)
    if (type === "consumable") {
        if (category === "ammo") {
            return "icons/weapons/ammunition/arrows-quiver-simple.webp";
        }
        return ItemMaskingHelper.obscuredConsumableIconForMaskedLabel(baseItemName);
    }

    // 4. Wands and Staves: rustic wooden stick / staff art
    if (/\bwand\b/i.test(nameLower) || (type === "equipment" && category === "wand")) {
        return "icons/weapons/staves/staff-simple.webp";
    }
    if (/\bstaff\b/i.test(nameLower) || (type === "equipment" && category === "staff")) {
        return "icons/weapons/staves/staff-carved-brown.webp";
    }

    // 5. Weapons, Armor, Shields, and Equipment:
    // Retain the item's authentic icon if valid (a disguised Longsword should look like a Longsword).
    const existingImg = itemMeta.img;
    const isDefaultOrMystery = !existingImg
        || existingImg === DEFAULT_ITEM_ICON
        || existingImg.includes("mystery-man")
        || existingImg.includes("item-bag")
        || existingImg.includes("unidentified_item_icons");

    if (!isDefaultOrMystery) {
        return existingImg;
    }

    // Fallbacks if no valid image exists on the source item
    if (type === "weapon") return "icons/weapons/swords/sword-broad-worn.webp";
    if (type === "armor") return "icons/equipment/chest/breastplate-leather-brown.webp";
    if (type === "shield") return "icons/equipment/shield/buckler-wooden-boss.webp";
    return "icons/sundries/adventuring/pack-backpack-leather.webp";
}

// ── Internal Helpers ─────────────────────────────────────────────────────

/**
 * Extract PF2e rarity from item meta.
 * @param {object} itemMeta
 * @returns {string}
 */
function _getPf2eRarity(itemMeta) {
    const raw = itemMeta.system?.traits?.rarity
        ?? itemMeta.system?.rarity
        ?? itemMeta.rarity
        ?? "common";
    return String(raw).toLowerCase().trim();
}

/**
 * Extract PF2e trait values array.
 * @param {object} itemMeta
 * @returns {string[]}
 */
function _getTraitValues(itemMeta) {
    const vals = itemMeta.system?.traits?.value;
    if (Array.isArray(vals)) return vals.map(v => String(v).toLowerCase());
    return [];
}

/**
 * Hybrid strip: set PF2e identification to unidentified AND stash
 * price/rarity/traits/runes in latentMagic for IdentificationService.
 *
 * @param {object} itemData
 * @param {object} maskInfo  { baseItemName, mundaneDesc, obscuredImg, sourceImg }
 * @returns {object|null}
 */
function _stripPf2eToLatent(itemData, maskInfo) {
    const system = itemData.system ??= {};
    const latent = {};
    const currentDesc = system.description?.value ?? "";

    // ── PF2e native identification layer ─────────────────────────────
    // Set status to unidentified and populate the unidentified fields.
    // PF2e's rendering engine handles displaying these to players.
    system.identification ??= {};
    system.identification.status = "unidentified";
    system.identification.unidentified ??= {};
    system.identification.unidentified.name = maskInfo.baseItemName;
    system.identification.unidentified.img = maskInfo.obscuredImg
        ?? itemData.img
        ?? DEFAULT_ITEM_ICON;
    system.identification.unidentified.data ??= {};
    system.identification.unidentified.data.description ??= {};
    system.identification.unidentified.data.description.value = maskInfo.mundaneDesc ?? "";

    // ── QM latentMagic stash (fields PF2e doesn't mask natively) ─────

    // Rarity: PF2e shows rarity badge/colour even when unidentified
    const rarity = system.traits?.rarity;
    if (rarity && rarity !== "common" && rarity !== "") {
        latent.originalRarity = rarity;
        system.traits ??= {};
        system.traits.rarity = "common";
    }

    // Magical trait: strip from the traits array
    const traitValues = system.traits?.value;
    if (Array.isArray(traitValues) && traitValues.includes("magical")) {
        latent.originalTraits = ["magical"];
        system.traits.value = traitValues.filter(t => t !== "magical");
    }

    // Runes: PF2e's computePrice() and computeLevelRarityPrice() recompute
    // price (e.g. 35 gp for +1) and rarity from system.runes on every data
    // preparation pass, ignoring system.price = 0 unless runes are stashed.
    const runes = system.runes;
    const hasActiveRunes = Boolean(
        runes && (
            Number(runes.potency) > 0
            || Number(runes.striking) > 0
            || Number(runes.resilient) > 0
            || Number(runes.reinforcing) > 0
            || (Array.isArray(runes.property) && runes.property.length > 0)
        )
    );
    if (hasActiveRunes) {
        latent.originalRunes = foundry.utils.deepClone(runes);
        const clearedRunes = { ...runes };
        if ("potency" in clearedRunes) clearedRunes.potency = 0;
        if ("striking" in clearedRunes) clearedRunes.striking = 0;
        if ("resilient" in clearedRunes) clearedRunes.resilient = 0;
        if ("reinforcing" in clearedRunes) clearedRunes.reinforcing = 0;
        if ("property" in clearedRunes) clearedRunes.property = [];
        system.runes = clearedRunes;
    }

    // Price: PF2e doesn't mask price in unidentified mode
    const price = system.price;
    if (price?.value !== undefined) {
        const gpValue = typeof price.value === "number"
            ? price.value
            : ((price.value.gp ?? 0)
                + (price.value.sp ?? 0) / 10
                + (price.value.cp ?? 0) / 100
                + (price.value.pp ?? 0) * 10);
        if (gpValue > 0) {
            latent.originalPrice = foundry.utils.deepClone(price);
            // Set to a mundane-equivalent price
            system.price = { value: { gp: 0, sp: 0, cp: 0 } };
        } else if (hasActiveRunes) {
            system.price = { value: { gp: 0, sp: 0, cp: 0 } };
        }
    }

    // Stash original name for IdentificationService display
    if (itemData.name && itemData.name !== maskInfo.baseItemName) {
        latent.originalName = itemData.name;
    }

    // Preserve identified.name for GM parenthetical view when runes/name are masked
    if (latent.originalName || hasActiveRunes) {
        system.identification.identified ??= {
            name: itemData.name,
            img: itemData.img ?? DEFAULT_ITEM_ICON,
            data: { description: { value: currentDesc } }
        };
    }

    // Stash original description
    if (maskInfo.mundaneDesc && maskInfo.mundaneDesc !== currentDesc) {
        latent.originalDescription = currentDesc;
    }

    // Stash original image if being replaced
    if (maskInfo.obscuredImg && itemData.img && itemData.img !== maskInfo.obscuredImg) {
        latent.originalImg = itemData.img;
    }

    return Object.keys(latent).length ? latent : null;
}

/**
 * @param {string} type
 * @returns {string}
 */
function _capitaliseType(type) {
    if (!type) return "Item";
    return type.charAt(0).toUpperCase() + type.slice(1);
}
