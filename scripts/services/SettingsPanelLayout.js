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
    "healingPotionFrequency",
    "ammoTypeTilt",
    "obscureConsumables",
    "obscureScrolls",
    "obscureMagicalItems",
    "gmOnlyIdentification",
    "scrollJitter",
    "distributeCoins"
];

const KEY_LABELS = {
    lootEconomy: "Loot abundance",
    magicFrequency: "Magic frequency",
    magicAmmoFrequency: "Magical ammunition",
    healingPotionFrequency: "Healing potions",
    ammoTypeTilt: "Ammunition preference",
    obscureConsumables: "Obscure consumables",
    obscureScrolls: "Obscure scrolls",
    obscureMagicalItems: "Obscure magical items",
    gmOnlyIdentification: "GM-only identification",
    scrollJitter: "Scroll jitter",
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
        desc: "Scarce loot, little magic, sparse healing, opaque items, tight scroll bands.",
        values: {
            lootEconomy: 0.5,
            magicFrequency: 0.25,
            magicAmmoFrequency: 0,
            healingPotionFrequency: 0.5,
            ammoTypeTilt: "balanced",
            obscureConsumables: true,
            obscureScrolls: true,
            obscureMagicalItems: true,
            gmOnlyIdentification: true,
            scrollJitter: 0,
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
            healingPotionFrequency: 1,
            ammoTypeTilt: "balanced",
            obscureConsumables: true,
            obscureScrolls: true,
            obscureMagicalItems: true,
            gmOnlyIdentification: true,
            scrollJitter: 1,
            distributeCoins: true
        }
    },
    {
        id: "high",
        label: "High",
        icon: "fas fa-gem",
        desc: "Generous hauls, more magic and healing, readable loot, wider scroll overshoot.",
        values: {
            lootEconomy: 1.5,
            magicFrequency: 1.5,
            magicAmmoFrequency: 1.5,
            healingPotionFrequency: 2.5,
            ammoTypeTilt: "balanced",
            obscureConsumables: false,
            obscureScrolls: false,
            obscureMagicalItems: false,
            gmOnlyIdentification: false,
            scrollJitter: 2,
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
    if (key === "lootEconomy" || key === "magicFrequency" || key === "magicAmmoFrequency"
            || key === "healingPotionFrequency") {
        const n = Number(value);
        const text = `×${Number.isInteger(n) ? n : n.toFixed(2).replace(/\.?0+$/, "")}`;
        return { text, cssClass: "value" };
    }
    if (key === "ammoTypeTilt") {
        return { text: AMMO_LABELS[value] ?? value, cssClass: "value" };
    }
    if (key === "scrollJitter") {
        const n = Number(value) || 0;
        return { text: String(n), cssClass: "value" };
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
            confirmRowGroups: [
                { beforeKey: "lootEconomy", label: "Loot & caches" },
                { beforeKey: "obscureConsumables", label: "Identification" }
            ],
            confirmNote: "Green values will change. Neutral values already match this profile. Loot pool sources, campaign milestone profile, and content packs are left unchanged.",
            guideTooltip: "Opens the GM setup guide (loot profiles, sources, milestone grid).",
            onGuide: () => openSetupGuide()
        },
        groups: GROUPS
    });
}

// ── Forge alert badge on Module Config ──────────────────────────────────
//
// Mirrors ionrift-library's injectPackUpdateBadge pattern: appends a small
// amber warning badge to the "Open Compendium Forge" button when a forge
// pipeline the table actually uses needs compilation or recompilation.

/**
 * @returns {boolean}
 */
function _isSrdCurseSourceEnabled() {
    try {
        const sources = JSON.parse(game.settings.get(MODULE_ID, "cursedItemSources") ?? "[]");
        return sources.includes(SrdCurseAdapter.worldCollectionId);
    } catch {
        return false;
    }
}

/**
 * @returns {boolean}
 */
function _hasScrollForgeSources() {
    try {
        const sources = JSON.parse(game.settings.get(MODULE_ID, ScrollForge.SETTING_SOURCES) ?? "[]");
        return Array.isArray(sources) && sources.length > 0;
    } catch {
        return false;
    }
}

/**
 * Normalize a forge status for badge aggregation.
 * @param {string|null|undefined} status
 * @returns {"fresh"|"stale"|"never"|null}
 */
function _normalizeForgeStatus(status) {
    if (!status || status === "fresh" || status === "na") return "fresh";
    if (status === "error") return "stale";
    return status;
}

/**
 * Compute the worst forge status across pipelines that are active for this world.
 * @returns {"fresh"|"stale"|"never"|null}
 */
export function getWorstForgeStatus() {
    try {
        const statuses = [];

        if (LootPoolCompiler.is2024ArchitecturePresent()) {
            statuses.push(_normalizeForgeStatus(LootPoolCompiler.getStatus()));
        }

        if (game.settings.get(MODULE_ID, "scrollForgeEnabled") && _hasScrollForgeSources()) {
            statuses.push(_normalizeForgeStatus(ScrollForge.getStatus()));
        }

        if (_isSrdCurseSourceEnabled()) {
            statuses.push(_normalizeForgeStatus(SrdCurseAdapter.getStatus()));
        }

        if (!statuses.length) return "fresh";

        if (statuses.includes("stale")) return "stale";
        if (statuses.includes("never")) return "never";
        return "fresh";
    } catch {
        return null;
    }
}

/**
 * Inject an alert badge on the Compendium Forge button in Module Config.
 * @param {jQuery|Element|DocumentFragment} html
 */
function injectForgeAlertBadge(html) {
    const root = html instanceof Element ? html : (html ? html[0] : document);
    const btn = root?.querySelector?.(`button[data-key="${MODULE_ID}.compendiumForge"]`);
    if (!btn) return;

    // Always remove any existing badge first so we can re-evaluate cleanly.
    btn.querySelector(".ionrift-forge-alert-badge")?.remove();

    const status = getWorstForgeStatus();
    if (!status || status === "fresh") return; // clean — no badge needed

    const isStale = status === "stale";
    const tooltip = isStale
        ? "A compiled pool is stale or missing. Open Compendium Forge to recompile."
        : "Content pools have not been compiled yet. Open Compendium Forge to set up.";
    const icon = isStale ? "fa-exclamation-triangle" : "fa-hammer";

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
    badge.innerHTML = `<i class="fas ${icon}" style="font-size:0.85em"></i> `;
    btn.appendChild(badge);
}

/**
 * Schedule badge refresh after ionrift-library ModuleConfigProfiles has
 * finished reordering the settings DOM (that hook runs on queueMicrotask).
 * @param {jQuery|HTMLElement|null} html
 */
function scheduleForgeAlertBadgeRefresh(html) {
    queueMicrotask(() => {
        queueMicrotask(() => {
            const sheet = game.settings.sheet;
            const root = html instanceof Element
                ? html
                : (html?.[0] ?? sheet?.element ?? null);
            if (root) injectForgeAlertBadge(root);
        });
    });
}

/**
 * Refresh the Compendium Forge alert badge on the currently-open settings panel.
 * Safe to call at any time; no-op if the settings panel is not rendered.
 * Called by CompendiumForgeApp after compile/close so the badge
 * clears without the GM needing to close and reopen the settings panel.
 */
export function refreshForgeAlertBadge() {
    const sheet = game.settings.sheet;
    if (!sheet?.rendered) return;
    scheduleForgeAlertBadgeRefresh(sheet.element);
}

Hooks.on("renderSettingsConfig", (app, html) => {
    scheduleForgeAlertBadgeRefresh(html);
});
