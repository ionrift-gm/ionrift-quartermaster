import { MODULE_ID } from "../../data/moduleId.js";
/**
 * DnD5e compendium pool matching and exclusion rules for ItemPoolResolver.
 */

import { ItemClassifier } from "../../services/workshop/ItemClassifier.js";
import { PotionEnrichment } from "../../services/scroll/PotionEnrichment.js";
import { isSrdCursedLootName } from "../../services/curse/SrdCurseCatalog.js";


export const EQUIPMENT24_PACKS = new Set(["dnd5e.equipment24"]);

export const LEGACY_2024_RENAMED = new Map([
    ["holy water",  "Flask of Holy Water"],
    ["acid",        "Acid (vial)"],
    ["antitoxin",   "Antitoxin (vial)"],
]);

export function extractDnd5ePrice(entry) {
    const price = entry.system?.price;
    if (!price) return 0;
    if (typeof price === "number") return price;
    if (typeof price === "object") {
        const val = price.value ?? 0;
        const denom = price.denomination ?? "gp";
        const toGp = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 };
        return val * (toGp[denom] ?? 1);
    }
    return 0;
}

export function extractDnd5eWeight(entry) {
    const w = entry.system?.weight;
    if (w === null || w === undefined) return 0;
    if (typeof w === "number") return w;
    if (typeof w === "object") return Number(w.value ?? 0) || 0;
    return Number(w) || 0;
}

