import { AMMO_TILT_PRESETS, AmmoTypeRegistry } from "../../services/workshop/AmmoTypeRegistry.js";
import { MODULE_ID } from "../../data/moduleId.js";


// ── Per-type colour palette ────────────────────────────────────────────────
// Distinct muted hues that read clearly on dark glass, sourced from the
// Ionrift UI colour system.  Custom types cycle through CUSTOM_PALETTE.
const BUILTIN_COLORS = {
    arrows:  "#f59e0b",   // amber
    bolts:   "#14b8a6",   // teal
    needles: "#e879f9",   // fuchsia
    sling:   "#818cf8",   // indigo / periwinkle
    other:   "#64748b",   // slate  (fallback bucket)
};

const CUSTOM_PALETTE = [
    "#34d399", "#60a5fa", "#fb923c",
    "#a78bfa", "#f472b6", "#4ade80",
    "#38bdf8", "#fbbf24", "#c084fc",
];

function typeColor(entry, customIdx = 0) {
    return (entry.builtin && BUILTIN_COLORS[entry.id])
        ? BUILTIN_COLORS[entry.id]
        : CUSTOM_PALETTE[customIdx % CUSTOM_PALETTE.length];
}

/**
 * AmmoTypeConfigApp — Distribution Bar edition.
 *
 * Layout:
 *   ┌───────────────────────────────────────────────────┐
 *   │  [proportional colour bar]                        │
 *   │  [legend: dot  Name  pct%  ···]                   │
 *   ├───────────────────────────────────────────────────┤
 *   │  QUICK PRESETS  [Balanced] [Arrows] [Bolts] ···   │
 *   ├───────────────────────────────────────────────────┤
 *   │  ● Arrows   ···pattern···  [−] 1.25 [+]  ◉        │
 *   │  ● Bolts    ···            [−]  1   [+]  ◉        │
 *   │  ···                                              │
 *   ├───────────────────────────────────────────────────┤
 *   │  + Add custom type        [Cancel]  [💾 Save]     │
 *   └───────────────────────────────────────────────────┘
 */
export class AmmoTypeConfigApp extends foundry.applications.api.ApplicationV2 {

    static DEFAULT_OPTIONS = {
        id: "qm-ammo-type-config",
        window: {
            title: "Ammunition Type Curve",
            icon:  "fas fa-bullseye-arrow",
            resizable: false
        },
        position: { width: 520, height: "auto" },
        classes: ["ionrift-window"]
    };

    /** @type {{ types: object[] }} */
    #draft = AmmoTypeRegistry.getDefaultConfig();

    /** Root element retained for save / collect. */
    #rootEl = null;

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /** @override */
    async _prepareContext() {
        this.#draft = foundry.utils.deepClone(AmmoTypeRegistry.load());
        return {};
    }

    /** @override */
    async _renderHTML() {
        const el = document.createElement("div");
        el.classList.add("qm-ammo-v2");
        el.innerHTML = this._buildShell();
        this._populateStepperList(el);
        this._bindListeners(el);
        this._refreshBar(el);
        this.#rootEl = el;
        return el;
    }

    /** @override */
    _replaceHTML(result, content, _options) {
        content.replaceChildren(result);
    }

    // ── HTML builders ────────────────────────────────────────────────────────

    /** Returns the static shell HTML (no type-specific rows yet). */
    _buildShell() {
        return `
            <p class="qm-ammo-lead">
                Cache generation picks an ammo category first, then picks a random item within it.
                Raise a type to favour it; set to 0 or toggle off to exclude it.
            </p>

            <div class="qm-dist-wrap">
                <div class="qm-dist-bar" aria-label="Ammo weight distribution"></div>
                <div class="qm-dist-legend"></div>
            </div>

            <div class="qm-ammo-presets">
                <span class="qm-presets-label">Quick presets</span>
                <div class="qm-preset-row">
                    ${this._buildPresetButtons()}
                </div>
            </div>

            <div class="qm-stepper-list"></div>

            <div class="qm-ammo-footer">
                <button type="button" class="qm-add-btn">
                    <i class="fas fa-plus"></i> Add custom type
                </button>
                <div class="qm-footer-actions">
                    <button type="button" class="qm-cancel-btn">Cancel</button>
                    <button type="button" class="qm-save-btn">
                        <i class="fas fa-save"></i> Save
                    </button>
                </div>
            </div>`;
    }

