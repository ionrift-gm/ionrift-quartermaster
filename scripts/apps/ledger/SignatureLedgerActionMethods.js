import { SignatureLedger } from "../../services/progression/SignatureLedger.js";
import { ProgressionSeeder }  from "../../services/progression/ProgressionSeeder.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { getCurseAdapter } from "../../services/curse/getCurseAdapter.js";
import { StandalonePoolRegistry, getActiveCursedRegistry } from "../../services/loot/StandalonePoolRegistry.js";
import { CursedSourcesApp, CURSED_POOL_DATA_HOOK } from "../forge/CursedSourcesApp.js";
import { CursedItemResolver } from "../../services/curse/CursedItemResolver.js";
import { LootGenerationConfigApp } from "../config/loot/LootGenerationConfigApp.js";
import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";

export class SignatureLedgerActionMethods {
    // ── Delivery Auto-Sync ────────────────────────────────────────────────────

    /**
     * Scan party inventories and auto-mark shelf items as delivered when
     * a matching item is found on any character. Persists changes only if
     * the delivery status actually changed.
     *
     * Match policy: case-insensitive name comparison with apostrophe
     * normalisation (dnd5e compendium uses unicode right single quotes).
     *
     * @param {Array}   shelf        Current party shelf entries
     * @param {Actor[]} partyActors  Active party members
     * @returns {Array} Updated shelf (same reference if unchanged)
     */
    async _syncDeliveryStatus(shelf, partyActors) {
        if (!shelf.length || !partyActors.length) return shelf;

        // Build a Set of all item names across all party inventories
        const ownedNames = new Set();
        for (const actor of partyActors) {
            for (const item of actor.items) {
                ownedNames.add(this._normaliseNameForMatch(item.name));
            }
        }

        let changed = false;
        for (const entry of shelf) {
            const normalised = this._normaliseNameForMatch(entry.name);
            const isOwned = ownedNames.has(normalised);

            if (isOwned && !entry.delivered) {
                entry.delivered = true;
                changed = true;
            }
            // Don't auto-undeliver: if a GM manually marked something delivered
            // but the item was consumed/sold, that's intentional history.
        }

        if (changed) {
            await SignatureLedger.setPartyShelf(shelf);
        }

        return shelf;
    }

    /**
     * Normalise an item name for fuzzy matching.
     * Lowercases, trims, and collapses unicode apostrophe variants.
     */
    _normaliseNameForMatch(name) {
        return (name ?? "")
            .toLowerCase()
            .trim()
            .replace(/[\u2018\u2019\u2032\u0060\u00B4]/g, "'");
    }

    // ── Signature Delivery Sync ──────────────────────────────────────────────

    /**
     * Scan party inventories and auto-mark signature items as delivered when
     * a matching item is found on the assigned character. Persists changes
     * only if delivery status actually changed.
     *
     * Same sticky-delivery policy as Party Shelf: once owned, delivered stays
     * true even if the item is later sold/discarded. GM can manually toggle.
     */
    async _syncSignatureDelivery(sigData, partyActors) {
        let changed = false;
        for (const actor of partyActors) {
            const entry = sigData[actor.id];
            if (!entry?.plannedItems?.length) continue;

            const ownedItems = actor.items;
            const ownedNames = new Set(
                ownedItems.map(i => this._normaliseNameForMatch(i.name))
            );
            const ownedIdentifiers = new Set(
                ownedItems.map(i => i.system?.identifier?.toLowerCase()).filter(Boolean)
            );
            const ownedSlugs = new Set(
                ownedItems.map(i => i.system?.slug?.toLowerCase()).filter(Boolean)
            );
            const ownedKeys = new Set(
                ownedItems.map(i => i.flags?.[MODULE_ID]?.compiledKey?.toLowerCase()).filter(Boolean)
            );

            for (const planned of entry.plannedItems) {
                const normName = this._normaliseNameForMatch(planned.name);
                const plannedIdent = (planned.system?.identifier || planned.identifier || "").toLowerCase();
                const plannedSlug = (planned.system?.slug || planned.slug || "").toLowerCase();
                const plannedKey = (planned.flags?.[MODULE_ID]?.compiledKey || planned.compiledKey || "").toLowerCase();

                const isOwned = ownedNames.has(normName)
                    || (plannedIdent && ownedIdentifiers.has(plannedIdent))
                    || (plannedSlug && ownedSlugs.has(plannedSlug))
                    || (plannedKey && ownedKeys.has(plannedKey));
                if (isOwned && !planned.delivered) {
                    planned.delivered = true;
                    changed = true;
                }
                // Sticky: never auto-undeliver
            }
        }
        if (changed) await SignatureLedger.setLedgerData(sigData);
        return sigData;
    }


