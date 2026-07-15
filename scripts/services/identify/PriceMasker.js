import { IdentificationService } from "./IdentificationService.js";
import { MODULE_ID } from "../../data/moduleId.js";


/**
 * PriceMasker
 *
 * Renders the "this is what the party thinks the item is worth" value
 * for a dnd5e item in a Quartermaster world. Two responsibilities:
 *
 * 1. Decide whether an item should be fogged at all (only cache-minted
 *    items get the default fuzz; compendium drops, shop purchases, and
 *    hand-authored items keep their exact price).
 *
 * 2. Produce a deterministic label + tooltip for the display. The
 *    fogging is seeded by the item id so repeated renders show the same
 *    value and power-players can't triangulate the real price by
 *    watching it reroll.
 *
 * Sibling modules (civics/shop with the Appraise activity) can fully
 * override the output by subscribing to the hook
 * `ionrift-quartermaster.renderItemPrice`. The first subscriber to
 * return a truthy object wins. Its return shape is the same as
 * `renderFuzzy` below - `{ label, tooltip, raw }`.
 *
 * Precision bands (default):
 *   - latentMagic present (unidentified magical)  → ±30%
 *   - Cache-minted mundane                         → ±15%
 *   - Cache-minted but identified (latent cleared) → ±5%
 *   - Non-cache (no mintBatch)                     → no fog
 */
export class PriceMasker {

    /**
     * Render the display price for an item. Returns null for items that
     * should render their exact price (i.e. non-cache items).
     *
     * Override surface: fires `ionrift-quartermaster.renderItemPrice`
     * with `(item, defaultOutput)`. Subscribers may return their own
     * `{ label, tooltip, raw }` to replace the default fog.
     *
     * @param {Item} item
     * @returns {{ label: string, tooltip: string, raw: object }|null}
     */
    static render(item) {
        const summary = IdentificationService.getLatentSummary(item);
        if (!summary) return null;
        if (!summary.mintBatch) return null;

        const defaultOutput = this.renderFuzzy(item, summary);

        const overrides = [];
        Hooks.callAll(`${MODULE_ID}.renderItemPrice`, item, defaultOutput, overrides);
        const chosen = overrides.find(o => o && typeof o.label === "string");
        return chosen ?? defaultOutput;
    }

    /**
     * Default fuzzy renderer. Deterministic per item.
     *
     * @param {Item} item
     * @param {object} summary  IdentificationService.getLatentSummary(item)
     * @returns {{ label: string, tooltip: string, raw: object }}
     */
    static renderFuzzy(item, summary = null) {
        const s = summary ?? IdentificationService.getLatentSummary(item) ?? {};
        const price = item.system?.price ?? { value: 0, denomination: "gp" };
        const value = Number(price.value) || 0;
        const denom = price.denomination || "gp";

        const band = this._bandFor(s);
        const seed = this._seedFromId(item.id ?? item.name ?? "");
        const jitter = this._deterministicRange(seed, -band, band);
        const estimate = Math.max(0, Math.round(value * (1 + jitter)));
        const lo = Math.max(0, Math.round(value * (1 - band)));
        const hi = Math.round(value * (1 + band));

        const bandPct = Math.round(band * 100);
        const label = `≈ ${estimate} ${denom}`;
        const tooltip = band > 0
            ? `Estimated ${lo}-${hi} ${denom} (±${bandPct}%) · Appraise to refine.`
            : `${value} ${denom}`;

        return {
            label,
            tooltip,
            raw: { value, denomination: denom, estimate, lo, hi, band }
        };
    }

    static _bandFor(summary) {
        if (!summary?.mintBatch) return 0;
        // Kind is the pre/post-identify signal. Under the takeover model
        // `system.identified` is always true; the flag's *presence* is
        // what actually tells us the item is still masked.
        if (summary.kind === "latent-magic") return 0.3;
        if (summary.kind === "cursed-lure") return 0.3;
        return 0.15;
    }

    // Stable FNV-1a-ish hash for the id string. Returns an unsigned 32-bit int.
    static _seedFromId(id) {
        let h = 0x811c9dc5;
        for (let i = 0; i < id.length; i++) {
            h ^= id.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return h >>> 0;
    }

    // Map the integer seed onto a floating point value in [lo, hi].
    static _deterministicRange(seed, lo, hi) {
        const frac = (seed & 0xffff) / 0xffff;
        return lo + frac * (hi - lo);
    }
}
