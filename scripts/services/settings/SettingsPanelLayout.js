import { MODULE_ID } from "../../data/moduleId.js";
/**
 * @module SettingsPanelLayout
 * @description Registers Quartermaster Quick Setup via ionrift-library.
 */

import { refreshOpenQuartermasterConfigApps } from "../../apps/config/QuartermasterSubmenuConfigApp.js";
import { LootPoolCompiler } from "../loot/LootPoolCompiler.js";
import { ScrollForge      } from "../scroll/ScrollForge.js";
import { getCurseAdapter } from "../curse/getCurseAdapter.js";
import { getQuartermasterAdapter } from "../../adapters/getAdapter.js";
import { QM_FEATURES } from "../../data/QMFeatures.js";


const PROFILE_KEYS = [
    "lootEconomy",
    "magicFrequency",
    "armourDropChance",
    "namedMagicFrequency",
    "magicAmmoFrequency",
    "healingPotionFrequency",
    "ammoTypeTilt",
    "obscureConsumables",
    "obscureScrolls",
    "obscureMagicalItems",
    "gmOnlyIdentification",
    "distributeCoins"
];

const KEY_LABELS = {
    get lootEconomy() { return game.i18n.localize("ionrift-quartermaster.quickSetup.keyLabel.lootEconomy"); },
    get magicFrequency() { return game.i18n.localize("ionrift-quartermaster.quickSetup.keyLabel.magicFrequency"); },
    get armourDropChance() { return game.i18n.localize("ionrift-quartermaster.quickSetup.keyLabel.armourDropChance"); },
    get namedMagicFrequency() { return game.i18n.localize("ionrift-quartermaster.quickSetup.keyLabel.namedMagicFrequency"); },
    get magicAmmoFrequency() { return game.i18n.localize("ionrift-quartermaster.quickSetup.keyLabel.magicAmmoFrequency"); },
    get healingPotionFrequency() { return game.i18n.localize("ionrift-quartermaster.quickSetup.keyLabel.healingPotionFrequency"); },
    get ammoTypeTilt() { return game.i18n.localize("ionrift-quartermaster.quickSetup.keyLabel.ammoTypeTilt"); },
    get obscureConsumables() { return game.i18n.localize("ionrift-quartermaster.quickSetup.keyLabel.obscureConsumables"); },
    get obscureScrolls() { return game.i18n.localize("ionrift-quartermaster.quickSetup.keyLabel.obscureScrolls"); },
    get obscureMagicalItems() { return game.i18n.localize("ionrift-quartermaster.quickSetup.keyLabel.obscureMagicalItems"); },
    get gmOnlyIdentification() { return game.i18n.localize("ionrift-quartermaster.quickSetup.keyLabel.gmOnlyIdentification"); },
    get distributeCoins() { return game.i18n.localize("ionrift-quartermaster.quickSetup.keyLabel.distributeCoins"); }
};

const AMMO_LABELS = {
    get balanced() { return game.i18n.localize("ionrift-quartermaster.quickSetup.ammoLabel.balanced"); },
    get arrows() { return game.i18n.localize("ionrift-quartermaster.quickSetup.ammoLabel.arrows"); },
    get bolts() { return game.i18n.localize("ionrift-quartermaster.quickSetup.ammoLabel.bolts"); },
    get sling() { return game.i18n.localize("ionrift-quartermaster.quickSetup.ammoLabel.sling"); },
    get mixed() { return game.i18n.localize("ionrift-quartermaster.quickSetup.ammoLabel.mixed"); },
    get custom() { return game.i18n.localize("ionrift-quartermaster.quickSetup.ammoLabel.custom"); }
};

const PROFILES = [
    {
        id: "low",
        get label() { return game.i18n.localize("ionrift-quartermaster.quickSetup.profile.low.label"); },
        icon: "fas fa-mountain",
        get desc() { return game.i18n.localize("ionrift-quartermaster.quickSetup.profile.low.desc"); },
        values: {
            lootEconomy: 0.5,
            magicFrequency: 0.25,
            armourDropChance: 0.30,
            namedMagicFrequency: 0.5,
            magicAmmoFrequency: 0,
            healingPotionFrequency: 0.5,
            ammoTypeTilt: "balanced",
            obscureConsumables: true,
            obscureScrolls: true,
            obscureMagicalItems: true,
            gmOnlyIdentification: true,
            distributeCoins: true
        }
    },
    {
        id: "standard",
        get label() { return game.i18n.localize("ionrift-quartermaster.quickSetup.profile.standard.label"); },
        icon: "fas fa-scale-balanced",
        get desc() { return game.i18n.localize("ionrift-quartermaster.quickSetup.profile.standard.desc"); },
        values: {
            lootEconomy: 1,
            magicFrequency: 1,
            armourDropChance: 0.65,
            namedMagicFrequency: 1.0,
            magicAmmoFrequency: 1,
            healingPotionFrequency: 1,
            ammoTypeTilt: "balanced",
            obscureConsumables: true,
            obscureScrolls: true,
            obscureMagicalItems: true,
            gmOnlyIdentification: true,
            distributeCoins: true
        }
    },
    {
        id: "high",
        get label() { return game.i18n.localize("ionrift-quartermaster.quickSetup.profile.high.label"); },
        icon: "fas fa-gem",
        get desc() { return game.i18n.localize("ionrift-quartermaster.quickSetup.profile.high.desc"); },
        values: {
            lootEconomy: 1.5,
            magicFrequency: 1.5,
            armourDropChance: 0.90,
            namedMagicFrequency: 1.5,
            magicAmmoFrequency: 1.5,
            healingPotionFrequency: 2.5,
            ammoTypeTilt: "balanced",
            obscureConsumables: false,
            obscureScrolls: false,
            obscureMagicalItems: false,
            gmOnlyIdentification: false,
            distributeCoins: true
        }
    }
];