    _onSwitchTab(event) {
        this._activeTab = event.currentTarget.dataset.tab;
        this.render();
    }

    /**
     * Opens the library's PartyRosterApp for managing party membership.
     * Membership changes propagate automatically via the ionrift.partyChanged hook.
     */
    _onManageParty(event) {
        event.preventDefault();
        const PartyRosterApp = game.ionrift?.library?.PartyRosterApp;
        if (PartyRosterApp) {
            new PartyRosterApp().render(true);
        } else {
            // Defensive fallback - should not reach here with library >= 2.0.0
            ui.notifications.warn(game.i18n.localize("ionrift-quartermaster.notification.partyRosterRequiresLib"));
        }
    }

    // ── Signature Actions ─────────────────────────────────────────────────────

    async _openItemSheetFromSlot(event, { dragGuard, ignoreSelector }) {
        if (dragGuard()) return;
        if (event.target.closest(ignoreSelector)) return;
        event.preventDefault();
        const uuid = event.currentTarget.dataset.uuid;
        if (!uuid) return;
        try {
            const doc = await fromUuid(uuid);
            doc?.sheet?.render(true);
        } catch { /* uuid may be stale */ }
    }

    async _onClearSignatureSlot(event) {
        event.preventDefault();
        event.stopPropagation();
        const slotEl  = $(event.currentTarget).closest(".grid-slot");
        const actorId = slotEl.data("actorId");
        const level   = parseInt(slotEl.data("level"));
        const data    = await SignatureLedger.getLedgerData();
        if (data[actorId]) {
            const pin = (data[actorId].plannedItems || []).find(i => i.level === level);
            if (pin?.locked) return;
            data[actorId].plannedItems = (data[actorId].plannedItems || []).filter(i => i.level !== level);
            await SignatureLedger.setLedgerData(data);
            this.render();
        }
    }

    async _onToggleSignatureDelivered(event) {
        event.preventDefault();
        event.stopPropagation();
        const btn     = event.currentTarget;
        const actorId = btn.dataset.actorId;
        const level   = parseInt(btn.dataset.level, 10);
        const data    = await SignatureLedger.getLedgerData();
        if (!data[actorId]) return;
        const pin = (data[actorId].plannedItems || []).find(i => i.level === level);
        if (!pin) return;
        pin.delivered = !pin.delivered;
        await SignatureLedger.setLedgerData(data);
        this.render();
    }

    async _onToggleLock(event) {
        event.preventDefault();
        event.stopPropagation();
        const btn     = event.currentTarget;
        const actorId = btn.dataset.actorId;
        const level   = parseInt(btn.dataset.level, 10);
        const uuid    = btn.dataset.uuid;
        const variant = btn.dataset.variant;  // "scroll", "party", "cursed", or undefined (sig)

        if (actorId) {
            const data = await SignatureLedger.getLedgerData();
            if (!data[actorId]) return;
            const pin = (data[actorId].plannedItems || []).find(i => i.level === level);
            if (!pin) return;
            pin.locked = !pin.locked;
            await SignatureLedger.setLedgerData(data);
        } else if (variant === "scroll") {
            const pinned = await SignatureLedger.getScrollPinned();
            const pin = pinned.find(p => p.level === level && p.uuid === uuid);
            if (!pin) return;
            pin.locked = !pin.locked;
            await SignatureLedger.setScrollPinned(pinned);
        } else if (variant === "party") {
            const shelf = await SignatureLedger.getPartyShelf();
            const pin = shelf.find(p => p.level === level && p.uuid === uuid);
            if (!pin) return;
            pin.locked = !pin.locked;
            await SignatureLedger.setPartyShelf(shelf);
        } else {
            const planned = await getActiveCursedRegistry().getCursedPlanned();
            const pin = planned.find(p => p.level === level && p.uuid === uuid);
            if (!pin) return;
            pin.locked = !pin.locked;
            await getActiveCursedRegistry().setCursedPlanned(planned);
        }
        this.render();
    }

