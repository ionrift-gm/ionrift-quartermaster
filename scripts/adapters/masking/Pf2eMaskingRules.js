import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";
/**
 * Pf2eMaskingRules
 *
 * PF2e-specific identification masking for Quartermaster loot caches.
 *
 * Hybrid approach: uses PF2e's native `system.identification` for display
 * masking (name, image, description) while stashing price, rarity, and
 * magical traits in QM's `latentMagic` flags for IdentificationService
 * compatibility.
 *
 * PF2e's identification schema:
 *   system.identification.status           "identified" | "unidentified"
 *   system.identification.unidentified     { name, img, data: { description: { value } } }
 *
 * Design: items are set to `status: "unidentified"` with QM-generated
 * mundane names/descriptions in the unidentified fields. The actual
 * item.name / item.img stay as the real values (GM-visible). Players
 * see the unidentified layer via PF2e's rendering engine.
 *
 * latentMagic stash covers fields PF2e doesn't mask natively:
 *   - originalRarity        system.traits.rarity
 *   - originalTraits        magical trait from system.traits.value[]
 *   - originalPrice         system.price
 */

import { TerrainDataRegistry } from "../../services/loot/TerrainDataRegistry.js";


// ── PF2e Unidentified Item Icons ─────────────────────────────────────────
// Shipped with the PF2e system at systems/pf2e/icons/unidentified_item_icons/

const PF2E_ICON_BASE = "systems/pf2e/icons/unidentified_item_icons";

const PF2E_ICON_MAP = {
    weapon:             `${PF2E_ICON_BASE}/weapon.webp`,
    armor:              `${PF2E_ICON_BASE}/armor.webp`,
    shield:             `${PF2E_ICON_BASE}/shields.webp`,
    "consumable:potion": `${PF2E_ICON_BASE}/potions.webp`,
    "consumable:elixir": `${PF2E_ICON_BASE}/alchemical_elixir.webp`,
    "consumable:oil":    `${PF2E_ICON_BASE}/oils.webp`,
    "consumable:scroll": `${PF2E_ICON_BASE}/other-consumables.webp`,
    "consumable:talisman": `${PF2E_ICON_BASE}/talisman.webp`,
    "consumable:poison": `${PF2E_ICON_BASE}/alchemical_poison.webp`,
    "consumable:drug":   `${PF2E_ICON_BASE}/drugs.webp`,
    "consumable:ammo":   `${PF2E_ICON_BASE}/ammunition.webp`,
    "equipment:wand":    `${PF2E_ICON_BASE}/wands.webp`,
    "equipment:staff":   `${PF2E_ICON_BASE}/staves.webp`,
    "equipment:worn":    `${PF2E_ICON_BASE}/worn-items.webp`,
    "equipment:held":    `${PF2E_ICON_BASE}/held-item.webp`,
    "equipment":         `${PF2E_ICON_BASE}/adventuring_gear.webp`,
};

// ── Rune & Prefix Stripping ──────────────────────────────────────────────

const POTENCY_RE = /\s*\+[1-3]\s*/g;
const STRIKING_RE = /\b(?:Major |Greater )?Striking\b\s*/gi;
const RESILIENT_RE = /\b(?:Major |Greater )?Resilient\b\s*/gi;

const PROPERTY_RUNE_NAMES = [
    "Anarchic", "Axiomatic", "Corrosive", "Dancing", "Disrupting",
    "Flaming", "Frost", "Ghost Touch", "Grievous", "Holy", "Keen",
    "Returning", "Serrating", "Shifting", "Shock", "Speed",
    "Thundering", "Unholy", "Vorpal", "Wounding",
    // Armor property runes
    "Antimagic", "Fortification", "Glamered", "Invisibility",
    "Shadow", "Slick", "Winged", "Energy-Resistant",
];

const PROPERTY_RUNE_RE = new RegExp(
    `\\b(?:Greater |Major |Moderate |Minor )?(?:${PROPERTY_RUNE_NAMES.join("|")})\\b\\s*`,
    "gi"
);

const MATERIAL_NAMES = [
    "Adamantine", "Cold Iron", "Darkwood", "Mithral", "Orichalcum",
    "Silver", "Sisterstone", "Sovereign Steel", "Warpglass",
    "Abysium", "Djezet", "Inubrix", "Noqual", "Siccatite",
];

const MATERIAL_RE = new RegExp(
    `\\b(?:High-Grade |Standard-Grade |Low-Grade )?(?:${MATERIAL_NAMES.join("|")})\\b\\s*`,
    "gi"
);

// ── Named Item Overrides ─────────────────────────────────────────────────
// Famous PF2e magical items → mundane base name

