import { SignatureLedger } from "../../services/progression/SignatureLedger.js";
import { ProgressionSeeder }  from "../../services/progression/ProgressionSeeder.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { getCurseAdapter } from "../../services/curse/getCurseAdapter.js";
import { StandalonePoolRegistry, getActiveCursedRegistry } from "../../services/loot/StandalonePoolRegistry.js";
import { CursedSourcesApp, CURSED_POOL_DATA_HOOK } from "../forge/CursedSourcesApp.js";
import { CursedItemResolver } from "../../services/curse/CursedItemResolver.js";
import { LootGenerationConfigApp } from "../config/loot/LootGenerationConfigApp.js";
import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";
import { CURSE_TYPE_DESCRIPTIONS } from "./SignatureLedgerViewModelMethods.js";

export class SignatureLedgerDragMethods {
    /**
     * Config-driven drag-drop engine shared by signature and cursed tabs.
     */
    _initSlotDragDrop(form, config) {
        const overClass = config.overClass || "sig-drag-over";
        const clearOver = () => {
            form.querySelectorAll(`.${overClass}`).forEach(s => s.classList.remove(overClass));
        };

        for (const src of config.sources) {
            form.querySelectorAll(src.selector).forEach(el => {
                if (src.skipEl?.(el)) return;
                el.setAttribute("draggable", "true");
                el.addEventListener("dragstart", ev => {
                    if (ev.target.closest("button")) { ev.preventDefault(); return; }
                    this._hideItemTooltip();
                    config.onDragStart(el);
                    ev.dataTransfer.effectAllowed = "move";
                    ev.dataTransfer.setData("text/plain", JSON.stringify(src.buildPayload(el)));
                    setTimeout(() => {
                        el.classList.add(src.dragClass || "sig-dragging");
                        form.classList.add(config.formDragClass);
                    }, 0);
                });
                el.addEventListener("dragend", ev => {
                    el.classList.remove(src.dragClass || "sig-dragging");
                    form.classList.remove(config.formDragClass);
                    const px = ev.clientX;
                    const py = ev.clientY;
                    setTimeout(() => {
                        config.onDragCleanup();
                        clearOver();
                        if (config.afterDragRestore) {
                            requestAnimationFrame(() => {
                                requestAnimationFrame(() => config.afterDragRestore(px, py));
                            });
                        }
                    }, 120);
                });
            });
        }

        for (const zone of config.dropZones) {
            form.querySelectorAll(zone.selector).forEach(target => {
                target.addEventListener("dragover", ev => {
                    if (!config.isDragging()) return;
                    if (zone.canDrop && !zone.canDrop(target)) return;
                    ev.preventDefault();
                    ev.dataTransfer.dropEffect = "move";
                    clearOver();
                    target.classList.add(overClass);
                });
                target.addEventListener("dragleave", ev => {
                    if (!target.contains(ev.relatedTarget)) target.classList.remove(overClass);
                });
                target.addEventListener("drop", async ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    ev.stopImmediatePropagation();
                    target.classList.remove(overClass);
                    let payload;
                    try { payload = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
                    await zone.onDrop(target, payload);
                });
            });

            if (zone.slotSelector && zone.nearestSlotFn) {
                form.querySelectorAll(zone.slotSelector).forEach(strip => {
                    strip.addEventListener("dragover", ev => {
                        if (!config.isDragging()) return;
                        if (ev.target.closest(zone.selector)) return;
                        const slot = zone.nearestSlotFn(strip, ev.clientX, ev.clientY);
                        if (!slot) return;
                        if (zone.canDrop && !zone.canDrop(slot)) return;
                        ev.preventDefault();
                        ev.dataTransfer.dropEffect = "move";
                        clearOver();
                        slot.classList.add(overClass);
                    });
                    strip.addEventListener("dragleave", ev => {
                        if (strip.contains(ev.relatedTarget)) return;
                        clearOver();
                    });
                    strip.addEventListener("drop", async ev => {
                        if (ev.target.closest(zone.selector)) return;
                        const slot = zone.nearestSlotFn(strip, ev.clientX, ev.clientY);
                        clearOver();
                        if (!slot) return;
                        ev.preventDefault();
                        ev.stopPropagation();
                        ev.stopImmediatePropagation();
                        let payload;
                        try { payload = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
                        await zone.onDrop(slot, payload);
                    });
                });
            }
        }

        for (const rec of (config.extraReceivers || [])) {
            const el = form.querySelector(rec.selector);
            if (!el) continue;
            el.addEventListener("drop", async ev => {
                let payload;
                try {
                    const raw = ev.dataTransfer.getData("text/plain");
                    if (raw) payload = JSON.parse(raw);
                } catch { /* */ }
                if (!rec.acceptPayload(payload)) return;
                ev.preventDefault();
                ev.stopPropagation();
                ev.stopImmediatePropagation();
                await rec.onDrop(payload);
            });
        }
    }

    /**
     * Priority-pool drag-drop.
     * Handles two interactions:
     *   1. Reorder within a column: drag a .curse-priority-card to a new position in the same
     *      or different tier column. Saves new order via setPriorityOrder.
     *   2. External drop from compendium/sidebar: add item to column (blocked if full).
     */
    _initCursedDragDrop(html) {
        const form = html[0];
        const CAP = 5;

        /** Resolve a Foundry drag-event data object from text/plain or standard Foundry DragData. */
        const parseDragPayload = (ev) => {
            try {
                const raw = ev.dataTransfer.getData("text/plain");
                if (raw) return JSON.parse(raw);
            } catch { /* fall through */ }
            return null;
        };

        /** Visual: highlight column on dragover; clear on leave/drop. */
        const setColHighlight = (colEl, on) => {
            colEl?.classList.toggle("curse-col-drag-over", on);
        };

        // ── Draggable priority cards (internal reorder) ───────────────────────
        form.querySelectorAll(".curse-priority-card[data-uuid]").forEach(card => {
            card.setAttribute("draggable", "true");
            card.addEventListener("dragstart", ev => {
                if (ev.target.closest(".curse-priority-card-remove")) { ev.preventDefault(); return; }
                this._cursedDragType = "pool";
                this._cursedDragInFlight = false;
                ev.dataTransfer.effectAllowed = "move";
                ev.dataTransfer.setData("text/plain", JSON.stringify({
                    type:     "cursed-priority-move",
                    uuid:     card.dataset.uuid,
                    tier:     parseInt(card.dataset.tier, 10),
                    posInCol: parseInt(card.dataset.posInCol, 10)
                }));
                setTimeout(() => card.classList.add("curse-priority-card--dragging"), 0);
            });
            card.addEventListener("dragend", () => {
                card.classList.remove("curse-priority-card--dragging");
                form.querySelectorAll(".curse-col-drag-over").forEach(el => el.classList.remove("curse-col-drag-over"));
                setTimeout(() => {
                    this._cursedDragType = null;
                    this._cursedDragInFlight = false;
                }, 120);
            });
        });

        // ── Drop zones: tier columns ──────────────────────────────────────────
        form.querySelectorAll(".curse-priority-col").forEach(col => {
            const tierNum = parseInt(col.dataset.tier, 10);

            col.addEventListener("dragover", ev => {
                ev.preventDefault();
                ev.dataTransfer.dropEffect = "move";
                setColHighlight(col, true);
            });
            col.addEventListener("dragleave", ev => {
                if (!col.contains(ev.relatedTarget)) setColHighlight(col, false);
            });

            col.addEventListener("drop", async ev => {
                ev.preventDefault();
                ev.stopPropagation();
                setColHighlight(col, false);

                const payload = parseDragPayload(ev);
                const reg = getActiveCursedRegistry();

                if (payload?.type === "cursed-priority-move") {
                    // ── Reorder within/between tier columns ──────────────────
                    const fromUuid = payload.uuid;
                    const fromTier = payload.tier;

                    const pool = await reg.getCursedPool();

                    // Determine drop target position from cursor Y vs card midpoints
                    const cards = [...col.querySelectorAll(".curse-priority-card")];
                    let insertBefore = null;
                    for (const c of cards) {
                        const rect = c.getBoundingClientRect();
                        if (ev.clientY < rect.top + rect.height / 2) { insertBefore = c; break; }
                    }
                    const insertBeforeUuid = insertBefore?.dataset.uuid ?? null;

                    // Build new ordered UUID list for this tier
                    const tierItems = pool
                        .filter(e => (e.tier ?? 1) === tierNum && (e.uuid || "") !== fromUuid)
                        .map(e => e.uuid);

                    // Moving from another tier: check cap
                    if (fromTier !== tierNum) {
                        const currentCount = tierItems.length;
                        if (currentCount >= CAP) {
                            ui.notifications.warn(game.i18n.format("ionrift-quartermaster.notification.cursedColFullRemoveBeforeAdd", { tier: tierNum, cap: CAP }));
                            return;
                        }
                        // Also update the source tier to remove the item from there
                        const sourceTierItems = pool
                            .filter(e => (e.tier ?? 1) === fromTier && (e.uuid || "") !== fromUuid)
                            .map(e => e.uuid);
                        // Find the entry and update its tier
                        const movingEntry = pool.find(e => (e.uuid || "") === fromUuid);
                        if (movingEntry) movingEntry.tier = tierNum;
                        if (typeof reg.setPriorityOrder === "function") {
                            await reg.setPriorityOrder(fromTier, sourceTierItems);
                        }
                    }

                    // Insert at cursor position
                    const insertIdx = insertBeforeUuid
                        ? tierItems.indexOf(insertBeforeUuid)
                        : -1;
                    if (insertIdx >= 0) {
                        tierItems.splice(insertIdx, 0, fromUuid);
                    } else {
                        tierItems.push(fromUuid);
                    }

                    if (typeof reg.setPriorityOrder === "function") {
                        await reg.setPriorityOrder(tierNum, tierItems);
                    }
                    this.render();
                    return;
                }

                // ── External drop: add new item from compendium/sidebar ───────
                let uuid = payload?.uuid;
                if (!uuid) {
                    // Try Foundry v12/v13 standard drag data
                    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
                    const foundryData = TE?.getDragEventData?.(ev) ?? null;
                    uuid = foundryData?.uuid;
                }
                if (!uuid) return;

                const pool = await reg.getCursedPool();
                const tierItems = pool.filter(e => (e.tier ?? 1) === tierNum);
                if (tierItems.length >= CAP) {
                    ui.notifications.warn(game.i18n.format("ionrift-quartermaster.notification.cursedColFullRemoveFirst", { tier: tierNum, cap: CAP }));
                    return;
                }
                if (pool.some(e => (e.uuid || "").toLowerCase() === uuid.toLowerCase())) {
                    ui.notifications.info(game.i18n.localize("ionrift-quartermaster.notification.cursedItemAlreadyInPool"));
                    return;
                }

                // Resolve item doc for metadata
                let doc;
                try { doc = await fromUuid(uuid); } catch { /* */ }
                if (!doc) return;

                const meta = doc.flags?.[MODULE_ID]?.cursedMeta ?? {};
                const newEntry = {
                    uuid,
                    name:            doc.name ?? "Unknown",
                    img:             doc.img ?? DEFAULT_ITEM_ICON,
                    curseType:       meta.curseType ?? "unknown",
                    decoyAppearance: meta.decoyAppearance ?? "",
                    trueNature:      meta.trueNature ?? "",
                    tier:            meta.tier ?? tierNum
                };

                await reg.setCursedPool([...pool, newEntry]);
                this.render();
            });
        });
    }


    _initScrollDragDrop(html) {
        const form = html[0];
        const scrollDropHandler = async (target, payload) => {
            const toLevel = parseInt(target.dataset.level, 10);
            const toIdx   = parseInt(target.dataset.slotIdx || "0", 10);
            if (Number.isNaN(toLevel)) return;
            if (payload?.type !== "scroll-pinned-move") return;
            await this._swapOrMoveScrollPinned(payload.level, payload.uuid, toLevel, toIdx);
            this.render();
        };

        this._initSlotDragDrop(form, {
            formDragClass: "scroll-drag-in-progress",
            isDragging:    () => !!this._scrollDragType,
            onDragStart:   () => {
                this._scrollDragType = "pinned";
                this._scrollDragInFlight = false;
            },
            onDragCleanup: () => {
                this._scrollDragType = null;
                this._scrollDragInFlight = false;
            },
            afterDragRestore: (px, py) => {
                this._tryRestoreTooltipAfterDrag(px, py,
                    ".scroll-slot.slot-filled[data-uuid]");
            },
            sources: [
                {
                    selector: ".scroll-slot.slot-filled[data-uuid]",
                    skipEl: el => el.classList.contains("slot-locked"),
                    buildPayload: el => ({
                        type: "scroll-pinned-move",
                        level: parseInt(el.dataset.level, 10),
                        slotIdx: parseInt(el.dataset.slotIdx || "0", 10),
                        uuid: el.dataset.uuid
                    })
                }
            ],
            dropZones: [
                {
                    selector: ".scroll-slot",
                    slotSelector: ".scroll-slots-strip",
                    nearestSlotFn: (strip, x, y) => {
                        const s = (this.constructor?._nearestCursedSlot ?? this._nearestCursedSlot)(strip, x, y);
                        return s?.classList.contains("scroll-slot") ? s : null;
                    },
                    onDrop: scrollDropHandler
                }
            ]
        });
    }

    _initPartyDragDrop(html) {
        const form = html[0];
        const partyDropHandler = async (target, payload) => {
            const toLevel = parseInt(target.dataset.level, 10);
            const toIdx   = parseInt(target.dataset.slotIdx || "0", 10);
            if (Number.isNaN(toLevel)) return;
            if (payload?.type !== "party-slot-move") return;
            await this._swapOrMovePartyShelf(payload.level, payload.uuid, toLevel, toIdx);
            this.render();
        };

        this._initSlotDragDrop(form, {
            formDragClass: "party-drag-in-progress",
            isDragging:    () => !!this._partyDragType,
            onDragStart:   () => {
                this._partyDragType = "shelf";
                this._partyDragInFlight = false;
            },
            onDragCleanup: () => {
                this._partyDragType = null;
                this._partyDragInFlight = false;
            },
            afterDragRestore: (px, py) => {
                this._tryRestoreTooltipAfterDrag(px, py,
                    ".party-slot.slot-filled[data-uuid]");
            },
            sources: [{
                selector: ".party-slot.slot-filled[data-uuid]",
                skipEl: el => el.classList.contains("slot-locked"),
                buildPayload: el => ({
                    type: "party-slot-move",
                    level: parseInt(el.dataset.level, 10),
                    slotIdx: parseInt(el.dataset.slotIdx || "0", 10),
                    uuid: el.dataset.uuid
                })
            }],
            dropZones: [{
                selector: ".party-slot",
                slotSelector: ".party-slots-strip",
                nearestSlotFn: (strip, x, y) => {
                    const s = (this.constructor?._nearestCursedSlot ?? this._nearestCursedSlot)(strip, x, y);
                    return s?.classList.contains("party-slot") ? s : null;
                },
                onDrop: partyDropHandler
            }]
        });
    }


    // ── Internal Signature Slot Drag-and-Drop ─────────────────────────────────

    _initSignatureDragDrop(html) {
        const form = html[0];

        const sigDropHandler = async (target, payload) => {
            if (payload?.type !== "sig-slot-move") return;
            const { actorId: srcActorId, level: srcLevel } = payload;
            const dstActorId = target.dataset.actorId;
            const dstLevel   = parseInt(target.dataset.level);
            if (srcActorId === dstActorId && srcLevel === dstLevel) return;
            if (target.classList.contains("slot-disabled") && srcActorId !== dstActorId) return;
            await this._swapSignatureSlots(srcActorId, srcLevel, dstActorId, dstLevel);
        };

        this._initSlotDragDrop(form, {
            formDragClass: "sig-drag-in-progress",
            isDragging:    () => !!this._sigDragActorId,
            onDragStart:   (el) => {
                this._sigDragActorId  = el.dataset.actorId;
                this._sigDragInFlight = false;
            },
            onDragCleanup: () => {
                this._sigDragActorId  = null;
                this._sigDragInFlight = false;
            },
            afterDragRestore: (px, py) => {
                this._tryRestoreTooltipAfterDrag(px, py, ".grid-slot.slot-filled[data-uuid]");
            },
            sources: [{
                selector: ".grid-slot.slot-filled[data-actor-id]",
                skipEl: el => el.classList.contains("slot-locked"),
                buildPayload: el => ({
                    type: "sig-slot-move",
                    actorId: el.dataset.actorId,
                    level: parseInt(el.dataset.level),
                    uuid: el.dataset.uuid
                })
            }],
            dropZones: [{
                selector: ".grid-slot[data-actor-id]",
                slotSelector: ".sig-slots-strip:not(.cursed-slots-strip)",
                nearestSlotFn: (this.constructor?._nearestSlot ?? this._nearestSlot),
                canDrop: (target) => {
                    const isSameChar = target.dataset.actorId === this._sigDragActorId;
                    return !target.classList.contains("slot-disabled") || isSameChar;
                },
                onDrop: sigDropHandler
            }]
        });
    }


    /** Nearest `.grid-slot` inside a strip by Euclidean distance from cursor. */
    static _nearestSlot(strip, x, y) {
        let best = null, bestDist = Infinity;
        for (const slot of strip.querySelectorAll(".grid-slot")) {
            const r = slot.getBoundingClientRect();
            const dx = x - (r.left + r.right) / 2;
            const dy = y - (r.top + r.bottom) / 2;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; best = slot; }
        }
        return best;
    }