    async _onRerollSlot(event) {
        event.preventDefault();
        event.stopPropagation();
        const slotEl  = $(event.currentTarget).closest(".grid-slot");
        const actorId = slotEl.data("actorId");
        const level   = parseInt(slotEl.data("level"));
        const actor   = game.actors.get(actorId);
        if (!actor) return;

        const banSet     = await SignatureLedger.getBanSet();
        const ledgerData = await SignatureLedger.getLedgerData();
        if (!ledgerData[actorId]) return;
        const locked = (ledgerData[actorId].plannedItems || []).find(i => i.level === level);
        if (locked?.locked) return;

        // Remove the current item from this slot
        const existing = ledgerData[actorId].plannedItems || [];
        const oldItem  = existing.find(i => i.level === level);

        ledgerData[actorId].plannedItems = existing.filter(i => i.level !== level);

        // Build exclusion sets: all other characters' items + this character's remaining items
        const partyUsedNames = new Set();
        for (const [otherId, otherData] of Object.entries(ledgerData)) {
            for (const item of (otherData.plannedItems || [])) {
                partyUsedNames.add(item.name.toLowerCase());
            }
        }
        // Also exclude the old item so a different one is picked
        if (oldItem) partyUsedNames.add(oldItem.name.toLowerCase());

        // Seed ONLY this milestone slot using forceMilestones
        const partyAllocations = new Map();
        const planned = await ProgressionSeeder.seedSignatures(actor, banSet, partyAllocations, partyUsedNames, [level]);
        const rerolled = planned[0];

        if (rerolled) {
            ledgerData[actorId].plannedItems.push(rerolled);
            await SignatureLedger.setLedgerData(ledgerData);
            ui.notifications.info(game.i18n.format("ionrift-quartermaster.notification.signatureRerolled", { item: rerolled.name, actor: actor.name, level }));
        } else {
            // Restore old item if no replacement found
            if (oldItem) ledgerData[actorId].plannedItems.push(oldItem);
            await SignatureLedger.setLedgerData(ledgerData);
            ui.notifications.warn(game.i18n.format("ionrift-quartermaster.notification.signatureNoAlternative", { actor: actor.name, level }));
        }
        this.render();
    }


    async _onSeedSignatures(event) {
        event.preventDefault();
        const actorId = event.currentTarget.dataset.actorId;
        const actor   = game.actors.get(actorId);
        if (!actor) return;

        const banSet     = await SignatureLedger.getBanSet();
        const ledgerData = await SignatureLedger.getLedgerData();
        if (!ledgerData[actorId]) return;

        const existing = ledgerData[actorId].plannedItems || [];
        const BUDGET   = 4;

        if (existing.length >= BUDGET) {
            ui.notifications.warn(game.i18n.format("ionrift-quartermaster.notification.signatureBudgetFull", { actor: actor.name, budget: BUDGET }));
            return;
        }

        const usedLevels     = new Set(existing.map(p => p.level));
        const partyUsedNames = new Set();
        const myRole         = ProgressionSeeder._detectRole(actor);
        const partyAllocations = new Map();

        for (const [otherId, otherData] of Object.entries(ledgerData)) {
            if (otherId === actorId) continue;
            for (const item of (otherData.plannedItems || [])) {
                partyUsedNames.add(item.name.toLowerCase());
            }
            const otherActor = game.actors.get(otherId);
            if (!otherActor) continue;
            if (ProgressionSeeder._detectRole(otherActor) !== myRole) continue;
            for (const item of (otherData.plannedItems || [])) {
                if (item.source !== "auto") continue;
                if (!partyAllocations.has(item.level)) {
                    partyAllocations.set(item.level, item._category || null);
                }
            }
        }

        for (const item of existing) {
            partyUsedNames.add(item.name.toLowerCase());
        }

        const planned = await ProgressionSeeder.seedSignatures(actor, banSet, partyAllocations, partyUsedNames);

        const budgetLeft = BUDGET - existing.length;
        const newItems   = planned
            .filter(p => !usedLevels.has(p.level))
            .slice(0, Math.max(0, budgetLeft));
        ledgerData[actorId].plannedItems = [...existing, ...newItems];

        await SignatureLedger.setLedgerData(ledgerData);
        ui.notifications.info(game.i18n.format("ionrift-quartermaster.notification.signatureFilledSlots", { count: newItems.length, actor: actor.name }));
        this.render();
    }