export function entryDescriptionText(entry) {
    const raw = entry.system?.description?.value
        ?? entry.system?.description
        ?? "";
    if (typeof raw !== "string") return "";
    return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export function isQmDedicatedPickerItem(entry) {
    const qm = entry.flags?.["ionrift-quartermaster"];
    if (!qm) return false;
    if (qm.gemMeta?.tier) return true;
    const cat = qm.coreMeta?.category;
    if (cat === "Treasure" || cat === "Trinkets") return true;
    if ((entry.system?.type?.value ?? "") === "gem") return true;
    return false;
}

export function isArmorEntry(entry) {
    if (entry.type === "armor") return true;
    if (entry.type !== "equipment") return false;
    const armorType = (entry.system?.armor?.type ?? "").trim();
    if (armorType) return true;
    const subtype = (entry.subtype ?? entry.system?.type?.value ?? "").trim();
    return ["light", "medium", "heavy", "shield"].includes(subtype);
}

export function matchesDnd5eSlotType(entry, slotType) {
    const type = entry.type;
    const subtype = (entry.system?.type?.value ?? "").toLowerCase();

    switch (slotType) {
        case "consumable": {
            if (type !== "consumable") return false;
            if (PotionEnrichment.isHealingPotion(entry.name)) return true;
            if (subtype === "scroll") return false;
            if (subtype === "ammo" || subtype === "ammunition") return false;
            const n = (entry.name ?? "").toLowerCase();
            if (/^(arrows?|bolts?|needles?|sling bullets?)\b/i.test(n)) return false;
            const potionSubtypes = ["potion", "poison", "food", ""];
            return potionSubtypes.includes(subtype);
        }
        case "ammo": {
            if (type !== "consumable") return false;
            if (subtype === "ammo" || subtype === "ammunition") return true;
            const n = (entry.name ?? "").toLowerCase();
            return /^(arrows?|bolts?|needles?|sling bullets?)\b/i.test(n);
        }
        case "scroll":
            return type === "consumable" && subtype === "scroll";
        case "mundane": {
            if (type === "loot" || type === "tool") {
                if (isQmDedicatedPickerItem(entry)) return false;
                return true;
            }
            if (type === "equipment") {
                const rarity = (entry.system?.rarity ?? "").toLowerCase();
                return !rarity || rarity === "common" || rarity === "none";
            }
            return false;
        }
        case "mastercraft":
            return type === "weapon" || isArmorEntry(entry);
        default:
            return false;
    }
}

export function isSlayingTemplateShell(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
    if (nameLower === "ammunition of slaying") return true;
    if (nameLower.startsWith("ammunition of slaying ")) return true;
    if (entry.type === "enchantment" && /^ammunition of slaying /i.test(entry.name ?? "")) return true;
    return false;
}

export function isNarrativeReserveLoot(entry) {
    return ItemClassifier.isSlayingAmmo(entry);
}

export function isBulkAmmoCollection(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
    if (entry.type !== "consumable") return false;
    const subtype = (entry.system?.type?.value ?? "").trim();
    if (subtype !== "ammo") return false;
    const BULK_BUNDLES = new Set(["arrows", "bolts", "bullets, sling", "bullets, firearm", "needles"]);
    return BULK_BUNDLES.has(nameLower);
}

export function isGmPlacedPoison(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
    if (/^potion of (?:greater |superior |supreme )?poison$/i.test(nameLower)) return true;
    const subtype = (entry.system?.type?.value ?? "").toString().toLowerCase();
    if (subtype !== "poison") return false;
    if (/^basic poison$/i.test(nameLower)) return false;
    if (/antitoxin/i.test(nameLower)) return false;
    return true;
}

export function isPlaceholderPoolEntry(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
    if (nameLower === "trinket") return true;
    if (/, or \+\d/.test(nameLower)) return true;
    const desc = entryDescriptionText(entry);
    if (!desc) return false;
    if (desc.includes("placeholder for the non-srd")) return true;
    if (desc.includes("placeholder") && desc.includes("d100 table")) return true;
    return false;
}

export function isZeroDataPlaceholder(entry) {
    if (PotionEnrichment.isHealingPotion(entry.name)) return false;
    const price = extractDnd5ePrice(entry);
    const weight = extractDnd5eWeight(entry);
    const rarity = (entry.system?.rarity ?? "").trim();
    return price === 0 && weight === 0 && rarity === "";
}

export function isEconomyPendingLoot(entry) {
    if (PotionEnrichment.isHealingPotion(entry.name)) return false;
    const price = extractDnd5ePrice(entry);
    const weight = extractDnd5eWeight(entry);
    if (price !== 0 || weight !== 0) return false;
    const rarity = (entry.system?.rarity ?? "").trim().toLowerCase();
    if (!rarity || rarity === "common" || rarity === "none") return false;
    return true;
}

export function isZeroWeightWeaponTemplate(entry) {
    if (entry.type !== "weapon") return false;
    const weight = extractDnd5eWeight(entry);
    if (weight !== 0) return false;
    const subtype = (entry.system?.type?.value ?? "").trim();
    return !subtype || subtype === "-";
}

export function isZeroWeightArmorTemplate(entry) {
    if (entry.type !== "equipment") return false;
    const weight = extractDnd5eWeight(entry);
    if (weight !== 0) return false;
    const subtype = (entry.system?.type?.value ?? "").trim();
    const WONDROUS_SUBTYPES = new Set([
        "wondrous", "ring", "trinket", "clothing", "wand", "rod", "gear"
    ]);
    if (WONDROUS_SUBTYPES.has(subtype)) return false;
    const ARMOR_SUBTYPES = new Set(["heavy", "medium", "light", "shield"]);
    if (ARMOR_SUBTYPES.has(subtype)) return false;
    return !subtype || subtype === "-";
}

export function isTrapOrHazard(entry) {
    const desc = entryDescriptionText(entry);
    if (!desc) return false;
    if (desc.includes("trigger:")) return true;
    if (/\b(?:nuisance|setpiece)\s+trap\b/.test(desc)) return true;
    return false;
}

export function isContainerContentOnly(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
    const subtype = (entry.system?.type?.value ?? "").toLowerCase();
    if (entry.type !== "consumable" || (subtype !== "food" && subtype !== "drink" && subtype !== "")) return false;
    if (/\(pint(?:s)?\)$/i.test(nameLower)) return true;
    if (/\(gallon(?:s)?\)$/i.test(nameLower)) return true;
    if (/\(ounce(?:s)?\)$/i.test(nameLower)) return true;
    if (/\(portion(?:s)?\)$/i.test(nameLower)) return true;
    return false;
}

function readEnabledLootSources() {
    try {
        const raw = JSON.parse(game.settings.get(MODULE_ID, "lootPoolSources") ?? "[]");
        return Array.isArray(raw) ? raw : [];
    } catch {
        return ["dnd5e.items", "dnd5e.tradegoods"];
    }
}

export function isLegacyRenamedItem(entry, nameLower = (entry.name || "").trim().toLowerCase()) {
    if (!LEGACY_2024_RENAMED.has(nameLower)) return false;
    const sources = readEnabledLootSources();
    return sources.some(id => EQUIPMENT24_PACKS.has(id));
}

/**
 * @param {object} entry
 * @returns {boolean}
 */
export function isDnd5eExcludedFromPool(entry) {
    const name = entry.name?.trim() ?? "";
    const nameLower = name.toLowerCase();
    if (entry.type === "feat" || entry.type === "class" || entry.type === "spell") return true;
    if (!name) return true;
    if (isPlaceholderPoolEntry(entry, nameLower)) return true;
    if (isContainerContentOnly(entry, nameLower)) return true;
    if (isTrapOrHazard(entry)) return true;
    if (isZeroDataPlaceholder(entry)) return true;
    if (isZeroWeightWeaponTemplate(entry)) return true;
    if (isZeroWeightArmorTemplate(entry)) return true;
    if (isEconomyPendingLoot(entry)) return true;
    if (isSlayingTemplateShell(entry, nameLower)) return true;
    if (isNarrativeReserveLoot(entry)) return true;
    if (isBulkAmmoCollection(entry, nameLower)) return true;
    if (isGmPlacedPoison(entry, nameLower)) return true;
    if (isLegacyRenamedItem(entry, nameLower)) return true;
    if (isSrdCursedLootName(name)) return true;
    return false;
}
