import { createQuartermasterConfigApp } from "./QuartermasterSubmenuConfigApp.js";
import { AmmoTypeConfigApp } from "./AmmoTypeConfigApp.js";
import { GenericArmorBonusConfigApp } from "./GenericArmorBonusConfigApp.js";
import { AmmoTypeRegistry } from "../../services/workshop/AmmoTypeRegistry.js";
import { GenericArmorBonusRegistry } from "../../services/workshop/GenericArmorBonusRegistry.js";

export const LootGenerationConfigApp = createQuartermasterConfigApp({
    appId: "qm-loot-generation-config",
    title: "Loot Generation",
    icon: "fas fa-coins",
    lead: "Cache value, magic rates, and consumable drops. Enhancement and named magic are configured separately.",
    savedMessage: "Loot generation settings saved.",
    popouts: {
        ammoTypes: AmmoTypeConfigApp,
        genericArmorBonus: GenericArmorBonusConfigApp
    },
    rows: [
        { type: "section", label: "Economy" },
        {
            key: "lootEconomy",
            label: "Loot Abundance",
            icon: "fas fa-scale-balanced",
            hint: "Scales the value of generated caches. Below 1.0 for scarce games. Above 1.0 for high-fantasy treasure runs.",
            type: "range",
            min: 0.25,
            max: 3,
            step: 0.25
        },
        { type: "section", label: "Enhancement Items" },
        {
            key: "magicFrequency",
            label: "Magic Frequency",
            icon: "fas fa-wand-sparkles",
            hint: "Mastercraft slot draw weight for generic +N weapons and enhancement gear. Does not affect armour drops or named magic.",
            type: "range",
            min: 0,
            max: 2,
            step: 0.25
        },
        {
            key: "armourDropChance",
            label: "Armour Drop Chance",
            icon: "fas fa-shield-halved",
            hint: "Chance a mastercraft armour slot is reserved per cache (Unspecified / Armaments themes). 0 = off. 0.65 = standard. 1.0 = guaranteed.",
            type: "range",
            min: 0,
            max: 1,
            step: 0.05
        },
        {
            key: "genericArmorBonusConfig",
            label: "Generic Armor Bonus Curve",
            icon: "fas fa-shield-halved",
            hint: "Tier caps for generic +N body armor and shields in mastercraft caches. Independent of magic frequency and weapon bonuses.",
            type: "popout",
            popout: "genericArmorBonus",
            summary: () => GenericArmorBonusRegistry.getSummaryLabel()
        },
        { type: "section", label: "Named Magic" },
        {
            key: "namedMagicFrequency",
            label: "Named Magic Frequency",
            icon: "fas fa-wand-sparkles",
            hint: "Scales how often one named magical item appears per cache. Baseline: T2 10%, T3 20%, T4 35%. 0 = off. 1 = standard. 2 = double.",
            type: "range",
            min: 0,
            max: 2,
            step: 0.25
        },
        { type: "column-break" },
        { type: "section", label: "Consumables" },
        {
            key: "healingPotionFrequency",
            label: "Healing Potion Frequency",
            icon: "fas fa-heart-pulse",
            hint: "Scales consumable slots, healing picks on those slots, and bonus healing lines per cache. 1.0 is moderate; 4.0 is heavy. Requires healing potions in Loot Pool Sources.",
            type: "range",
            min: 0,
            max: 4,
            step: 0.25
        },
        { type: "section", label: "Ammunition" },
        {
            key: "magicAmmoFrequency",
            label: "Magical Ammunition Frequency",
            icon: "fas fa-bullseye",
            hint: "How often +1/+2/+3 ammunition appears. Independent of Magic Frequency.",
            type: "range",
            min: 0,
            max: 2,
            step: 0.25
        },
        {
            key: "ammoTypeConfig",
            label: "Ammunition Type Curve",
            icon: "fas fa-bullseye-arrow",
            hint: "Weight arrows, bolts, needles, sling bullets, and custom house-rule types.",
            type: "popout",
            popout: "ammoTypes",
            summary: () => AmmoTypeRegistry.getSummaryLabel()
        },
        { type: "section", label: "Coinage" },
        {
            key: "distributeCoins",
            label: "Distribute Coinage",
            icon: "fas fa-coins",
            hint: "Convert cache gold into a randomized mix of cp, sp, ep, gp, and pp.",
            type: "boolean"
        }
    ]
});
