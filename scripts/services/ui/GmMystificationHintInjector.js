import { MODULE_ID, MODULE_LABEL } from "../../data/moduleId.js";
import { Logger } from "../../utils/Logger.js";

/**
 * GmMystificationHintInjector
 *
 * Injects GM-only visual hints in brackets on dnd5e sheets (e.g. "Corked Bottle [Potion of Healing]")
 * so Dungeon Masters can see what a masked item conceals at a glance, matching PF2e's native behavior.
 */
export class GmMystificationHintInjector {

    static init() {
        if (!game.user?.isGM) return;
        if (game.system?.id !== "dnd5e") return;

        // Actor inventory sheets (Character, NPC, Loot, Container)
        const onActorRender = (app, html) => {
            GmMystificationHintInjector._onRenderActor(app, html);
        };
        Hooks.on("renderActorSheet", onActorRender);
        Hooks.on("renderActorSheet5e", onActorRender);
        Hooks.on("renderActorSheet5eCharacter", onActorRender);
        Hooks.on("renderActorSheet5eCharacter2", onActorRender);
        Hooks.on("renderActorSheet5eNPC", onActorRender);
        Hooks.on("renderActorSheet5eNPC2", onActorRender);

        // Item sheet header
        const onItemRender = (app, html) => {
            GmMystificationHintInjector._onRenderItem(app, html);
        };
        Hooks.on("renderItemSheet", onItemRender);
        Hooks.on("renderItemSheet5e", onItemRender);
        Hooks.on("renderItemSheet5e2", onItemRender);
    }

    static _onRenderActor(app, html) {
        try {
            if (!game.user?.isGM) return;
            const actor = app.actor ?? app.document;
            if (!actor || !actor.items) return;

            const root = html instanceof HTMLElement ? html : (html?.[0] ?? html?.element ?? null);
            if (!root) return;

            const itemRows = root.querySelectorAll?.('.item[data-item-id], .item[data-entry-id]');
            if (!itemRows || itemRows.length === 0) return;

            for (const row of itemRows) {
                if (row.querySelector?.(".ionrift-gm-latent-hint")) continue;

                const itemId = row.dataset.itemId || row.dataset.entryId;
                const item = actor.items.get(itemId);
                if (!item) continue;

                const originalName = GmMystificationHintInjector._getOriginalName(item);
                if (!originalName) continue;
                if (originalName.toLowerCase().trim() === (item.name || "").toLowerCase().trim()) continue;

                const targetEl = row.querySelector?.(".name-stacked .title")
                    ?? row.querySelector?.(".name-stacked")
                    ?? row.querySelector?.(".item-name h4")
                    ?? row.querySelector?.(".item-name span")
                    ?? row.querySelector?.(".item-name a")
                    ?? row.querySelector?.(".item-name");
                if (!targetEl) continue;

                const hint = document.createElement("span");
                hint.className = "ionrift-gm-latent-hint";
                hint.textContent = ` [${originalName}]`;
                hint.dataset.tooltip = game.i18n.format("ionrift-quartermaster.identify.concealedIdentityTooltip", { name: originalName });
                hint.style.opacity = "0.75";
                hint.style.fontStyle = "italic";
                hint.style.fontWeight = "normal";
                hint.style.color = "var(--dnd5e-color-gold, #c59b27)";
                hint.style.marginLeft = "4px";

                targetEl.appendChild(hint);
            }
        } catch (err) {
            Logger.warn(MODULE_LABEL, "GmMystificationHintInjector (Actor):", err);
        }
    }

    static _onRenderItem(app, html) {
        try {
            if (!game.user?.isGM) return;
            const item = app.item ?? app.document;
            if (!item || item.documentName !== "Item") return;

            const originalName = GmMystificationHintInjector._getOriginalName(item);
            if (!originalName) return;
            if (originalName.toLowerCase().trim() === (item.name || "").toLowerCase().trim()) return;

            const root = html instanceof HTMLElement ? html : (html?.[0] ?? html?.element ?? null);
            if (!root) return;
            if (root.querySelector?.(".ionrift-gm-latent-item-hint")) return;

            const titleInput = root.querySelector?.('input[name="name"]')
                ?? root.querySelector?.(".document-name")
                ?? root.querySelector?.(".item-title");
            if (!titleInput) return;

            const badge = document.createElement("div");
            badge.className = "ionrift-gm-latent-item-hint";
            badge.textContent = game.i18n.format("ionrift-quartermaster.identify.concealsBadge", { name: originalName });
            badge.dataset.tooltip = game.i18n.localize("ionrift-quartermaster.identify.trueItemRevealedTooltip");
            badge.style.fontSize = "0.85em";
            badge.style.fontStyle = "italic";
            badge.style.opacity = "0.85";
            badge.style.color = "var(--dnd5e-color-gold, #c59b27)";
            badge.style.marginTop = "2px";

            titleInput.parentElement?.appendChild(badge);
        } catch (err) {
            Logger.warn(MODULE_LABEL, "GmMystificationHintInjector (Item):", err);
        }
    }

    static _getOriginalName(item) {
        const qmFlags = item.flags?.[MODULE_ID] ?? {};
        const latent = qmFlags.latentMagic;
        if (latent && !latent.promoted && latent.originalName) {
            return latent.originalName;
        }

        const cursedMeta = qmFlags.cursedMeta;
        if (cursedMeta?.lure?.name) return cursedMeta.lure.name;
        if (cursedMeta?.lureName) return cursedMeta.lureName;

        return null;
    }
}
