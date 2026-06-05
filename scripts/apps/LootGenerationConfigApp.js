import { createQuartermasterConfigApp } from "./QuartermasterSubmenuConfigApp.js";
import { AmmoTypeConfigApp } from "./AmmoTypeConfigApp.js";
import { GenericArmorBonusConfigApp } from "./GenericArmorBonusConfigApp.js";
import { AmmoTypeRegistry } from "../services/AmmoTypeRegistry.js";
import { GenericArmorBonusRegistry } from "../services/GenericArmorBonusRegistry.js";

export const LootGenerationConfigApp = createQuartermasterConfigApp({
    appId: "qm-loot-generation-config",
    title: "Loot Generation",
    icon: "fas fa-coins",
    lead: "Scales cache value, magic rates, ammunition, healing potions, scroll overshoot, and coin breakdown.",
    savedMessage: "Loot generation settings saved.",
    popouts: {
        ammoTypes: AmmoTypeConfigApp,
        genericArmorBonus: GenericArmorBonusConfigApp
    },
    rows: [
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
        {
            key: "magicFrequency",
            label: "Magic Frequency",
            icon: "fas fa-wand-sparkles",
            hint: "Likelihood of magical items (Uncommon+) in caches. 0 disables magic. 2.0 is high fantasy.",
            type: "range",
            min: 0,
            max: 2,
            step: 0.25
        },
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
            key: "genericArmorBonusConfig",
            label: "Generic Armor Bonus Curve",
            icon: "fas fa-shield-halved",
            hint: "Tier caps for generic +N body armor and shields in mastercraft caches. Independent of magic frequency and weapon bonuses.",
            type: "popout",
            popout: "genericArmorBonus",
            summary: () => GenericArmorBonusRegistry.getSummaryLabel()
        },
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
        {
            key: "ammoTypeConfig",
            label: "Ammunition Type Curve",
            icon: "fas fa-bullseye-arrow",
            hint: "Weight arrows, bolts, needles, sling bullets, and custom house-rule types.",
            type: "popout",
            popout: "ammoTypes",
            summary: () => AmmoTypeRegistry.getSummaryLabel()
        },
        {
            key: "scrollJitter",
            label: "Scroll Jitter",
            icon: "fas fa-scroll",
            hint: "How far scroll spell level can overshoot the tier cap. 0 keeps scrolls within tier limits.",
            type: "range",
            min: 0,
            max: 3,
            step: 1
        },
        {
            key: "distributeCoins",
            label: "Distribute Coinage",
            icon: "fas fa-coins",
            hint: "Convert cache gold into a randomized mix of cp, sp, ep, gp, and pp.",
            type: "boolean"
        }
    ]
});
