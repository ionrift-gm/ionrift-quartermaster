import { createQuartermasterConfigApp } from "./QuartermasterSubmenuConfigApp.js";

export const ProgressionConfigApp = createQuartermasterConfigApp({
    appId: "qm-progression-config",
    title: "Progression",
    icon: "fas fa-chart-line",
    lead: "Signature Ledger auto-seeding behavior. Campaign milestone bands are set in Start here on the main settings panel.",
    savedMessage: "Progression settings saved.",
    rows: [
        {
            key: "shelfJitter",
            label: "Auto-Seed Drift",
            icon: "fas fa-shuffle",
            hint: "Where auto-seeded shelf items land on the milestone grid. 0 = exact rarity milestone. 1 or 2 shifts late-biased. Manual plans are unaffected.",
            type: "range",
            min: 0,
            max: 2,
            step: 1
        }
    ]
});
