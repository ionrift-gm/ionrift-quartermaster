/**
 * @module SettingsPanelLayout
 * @description Registers Quartermaster Quick Setup via ionrift-library.
 */

import { openSetupGuide } from "../constants/SetupGuide.js";
import { LootPoolCompiler } from "./LootPoolCompiler.js";
import { ScrollForge      } from "./ScrollForge.js";
import { SrdCurseAdapter  } from "./SrdCurseAdapter.js";

const MODULE_ID = "ionrift-quartermaster";

const PROFILE_KEYS = [
    "lootEconomy",
    "magicFrequency",
    "magicAmmoFrequency",
    "ammoTypeTilt",
    "obscureConsumables",
    "obscureScrolls",
    "scrollJitter",
    "shelfJitter",
    "distributeCoins"
];

const KEY_LABELS = {
    lootEconomy: "Loot abundance",
    magicFrequency: "Magic frequency",
    magicAmmoFrequency: "Magical ammunition",
    ammoTypeTilt: "Ammunition preference",
    obscureConsumables: "Obscure consumables",
    obscureScrolls: "Obscure scrolls",
    scrollJitter: "Scroll jitter",
    shelfJitter: "Auto-seed drift",
    distributeCoins: "Distribute coinage"
};

const AMMO_LABELS = {
    balanced: "Balanced",
    arrows: "Arrows",
    bolts: "Bolts",
    sling: "Sling",
    mixed: "Mixed",
    custom: "Custom curve"
};

const PROFILES = [
    {
        id: "low",
        label: "Low",
        icon: "fas fa-mountain",
        desc: "Scarce loot, little magic, opaque items, tight scroll bands.",
        values: {
            lootEconomy: 0.5,
            magicFrequency: 0.25,
            magicAmmoFrequency: 0,
            ammoTypeTilt: "balanced",
            obscureConsumables: true,
            obscureScrolls: true,
            scrollJitter: 0,
            shelfJitter: 0,
            distributeCoins: true
        }
    },
    {
        id: "standard",
        label: "Standard",
        icon: "fas fa-scale-balanced",
        desc: "Default table: balanced economy, magic, and identification.",
        values: {
            lootEconomy: 1,
            magicFrequency: 1,
            magicAmmoFrequency: 1,
            ammoTypeTilt: "balanced",
            obscureConsumables: true,
            obscureScrolls: true,
            scrollJitter: 1,
            shelfJitter: 1,
            distributeCoins: true
        }
    },
    {
        id: "high",
        label: "High",
        icon: "fas fa-gem",
        desc: "Generous hauls, more magic, lighter masking, wider scroll overshoot.",
        values: {
            lootEconomy: 1.5,
            magicFrequency: 1.5,
            magicAmmoFrequency: 1.5,
            ammoTypeTilt: "balanced",
            obscureConsumables: false,
            obscureScrolls: false,
            scrollJitter: 2,
            shelfJitter: 1,
            distributeCoins: true
        }
    }
];

const GROUPS = [
    {
        title: "Start here",
        icon: "fas fa-flag",
        keys: ["milestoneProfile", "compendiumForge"]
    },
    {
        title: "Loot & caches",
        icon: "fas fa-coins",
        keys: ["lootGenerationConfig"]
    },
    {
        title: "At the table",
        icon: "fas fa-eye",
        keys: ["identificationConfig"]
    },
    {
        title: "Progression",
        icon: "fas fa-chart-line",
        keys: ["progressionConfig"]
    },
    {
        title: "Tools",
        icon: "fas fa-wrench",
        keys: ["debug"]
    }
];

/**
 * @param {string} key
 * @param {*} value
 * @returns {{ text: string, cssClass: string }}
 */
function formatProfileCell(key, value) {
    if (key === "lootEconomy" || key === "magicFrequency" || key === "magicAmmoFrequency") {
        const n = Number(value);
        const text = `×${Number.isInteger(n) ? n : n.toFixed(2).replace(/\.?0+$/, "")}`;
        return { text, cssClass: n >= 1 ? "on" : "off" };
    }
    if (key === "ammoTypeTilt") {
        return { text: AMMO_LABELS[value] ?? value, cssClass: "on" };
    }
    if (key === "scrollJitter" || key === "shelfJitter") {
        const n = Number(value) || 0;
        return { text: String(n), cssClass: n > 0 ? "on" : "off" };
    }
    return { text: value ? "On" : "Off", cssClass: value ? "on" : "off" };
}