    _buildPresetButtons() {
        const labels = {
            balanced: "Balanced",
            arrows:   "Arrows",
            bolts:    "Bolts",
            sling:    "Sling",
            mixed:    "Mixed"
        };
        return Object.keys(AMMO_TILT_PRESETS).map(id => `
            <button type="button" class="qm-preset-btn" data-preset="${id}">
                ${labels[id] ?? id}
            </button>`).join("");
    }

    /** Fills .qm-stepper-list from the current #draft. */
    _populateStepperList(el) {
        const list = el.querySelector(".qm-stepper-list");
        if (!list) return;
        list.replaceChildren();

        let customIdx = 0;
        for (const typeEntry of this.#draft.types) {
            const color = typeColor(typeEntry, customIdx);
            if (!typeEntry.builtin) customIdx++;
            const rowEl = this._buildStepperRow(typeEntry, color);
            list.appendChild(rowEl);
            this._bindRowListeners(rowEl, el);
        }
    }

    /**
     * Builds one stepper row as a DOM element.
     * @param {object} typeEntry
     * @param {string} color
     * @returns {HTMLElement}
     */
    _buildStepperRow(typeEntry, color) {
        const weight     = AmmoTypeRegistry.clampWeight(typeEntry.weight ?? 1);
        const isDisabled = weight === 0;
        const displayW   = isDisabled ? (typeEntry._prevWeight ?? 1) : weight;
        const isBuiltin  = !!typeEntry.builtin;
        const patternTxt = (typeEntry.patterns ?? []).join(", ") || "Fallback category";

        const nameHtml = isBuiltin
            ? `<span class="qm-type-name">${foundry.utils.escapeHTML(typeEntry.label ?? "")}</span>`
            : `<input type="text" class="qm-type-name-input"
                      value="${foundry.utils.escapeHTML(typeEntry.label ?? "")}"
                      placeholder="Custom label" />`;

        const patternHtml = isBuiltin
            ? `<span class="qm-type-pattern">${foundry.utils.escapeHTML(patternTxt)}</span>`
            : `<input type="text" class="qm-type-pattern-input"
                      value="${foundry.utils.escapeHTML((typeEntry.patterns ?? []).join(", "))}"
                      placeholder="Regex patterns, comma-separated" />`;

        const removeHtml = isBuiltin
            ? ""
            : `<button type="button" class="qm-remove-btn" title="Remove">
                   <i class="fas fa-trash-alt"></i>
               </button>`;

        const el = document.createElement("div");
        el.classList.add("qm-stepper-row");
        if (isDisabled) el.classList.add("is-disabled");
        el.dataset.typeId = typeEntry.id;
        el.dataset.weight = displayW;
        el.dataset.color  = color;
        el.style.setProperty("--type-color", color);

        el.innerHTML = `
            <span class="qm-type-dot" style="background: ${color};
                  box-shadow: 0 0 7px ${color}88;"></span>

            <div class="qm-type-info">
                ${nameHtml}
                ${patternHtml}
            </div>

            <div class="qm-stepper-ctrl">
                <button type="button" class="qm-step-btn qm-step-down"
                        ${isDisabled ? "disabled" : ""} aria-label="Decrease weight">
                    <i class="fas fa-minus"></i>
                </button>
                <span class="qm-step-val">${isDisabled ? "0" : displayW}</span>
                <button type="button" class="qm-step-btn qm-step-up"
                        ${isDisabled ? "disabled" : ""} aria-label="Increase weight">
                    <i class="fas fa-plus"></i>
                </button>
            </div>

            <label class="qm-toggle" title="${isDisabled ? "Enable" : "Disable"} this type">
                <input type="checkbox" class="qm-type-toggle" ${isDisabled ? "" : "checked"} />
                <span class="qm-toggle-track"></span>
            </label>

            ${removeHtml}`;

        return el;
    }