    async _assignSignature(actorId, level, itemData) {
        const BUDGET = 4;
        const ledgerData = await SignatureLedger.getLedgerData();
        if (!ledgerData[actorId]) return;
        if (!ledgerData[actorId].plannedItems) ledgerData[actorId].plannedItems = [];

        const existing    = ledgerData[actorId].plannedItems;
        const occupant    = existing.find(i => i.level === level);
        if (occupant?.locked) return;
        const alreadyFilled = !!occupant;

        // Replacing an existing slot is always allowed (swap, not addition).
        // Adding to a full budget is blocked.
        if (!alreadyFilled && existing.length >= BUDGET) {
            ui.notifications.warn(
                game.i18n.format("ionrift-quartermaster.notification.signatureBudgetFullAssign", { budget: BUDGET })
            );
            return;
        }

        ledgerData[actorId].plannedItems = existing.filter(i => i.level !== level);
        ledgerData[actorId].plannedItems.push({ uuid: itemData.uuid, name: itemData.name, img: itemData.img, rarity: itemData.rarity || "uncommon", level, source: "manual" });
        await SignatureLedger.setLedgerData(ledgerData);
        this.render();
    }

    // ── Scroll Pinned Actions ──────────────────────────────────────────────────

    async _onRemoveScrollPin(event) {
        event.preventDefault();
        event.stopPropagation();
        const level = parseInt(event.currentTarget.dataset.level);
        const uuid  = event.currentTarget.dataset.uuid;
        const pinned = await SignatureLedger.getScrollPinned();
        const pin = pinned.find(p => p.level === level && p.uuid === uuid);
        if (pin?.locked) return;
        await SignatureLedger.setScrollPinned(
            pinned.filter(p => !(p.level === level && p.uuid === uuid))
        );
        this.render();
    }

    async _onToggleScrollDelivered(event) {
        event.preventDefault();
        event.stopPropagation();
        const level = parseInt(event.currentTarget.dataset.level);
        const uuid  = event.currentTarget.dataset.uuid;
        const pinned = await SignatureLedger.getScrollPinned();
        const pin = pinned.find(p => p.level === level && p.uuid === uuid);
        if (pin) {
            pin.delivered = !pin.delivered;
            await SignatureLedger.setScrollPinned(pinned);
            this.render();
        }
    }

    /** Opens the forged spell scroll compendium. */
    async _onOpenForgedScrolls(event) {
        event.preventDefault();
        const { ScrollForge } = await import("../../services/scroll/ScrollForge.js");
        ScrollForge.openForgedPack();
    }

    /** Launches the Scroll Forge source-selection dialog, then re-renders. */
    async _onCompileScrollForge(event) {
        event.preventDefault();
        const { CompendiumForgeApp } = await import("../forge/CompendiumForgeApp.js");
        const app = new CompendiumForgeApp({}, { activeTab: "scrollForge" });
        app.render(true);
        Hooks.once("closeCompendiumForgeApp", () => this.render());
    }

    // ── Party Shelf Actions ───────────────────────────────────────────────────

    async _onRemovePartyItem(event) {
        event.preventDefault();
        event.stopPropagation();
        const level = parseInt(event.currentTarget.dataset.level);
        const uuid  = event.currentTarget.dataset.uuid;
        const shelf = await SignatureLedger.getPartyShelf();
        await SignatureLedger.setPartyShelf(
            shelf.filter(p => !(p.level === level && p.uuid === uuid))
        );
        this.render();
    }

    async _onToggleDelivered(event) {
        event.preventDefault();
        event.stopPropagation();
        const level = parseInt(event.currentTarget.dataset.level);
        const uuid  = event.currentTarget.dataset.uuid;
        const shelf = await SignatureLedger.getPartyShelf();
        const item  = shelf.find(p => p.level === level && p.uuid === uuid);
        if (item) {
            item.delivered = !item.delivered;
            await SignatureLedger.setPartyShelf(shelf);
            this.render();
        }
    }

