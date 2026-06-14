import { IdentificationService } from "./IdentificationService.js";
import { traceIdentify, traceItemFlags } from "./IdentificationTrace.js";

const MODULE_ID = "ionrift-quartermaster";

/** dnd5e 5.x frame header toggle for system.identified */
const DND5E_IDENTIFY_SELECTOR = '[data-action="toggleState"][data-property="system.identified"], .toggle-identified';

/**
 * Blocks naive `system.identified` writes on actor-owned items when
 * `gmOnlyIdentification` is enabled. Routes GM wand clicks through
 * IdentificationService when a Quartermaster payload is pending.
 *
 * Must register on every connected client; preUpdateItem is local to
 * the client that initiates the update.
 *
 * Masked items keep `system.identified = true` so dnd5e sheets stay
 * functional. The native wand toggles frame state via `toggleState`;
 * a capture listener on that control routes to IdentificationService.
 */
export class IdentificationGuard {

    /** @type {boolean} */
    static _initialized = false;

    /** @type {boolean} */
    static _captureInstalled = false;

    static init() {
        if (IdentificationGuard._initialized) return;
        IdentificationGuard._initialized = true;
        Hooks.on("preUpdateItem", IdentificationGuard.guardIdentify);
        const onRender = (app, html) => IdentificationGuard._scheduleBind(app, html);
        Hooks.on("renderItemSheet", onRender);
        Hooks.on("renderItemSheet5e", onRender);
        Hooks.on("renderItemSheet5e2", onRender);
        IdentificationGuard._installGlobalIdentifyCapture();
    }

    /**
     * @param {Item} item
     * @param {object} change
     * @param {object} options
     * @returns {boolean|void} Return false to cancel the update.
     */
    static guardIdentify(item, change, options /*, userId */) {
        if (!foundry.utils.hasProperty(change, "system.identified")) return;

        traceIdentify("preUpdateItem", {
            ...traceItemFlags(item),
            changeIdentified: change.system?.identified,
            changeQty: change.system?.quantity,
            curseBypass: !!options?.curseBypass,
            isGM: game.user.isGM
        });

        if (!game.settings.get(MODULE_ID, "gmOnlyIdentification")) {
            traceIdentify("preUpdateItem:pass", { reason: "gmOnlyIdentification-off" });
            return;
        }
        if (options?.curseBypass) {
            traceIdentify("preUpdateItem:pass", { reason: "curseBypass" });
            return;
        }
        if (!item?.parent) {
            traceIdentify("preUpdateItem:pass", { reason: "no-parent" });
            return;
        }

        const latent = item.getFlag?.(MODULE_ID, "latentMagic");
        const infected = item.getFlag?.(MODULE_ID, "infectedCount") ?? 0;
        const isItemPile = !!item.parent?.flags?.["item-piles"]?.data?.enabled;

        const hasLatentOrInfected = !!(latent && !latent.promoted) || infected > 0;
        const isIPNormalisationPass = hasLatentOrInfected && change?.system?.quantity !== undefined;
        if (isIPNormalisationPass) {
            delete change.system.identified;
            if (change.system && Object.keys(change.system).length === 0) delete change.system;
            traceIdentify("preUpdateItem:strip-identified", {
                reason: "ip-normalisation",
                isItemPile,
                qty: change.system?.quantity
            });
            if (!change.system && !change.name && !change.img && !change.flags) return false;
            return;
        }

        const hasPendingPayload = IdentificationService.hasPendingIdentification(item);

        if (game.user.isGM) {
            if (hasPendingPayload) {
                traceIdentify("preUpdateItem:route-service", traceItemFlags(item));
                Promise.resolve().then(() =>
                    game.ionrift?.quartermaster?.identificationService?.identify(item)
                );
                return false;
            }
            traceIdentify("preUpdateItem:pass", { reason: "gm-no-pending-payload" });
            return;
        }

        if (hasPendingPayload || hasLatentOrInfected) {
            traceIdentify("preUpdateItem:block", { reason: "non-gm-masked" });
            return false;
        }
        if (isItemPile) {
            traceIdentify("preUpdateItem:pass", { reason: "non-gm-pile-mundane" });
            return;
        }
        traceIdentify("preUpdateItem:block", { reason: "non-gm-default" });
        return false;
    }