    /**
     * Planned curse strip: pick column by X, then slot by Y (two stacked slots per column).
     * Avoids Euclidean bias that favoured the wrong row when columns are narrow.
     */
    static _nearestCursedSlot(strip, clientX, clientY) {
        const stacks = strip.querySelectorAll(".cursed-milestone-stack");
        if (!stacks.length) return (this.constructor?._nearestSlot ?? this._nearestSlot)(strip, clientX, clientY);

        let bestStack = null;
        let bestStackDist = Infinity;
        for (const stack of stacks) {
            const r = stack.getBoundingClientRect();
            const midX = (r.left + r.right) / 2;
            const distX = Math.abs(clientX - midX);
            if (clientX >= r.left && clientX <= r.right) {
                bestStack = stack;
                bestStackDist = 0;
                break;
            }
            if (distX < bestStackDist) {
                bestStackDist = distX;
                bestStack = stack;
            }
        }
        if (!bestStack) return null;

        const slots = [...bestStack.querySelectorAll(".grid-slot")];
        if (!slots.length) return null;

        for (const slot of slots) {
            const sr = slot.getBoundingClientRect();
            if (clientY >= sr.top && clientY <= sr.bottom) return slot;
        }

        let best = slots[0];
        let bestDy = Infinity;
        for (const slot of slots) {
            const sr = slot.getBoundingClientRect();
            const cy = (sr.top + sr.bottom) / 2;
            const dy = Math.abs(clientY - cy);
            if (dy < bestDy) {
                bestDy = dy;
                best = slot;
            }
        }
        return best;
    }

