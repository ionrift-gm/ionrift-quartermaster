/**
 * GM settings submenu base for Quartermaster (Ionrift glass).
 */

const MODULE_ID = "ionrift-quartermaster";

/**
 * @param {object} definition
 * @param {string} definition.appId
 * @param {string} definition.title
 * @param {string} definition.icon
 * @param {string} definition.lead
 * @param {object[]} definition.rows
 * @param {string} [definition.savedMessage]
 * @returns {typeof foundry.applications.api.ApplicationV2}
 */
export function createQuartermasterConfigApp(definition) {
    return class QuartermasterSubmenuConfigApp extends foundry.applications.api.ApplicationV2 {

        static DEFAULT_OPTIONS = {
            id: definition.appId,
            window: {
                title: definition.title,
                icon: definition.icon,
                resizable: false
            },
            position: { width: 460, height: "auto" },
            classes: ["ionrift-window"]
        };

        /** @override */
        async _prepareContext() {
            return {
                rows: definition.rows.map(row => ({
                    ...row,
                    value: row.type === "popout"
                        ? (typeof row.summary === "function" ? row.summary() : row.summary ?? "")
                        : game.settings.get(MODULE_ID, row.key)
                }))
            };
        }

        /** @override */
        async _renderHTML(context) {
            const el = document.createElement("div");
            el.classList.add("qm-settings-config");

            let html = `<p class="settings-config-lead">${definition.lead}</p><div class="settings-config-list">`;

            for (const row of context.rows) {
                html += `
            <div class="settings-config-row" data-key="${row.key}">
                <div class="settings-config-info">
                    <div class="settings-config-label">
                        <i class="${row.icon} settings-config-icon"></i>
                        ${row.label}
                    </div>
                    <div class="settings-config-hint">${row.hint}</div>
                </div>
                ${this._renderControl(row)}
            </div>`;
            }

            html += `</div>
        <div class="settings-config-actions">
            <button type="button" class="settings-config-save-btn">
                <i class="fas fa-save"></i> Save
            </button>
        </div>`;

            el.innerHTML = html;
            el.querySelector(".settings-config-save-btn")?.addEventListener("click", () => this._onSave(el));
            el.querySelectorAll(".settings-config-range").forEach(range => {
                range.addEventListener("input", () => {
                    const display = el.querySelector(`.settings-config-range-val[data-key="${range.dataset.key}"]`);
                    if (display) display.textContent = range.value;
                });
            });
            el.querySelectorAll(".settings-config-popout-btn").forEach(btn => {
                btn.addEventListener("click", () => {
                    const App = definition.popouts?.[btn.dataset.popout];
                    if (App) new App().render(true);
                });
            });
            return el;
        }

        _renderControl(row) {
            if (row.type === "boolean") {
                return `
            <label class="settings-config-toggle">
                <input type="checkbox" class="settings-config-cb"
                       data-key="${row.key}"
                       ${row.value ? "checked" : ""} />
                <span class="settings-config-slider"></span>
            </label>`;
            }
            if (row.type === "select") {
                const options = Object.entries(row.choices)
                    .map(([k, v]) => `<option value="${k}" ${row.value === k ? "selected" : ""}>${v}</option>`)
                    .join("");
                return `<select class="settings-config-select" data-key="${row.key}">${options}</select>`;
            }
            if (row.type === "range") {
                return `
            <div class="settings-config-range-wrap">
                <input type="range" class="settings-config-range" data-key="${row.key}"
                       min="${row.min}" max="${row.max}" step="${row.step}"
                       value="${row.value}" />
                <span class="settings-config-range-val" data-key="${row.key}">${row.value}</span>
            </div>`;
            }
            if (row.type === "popout") {
                return `
            <div class="settings-config-popout-wrap">
                <span class="settings-config-popout-summary">${row.value ?? ""}</span>
                <button type="button" class="settings-config-popout-btn" data-popout="${row.popout}">
                    <i class="fas fa-sliders"></i> Configure
                </button>
            </div>`;
            }
            return "";
        }

        /** @override */
        _replaceHTML(result, content, _options) {
            content.replaceChildren(result);
        }

        async _onSave(el) {
            for (const row of definition.rows) {
                if (row.type === "boolean") {
                    const cb = el.querySelector(`.settings-config-cb[data-key="${row.key}"]`);
                    if (cb) await game.settings.set(MODULE_ID, row.key, cb.checked);
                } else if (row.type === "select") {
                    const sel = el.querySelector(`.settings-config-select[data-key="${row.key}"]`);
                    if (sel) await game.settings.set(MODULE_ID, row.key, sel.value);
                } else if (row.type === "range") {
                    const range = el.querySelector(`.settings-config-range[data-key="${row.key}"]`);
                    if (range) await game.settings.set(MODULE_ID, row.key, Number(range.value));
                }
            }
            ui.notifications.info(definition.savedMessage ?? "Quartermaster settings saved.");
            this.close();
        }
    };
}
