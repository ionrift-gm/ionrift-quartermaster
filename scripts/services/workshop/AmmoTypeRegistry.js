import { MODULE_ID } from "../../data/moduleId.js";
/**
 * Ammunition type categories, curve weights, and name matching for cache generation.
 */


/** @type {Record<string, Record<string, number>|null>} */
export const AMMO_TILT_PRESETS = {
    balanced: null,
    arrows:  { arrows: 3, bolts: 1, needles: 1, sling: 1, other: 1 },
    bolts:   { arrows: 1, bolts: 3, needles: 1, sling: 1, other: 1 },
    sling:   { arrows: 1, bolts: 1, needles: 1, sling: 3, other: 1 },
    mixed:   { arrows: 2, bolts: 2, needles: 0.5, sling: 0.5, other: 1 }
};

/** @type {object[]} */
export const DEFAULT_AMMO_TYPES = [
    {
        id: "arrows",
        get label() { return game.i18n?.localize ? game.i18n.localize("ionrift-quartermaster.ammo.type.arrows") : ""; },
        patterns: ["\\barrows?\\b"],
        builtin: true,
        weight: 1
    },
    {
        id: "bolts",
        get label() { return game.i18n?.localize ? game.i18n.localize("ionrift-quartermaster.ammo.type.bolts") : ""; },
        patterns: ["\\bbolts?\\b", "\\bcrossbow\\b"],
        builtin: true,
        weight: 1
    },
    {
        id: "needles",
        get label() { return game.i18n?.localize ? game.i18n.localize("ionrift-quartermaster.ammo.type.needles") : ""; },
        patterns: ["\\bneedles?\\b", "\\bblowgun\\b"],
        builtin: true,
        weight: 1
    },
    {
        id: "sling",
        get label() { return game.i18n?.localize ? game.i18n.localize("ionrift-quartermaster.ammo.type.slingBullets") : ""; },
        patterns: ["\\bsling bullets?\\b", "\\bbullets?\\b"],
        builtin: true,
        weight: 1
    },
    {
        id: "other",
        get label() { return game.i18n?.localize ? game.i18n.localize("ionrift-quartermaster.ammo.type.other") : ""; },
        patterns: [],
        builtin: true,
        fallback: true,
        weight: 1
    }
];

const PRESET_LABELS = {
    get balanced() { return game.i18n.localize("ionrift-quartermaster.config.ammoType.preset.balanced"); },
    get arrows()   { return game.i18n.localize("ionrift-quartermaster.config.ammoType.preset.arrows"); },
    get bolts()    { return game.i18n.localize("ionrift-quartermaster.config.ammoType.preset.bolts"); },
    get sling()    { return game.i18n.localize("ionrift-quartermaster.config.ammoType.preset.sling"); },
    get mixed()    { return game.i18n.localize("ionrift-quartermaster.config.ammoType.preset.mixed"); },
    get custom()   { return game.i18n.localize("ionrift-quartermaster.config.ammoType.preset.custom"); }
};

export class AmmoTypeRegistry {

    /** @returns {{ types: object[] }} */
    static getDefaultConfig() {
        return { types: foundry.utils.deepClone(DEFAULT_AMMO_TYPES) };
    }

    /**
     * @param {string|object|null|undefined} raw
     * @returns {{ types: object[] }}
     */
    static parse(raw) {
        if (!raw) return this.getDefaultConfig();
        try {
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            return this.normalize(parsed);
        } catch {
            return this.getDefaultConfig();
        }
    }

    /**
     * @param {object} config
     * @returns {{ types: object[] }}
     */
    static normalize(config) {
        const saved = Array.isArray(config?.types) ? config.types : [];
        const byId = new Map(saved.map(t => [t.id, t]));
        const types = [];

        for (const builtin of DEFAULT_AMMO_TYPES) {
            const existing = byId.get(builtin.id);
            types.push({
                ...foundry.utils.deepClone(builtin),
                ...(existing ?? {}),
                id: builtin.id,
                builtin: true,
                fallback: !!builtin.fallback,
                weight: AmmoTypeRegistry._clampWeight(existing?.weight ?? builtin.weight ?? 1)
            });
            byId.delete(builtin.id);
        }

        for (const [id, entry] of byId.entries()) {
            if (!entry || entry.builtin) continue;
            types.push(AmmoTypeRegistry._normalizeCustomType(id, entry));
        }

        const fallbackIdx = types.findIndex(t => t.fallback);
        if (fallbackIdx >= 0) {
            const [fallback] = types.splice(fallbackIdx, 1);
            types.push(fallback);
        }

        return { types };
    }

    /** @returns {{ types: object[] }} */
    static load() {
        const raw = game.settings?.get(MODULE_ID, "ammoTypeConfig");
        if (raw) return this.parse(raw);

        const tilt = game.settings?.get(MODULE_ID, "ammoTypeTilt") ?? "balanced";
        return this.normalize(this.applyPreset(tilt));
    }