    /**
     * Capture-phase listener on the dnd5e frame wand. The control lives on
     * the application frame, not in the sheet body passed to render hooks.
     */
    static _installGlobalIdentifyCapture() {
        if (IdentificationGuard._captureInstalled) return;
        IdentificationGuard._captureInstalled = true;

        document.addEventListener("click", (event) => {
            const control = event.target.closest?.(DND5E_IDENTIFY_SELECTOR);
            if (!control) return;

            traceIdentify("wand-click", {
                controlAction: control.dataset?.action,
                controlProperty: control.dataset?.property,
                controlActive: control.classList.contains("active")
            });

            const item = IdentificationGuard._itemFromIdentifyControl(control);
            if (!item) {
                traceIdentify("wand-click:abort", { reason: "item-not-resolved" });
                return;
            }

            traceIdentify("wand-click:item", traceItemFlags(item));

            if (!game.user.isGM) {
                traceIdentify("wand-click:abort", { reason: "not-gm" });
                return;
            }
            if (!game.settings.get(MODULE_ID, "gmOnlyIdentification")) {
                traceIdentify("wand-click:pass-native", { reason: "gmOnlyIdentification-off" });
                return;
            }

            const pending = IdentificationService.hasPendingIdentification(item);
            traceIdentify("wand-click:pending-check", { pending, ...traceItemFlags(item) });
            if (!pending) {
                traceIdentify("wand-click:pass-native", { reason: "no-pending-payload" });
                return;
            }

            traceIdentify("wand-click:route-service", traceItemFlags(item));
            event.preventDefault();
            event.stopImmediatePropagation();
            game.ionrift?.quartermaster?.identificationService?.identify(item);
        }, true);
    }

    /**
     * @param {Application} app
     * @param {HTMLElement|JQuery} html
     */
    static _scheduleBind(app, html) {
        IdentificationGuard._bindIdentifyControl(app, html);
        requestAnimationFrame(() => IdentificationGuard._bindIdentifyControl(app, html));
    }

    /**
     * @param {Application} app
     * @param {HTMLElement|JQuery} html
     */
    static _bindIdentifyControl(app, html) {
        if (!game.user.isGM) return;
        if (!game.settings.get(MODULE_ID, "gmOnlyIdentification")) return;

        const item = app?.item ?? app?.document;
        if (!item || item.documentName !== "Item") return;

        const pending = IdentificationService.hasPendingIdentification(item);
        traceIdentify("sheet-render", { pending, ...traceItemFlags(item) });

        if (!pending) return;

        const control = IdentificationGuard._resolveIdentifyControl(app, html);
        if (!control) {
            traceIdentify("sheet-bind:miss", {
                hasHeaderToggle: !!app?._headerToggles?.identified,
                appElement: !!app?.element,
                ...traceItemFlags(item)
            });
            return;
        }
        if (control.dataset.ionriftIdentifyBound === "1") return;
        control.dataset.ionriftIdentifyBound = "1";

        traceIdentify("sheet-bind:ok", {
            via: control === app?._headerToggles?.identified ? "headerToggles" : "selector",
            ...traceItemFlags(item)
        });
    }

    /**
     * @param {Application} app
     * @param {HTMLElement|JQuery} html
     * @returns {HTMLElement|null}
     */
    static _resolveIdentifyControl(app, html) {
        if (app?._headerToggles?.identified instanceof HTMLElement) {
            return app._headerToggles.identified;
        }

        const roots = [
            app?.element,
            app?.window?.element,
            html instanceof HTMLElement ? html : (html?.[0] ?? html?.element ?? null)
        ].filter(Boolean);

        for (const root of roots) {
            const control = root.querySelector?.(DND5E_IDENTIFY_SELECTOR);
            if (control) return control;
            if (root.matches?.(DND5E_IDENTIFY_SELECTOR)) return root;
        }
        return null;
    }

    /**
     * @param {HTMLElement} control
     * @returns {Item|null}
     */
    static _itemFromIdentifyControl(control) {
        const appRoot = control.closest?.(".application");
        if (appRoot?.id) {
            const app = foundry.applications?.instances?.get(appRoot.id);
            const item = app?.item ?? app?.document;
            if (item?.documentName === "Item") return item;
        }

        for (const app of foundry.applications?.instances?.values?.() ?? []) {
            const toggle = app?._headerToggles?.identified;
            if (toggle === control) {
                const item = app?.item ?? app?.document;
                if (item?.documentName === "Item") return item;
            }
        }

        return null;
    }
}
