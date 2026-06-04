/**
 * WorkshopPackRegistryApp
 *
 * GM-only pack management panel for Ionrift Quartermaster.
 * Tabs:
 *   - Items: downloaded content packs (loot tables, item sets) with enable/disable
 *   - Art: icon pack status (placeholder - deferred to kernel ArtPackResolver)
 *
 * Extends AbstractPackRegistryApp from ionrift-library.
 */

const { AbstractPackRegistryApp } = await import("../../../ionrift-library/scripts/apps/AbstractPackRegistryApp.js");
import { ContentPackLoader } from "../services/ContentPackLoader.js";
import { ContentPackCompiler } from "../services/ContentPackCompiler.js";

export class WorkshopPackRegistryApp extends AbstractPackRegistryApp {

    static DEFAULT_OPTIONS = {
        id: "workshop-pack-registry",
        window: {
            title: "Quartermaster Packs",
            icon: "fas fa-treasure-chest",
            resizable: true
        },
        position: { width: 460, height: 480 },
        classes: ["ionrift-window", "glass-ui"]
    };

    // ═══════════════════════════════════════════════════════════════
    //  BASE CLASS OVERRIDES
    // ═══════════════════════════════════════════════════════════════

    _getModuleId() {
        return "ionrift-quartermaster";
    }

    _getTabDefinitions() {
        return [
            { id: "items", label: "Item Packs", icon: "fas fa-treasure-chest" },
            { id: "art", label: "Content Packs", icon: "fas fa-gem" }
        ];
    }

    async _preparePackData() {
        const enabledPacks = game.settings.get("ionrift-quartermaster", "workshopEnabledPacks") ?? {};
        const installedPacks = game.settings.get("ionrift-library", "installedPacks") ?? {};
        const importedPacks = game.settings.get("ionrift-quartermaster", "workshopImportedPacks") ?? {};

        const packs = [];

        // ── Scan imported content packs ──
        for (const [packId, packData] of Object.entries(importedPacks)) {
            const items = packData.items ?? [];
            const tables = packData.tables ?? [];
            const totalItems = items.length + tables.length;

            // Build rarity breakdown
            const rarityMap = {};
            for (const item of items) {
                const rarity = item.rarity ?? item.system?.rarity ?? "common";
                rarityMap[rarity] = (rarityMap[rarity] ?? 0) + 1;
            }

            packs.push({
                id: packId,
                label: packData.name ?? packId.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
                icon: packData.icon ?? "fas fa-gem",
                description: packData.description ?? "Imported item pack",
                enabled: enabledPacks[packId] !== false,
                totalItems,
                version: packData.version ?? installedPacks[packId]?.version ?? null,
                countLabel: "items",
                rarities: rarityMap,
                tableCount: tables.length
            });
        }

        // Sort alphabetical
        packs.sort((a, b) => a.label.localeCompare(b.label));

        return { packs, extra: {} };
    }