    async _onSeedPartyShelf(event) {
        event.preventDefault();
        ui.notifications.info(game.i18n.localize("ionrift-quartermaster.notification.partyShelfSeeding"));

        const partyActors = SignatureLedger._resolvePartyMembers();
        const banSet      = await SignatureLedger.getBanSet();
        const existing    = await SignatureLedger.getPartyShelf();

        const kept = existing.filter(e => e.source !== "auto" || e.locked);
        const usedNames = new Set(kept.map(e => e.name.toLowerCase()));

        const seeded = await ProgressionSeeder.seedPartyShelf(partyActors, banSet);
        const fresh  = seeded.filter(s => !usedNames.has(s.name.toLowerCase()));

        if (!fresh.length && kept.length === existing.length) {
            ui.notifications.warn(game.i18n.localize("ionrift-quartermaster.notification.partyShelfNoNewItems"));
            return;
        }

        const CAP = 3;
        const merged = [...kept];
        for (const item of fresh) {
            const atLevel = merged.filter(p => p.level === item.level);
            if (atLevel.length >= CAP) continue;
            item.slotOrder = atLevel.length;
            merged.push(item);
        }
        await SignatureLedger.setPartyShelf(merged);
        const replaced = existing.length - kept.length;
        const added    = merged.length - kept.length;
        ui.notifications.info(replaced
            ? game.i18n.format("ionrift-quartermaster.notification.partyShelfRandomisedWithReplaced", { added, replaced })
            : game.i18n.format("ionrift-quartermaster.notification.partyShelfRandomised", { added })
        );
        this.render();
    }

    async _onCurateShelfSources(event) {
        event.preventDefault();
        const { CompendiumForgeApp } = await import("../forge/CompendiumForgeApp.js");
        const app = new CompendiumForgeApp({}, { activeTab: "lootPool" });
        app.render(true);
        Hooks.once("closeCompendiumForgeApp", () => this.render());
    }

    // ── Cursed: Pool Management ─────────────────────────────────────────

    async _onLoadSrdCursedItems(event) {
        event.preventDefault();
        if (!game.user.isGM) return;
        // SRD items are superseded when Cursewright is loaded. Block silently so
        // any programmatic caller doesn't pollute the pool with obsolete items.
        if (game.ionrift?.cursewright) {
            ui.notifications.warn(game.i18n.localize("ionrift-quartermaster.notification.cursewrightActiveUseCompileCW"));
            return;
        }

        ui.notifications.info(game.i18n.localize("ionrift-quartermaster.notification.compilingSrdCursedItems"));
        await getCurseAdapter().compile({ forceRecompile: true });

        const srdPack = game.packs.get(getCurseAdapter().worldCollectionId);
        if (!srdPack) {
            ui.notifications.warn(game.i18n.localize("ionrift-quartermaster.notification.srdCursedItemsNotFound"));
            return;
        }

        let docs;
        try { docs = await srdPack.getDocuments(); }
        catch (e) { Logger.error(MODULE_LABEL, "_onLoadSrdCursedItems: could not read SRD pack", e); return; }

        // Strip any existing SRD items from the pool first.
        // Their UUIDs become stale after a recompile (compendium is destroyed + recreated).
        // Replacing is correct Refresh behaviour; non-SRD items are untouched.
        let pool = await getActiveCursedRegistry().getCursedPool();
        pool = pool.filter(p => !(p.uuid || "").includes("ionrift-srd-cursed"));
        const before = pool.length;

        for (const item of docs) {
            const meta = item.flags?.[MODULE_ID]?.cursedMeta ?? {};
            pool.push({
                uuid:      item.uuid,
                name:      item.name,
                img:       item.img || DEFAULT_ITEM_ICON,
                curseType: meta.curseType || "",
                tier:      meta.tier ?? 1
            });
        }

        await getActiveCursedRegistry().setCursedPool(pool);
        Hooks.callAll(CURSED_POOL_DATA_HOOK);
        const added = pool.length - before;
        ui.notifications.info(docs.length === 1
            ? game.i18n.format("ionrift-quartermaster.notification.srdCursedItemsRefreshedOne", { count: docs.length })
            : game.i18n.format("ionrift-quartermaster.notification.srdCursedItemsRefreshedOther", { count: docs.length })
        );
        this.render();
    }