const NAMED_ITEM_OVERRIDES = [
    [/\bstaff\s+of\b/i,                 "Wooden Staff"],
    [/\bdoubling\s+rings?\b/i,          "Pair of Rings"],
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
];

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
    "The blade shows signs of regular use but remains sharp.",
    "The grip is wrapped in worn leather, shaped by many hands.",
    "The balance feels natural, suggesting quality construction.",
    "A serviceable weapon, well-maintained by its previous owner.",
    "The metal has a slight sheen, free of pitting or corrosion.",
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

    // Determine magical status
    const isMagical = rarityMagical || hasMagicalTrait || isScroll || isConsumable;

    if (!isMagical) {
        return { isMagical: false, baseItemName: null, mundaneDesc: null, obscuredImg: null };
    }

    // Apply settings gates (same logic as DnD5e)
    const isGearMagic = rarityMagical && !isScroll && !isConsumable;
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
    const obscuredImg = _resolvePf2eObscuredIcon(itemMeta);

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
        if (category === "elixir" || /\belixir\b/i.test(nameLower)) return _pick(POTION_NAMES);
        if (category === "oil" || /\boil\s+of\b/i.test(nameLower)) return _pick(OIL_NAMES);
        if (category === "talisman") return _pick(TALISMAN_NAMES);
        if (/\bpoison\b/i.test(nameLower) || category === "poison") return "Sealed Vial";
        // Generic consumable fallback
        return _pick(POTION_NAMES);
    }

    // 4. Wand/staff masking by name
    if (/\bwand\b/i.test(nameLower)) return "Carved Stick";
    if (/\bstaff\b/i.test(nameLower) && type !== "weapon") return "Wooden Staff";

    // 5. Rune and material stripping for weapons/armor/shields/equipment
    let stripped = rawName;
    stripped = stripped.replace(POTENCY_RE, " ").trim();
    stripped = stripped.replace(STRIKING_RE, " ").trim();
    stripped = stripped.replace(RESILIENT_RE, " ").trim();
    stripped = stripped.replace(PROPERTY_RUNE_RE, " ").trim();
    stripped = stripped.replace(MATERIAL_RE, " ").trim();

    // Collapse whitespace and trim
    stripped = stripped.replace(/\s{2,}/g, " ").trim();

    // If stripping left us with an empty string or just punctuation, use type
    if (!stripped || stripped.length < 3) {
        return _capitaliseType(type);
    }

    return stripped;
}

// ── Mundane Description ──────────────────────────────────────────────────

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
    const hints = QUALITY_HINTS[rarity] ?? QUALITY_HINTS.common;
    const hint = _pick(hints);

    let flavour;
    switch (type) {
        case "weapon":
            flavour = _pick(WEAPON_FLAVOUR);
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

    return `<p>A ${hint} ${baseItemName.toLowerCase()}. ${flavour}${terrainNote}</p>`;
}

// ── Icon Resolution ──────────────────────────────────────────────────────

/**
 * @param {object} itemMeta
 * @returns {string}
 */
function _resolvePf2eObscuredIcon(itemMeta) {
    const type = (itemMeta.type || "").toLowerCase();
    const category = (itemMeta.system?.category ?? "").toLowerCase();
    const nameLower = (itemMeta.name || "").toLowerCase();

    // Consumable subcategory icons
    if (type === "consumable" && category) {
        const key = `consumable:${category}`;
        if (PF2E_ICON_MAP[key]) return PF2E_ICON_MAP[key];
    }

    // Equipment subcategory by name
    if (type === "equipment") {
        if (/\bwand\b/i.test(nameLower)) return PF2E_ICON_MAP["equipment:wand"];
        if (/\bstaff\b/i.test(nameLower)) return PF2E_ICON_MAP["equipment:staff"];
        if (/\bworn\b/i.test(nameLower)
            || /\bring\b|\bamulet\b|\bbelt\b|\bbracers?\b|\bboots?\b|\bcloak\b|\bcirclet\b/i.test(nameLower)) {
            return PF2E_ICON_MAP["equipment:worn"];
        }
        return PF2E_ICON_MAP["equipment:held"] ?? PF2E_ICON_MAP["equipment"];
    }

    // Direct type match
    return PF2E_ICON_MAP[type] ?? PF2E_ICON_MAP["equipment"];
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
 * price/rarity/traits in latentMagic for IdentificationService.
 *
 * @param {object} itemData
 * @param {object} maskInfo  { baseItemName, mundaneDesc, obscuredImg, sourceImg }
 * @returns {object|null}
 */
function _stripPf2eToLatent(itemData, maskInfo) {
    const system = itemData.system ??= {};
    const latent = {};

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

    // Price: PF2e doesn't mask price in unidentified mode
    const price = system.price;
    if (price?.value) {
        const gpValue = (price.value.gp ?? 0)
            + (price.value.sp ?? 0) / 10
            + (price.value.cp ?? 0) / 100;
        if (gpValue > 0) {
            latent.originalPrice = foundry.utils.deepClone(price);
            // Set to a mundane-equivalent price
            system.price = { value: { gp: 0, sp: 0, cp: 0 } };
        }
    }

    // Stash original name for IdentificationService display
    if (itemData.name && itemData.name !== maskInfo.baseItemName) {
        latent.originalName = itemData.name;
    }

    // Stash original description
    const currentDesc = system.description?.value ?? "";
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