    /**
     * Canonical occupant lookup: find the entry at (level, slotIdx) using raw slotOrder.
     * Do NOT bucket-rebuild - that is for view-model only.
     */
    static _slotOccupant(pins, level, slotIdx, cap) {
        const idx = Math.min(cap - 1, Math.max(0, Number(slotIdx) || 0));
        return pins.find(p => p.level === level && (p.slotOrder ?? 0) === idx) ?? undefined;
    }

    /**
     * Canonical slot merge: replace the entry at (level, slotIdx) with newEntry.
     * Returns a new array; does not mutate pins.
     */
    static _mergeSlot(pins, level, slotIdx, cap, newEntry) {
        const idx = Math.min(cap - 1, Math.max(0, Number(slotIdx) || 0));
        const others = pins.filter(p => !(p.level === level && (p.slotOrder ?? 0) === idx));
        return [...others, { ...newEntry, level, slotOrder: idx }];
    }

    /**
     * Move or swap signature items between two slots.
     * Handles same-character and cross-character cases.
     * Budget is re-validated: moving within same-char is always fine;
     * cross-char is allowed only if the destination character has budget.
     */
    async _swapSignatureSlots(srcActorId, srcLevel, dstActorId, dstLevel) {
        const BUDGET     = 4;
        const ledgerData = await SignatureLedger.getLedgerData();
        if (!ledgerData[srcActorId] || !ledgerData[dstActorId]) return;

        const srcItems = ledgerData[srcActorId].plannedItems || [];
        const dstItems = ledgerData[dstActorId].plannedItems || [];

        const srcEntry = srcItems.find(i => i.level === srcLevel);
        const dstEntry = dstItems.find(i => i.level === dstLevel);

        if (!srcEntry) return;
        if (srcEntry.locked || dstEntry?.locked) return;

        const isSameChar = srcActorId === dstActorId;

        if (!isSameChar && !dstEntry) {
            // Cross-character move: destination char must have budget
            const dstBudgetUsed = dstItems.length;
            if (dstBudgetUsed >= BUDGET) {
                ui.notifications.warn(
                    game.i18n.format("ionrift-quartermaster.notification.signatureNoBudgetRemaining", {
                        actor: ledgerData[dstActorId].name,
                        budget: BUDGET
                    })
                );
                return;
            }
        }

        if (isSameChar) {
            // ── Same character: move or swap by changing the level field ──
            for (const item of srcItems) {
                if (item.level === srcLevel) item.level = dstLevel;
                else if (item.level === dstLevel) item.level = srcLevel;
            }
        } else {
            // ── Cross-character: extract both entries, reassign ──
            ledgerData[srcActorId].plannedItems = srcItems.filter(i => i.level !== srcLevel);
            if (dstEntry) {
                ledgerData[dstActorId].plannedItems = dstItems.filter(i => i.level !== dstLevel);
            }

            // Move src → dst
            ledgerData[dstActorId].plannedItems.push({ ...srcEntry, level: dstLevel });
            // Move dst → src (if there was something there)
            if (dstEntry) {
                ledgerData[srcActorId].plannedItems.push({ ...dstEntry, level: srcLevel });
            }
        }

        await SignatureLedger.setLedgerData(ledgerData);

        const srcName = ledgerData[srcActorId].name;
        const dstName = ledgerData[dstActorId].name;
        if (isSameChar) {
            ui.notifications.info(game.i18n.format("ionrift-quartermaster.notification.signatureMovedLevel", {
                item: srcEntry.name,
                level: dstLevel,
                actor: srcName
            }));
        } else if (dstEntry) {
            ui.notifications.info(game.i18n.format("ionrift-quartermaster.notification.signatureSwapped", {
                itemA: srcEntry.name,
                itemB: dstEntry.name,
                actorA: srcName,
                actorB: dstName
            }));
        } else {
            ui.notifications.info(game.i18n.format("ionrift-quartermaster.notification.signatureMovedActor", {
                item: srcEntry.name,
                actorA: srcName,
                actorB: dstName,
                level: dstLevel
            }));
        }

        this.render();
    }

}