    /**
     * "Load Cursewright" / "Refresh Cursewright" button.
     * Silently compiles from auto-detected dnd5e packs (no picker dialog)
     * then seeds the pool from the resulting world pack.
     */
    async _onRebuildCursedPool(event) {
        event.preventDefault();
        if (!game.user.isGM) return;

        const cw = game.ionrift?.cursewright;
        if (!cw) {
            // Fallback: if CW button somehow fires without CW, load SRD instead
            return this._onLoadSrdCursedItems(event);
        }

        const CurseForge = cw.forge;
        if (!CurseForge?.compile) {
            Logger.warn(MODULE_LABEL, "_onRebuildCursedPool: Cursewright forge API is unavailable.");
            return;
        }

        // If the world pack was deleted manually, the CW hash setting is stale.
        // compile() will see "hash unchanged" and no-op, leaving the pack missing.
        // Detect this and clear the hash so compile() runs in full.
        const cwPackId = CurseForge.worldCollectionId;
        if (!game.packs.get(cwPackId)) {
            Logger.warn(MODULE_LABEL, "_onRebuildCursedPool: world pack missing; clearing hash to force recompile.");
            try { await game.settings.set("ionrift-cursewright", CurseForge.SETTING_HASH, ""); }
            catch (e) { /* The setting may not exist yet. */ }
        }

        ui.notifications.info(game.i18n.localize("ionrift-quartermaster.notification.compilingCursewrightItems"));
        await CurseForge.compile({ force: true });
        CurseForge.enforceOwnership();

        await this._seedPoolFromForgedPack();
        this.render();
    }

    /**
     * Imports every item from the Cursewright forged world pack into the pool.
     * Strip-then-replace: removes existing CW items (stale UUIDs after recompile)
     * then adds all fresh items from the newly compiled pack.
     */
    async _seedPoolFromForgedPack() {
        const cw = game.ionrift?.cursewright;
        const forgedPackId = cw?.forge?.worldCollectionId ?? "world.ionrift-cursewright-forged";
        const pack = game.packs.get(forgedPackId);
        if (!pack) {
            Logger.warn(MODULE_LABEL, "_seedPoolFromForgedPack: forged pack not found after compile.");
            return;
        }

        let docs;
        try {
            const all = await pack.getDocuments();
            // The forged pack now contains paired lure + identified-twin docs
            // for non-deceptive recipes. Twins are GM audit references only;
            // the pool must contain LURES exclusively.
            docs = all.filter(d => d.flags?.["ionrift-cursewright"]?.role !== "identified");
        }
        catch (e) { Logger.error(MODULE_LABEL, "_seedPoolFromForgedPack: could not read forged pack", e); return; }

        // Strip existing CW items - their UUIDs are invalidated when the pack is rebuilt.
        let pool = await getActiveCursedRegistry().getCursedPool();
        pool = pool.filter(p => !(p.uuid || "").includes("ionrift-cursewright-forged"));

        for (const item of docs) {
            const meta = item.flags?.[MODULE_ID]?.cursedMeta ?? {};
            pool.push({
                uuid:            item.uuid,
                name:            item.name,
                img:             item.img || DEFAULT_ITEM_ICON,
                curseType:       meta.curseType       || "",
                decoyAppearance: meta.decoyAppearance || "",
                trueNature:      meta.trueNature      || "",
                tier:            meta.tier ?? 1
            });
        }

        await getActiveCursedRegistry().setCursedPool(pool);
        if (typeof getActiveCursedRegistry().rematchLedgerCursedUuids === "function") {
            await getActiveCursedRegistry().rematchLedgerCursedUuids(docs);
        }
        Hooks.callAll(CURSED_POOL_DATA_HOOK);
        ui.notifications.info(docs.length === 1
            ? game.i18n.format("ionrift-quartermaster.notification.cursewrightItemsInPoolOne", { count: docs.length })
            : game.i18n.format("ionrift-quartermaster.notification.cursewrightItemsInPoolOther", { count: docs.length })
        );
    }

    // ── Cursed: Pool Actions ──────────────────────────────────────────────