const GROUPS = [
    {
        get title() { return game.i18n.localize("ionrift-quartermaster.settingsGroup.startHere"); },
        icon: "fas fa-flag",
        keys: ["milestoneProfile", "compendiumForge"]
    },
    {
        get title() { return game.i18n.localize("ionrift-quartermaster.settingsGroup.lootAndCaches"); },
        icon: "fas fa-coins",
        keys: ["lootGenerationConfig"]
    },
    {
        get title() { return game.i18n.localize("ionrift-quartermaster.settingsGroup.atTheTable"); },
        icon: "fas fa-eye",
        keys: ["identificationConfig"]
    },
    {
        get title() { return game.i18n.localize("ionrift-quartermaster.settingsGroup.tools"); },
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
    if (key === "armourDropChance") {
        const n = Number(value);
        const pct = Math.round(n * 100);
        return { text: `${pct}%`, cssClass: "value" };
    }
    if (key === "lootEconomy" || key === "magicFrequency" || key === "namedMagicFrequency"
            || key === "magicAmmoFrequency" || key === "healingPotionFrequency") {
        const n = Number(value);
        const text = `×${Number.isInteger(n) ? n : n.toFixed(2).replace(/\.?0+$/, "")}`;
        return { text, cssClass: "value" };
    }
    if (key === "ammoTypeTilt") {
        return { text: AMMO_LABELS[value] ?? value, cssClass: "value" };
    }
    return { text: value ? game.i18n.localize("ionrift-quartermaster.quickSetup.cell.on") : game.i18n.localize("ionrift-quartermaster.quickSetup.cell.off"), cssClass: value ? "on" : "off" };
}

export function registerQuartermasterSettingsPanel() {
    const MCP = game.ionrift?.library?.ModuleConfigProfiles;
    if (!MCP) return;

    const adapter = getQuartermasterAdapter();
    if (!adapter.supports(QM_FEATURES.LATENT_MASKING) && !adapter.supports(QM_FEATURES.SIGNATURE_LEDGER)) {
        return;
    }

    MCP.register({
        moduleId: MODULE_ID,
        moduleLabel: "Quartermaster",
        anchorKey: "milestoneProfile",
        quickSetup: {
            get title() { return game.i18n.localize("ionrift-quartermaster.quickSetup.title"); },
            get subtitle() { return game.i18n.localize("ionrift-quartermaster.quickSetup.subtitle"); },
            profiles: PROFILES,
            profileKeys: PROFILE_KEYS,
            keyLabels: KEY_LABELS,
            formatCell: formatProfileCell,
            confirmRowGroups: [
                { beforeKey: "lootEconomy", get label() { return game.i18n.localize("ionrift-quartermaster.quickSetup.rowGroup.lootAndCaches"); } },
                { beforeKey: "obscureConsumables", get label() { return game.i18n.localize("ionrift-quartermaster.quickSetup.rowGroup.identification"); } }
            ],
            get confirmNote() { return game.i18n.localize("ionrift-quartermaster.quickSetup.confirmNote"); },
            onApplied: () => refreshOpenQuartermasterConfigApps()
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
        return sources.includes(getCurseAdapter().worldCollectionId);
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
        const adapter = getQuartermasterAdapter();
        const statuses = [];
        const compiledLootHash = game.settings.get(MODULE_ID, LootPoolCompiler.SETTING_HASH);

        if (adapter.supports(QM_FEATURES.LOOT_POOL_COMPILE)
            && (LootPoolCompiler.is2024ArchitecturePresent() || compiledLootHash)) {
            statuses.push(_normalizeForgeStatus(LootPoolCompiler.getStatus()));
        }

        if (adapter.supports(QM_FEATURES.SCROLL_FORGE)
            && game.settings.get(MODULE_ID, "scrollForgeEnabled")
            && _hasScrollForgeSources()) {
            statuses.push(_normalizeForgeStatus(ScrollForge.getStatus()));
        }

        if (adapter.supports(QM_FEATURES.SRD_CURSES) && _isSrdCurseSourceEnabled()) {
            statuses.push(_normalizeForgeStatus(getCurseAdapter().getStatus()));
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
    if (!status || status === "fresh") return; // clean - no badge needed

    const isStale = status === "stale";
    const tooltip = isStale
        ? game.i18n.localize("ionrift-quartermaster.forgeAlert.staleTooltip")
        : game.i18n.localize("ionrift-quartermaster.forgeAlert.neverTooltip");
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