    // ── Distribution bar ─────────────────────────────────────────────────────

    /** Recomputes and repaints the proportion bar + legend from current DOM state. */
    _refreshBar(rootEl) {
        const rows = [...rootEl.querySelectorAll(".qm-stepper-row")];

        const segments = rows.map(row => {
            const enabled = !row.classList.contains("is-disabled");
            return {
                id:      row.dataset.typeId,
                weight:  enabled ? (parseFloat(row.dataset.weight) || 0) : 0,
                color:   row.dataset.color,
                name:    (
                    row.querySelector(".qm-type-name")?.textContent
                    ?? row.querySelector(".qm-type-name-input")?.value
                    ?? "?"
                ).trim(),
                enabled
            };
        });

        const total = segments.reduce((s, t) => s + t.weight, 0);
        const bar    = rootEl.querySelector(".qm-dist-bar");
        const legend = rootEl.querySelector(".qm-dist-legend");
        if (!bar) return;

        if (total === 0) {
            bar.innerHTML   = `<div class="qm-dist-empty">All types excluded</div>`;
            if (legend) legend.innerHTML = "";
            return;
        }

        bar.innerHTML = segments
            .filter(s => s.weight > 0)
            .map(s => {
                const pct      = (s.weight / total * 100).toFixed(1);
                const showLbl  = parseFloat(pct) > 11;
                return `<div class="qm-dist-segment"
                             style="width:${pct}%; background:${s.color};"
                             title="${s.name}: ${parseFloat(pct).toFixed(0)}%">
                    ${showLbl ? `<span class="qm-dist-label">${s.name}</span>` : ""}
                </div>`;
            })
            .join("");

        if (legend) {
            legend.innerHTML = segments
                .filter(s => s.weight > 0)
                .map(s => {
                    const pct = (s.weight / total * 100).toFixed(0);
                    return `<span class="qm-legend-item">
                        <span class="qm-legend-dot" style="background:${s.color};"></span>
                        <span class="qm-legend-name">${s.name}</span>
                        <span class="qm-legend-pct">${pct}%</span>
                    </span>`;
                })
                .join("");
        }
    }

    // ── Event binding ────────────────────────────────────────────────────────

