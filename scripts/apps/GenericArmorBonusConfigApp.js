import {
    DEFAULT_GENERIC_ARMOR_BONUS,
    GENERIC_ARMOR_BONUS_PRESETS,
    GenericArmorBonusRegistry
} from "../services/GenericArmorBonusRegistry.js";

const PRESET_LABELS = {
    standard: "Standard",
    plus1Only: "+1 cap",
    noPlusArmor: "No +N armor"
};

/**
 * Configure tier caps and global ceiling for generic +N armor and shields.
 */
export class GenericArmorBonusConfigApp extends foundry.applications.api.ApplicationV2 {

    static DEFAULT_OPTIONS = {
        id: "qm-generic-armor-bonus-config",
        window: {
            title: "Generic Armor Bonus Curve",
            icon: "fas fa-shield-halved",
            resizable: false
        },
        position: { width: 480, height: "auto" },
        classes: ["ionrift-window"]
    };

    /** @type {typeof DEFAULT_GENERIC_ARMOR_BONUS} */
    #draft = GenericArmorBonusRegistry.getDefaultConfig();

    #rootEl = null;

    /** @override */
    async _prepareContext() {
        this.#draft = foundry.utils.deepClone(GenericArmorBonusRegistry.load());
        return {};
    }

    /** @override */
    async _renderHTML() {
        const el = document.createElement("div");
        el.classList.add("qm-armor-bonus-config");
        el.innerHTML = this._buildShell();
        this._bindListeners(el);
        this.#rootEl = el;
        return el;
    }

    /** @override */
    _replaceHTML(result, content, _options) {
        content.replaceChildren(result);
    }

    _buildShell() {
        const cap = this.#draft.cap;
        const tierRows = [1, 2, 3, 4].map(tier => {
            const max = this.#draft.maxByTier[tier] ?? 0;
            const options = [0, 1, 2, 3].map(n => {
                const disabled = n > cap ? "disabled" : "";
                const selected = n === max ? "selected" : "";
                const label = n === 0 ? "None" : `+${n}`;
                return `<option value="${n}" ${selected} ${disabled}>${label}</option>`;
            }).join("");
            return `
                <div class="qm-armor-bonus-tier-row" data-tier="${tier}">
                    <span class="qm-armor-bonus-tier-label">Tier ${tier}</span>
                    <select class="qm-armor-bonus-tier-max">${options}</select>
                </div>`;
        }).join("");

        const presetBtns = Object.entries(PRESET_LABELS).map(([id, label]) =>
            `<button type="button" class="qm-armor-bonus-preset-btn" data-preset="${id}">${label}</button>`
        ).join("");

        return `
            <p class="qm-armor-bonus-lead">
                Caps generic +N body armor and shields in armaments mastercraft slots.
                Weapons and named magic use the separate magic curve.
            </p>
            <div class="qm-armor-bonus-presets">
                <span class="qm-armor-bonus-presets-label">Presets</span>
                <div class="qm-armor-bonus-preset-row">${presetBtns}</div>
            </div>
            <div class="qm-armor-bonus-cap-row">
                <label class="qm-armor-bonus-cap-label" for="qm-armor-bonus-cap">Global cap</label>
                <select id="qm-armor-bonus-cap" class="qm-armor-bonus-cap-select">
                    ${[0, 1, 2, 3].map(n =>
                        `<option value="${n}" ${n === cap ? "selected" : ""}>+${n} maximum</option>`
                    ).join("")}
                </select>
            </div>
            <div class="qm-armor-bonus-tier-grid">${tierRows}</div>
            <p class="qm-armor-bonus-note">
                Standard uses a global cap of +2 (no +3 armor). Adjust the cap or tier rows for a stricter or looser table.
            </p>
            <div class="qm-armor-bonus-footer">
                <button type="button" class="qm-armor-bonus-cancel-btn">Cancel</button>
                <button type="button" class="qm-armor-bonus-save-btn"><i class="fas fa-save"></i> Save</button>
            </div>`;
    }

    /** @param {HTMLElement} rootEl */
    _bindListeners(rootEl) {
        rootEl.querySelector(".qm-armor-bonus-cap-select")?.addEventListener("change", ev => {
            this.#draft.cap = GenericArmorBonusRegistry._clampBonus(parseInt(ev.target.value, 10));
            for (const tier of [1, 2, 3, 4]) {
                if ((this.#draft.maxByTier[tier] ?? 0) > this.#draft.cap) {
                    this.#draft.maxByTier[tier] = this.#draft.cap;
                }
            }
            this._rerender(rootEl);
        });

        rootEl.querySelectorAll(".qm-armor-bonus-tier-max").forEach(select => {
            select.addEventListener("change", ev => {
                const row = ev.target.closest(".qm-armor-bonus-tier-row");
                const tier = parseInt(row?.dataset.tier ?? "1", 10);
                this.#draft.maxByTier[tier] = GenericArmorBonusRegistry._clampBonus(parseInt(ev.target.value, 10));
            });
        });

        rootEl.querySelectorAll(".qm-armor-bonus-preset-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const preset = GENERIC_ARMOR_BONUS_PRESETS[btn.dataset.preset];
                if (!preset) return;
                this.#draft = foundry.utils.deepClone(GenericArmorBonusRegistry.normalize(preset));
                this._rerender(rootEl);
            });
        });

        rootEl.querySelector(".qm-armor-bonus-cancel-btn")?.addEventListener("click", () => this.close());
        rootEl.querySelector(".qm-armor-bonus-save-btn")?.addEventListener("click", () => this._onSave());
    }

    /** @param {HTMLElement} rootEl */
    _rerender(rootEl) {
        const parent = rootEl.parentElement;
        if (!parent) return;
        const fresh = document.createElement("div");
        fresh.classList.add("qm-armor-bonus-config");
        fresh.innerHTML = this._buildShell();
        this._bindListeners(fresh);
        this.#rootEl = fresh;
        rootEl.replaceWith(fresh);
    }

    _collectDraftFromDom() {
        const root = this.#rootEl;
        if (!root) return GenericArmorBonusRegistry.normalize(this.#draft);

        const cap = GenericArmorBonusRegistry._clampBonus(
            parseInt(root.querySelector(".qm-armor-bonus-cap-select")?.value ?? String(this.#draft.cap), 10)
        );
        const maxByTier = { ...this.#draft.maxByTier };
        root.querySelectorAll(".qm-armor-bonus-tier-row").forEach(row => {
            const tier = parseInt(row.dataset.tier ?? "1", 10);
            const max = GenericArmorBonusRegistry._clampBonus(
                parseInt(row.querySelector(".qm-armor-bonus-tier-max")?.value ?? "0", 10)
            );
            maxByTier[tier] = Math.min(max, cap);
        });

        return GenericArmorBonusRegistry.normalize({
            cap,
            maxByTier,
            pickWeightsByTier: this.#draft.pickWeightsByTier
        });
    }

    async _onSave() {
        await GenericArmorBonusRegistry.save(this._collectDraftFromDom());
        ui.notifications.info("Generic armor bonus curve saved.");
        this.close();
    }
}