    async _onRemovePoolItem(event) {
        event.preventDefault();
        // Use UUID for removal - data-index carries posInCol (a within-tier ordinal),
        // NOT a global pool array index. Splicing by posInCol would delete the wrong
        // item when tiers 1/2 have entries ahead of the target tier in the pool array.
        const uuid = event.currentTarget.dataset.uuid;
        if (!uuid) return;
        const pool = await getActiveCursedRegistry().getCursedPool();
        const next = pool.filter(e => (e.uuid || "") !== uuid);
        if (next.length === pool.length) return; // nothing matched - bail
        await getActiveCursedRegistry().setCursedPool(next);
        Hooks.callAll(CURSED_POOL_DATA_HOOK);
        this.render();
    }


    _initCardSearchFilter(html, { inputSelector, cardSelector, noMatchSelector, emptySelector }) {
        const input = html[0]?.querySelector(inputSelector);
        if (!input) return;

        /** Shared filter runner - called by both text input and type dropdown. */
        const runFilter = () => {
            const query = input.value.toLowerCase().trim();
            const typeSelect = html[0]?.querySelector(".cursed-pool-type-filter");
            const typeFilter = typeSelect?.value?.toLowerCase() || "";
            const cards = html[0].querySelectorAll(cardSelector);
            const noMatches = html[0].querySelector(noMatchSelector);
            const emptyState = html[0].querySelector(emptySelector);
            let visible = 0;

            cards.forEach(card => {
                const name = (card.dataset.name || "").toLowerCase();
                const type = (card.dataset.curseType || "").toLowerCase();
                const matchText = !query || name.includes(query);
                const matchType = !typeFilter || type === typeFilter;
                const show = matchText && matchType;
                card.style.display = show ? "" : "none";
                if (show) visible++;
            });

            const hasFilter = query || typeFilter;
            if (noMatches) noMatches.style.display = (hasFilter && visible === 0) ? "" : "none";
            if (emptyState) emptyState.style.display = (!hasFilter && cards.length === 0) ? "" : "none";
        };

        input.addEventListener("input", runFilter);
    }

    // ── Ban List Actions ──────────────────────────────────────────────────────

    async _onRemoveBan(event) {
        event.preventDefault();
        const idx  = parseInt(event.currentTarget.dataset.index);
        const list = await SignatureLedger.getBanList();
        list.splice(idx, 1);
        await SignatureLedger.setBanList(list);
        this.render();
    }

    /**
     * Wire dragover/dragleave visuals on the ban drop zone. The actual drop
     * is handled by Foundry's dragDrop config routing to _onDrop.
     */
    _initBanDropZoneVisuals(html) {
        const zone = html[0]?.querySelector(".ban-drop-zone");
        if (!zone) return;

        zone.addEventListener("dragover", ev => {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "copy";
            zone.classList.add("ban-drop-active");
        });
        zone.addEventListener("dragleave", ev => {
            if (!zone.contains(ev.relatedTarget)) zone.classList.remove("ban-drop-active");
        });
        zone.addEventListener("drop", () => {
            zone.classList.remove("ban-drop-active");
        });
    }

    // ── Drag-Drop (item compendium drag onto slots) ───────────────────────────

