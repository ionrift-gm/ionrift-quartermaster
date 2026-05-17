/**
 * Deterministic character profile population for Monte Carlo balance testing.
 *
 * Each profile represents a realistic D&D 5e character with a STR score,
 * a gear weight (before the cursed item), and metadata about their role.
 * Profiles are fixed — no randomisation — so every run produces identical
 * results and blueprint changes show up as clean diffs.
 */

const ARCHETYPES = [
    {
        id: "light",
        label: "Light Explorer",
        classes: ["rogue", "ranger", "monk"],
        caster: false,
        strRange: [8, 10, 12],
        gearByStr: { 8: 45, 10: 55, 12: 70 },
        attacksPerRound: 2
    },
    {
        id: "medium",
        label: "Medium Versatile",
        classes: ["cleric", "paladin", "bard"],
        caster: true,
        strRange: [12, 13, 14],
        gearByStr: { 12: 80, 13: 90, 14: 100 },
        attacksPerRound: 2
    },
    {
        id: "heavy",
        label: "Heavy Martial",
        classes: ["fighter"],
        caster: false,
        strRange: [14, 15, 16],
        gearByStr: { 14: 110, 15: 120, 16: 140 },
        attacksPerRound: 3
    },
    {
        id: "loot-goblin",
        label: "Loot Goblin",
        classes: ["fighter", "ranger"],
        caster: false,
        strRange: [10, 12, 14],
        gearByStr: { 10: 120, 12: 140, 14: 155 },
        attacksPerRound: 2
    },
    {
        id: "caster",
        label: "Low-STR Caster",
        classes: ["wizard", "sorcerer"],
        caster: true,
        strRange: [8, 9, 10],
        gearByStr: { 8: 30, 9: 40, 10: 50 },
        attacksPerRound: 1
    }
];

const LEVELS = [3, 5];

export function generateProfiles() {
    const profiles = [];

    for (const arch of ARCHETYPES) {
        for (const str of arch.strRange) {
            for (const level of LEVELS) {
                const cls = arch.classes[0];
                profiles.push({
                    label: `STR ${str} ${cls} L${level} (${arch.label.toLowerCase()})`,
                    level,
                    naturalStr: str,
                    gearWeight: arch.gearByStr[str],
                    class: cls,
                    caster: arch.caster,
                    archetype: arch.id,
                    attacksPerRound: arch.attacksPerRound
                });
            }
        }
    }

    return profiles;
}

export { ARCHETYPES, LEVELS };