export function applySignatureLedgerDragAndTooltipMethods(SignatureLedgerApp) {
    for (const key of Object.getOwnPropertyNames(SignatureLedgerDragMethods.prototype)) {
        if (key === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(SignatureLedgerDragMethods.prototype, key);
        if (desc) Object.defineProperty(SignatureLedgerApp.prototype, key, desc);
    }
    for (const key of Object.getOwnPropertyNames(SignatureLedgerDragMethods)) {
        if (key === "length" || key === "name" || key === "prototype") continue;
        const desc = Object.getOwnPropertyDescriptor(SignatureLedgerDragMethods, key);
        if (desc) Object.defineProperty(SignatureLedgerApp, key, desc);
    }

// ── Tooltip Engine ──────────────────────────────────────────────────────────
// Appended outside the class to keep it a module-level utility block
// but scoped to SignatureLedgerApp via assignment on the prototype.

const LEDGER_ITEM_TOOLTIP_DELAY_MS = 220;

/** Queue the hover card for a uuid-bearing anchor (shared by hover and post-drag restore). */
SignatureLedgerApp.prototype._queueLedgerItemTooltip = function(anchorEl) {
    if (!anchorEl?.dataset?.uuid) return;
    if (anchorEl.classList.contains("grid-slot") && this._sigDragActorId) return;
    if (anchorEl.classList.contains("curse-priority-card") && this._cursedDragType) return;

    clearTimeout(this._tooltipTimer);
    this._tooltipTimer = setTimeout(async () => {
        const uuid = anchorEl.dataset.uuid;
        if (!uuid) return;

        let item = this._tooltipCache.get(uuid);
        if (!item) {
            try { item = await fromUuid(uuid); } catch { /* compendium may not be loaded */ }
            if (item) this._tooltipCache.set(uuid, item);
        }

        if (!item && anchorEl.classList.contains("curse-priority-card")) {
            const imgEl = anchorEl.querySelector(".slot-item-img, .curse-priority-card-img");
            item = {
                name:   anchorEl.dataset.name || "Cursed Item",
                img:    imgEl?.src || "",
                type:   "equipment",
                system: { rarity: "uncommon", description: { value: "" } },
                _cursedFallback: true
            };
        }
        if (!item) return;

        this._showItemTooltip(item, anchorEl);
    }, LEDGER_ITEM_TOOLTIP_DELAY_MS);
};

/**
 * After a drag ends, the browser may not emit mouseenter on the
 * slot under the pointer. Re-resolve from the drop/release coordinates.
 */
SignatureLedgerApp.prototype._tryRestoreTooltipAfterDrag = function(clientX, clientY, selector) {
    if (clientX === null || clientX === undefined || clientY === null || clientY === undefined) return;
    const under  = document.elementFromPoint(clientX, clientY);
    const anchor = under?.closest?.(selector);
    if (!anchor) return;
    this._queueLedgerItemTooltip(anchor);
};

SignatureLedgerApp.prototype._initTooltipListeners = function(html) {
    const repositionFromAnchor = () => {
        if (this._tooltipEl && this._tooltipAnchorEl) {
            this._positionTooltip(this._tooltipAnchorEl);
        }
    };

    // Slots: open the hover card from the portrait only so corner controls stay
    // unobstructed (native title tips and hit testing no longer compete with lock).
    html.find(".grid-slot.slot-filled[data-uuid]").each((_, slot) => {
        const img = slot.querySelector(".slot-item-img");
        if (img) {
            img.addEventListener("mouseenter", () => {
                this._queueLedgerItemTooltip(slot);
            });
        }
        slot.addEventListener("mouseleave", (ev) => {
            if (slot.contains(ev.relatedTarget)) return;
            clearTimeout(this._tooltipTimer);
            this._tooltipAnchorEl = null;
            this._hideItemTooltip();
        });
    });

    const otherHover = [
        ".party-item-row[title]",
        ".scroll-drag-item[data-uuid]",
        ".curse-priority-card[data-uuid]"
    ].join(", ");

    html.find(otherHover).each((_, el) => {
        el.addEventListener("mouseenter", () => {
            this._queueLedgerItemTooltip(el);
        });

        el.addEventListener("mouseleave", () => {
            clearTimeout(this._tooltipTimer);
            this._tooltipAnchorEl = null;
            this._hideItemTooltip();
        });
    });

    html.find(".ledger-scroll-area").each((_, scrollEl) => {
        scrollEl.addEventListener("scroll", repositionFromAnchor, { passive: true });
    });
};

SignatureLedgerApp.prototype._showItemTooltip = function(item, anchorEl) {
    this._hideItemTooltip();

    const rarity      = item.system?.rarity || "common";
    const type        = item.type || "";
    const subtype     = item.system?.type?.value || "";
    const attunement  = item.system?.attunement > 0;
    const rawDesc     = item.system?.description?.value || "";
    let   desc        = this._stripHtml(rawDesc).slice(0, 300).trim();

    // DnD5e SRD artefact: descriptions often open with the item type as a label
    // ("Wand. This wand has..." -> after HTML strip -> "Wand This wand...")
    // Strip the leading word if it matches the subtype or the item name's first word.
    const firstWord   = desc.split(/[\s.]/)[0]?.toLowerCase();
    const matchWords  = [subtype, type, item.name.split(" ")[0]]
        .filter(Boolean).map(w => w.toLowerCase());
    if (firstWord && matchWords.includes(firstWord)) {
        desc = desc.replace(/^\S+[\s.]+/, "").trim();
    }
    desc = desc.slice(0, 240);

    const rarityLabel = rarity === "veryRare"
        ? game.i18n.localize("ionrift-quartermaster.ledger.rarity.veryRare")
        : (rarity.charAt(0).toUpperCase() + rarity.slice(1));

    const isCursed   = anchorEl?.classList?.contains("curse-priority-card");
    const curseType  = anchorEl?.dataset?.curseType || "";
    const curseLabel = curseType && curseType !== "unknown"
        ? curseType.charAt(0).toUpperCase() + curseType.slice(1) : "";
    const isFallback = !!item._cursedFallback;

    // Enriched cursed context: tier badge + type description + detection hints
    let cursedEnrichment = "";
    if (isCursed) {
        const cursedMeta = item.flags?.[MODULE_ID]?.cursedMeta || item.flags?.cursedMeta || null;
        const tier = cursedMeta?.tier ?? (anchorEl?.dataset?.tier ? Number(anchorEl.dataset.tier) : null);
        const ctKey = (curseType || "").toLowerCase();
        const typeDesc = CURSE_TYPE_DESCRIPTIONS[ctKey] || "";
        const hints = cursedMeta?.detection?.hints;

        const tierColors = { 1: "#6ee7b7", 2: "#60a5fa", 3: "#c084fc", 4: "#f87171" };
        const tierBadge = tier
            ? `<span class="sig-tooltip-tier-badge" style="color:${tierColors[tier] || "#ccc"}; border-color:${tierColors[tier] || "#555"};">T${tier}</span>`
            : "";

        const typeDescHtml = typeDesc
            ? `<div class="sig-tooltip-curse-desc">${typeDesc}</div>`
            : "";

        const hintHtml = Array.isArray(hints) && hints.length
            ? `<div class="sig-tooltip-curse-hints"><i class="fas fa-eye" aria-hidden="true"></i> ${hints[0]}</div>`
            : "";

        cursedEnrichment = `${tierBadge}${typeDescHtml}${hintHtml}`;
    }

    const el = document.createElement("div");
    el.className = "sig-tooltip" + (isCursed ? " sig-tooltip-cursed" : "");
    el.innerHTML = `
        <div class="sig-tooltip-accent ${isCursed ? "cursed" : rarity}"></div>
        <div class="sig-tooltip-body">
            <div class="sig-tooltip-name">${item.name}</div>
            <div class="sig-tooltip-meta">
                ${isCursed && curseLabel ? `<span class="sig-tooltip-curse-type">${curseLabel}</span>` : ""}
                <span class="sig-tooltip-rarity ${rarity}">${rarityLabel}</span>
                ${type && !isFallback ? `<span class="sig-tooltip-type">${subtype || type}</span>` : ""}
                ${attunement ? `<span class="sig-tooltip-attunement">${game.i18n.localize("ionrift-quartermaster.ledger.tooltipRequiresAttunement")}</span>` : ""}
            </div>
            ${cursedEnrichment}
            ${desc ? `<div class="sig-tooltip-desc">${desc}</div>` : ""}
            <div class="sig-tooltip-hint">${isFallback ? game.i18n.localize("ionrift-quartermaster.ledger.tooltipCompendiumItem") : game.i18n.localize("ionrift-quartermaster.ledger.tooltipClickToOpenSheet")}</div>
        </div>
    `;

    document.body.appendChild(el);
    this._tooltipEl = el;
    this._tooltipAnchorEl = anchorEl;
    this._positionTooltip(anchorEl);
};

/**
 * Place the hover card beside the anchor element (signature slot, party row, etc.),
 * not at the cursor. Prefers the right edge; falls back to the left, then clamps to the viewport.
 */
SignatureLedgerApp.prototype._positionTooltip = function(anchorEl) {
    if (!this._tooltipEl || !anchorEl?.getBoundingClientRect) return;

    const PAD = 8;
    const GAP = 8;

    const anchor = anchorEl.getBoundingClientRect();
    const tip = this._tooltipEl.getBoundingClientRect();

    let left = anchor.right + GAP;
    let top  = anchor.top;

    if (left + tip.width > window.innerWidth - PAD) {
        left = anchor.left - tip.width - GAP;
    }
    if (left < PAD) {
        left = PAD;
    }
    if (left + tip.width > window.innerWidth - PAD) {
        left = Math.max(PAD, window.innerWidth - tip.width - PAD);
    }

    if (top + tip.height > window.innerHeight - PAD) {
        top = window.innerHeight - tip.height - PAD;
    }
    if (top < PAD) {
        top = PAD;
    }

    this._tooltipEl.style.left = `${left}px`;
    this._tooltipEl.style.top  = `${top}px`;
};

SignatureLedgerApp.prototype._hideItemTooltip = function() {
    if (this._tooltipTimer !== null && this._tooltipTimer !== undefined) {
        clearTimeout(this._tooltipTimer);
        this._tooltipTimer = null;
    }
    if (this._tooltipEl) {
        this._tooltipEl.remove();
        this._tooltipEl = null;
    }
    this._tooltipAnchorEl = null;
};

SignatureLedgerApp.prototype._stripHtml = function(html) {
    // Remove Foundry enricher syntax before parsing - they appear as @UUID[...]{label} or @Compendium[...]
    const noEnrichers = html
        .replace(/@(?:UUID|Compendium|Actor|Item|Scene|RollTable|JournalEntry|Macro)\[[^\]]*\]\{([^}]*)\}/g, "$1")
        .replace(/@(?:UUID|Compendium|Actor|Item|Scene|RollTable|JournalEntry|Macro)\[[^\]]*\]/g, "");

    const tmp = document.createElement("div");
    tmp.innerHTML = noEnrichers;
    return (tmp.textContent || tmp.innerText || "").replace(/\s+/g, " ").trim();
};
}