    async _onDrop(event) {
        // ── Guard: internal sig-slot-move is handled entirely in _initSignatureDragDrop.
        // If stopPropagation worked, this won't fire. Belt-and-suspenders check:
        try {
            const raw = event.dataTransfer.getData("text/plain");
            if (raw) {
                const peek = JSON.parse(raw);
                if (peek?.type === "sig-slot-move") return;
                if (peek?.type === "scroll-pinned-move") return;
                if (peek?.type === "party-slot-move") return;
            }
        } catch { /* not our payload */ }

        const data = TextEditor.getDragEventData(event);
        if (!data || data.type !== "Item" || !data.uuid) return;

        // ── Ban list drop zone ──────────────────────────────────
        const banZone = event.target.closest(".ban-drop-zone");
        if (banZone) {
            const item = await fromUuid(data.uuid);
            if (!item) return;
            const list = await SignatureLedger.getBanList();
            const key = data.uuid.toLowerCase();
            if (list.some(b => (b.uuid || "").toLowerCase() === key) ||
                list.some(b => b.name.toLowerCase() === item.name.toLowerCase())) {
                ui.notifications.warn(game.i18n.format("ionrift-quartermaster.notification.banItemAlreadyOnList", { name: item.name }));
                return;
            }
            list.push({ name: item.name, img: item.img || null, uuid: data.uuid, reason: "" });
            await SignatureLedger.setBanList(list);
            ui.notifications.info(game.i18n.format("ionrift-quartermaster.notification.banItemAdded", { name: item.name }));
            this.render();
            return;
        }

        // Identify which slot was dropped on (fall back to nearest column if cursor hit the strip gap)
        let slotEl = event.target.closest(".grid-slot");
        if (!slotEl) {
            const strip = event.target.closest(".sig-slots-strip");
            if (strip) slotEl = this.constructor._nearestSlot(strip, event.clientX, event.clientY);
        }
        if (!slotEl) {
            const cursedStrip = event.target.closest(".cursed-slots-strip");
            if (cursedStrip) {
                slotEl = this.constructor._nearestCursedSlot(cursedStrip, event.clientX, event.clientY);
            }
        }
        if (!slotEl) {
            const scrollStrip = event.target.closest(".scroll-slots-strip");
            if (scrollStrip) {
                slotEl = this.constructor._nearestCursedSlot(scrollStrip, event.clientX, event.clientY);
            }
        }
        if (!slotEl) {
            const partyStrip = event.target.closest(".party-slots-strip");
            if (partyStrip) {
                slotEl = this.constructor._nearestCursedSlot(partyStrip, event.clientX, event.clientY);
            }
        }
        if (!slotEl) return;

        // Refuse drops onto budget-exhausted empty slots (filled slots always accept replacements)
        if (slotEl.classList.contains("slot-disabled") && !slotEl.classList.contains("slot-filled")) return;

        const isParty    = slotEl.classList.contains("party-slot");
        const isScroll   = slotEl.classList.contains("scroll-slot");
        const actorId    = slotEl.dataset.actorId;
        const level      = parseInt(slotEl.dataset.level);
        if (isNaN(level)) return;

        const item = await fromUuid(data.uuid);
        if (!item) return;

        const base = { uuid: data.uuid, name: item.name, img: item.img, rarity: item.system?.rarity || "uncommon" };

        if (isParty) {
            const shelf = await SignatureLedger.getPartyShelf();
            const slotIdx = parseInt(slotEl.dataset.slotIdx || "0", 10);
            const occupant = shelf.find(p => p.level === level && (p.slotOrder ?? 0) === slotIdx);
            const next = occupant
                ? shelf.filter(p => !(p.level === level && (p.slotOrder ?? 0) === slotIdx))
                : [...shelf];
            next.push({ ...base, level, slotOrder: slotIdx, delivered: false });
            await SignatureLedger.setPartyShelf(next);
        } else if (isScroll) {
            if (slotEl.classList.contains("slot-locked")) return;
            const pinned = await SignatureLedger.getScrollPinned();
            const nameKey = (item.name || "").toLowerCase();
            if (pinned.some(s => (s.spellName || "").toLowerCase() === nameKey)) {
                ui.notifications.warn(game.i18n.format("ionrift-quartermaster.notification.scrollAlreadyPinned", { name: item.name }));
                return;
            }
            const slotIdx = Math.min(2, Math.max(0, parseInt(slotEl.dataset.slotIdx || "0", 10)));
            const newEntry = {
                uuid:       data.uuid,
                spellName:  item.name,
                spellLevel: item.system?.level ?? 1,
                img:        item.img,
                source:     "drag",
                school:     item.system?.school || "",
                level,
                slotOrder:  slotIdx,
                delivered:  false,
                locked:     false
            };
            const merged = this.constructor._mergeScrollPinnedSlot(pinned, level, slotIdx, newEntry);
            await SignatureLedger.setScrollPinned(merged);
        } else if (actorId) {
            await this._assignSignature(actorId, level, base);
            return; // _assignSignature calls render()
        }

        this.render();
    }
}

export function applySignatureLedgerActionMethods(TargetClass) {
    for (const key of Object.getOwnPropertyNames(SignatureLedgerActionMethods.prototype)) {
        if (key === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(SignatureLedgerActionMethods.prototype, key);
        if (desc) Object.defineProperty(TargetClass.prototype, key, desc);
    }
}