    /** Top-level listeners (presets, save/cancel, add, delegated remove). */
    _bindListeners(el) {
        el.querySelector(".qm-save-btn")?.addEventListener("click", () => this._onSave());
        el.querySelector(".qm-cancel-btn")?.addEventListener("click", () => this.close());

        el.querySelector(".qm-add-btn")?.addEventListener("click", () => {
            const customIdx  = el.querySelectorAll(".qm-stepper-row:not([data-type-id='arrows']):not([data-type-id='bolts']):not([data-type-id='needles']):not([data-type-id='sling']):not([data-type-id='other'])").length;
            const newType    = AmmoTypeRegistry.createCustomType();
            const color      = CUSTOM_PALETTE[customIdx % CUSTOM_PALETTE.length];
            const fallbackIdx = this.#draft.types.findIndex(t => t.fallback);
            const insertAt   = fallbackIdx >= 0 ? fallbackIdx : this.#draft.types.length;
            this.#draft.types.splice(insertAt, 0, newType);

            const list      = el.querySelector(".qm-stepper-list");
            const rowEl     = this._buildStepperRow(newType, color);
            const fallbackRow = [...(list?.querySelectorAll(".qm-stepper-row") ?? [])]
                .find(r => this.#draft.types.find(t => t.id === r.dataset.typeId)?.fallback);
            if (fallbackRow) list?.insertBefore(rowEl, fallbackRow);
            else list?.appendChild(rowEl);

            this._bindRowListeners(rowEl, el);
            this._refreshBar(el);
        });

        // Preset buttons
        el.querySelectorAll(".qm-preset-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                this.#draft = AmmoTypeRegistry.applyPreset(btn.dataset.preset);
                this._populateStepperList(el);
                this._refreshBar(el);
            });
        });

        // Delegated remove (custom types only)
        el.addEventListener("click", ev => {
            const removeBtn = ev.target.closest(".qm-remove-btn");
            if (!removeBtn) return;
            const row    = removeBtn.closest(".qm-stepper-row");
            const typeId = row?.dataset.typeId;
            if (!typeId) return;
            this.#draft.types = this.#draft.types.filter(t => t.id !== typeId);
            row.remove();
            this._refreshBar(el);
        });
    }

    /**
     * Binds stepper and toggle listeners to a single row.
     * Called for every row, including dynamically added ones.
     */
    _bindRowListeners(row, rootEl) {
        const STEP = 0.25;
        const MAX  = 3;

        const getW   = ()  => parseFloat(row.dataset.weight) || 0;
        const setW   = (w) => {
            const clamped = AmmoTypeRegistry.clampWeight(w);
            row.dataset.weight = clamped;
            const valEl = row.querySelector(".qm-step-val");
            if (valEl) valEl.textContent = clamped;
            this._refreshBar(rootEl);
        };

        row.querySelector(".qm-step-up")?.addEventListener("click", () => {
            if (!row.classList.contains("is-disabled"))
                setW(Math.min(MAX, getW() + STEP));
        });

        row.querySelector(".qm-step-down")?.addEventListener("click", () => {
            if (!row.classList.contains("is-disabled"))
                setW(Math.max(0, getW() - STEP));
        });

        const toggle   = row.querySelector(".qm-type-toggle");
        const stepUp   = row.querySelector(".qm-step-up");
        const stepDown = row.querySelector(".qm-step-down");
        const valEl    = row.querySelector(".qm-step-val");

        toggle?.addEventListener("change", () => {
            if (toggle.checked) {
                row.classList.remove("is-disabled");
                const restored = parseFloat(row.dataset.prevWeight) || 1;
                row.dataset.weight = restored;
                if (valEl) valEl.textContent = restored;
                if (stepUp)   stepUp.disabled   = false;
                if (stepDown) stepDown.disabled = false;
            } else {
                row.classList.add("is-disabled");
                row.dataset.prevWeight = row.dataset.weight;
                row.dataset.weight = 0;
                if (valEl) valEl.textContent = "0";
                if (stepUp)   stepUp.disabled   = true;
                if (stepDown) stepDown.disabled = true;
            }
            this._refreshBar(rootEl);
        });
    }

    // ── Save / collect ───────────────────────────────────────────────────────

    _collectDraftFromDom() {
        const root = this.#rootEl;
        if (!root) return this.#draft;

        const types = [];
        root.querySelectorAll(".qm-stepper-row").forEach(row => {
            const id       = row.dataset.typeId;
            const existing = this.#draft.types.find(t => t.id === id);
            if (!existing) return;

            const isEnabled = !row.classList.contains("is-disabled");
            const weight    = isEnabled ? (parseFloat(row.dataset.weight) || 0) : 0;

            if (existing.builtin) {
                types.push({ ...existing, weight });
                return;
            }

            const label      = row.querySelector(".qm-type-name-input")?.value?.trim() || "Custom type";
            const patternRaw = row.querySelector(".qm-type-pattern-input")?.value ?? "";
            const patterns   = patternRaw.split(",").map(p => p.trim()).filter(Boolean);
            types.push({ ...existing, label, patterns, weight });
        });

        return AmmoTypeRegistry.normalize({ types });
    }

    async _onSave() {
        const config = this._collectDraftFromDom();
        await AmmoTypeRegistry.save(config);
        ui.notifications.info("Ammunition type curve saved.");
        this.close();
    }
}