    /**
     * @param {{ types: object[] }} config
     */
    static async save(config) {
        const normalized = this.normalize(config);
        const preset = this.detectPreset(normalized);
        await game.settings.set(MODULE_ID, "ammoTypeConfig", JSON.stringify(normalized));
        await game.settings.set(MODULE_ID, "ammoTypeTilt", preset);
        return normalized;
    }

    /**
     * @param {string} presetId
     * @returns {{ types: object[] }}
     */
    static applyPreset(presetId) {
        // Use the default config as the base -- NOT load() -- to avoid
        // a stack-overflow loop when load() itself calls applyPreset()
        // as a fallback (i.e. before ammoTypeConfig has ever been saved).
        const config = this.getDefaultConfig();
        const preset = AMMO_TILT_PRESETS[presetId];

        for (const typeEntry of config.types) {
            if (!preset) {
                typeEntry.weight = 1;
                continue;
            }
            typeEntry.weight = AmmoTypeRegistry._clampWeight(preset[typeEntry.id] ?? 1);
        }

        return this.normalize(config);
    }

    /**
     * @param {{ types: object[] }} config
     * @returns {string}
     */
    static detectPreset(config) {
        const weights = this.getWeightMap(config);

        for (const [presetId, presetWeights] of Object.entries(AMMO_TILT_PRESETS)) {
            if (!presetWeights) {
                if (DEFAULT_AMMO_TYPES.every(t => Math.abs((weights[t.id] ?? 1) - 1) < 0.001)) {
                    return "balanced";
                }
                continue;
            }
            const matches = Object.entries(presetWeights).every(([id, w]) =>
                Math.abs((weights[id] ?? 1) - w) < 0.001
            );
            if (matches) return presetId;
        }

        return "custom";
    }

    /**
     * @param {{ types: object[] }} [config]
     * @returns {Record<string, number>}
     */
    static getWeightMap(config = null) {
        const resolved = config ?? this.load();
        /** @type {Record<string, number>} */
        const map = {};
        for (const typeEntry of resolved.types) {
            map[typeEntry.id] = AmmoTypeRegistry._clampWeight(typeEntry.weight ?? 1);
        }
        return map;
    }

    /**
     * @param {object} item
     * @param {{ types: object[] }} [config]
     * @returns {string}
     */
    static detectType(item, config = null) {
        const resolved = config ?? this.load();
        const name = (item?.name ?? "").toLowerCase();

        for (const typeEntry of resolved.types) {
            if (typeEntry.fallback) continue;
            for (const pattern of typeEntry.patterns ?? []) {
                try {
                    if (new RegExp(pattern, "i").test(name)) return typeEntry.id;
                } catch {
                    // Skip invalid custom patterns.
                }
            }
        }

        const fallback = resolved.types.find(t => t.fallback);
        return fallback?.id ?? "other";
    }

    /**
     * @param {{ types: object[] }} [config]
     * @returns {string}
     */
    static getSummaryLabel(config = null) {
        const resolved = config ?? this.load();
        const preset = this.detectPreset(resolved);
        if (preset !== "custom") return PRESET_LABELS[preset] ?? preset;

        const weighted = resolved.types
            .filter(t => !t.fallback && (t.weight ?? 1) > 0)
            .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));

        if (!weighted.length) return game.i18n.localize("ionrift-quartermaster.config.ammoType.preset.custom");
        if (weighted.every(t => Math.abs((t.weight ?? 1) - 1) < 0.001)) {
            return game.i18n.localize("ionrift-quartermaster.config.ammoType.preset.balanced");
        }

        const lead = weighted[0].label ?? weighted[0].id;
        const rest = weighted.length - 1;
        return rest > 0
            ? game.i18n.format("ionrift-quartermaster.ammo.summaryWeightedPlus", { lead, rest })
            : game.i18n.format("ionrift-quartermaster.ammo.summaryWeighted", { lead });
    }

    /**
     * @param {string} [label="Custom type"]
     * @returns {object}
     */
    static createCustomType(label = game.i18n.localize("ionrift-quartermaster.config.ammoType.customTypeDefault")) {
        const id = `custom-${foundry.utils.randomID(8)}`;
        return {
            id,
            label,
            patterns: [],
            builtin: false,
            weight: 1
        };
    }

    /**
     * @param {string} id
     * @param {object} entry
     * @returns {object}
     */
    static _normalizeCustomType(id, entry) {
        const patterns = Array.isArray(entry.patterns)
            ? entry.patterns.map(p => String(p).trim()).filter(Boolean)
            : String(entry.patterns ?? "")
                .split(",")
                .map(p => p.trim())
                .filter(Boolean);

        return {
            id,
            label: String(entry.label ?? game.i18n.localize("ionrift-quartermaster.config.ammoType.customTypeDefault")).trim()
                || game.i18n.localize("ionrift-quartermaster.config.ammoType.customTypeDefault"),
            patterns,
            builtin: false,
            weight: AmmoTypeRegistry._clampWeight(entry.weight ?? 1)
        };
    }

    /** @param {number} value */
    static clampWeight(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 1;
        return Math.min(3, Math.max(0, Math.round(n * 4) / 4));
    }

    /** @param {number} value */
    static _clampWeight(value) {
        return AmmoTypeRegistry.clampWeight(value);
    }
}
