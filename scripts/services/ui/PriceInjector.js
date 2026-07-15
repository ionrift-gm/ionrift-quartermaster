import { PriceMasker } from "../PriceMasker.js";
import { Logger, MODULE_LABEL } from "../../utils/Logger.js";

/**
 * PriceInjector
 *
 * Swaps the price field on dnd5e item sheets for a fuzzy estimate on
 * cache-minted items. Compendium drops, shop purchases, and authored
 * items render their exact price as normal.
 *
 * The actual fog math lives in `PriceMasker`; this file is just the
 * sheet-side plumbing. It tries a handful of selectors to stay resilient
 * across dnd5e v3/v4/v5 sheet generations.
 */
export class PriceInjector {

    static init() {
        Hooks.on("renderItemSheet", (app, html, data) => {
            PriceInjector._onRender(app, html);
        });
        Hooks.on("renderItemSheet5e", (app, html, data) => {
            PriceInjector._onRender(app, html);
        });
        Hooks.on("renderItemSheet5e2", (app, html, data) => {
            PriceInjector._onRender(app, html);
        });
    }

    static _onRender(app, html) {
        try {
            const item = app?.item ?? app?.document;
            if (!item || item.documentName !== "Item") return;

            const output = PriceMasker.render(item);
            if (!output) return;

            const root = html instanceof HTMLElement
                ? html
                : (html?.[0] ?? html?.element ?? null);
            if (!root) return;

            const priceEl = PriceInjector._locatePriceElement(root);
            if (!priceEl) return;

            PriceInjector._applyFuzzyDisplay(priceEl, output);
        } catch (err) {
            Logger.warn(MODULE_LABEL, "PriceInjector:", err);
        }
    }

    static _locatePriceElement(root) {
        return root.querySelector?.('input[name="system.price.value"]')
            ?? root.querySelector?.('[data-prop="price.value"]')
            ?? root.querySelector?.('.item-price')
            ?? root.querySelector?.('.item-cost')
            ?? null;
    }

    static _applyFuzzyDisplay(el, output) {
        if (el.dataset.ionriftFuzzed === "1") return;

        const host = el.tagName === "INPUT" ? el.parentElement : el;
        if (!host) return;

        const replacement = document.createElement("span");
        replacement.classList.add("ionrift-fuzzy-price");
        replacement.textContent = output.label;
        replacement.dataset.tooltip = output.tooltip;
        replacement.dataset.ionriftFuzzed = "1";
        replacement.style.fontVariantNumeric = "tabular-nums";

        if (el.tagName === "INPUT") {
            const sibling = host.querySelector?.('select[name="system.price.denomination"]');
            el.style.display = "none";
            if (sibling) sibling.style.display = "none";
            host.appendChild(replacement);
        } else {
            el.replaceWith(replacement);
        }
    }
}