    async _renderTabPanel(tabId, context, panel) {
        if (tabId === "items") {
            await this._renderItemsTab(context, panel);
        } else if (tabId === "art") {
            await this._renderArtTab(context, panel);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  ITEMS TAB
    // ═══════════════════════════════════════════════════════════════

    async _renderItemsTab(context, panel) {
        let html = `<div class="pack-tab-content">`;

        // Summary bar
        html += this._renderSummaryBar([
            { label: "active items", value: context.totalEnabled },
            { label: "packs enabled", value: context.packs.filter(p => p.enabled).length },
            { label: "total available", value: context.totalAll }
        ]);

        // Updates banner
        html += this._renderUpdateBanner(context.pendingUpdates);

        if (context.packs.length === 0) {
            html += `
            <div class="art-empty-state">
                <i class="fas fa-treasure-chest"></i>
                <p>No item packs installed.</p>
                <span>Import a JSON pack to add custom loot tables, item sets, and treasures.</span>
            </div>`;
        } else {
            html += `<div class="pack-section-header"><i class="fas fa-gem"></i> Item Packs</div>`;
            for (const pack of context.packs) {
                const bodyHtml = this._renderItemCardBody(pack);
                html += this._renderPackCard(pack, bodyHtml);
            }
        }

        html += `</div>`;

        // Footer links
        html += this._renderFooterLinks([
            { href: "https://www.patreon.com/ionrift", icon: "fas fa-download", label: "Get packs" },
            { href: "https://github.com/ionrift-gm/ionrift-library/wiki", icon: "fas fa-book", label: "Documentation" }
        ]);

        // Action buttons
        html += this._renderActionButtons([
            { cls: "pack-import-btn", icon: "fas fa-file-import", label: "Import Pack" },
            { cls: "pack-save-btn", icon: "fas fa-save", label: "Save Changes" }
        ]);

        panel.innerHTML = html;

        // Wire toggles
        this._wireToggles(panel);

        // Wire action buttons
        panel.querySelector(".pack-save-btn")?.addEventListener("click", () => this._onSaveItemPacks(panel));
        panel.querySelector(".pack-import-btn")?.addEventListener("click", () => this._importItemPack());
    }

    /**
     * Renders rarity badges for an item pack card body.
     */
    _renderItemCardBody(pack) {
        const RARITY_ORDER = ["common", "uncommon", "rare", "veryRare", "legendary", "artifact"];
        const RARITY_LABELS = {
            common: "Common", uncommon: "Uncommon", rare: "Rare",
            veryRare: "Very Rare", legendary: "Legendary", artifact: "Artifact"
        };
        const RARITY_COLORS = {
            common: "rgba(200,200,200,0.5)", uncommon: "rgba(30,200,30,0.6)",
            rare: "rgba(50,120,220,0.7)", veryRare: "rgba(155,89,182,0.7)",
            legendary: "rgba(255,165,0,0.7)", artifact: "rgba(220,70,70,0.7)"
        };

        const badges = RARITY_ORDER
            .filter(r => (pack.rarities?.[r] ?? 0) > 0)
            .map(r => {
                const count = pack.rarities[r];
                const color = RARITY_COLORS[r] ?? "rgba(255,255,255,0.4)";
                return `<span class="pack-terrain-badge" style="border-color: ${color}; color: ${color};"><em>${count}</em> ${RARITY_LABELS[r] ?? r}</span>`;
            })
            .join("");

        const tablesBadge = pack.tableCount > 0
            ? `<span class="pack-terrain-badge"><i class="fas fa-dice"></i> ${pack.tableCount} tables</span>`
            : "";

        return `<div class="pack-terrain-list">${badges}${tablesBadge}</div>`;
    }

    async _onSaveItemPacks(el) {
        const updated = {};
        el.querySelectorAll(".pack-toggle-input").forEach(cb => {
            updated[cb.dataset.packId] = cb.checked;
        });

        await game.settings.set("ionrift-quartermaster", "workshopEnabledPacks", updated);
        ui.notifications.info("Item packs updated. Changes apply to the next cache generation.");
        this.close();
    }

    // ═══════════════════════════════════════════════════════════════
    //  ART TAB
    // ═══════════════════════════════════════════════════════════════

    async _renderArtTab(_context, panel) {
        const loadedPacks = ContentPackLoader.getLoadedPacks();

        let html = `<div class="pack-tab-content">`;
        html += `<div class="pack-section-header"><i class="fas fa-gem"></i> CONTENT PACKS</div>`;

        if (loadedPacks.length === 0) {
            html += `
            <div class="art-empty-state">
                <i class="fas fa-archive"></i>
                <p>No content packs installed.</p>
                <span>Extract a content pack ZIP to <code>ionrift-data/quartermaster/packs/</code> and reload Foundry.</span>
            </div>`;
        } else {
            for (const packMeta of loadedPacks) {
                const compiled = ContentPackCompiler.getCompiledInfo(packMeta.id);
                const statusIcon = compiled
                    ? `<span class="pack-terrain-badge" style="border-color: rgba(30,200,30,0.6); color: rgba(30,200,30,0.6);"><i class="fas fa-check"></i> Compiled</span>`
                    : `<span class="pack-terrain-badge" style="border-color: rgba(255,165,0,0.7); color: rgba(255,165,0,0.7);"><i class="fas fa-clock"></i> Not compiled</span>`;
                const compiledInfo = compiled
                    ? `<span class="pack-terrain-badge"><em>${compiled.totalItems}</em> items</span>`
                    : `<span class="pack-terrain-badge"><em>${packMeta.totalItems}</em> items available</span>`;

                const bodyHtml = `<div class="pack-terrain-list">${statusIcon}${compiledInfo}</div>`;
                const packCard = this._renderPackCard({
                    id: packMeta.id,
                    label: packMeta.name,
                    icon: "fas fa-gem",
                    description: `${packMeta.description}${packMeta.version ? ` v${packMeta.version}` : ""}`,
                    enabled: !!compiled,
                    totalItems: packMeta.totalItems,
                    countLabel: "items"
                }, bodyHtml, { showToggle: false });
                html += packCard;
            }
        }

        html += `</div>`;

        // Footer links
        html += this._renderFooterLinks([
            { href: "https://www.patreon.com/ionrift", icon: "fas fa-download", label: "Get content packs" },
            { href: "https://github.com/ionrift-gm/ionrift-library/wiki", icon: "fas fa-book", label: "Install guide" }
        ]);

        // Action buttons
        html += this._renderActionButtons([
            { cls: "content-pack-compile-btn", icon: "fas fa-hammer", label: "Compile All" },
            { cls: "content-pack-remove-btn", icon: "fas fa-trash", label: "Remove All" }
        ]);

        panel.innerHTML = html;

        // Wire action buttons
        panel.querySelector(".content-pack-compile-btn")?.addEventListener("click", async () => {
            const btn = panel.querySelector(".content-pack-compile-btn");
            btn.disabled = true;
            btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Compiling\u2026`;
            try {
                await ContentPackCompiler.compileAll();
                this.render({ force: true });
            } catch (err) {
                ui.notifications.error("Content pack compilation failed. Check the console.");
                console.error(err);
                btn.disabled = false;
                btn.innerHTML = `<i class="fas fa-hammer"></i> Compile All`;
            }
        });

        panel.querySelector(".content-pack-remove-btn")?.addEventListener("click", async () => {
            const confirmed = await Dialog.confirm({
                title: "Remove Content Packs",
                content: "<p>This will delete all compiled world compendiums from content packs. The pack files in ionrift-data/ will not be deleted.</p><p>Continue?</p>"
            });
            if (!confirmed) return;

            for (const packMeta of loadedPacks) {
                const compiled = ContentPackCompiler.getCompiledInfo(packMeta.id);
                if (compiled) {
                    await ContentPackCompiler.removePack(packMeta.id);
                }
            }
            this.render({ force: true });
        });
    }

    // ═══════════════════════════════════════════════════════════════
    //  IMPORT FLOW
    // ═══════════════════════════════════════════════════════════════

    /**
     * Import a Quartermaster JSON content pack (items, loot tables).
     */
    async _importItemPack() {
        if (!game.ionrift?.library?.importJsonPack) {
            ui.notifications.error("Ionrift Library v1.7.0+ is required for pack imports.");
            return;
        }

        const result = await game.ionrift.library.importJsonPack({
            moduleId: "workshop",
            schemaValidator: (data) => {
                if (!data.id) return { valid: false, errors: ["Pack JSON is missing 'id' field."] };
                const hasItems = Array.isArray(data.items) && data.items.length > 0;
                const hasTables = Array.isArray(data.tables) && data.tables.length > 0;
                if (!hasItems && !hasTables) {
                    return { valid: false, errors: ["Pack JSON has no items or tables."] };
                }
                return { valid: true, errors: [] };
            },
            onImport: async (data) => {
                const importedPacks = game.settings.get("ionrift-quartermaster", "workshopImportedPacks") ?? {};
                importedPacks[data.id] = {
                    name: data.name ?? data.id,
                    description: data.description ?? "",
                    icon: data.icon ?? "fas fa-gem",
                    items: data.items ?? [],
                    tables: data.tables ?? [],
                    version: data.version ?? "1.0.0",
                    importedAt: new Date().toISOString()
                };
                await game.settings.set("ionrift-quartermaster", "workshopImportedPacks", importedPacks);

                const enabledPacks = game.settings.get("ionrift-quartermaster", "workshopEnabledPacks") ?? {};
                enabledPacks[data.id] = true;
                await game.settings.set("ionrift-quartermaster", "workshopEnabledPacks", enabledPacks);

                return { packId: data.id, name: data.name ?? data.id };
            }
        });

        if (result?.success) {
            ui.notifications.info(`Imported "${result.packId}" successfully.`);
            this.render({ force: true });
        }
    }
}