export function registerQuartermasterSettingsPanel() {
    const MCP = game.ionrift?.library?.ModuleConfigProfiles;
    if (!MCP) return;

    MCP.register({
        moduleId: MODULE_ID,
        moduleLabel: "Quartermaster",
        anchorKey: "milestoneProfile",
        quickSetup: {
            title: "Quick setup",
            subtitle: "Pick a loot feel for the table. Sources, milestone band, and packs stay as they are.",
            profiles: PROFILES,
            profileKeys: PROFILE_KEYS,
            keyLabels: KEY_LABELS,
            formatCell: formatProfileCell,
            confirmNote: "Loot pool sources, campaign milestone profile, and content packs are left unchanged. Fine-tune in the panels below.",
            guideTooltip: "Opens the GM setup guide (loot profiles, sources, milestone grid).",
            onGuide: () => openSetupGuide()
        },
        groups: GROUPS
    });
}

// ── Forge alert badge on Module Config ──────────────────────────────────
//
// Mirrors ionrift-library's injectPackUpdateBadge pattern: appends a small
// amber warning badge to the "Open Compendium Forge" button when any of the
// three forge tabs has a stale or never-compiled status. Purely cosmetic DOM
// injection; no network calls, reads cached settings only.

/**
 * Compute the worst forge status across all three compilers.
 * @returns {"fresh"|"stale"|"never"|null}
 */
function _worstForgeStatus() {
    try {
        // Loot pool
        const lootStatus = LootPoolCompiler.is2024ArchitecturePresent()
            ? LootPoolCompiler.getStatus()
            : "fresh";

        // Scroll forge
        const scrollStatus = ScrollForge.getStatus();

        // Cursed items
        const curseStatus = SrdCurseAdapter.getStatus();

        // Priority: stale > never > fresh
        if ([lootStatus, scrollStatus, curseStatus].includes("stale")) return "stale";
        if ([lootStatus, scrollStatus, curseStatus].includes("never")) return "never";
        return "fresh";
    } catch {
        return null;
    }
}

/**
 * Inject an alert badge on the Compendium Forge button in Module Config.
 * @param {jQuery|Element} html
 */
function injectForgeAlertBadge(html) {
    const status = _worstForgeStatus();
    if (!status || status === "fresh") return;

    const root = html instanceof Element ? html : (html ? html[0] : document);
    const btn = root?.querySelector?.(`button[data-key="${MODULE_ID}.compendiumForge"]`);
    if (!btn) return;
    if (btn.querySelector(".ionrift-forge-alert-badge")) return;

    const isStale = status === "stale";
    const tooltip = isStale
        ? "A compiled pool is stale or missing. Open Compendium Forge to recompile."
        : "Content pools have not been compiled yet. Open Compendium Forge to set up.";
    const icon = isStale ? "fa-exclamation-triangle" : "fa-hammer";
    const label = "";

    const badge = document.createElement("span");
    badge.className = "ionrift-forge-alert-badge";
    badge.title = tooltip;
    badge.style.cssText = [
        "display: inline-flex",
        "align-items: center",
        "justify-content: center",
        "margin-left: 6px",
        "padding: 2px 7px",
        "background: rgba(251, 191, 36, 0.18)",
        "border: 1px solid rgba(251, 191, 36, 0.5)",
        "border-radius: 10px",
        "color: #fbbf24",
        "font-size: 0.8em",
        "line-height: 1.4",
        "vertical-align: middle",
        "cursor: default"
    ].join(";");
    badge.innerHTML = `<i class="fas ${icon}" style="font-size:0.85em"></i> ${label}`;
    btn.appendChild(badge);
}

Hooks.on("renderSettingsConfig", (app, html) => {
    injectForgeAlertBadge(html);
});
