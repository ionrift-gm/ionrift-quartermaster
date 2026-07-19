import { getActiveCursedRegistry } from "../../services/loot/StandalonePoolRegistry.js";
import { CursedSourcesApp, CURSED_POOL_DATA_HOOK } from "./CursedSourcesApp.js";
import { CursedItemResolver } from "../../services/curse/CursedItemResolver.js";
import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";


/**
 * GM picker: add or remove cursedMeta-stamped items from registered compendiums
 * in the cursed pool (CurseRegistry or StandalonePoolRegistry).
 */
export class CursedImportApp extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "ionrift-cursed-import",
            title: "Add Cursed Items",
            template: `modules/${MODULE_ID}/templates/cursed-import.hbs`,
            width: 520,
            height: 560,
            classes: ["ionrift-window", "glass-ui"],
            closeOnSubmit: false,
            scrollY: [".cursed-import-scroll"]
        });
    }

    constructor(options = {}) {
        super(options);
        this._selectedPackId = options.initialPackId ?? null;
    }

    /** @param {string} packId */
    static async _fetchCursedMetaItemsFromPack(packId) {
        const pack = game.packs.get(packId);
        if (!pack) return [];
        const docs = await pack.getDocuments();
        const rows = [];
        for (const item of docs) {
            const meta = item.getFlag(MODULE_ID, "cursedMeta");
            if (!meta || typeof meta !== "object") continue;
            // Resolve display name via shared service (bypasses dnd5e's identified:false getter)
            const displayName = CursedItemResolver.resolveDisplayName(item);
            rows.push({
                id:               item.id,
                uuid:             item.uuid,
                name:             displayName,
                img:              item.img ?? DEFAULT_ITEM_ICON,
                curseType:        meta.curseType ?? "unknown",
                tier:             meta.tier ?? 1,
                decoyAppearance:  meta.decoyAppearance ?? "",
                trueNature:       meta.trueNature ?? ""
            });
        }
        rows.sort((a, b) => a.name.localeCompare(b.name));
        return rows;
    }

    async getData() {
        const sourceIds = CursedSourcesApp.getEnabledSources();

        const packs = sourceIds
            .map(id => {
                const pack = game.packs.get(id);
                if (!pack) return null;
                const label = pack.metadata?.label ?? pack.metadata?.name ?? id;
                return { id, label };
            })
            .filter(Boolean);

        if (packs.length && !this._selectedPackId) {
            this._selectedPackId = packs[0].id;
        }
        const selectedPackId = this._selectedPackId ?? "";

        let items = [];
        if (selectedPackId) {
            items = await CursedImportApp._fetchCursedMetaItemsFromPack(selectedPackId);
        }

        const pool = await getActiveCursedRegistry().getCursedPool();
        const poolKeys = new Set(pool.map(p => (p.uuid || "").toLowerCase()));

        items = items.map(it => ({
            ...it,
            inPool: poolKeys.has((it.uuid || "").toLowerCase())
        }));

        return {
            packs,
            selectedPackId,
            items,
            hasPacks: packs.length > 0
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find("select[name='cursedImportPack']").on("change", async ev => {
            this._selectedPackId = ev.currentTarget.value;
            await this.render(false);
        });
        html.find(".action-cursed-import-apply").on("click", this._onApplyPoolChanges.bind(this));
        html.find(".cursed-import-toggle-selection").on("click", ev => {
            ev.preventDefault();
            const boxes = html.find(".cursed-import-row input[type='checkbox']");
            if (!boxes.length) return;
            const allOn = boxes.toArray().every(b => b.checked);
            boxes.prop("checked", !allOn);
        });
        html.find(".cursed-import-manage-sources").on("click", async ev => {
            ev.preventDefault();
            const { CursedSourcesApp: SourcesApp } = await import("./CursedSourcesApp.js");
            new SourcesApp().render(true);
        });
    }

    async _updateObject() {
        return;
    }

    async _onApplyPoolChanges(event) {
        event.preventDefault();
        if (!game.user.isGM) {
            ui.notifications.warn("Only a GM can modify the cursed pool.");
            return;
        }

        const html = this.element;
        const uuidKey = u => (u || "").toLowerCase();

        let pool = await getActiveCursedRegistry().getCursedPool();
        const initialLen = pool.length;

        const toRemove = new Set();
        const toAddUuids = [];

        for (const row of html.find(".cursed-import-row").toArray()) {
            const uuid = row.dataset.uuid;
            if (!uuid) continue;
            const key = uuidKey(uuid);
            const cb = row.querySelector("input[type='checkbox']");
            const checked = !!cb?.checked;
            const inPool = row.classList.contains("in-pool");

            if (inPool && !checked) toRemove.add(key);
            if (!inPool && checked) toAddUuids.push(uuid);
        }

        if (!toRemove.size && !toAddUuids.length) {
            ui.notifications.info("No changes to apply.");
            return;
        }

        pool = pool.filter(p => !toRemove.has(uuidKey(p.uuid)));
        const removed = initialLen - pool.length;

        const existing = new Set(pool.map(p => uuidKey(p.uuid)));
        let added = 0;

        for (const uuid of toAddUuids) {
            const key = uuidKey(uuid);
            if (existing.has(key)) continue;

            const item = await fromUuid(uuid);
            if (!item) continue;
            const meta = item.getFlag(MODULE_ID, "cursedMeta");
            if (!meta || typeof meta !== "object") continue;

            // Resolve display name via shared service (bypasses dnd5e's identified:false getter)
            const displayName = CursedItemResolver.resolveDisplayName(item);

            pool.push({
                uuid,
                name:            displayName,
                img:             item.img || DEFAULT_ITEM_ICON,
                curseType:       meta.curseType ?? "unknown",
                decoyAppearance: meta.decoyAppearance ?? "",
                trueNature:      meta.trueNature ?? "",
                tier:            Math.max(1, Math.min(4, Number(meta.tier) || 1))
            });

            existing.add(key);
            added++;
        }

        await getActiveCursedRegistry().setCursedPool(pool);
        Hooks.callAll(CURSED_POOL_DATA_HOOK);

        const parts = [];
        if (added) parts.push(`${added} added`);
        if (removed) parts.push(`${removed} removed`);
        ui.notifications.info(parts.length ? `Applied: ${parts.join(", ")}.` : "Pool updated.");

        await this.render(false);
    }
}
