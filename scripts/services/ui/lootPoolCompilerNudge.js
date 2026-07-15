/**
 * Loot Pool Compiler nudge wiring.
 *
 * Surfaces the shared library pack-nudge banner in Module Settings when a
 * 2024-architecture compendium is in lootPoolSources but the compiled pool
 * is absent or stale.
 */

import { LootPoolCompiler } from "../LootPoolCompiler.js";
import { MODULE_ID } from "../../data/moduleId.js";

/**
 * Registers the loot pool compiler nudge with the shared library service.
 * Idempotent. Settings panel injection runs centrally from ionrift-library.
 */
export function registerLootPoolCompilerNudge() {
    const packNudge = game.ionrift?.library?.packNudge;
    if (!packNudge) return;

    // Guard against double-registration if the nudge service uses a nudgeId key
    if (typeof packNudge.isRegistered === "function" && packNudge.isRegistered(`${MODULE_ID}-loot-pool-compiler`)) return;

    packNudge.register({
        moduleId:   MODULE_ID,
        nudgeId:    "loot-pool-compiler",
        // Alert surface is the amber badge on the Compendium Forge button (see
        // SettingsPanelLayout.getWorstForgeStatus). The purple pack-nudge banner
        // is reserved for pack-install flows; suppress it here.
        isEnabled:  () => false,
        isContentInstalled: async () => {
            const status = LootPoolCompiler.getStatus();
            return status === "fresh";
        },
        openInstaller: async () => {
            const { CompendiumForgeApp } = await import("../../apps/forge/CompendiumForgeApp.js");
            new CompendiumForgeApp({}, { activeTab: "lootPool" }).render(true);
        },
        title:        "Loot pool needs compilation.",
        subtitle:     "Your 2024 SRD sources contain weapon templates that need expanding before they appear in loot caches.",
        icon:         "fas fa-hammer",
        primaryLabel: "Open Forge",
        primaryIcon:  "fas fa-hammer",
        findSettingsAnchor: ($html) => {
            const candidates = [
                { selector: `button[data-key="${MODULE_ID}.compendiumForge"]`, position: "before" },
                { selector: `button[data-key="${MODULE_ID}.lootPoolConfig"]`,  position: "before" },
            ];
            for (const { selector, position } of candidates) {
                const $btn = $html.find(selector);
                if (!$btn.length) continue;
                const $group = $btn.closest(".form-group");
                if ($group.length) return { $anchor: $group, position };
            }
            return null;
        }
    });
}
