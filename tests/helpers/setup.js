/**
 * Vitest setup file: establishes Foundry VTT global mocks.
 * Runs before each test file so ES module imports that reference
 * Foundry globals (game, Hooks, ui, etc.) resolve cleanly.
 */

// ── game ────────────────────────────────────────────────────────────

const _settingsStore = new Map();

globalThis.game = {
    user: { isGM: true, id: "gm-user-1" },
    users: Object.assign([], {
        find(fn)   { return Array.prototype.find.call(this, fn); },
        filter(fn) { return Array.prototype.filter.call(this, fn); }
    }),
    actors: [],
    scenes: [],
    settings: {
        get(module, key)         { return _settingsStore.get(`${module}.${key}`); },
        set(module, key, value)  { _settingsStore.set(`${module}.${key}`, value); },
        _store: _settingsStore,
        _reset()                 { _settingsStore.clear(); }
    },
    packs: new Map(),
    ionrift: {
        library: {
            createLogger: () => ({
                log()   {},
                info()  {},
                warn()  {},
                error() {}
            })
        }
    }
};

// ── Hooks ───────────────────────────────────────────────────────────

const _hooks = {};
globalThis.Hooks = {
    _hooks,
    on(name, fn) {
        (_hooks[name] ??= []).push(fn);
    },
    off(name, fn) {
        const arr = _hooks[name];
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
    },
    callAll(name, ...args) {
        for (const fn of (_hooks[name] ?? [])) fn(...args);
    },
    _reset() {
        for (const k of Object.keys(_hooks)) delete _hooks[k];
    }
};

// ── UI ──────────────────────────────────────────────────────────────

globalThis.ui = {
    notifications: {
        warn:  () => {},
        info:  () => {},
        error: () => {}
    }
};

// ── ChatMessage ─────────────────────────────────────────────────────

globalThis.ChatMessage = {
    create: async () => ({}),
    getSpeaker: () => ({ alias: "Test" })
};

// ── Dialog ──────────────────────────────────────────────────────────

globalThis.Dialog = class Dialog {
    constructor(config, options) {
        this.config = config;
        this.options = options;
        Dialog._lastInstance = this;
    }
    render() { return this; }
    static _lastInstance = null;
    static _reset() { Dialog._lastInstance = null; }
};

// ── Foundry utils ───────────────────────────────────────────────────

let _idCounter = 0;
globalThis.foundry = {
    utils: {
        randomID(len = 16) {
            return "mockid" + String(++_idCounter).padStart(6, "0");
        },
        hasProperty(obj, path) {
            const parts = path.split(".");
            let cur = obj;
            for (const p of parts) {
                if (cur == null || typeof cur !== "object") return false;
                if (!(p in cur)) return false;
                cur = cur[p];
            }
            return true;
        },
        getProperty(obj, path) {
            const parts = path.split(".");
            let cur = obj;
            for (const p of parts) {
                if (cur == null || typeof cur !== "object") return undefined;
                cur = cur[p];
            }
            return cur;
        },
        deepClone(obj) {
            return structuredClone(obj);
        },
        mergeObject(target, source, { insertKeys = true } = {}) {
            for (const [k, v] of Object.entries(source)) {
                if (insertKeys || k in target) target[k] = v;
            }
            return target;
        },
        setProperty(obj, path, value) {
            const parts = path.split(".");
            let cur = obj;
            for (let i = 0; i < parts.length - 1; i++) {
                const p = parts[i];
                if (!(p in cur) || typeof cur[p] !== "object") cur[p] = {};
                cur = cur[p];
            }
            cur[parts[parts.length - 1]] = value;
            return obj;
        }
    }
};

// ── Roll ────────────────────────────────────────────────────────────

globalThis.Roll = class Roll {
    constructor(formula) { this.formula = formula; }
    async evaluate() { return { total: 10 }; }
};

// ── Document stubs ──────────────────────────────────────────────────

globalThis.Folder = {
    create: async (data) => ({ ...data, id: "folder-" + (++_idCounter) })
};

globalThis.Item = {
    create: async (arr) => (Array.isArray(arr)
        ? arr.map((d, i) => ({ ...d, id: "item-" + (++_idCounter) }))
        : [{ ...arr, id: "item-" + (++_idCounter) }])
};

// ── CONST (Foundry constants) ────────────────────────────────────────

globalThis.CONST = {
    ACTIVE_EFFECT_MODES: {
        CUSTOM: 0,
        MULTIPLY: 1,
        ADD: 2,
        DOWNGRADE: 3,
        UPGRADE: 4,
        OVERRIDE: 5
    }
};

// ── Math.clamped (Foundry polyfill) ─────────────────────────────────

if (!Math.clamped) {
    Math.clamped = (val, min, max) => Math.min(Math.max(val, min), max);
}
