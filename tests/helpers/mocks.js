/**
 * Mock factories for Foundry documents used in curse tests.
 *
 * createMockItem()  returns a minimal Item-like object with in-memory
 * flag storage that mirrors item.getFlag / setFlag / unsetFlag.
 *
 * createMockActor() returns an Actor-like object with an embedded items
 * collection and a basic ActiveEffect store.
 */

let _seq = 0;

// ── Mock Item ──────────────────────────────────────────────────────

export function createMockItem(overrides = {}) {
    const _flags = {};
    const id = overrides.id ?? "item-" + (++_seq);

    const item = {
        id,
        name:   overrides.name   ?? "Test Item",
        type:   overrides.type   ?? "weapon",
        img:    overrides.img    ?? "icons/test.webp",
        uuid:   overrides.uuid   ?? `Actor.a1.Item.${id}`,
        parent: overrides.parent ?? null,
        system: overrides.system ?? {},
        items:  [],

        get flags() {
            if (item._flagsOverride) return item._flagsOverride;
            const out = {};
            for (const [compound, value] of Object.entries(_flags)) {
                const dot = compound.indexOf(".");
                const mod = compound.slice(0, dot);
                const key = compound.slice(dot + 1);
                out[mod] ??= {};
                out[mod][key] = value;
            }
            return out;
        },
        set flags(val) {
            item._flagsOverride = val;
        },

        getFlag(module, key) {
            return _flags[`${module}.${key}`] ?? null;
        },

        async setFlag(module, key, value) {
            _flags[`${module}.${key}`] = value;
        },

        async unsetFlag(module, key) {
            delete _flags[`${module}.${key}`];
        },

        async update(data, options) {
            if (data?.img) item.img = data.img;
            if (data?.name) item.name = data.name;
            if (data?.system) {
                item.system = { ...item.system, ...data.system };
            }
            for (const [k, v] of Object.entries(data ?? {})) {
                if (!k.startsWith("system.")) continue;
                const parts = k.split(".");
                let cur = item;
                for (let i = 0; i < parts.length - 1; i++) {
                    cur[parts[i]] ??= {};
                    cur = cur[parts[i]];
                }
                cur[parts[parts.length - 1]] = v;
            }
        },

        _flags,
        _setRawFlag(module, key, value) {
            _flags[`${module}.${key}`] = value;
        }
    };

    return item;
}

// ── Mock Actor ─────────────────────────────────────────────────────

export function createMockActor(overrides = {}) {
    const _effects = [];
    const id = overrides.id ?? "actor-" + (++_seq);

    const actor = {
        id,
        name:            overrides.name ?? "Test Actor",
        type:            overrides.type ?? "character",
        hasPlayerOwner:  overrides.hasPlayerOwner ?? true,
        items:           overrides.items ?? [],
        effects:         _effects,

        testUserPermission(user, perm) {
            return overrides.isOwnedBy?.(user) ?? true;
        },

        async createEmbeddedDocuments(type, dataArr) {
            const created = dataArr.map((d, i) => ({
                ...d,
                id: `ae-${id}-${_effects.length + i}`,
                flags: d.flags ?? {}
            }));
            _effects.push(...created);
            return created;
        },

        async deleteEmbeddedDocuments(type, ids) {
            for (const delId of ids) {
                const idx = _effects.findIndex(e => e.id === delId);
                if (idx >= 0) _effects.splice(idx, 1);
            }
        }
    };

    // Wire item parents
    for (const item of actor.items) {
        item.parent = actor;
    }

    return actor;
}

// ── Pre-built cursed item templates ────────────────────────────────

const MODULE_ID = "ionrift-quartermaster";

/**
 * Create a Fool's Garnet item with cursedMeta flags set.
 * Trigger: "uses", threshold: 3, tier: 1.
 */
export function createFoolsGarnet(actor = null) {
    const item = createMockItem({
        name: "Fool's Garnet",
        type: "loot",
        img: "icons/commodities/gems/gem-faceted-radiant-red.webp",
        parent: actor
    });
    item._setRawFlag(MODULE_ID, "cursedMeta", {
        category: "Cursed Trinkets & Gems",
        curseType: "deceptive",
        tier: 1,
        decoyAppearance: "A brilliant cut red garnet. Estimated value 150 gp.",
        trueNature: "Worthless alchemical fake. Carrier has disadvantage on Deception checks.",
        tags: ["gem", "deceptive", "social", "worthless"],
        curse: {
            name: "The Fool's Gleam",
            description: "The gem is a worthless simulacrum. Disadvantage on Deception checks.",
            effects: []
        },
        detection: { arcanaDC: 15, hints: ["Appraisers agree too quickly."] },
        latent: {
            trigger: "uses",
            threshold: 3,
            escalation: [
                { at: 1, effect: "Small contradictions in how light catches the facets.", playerHint: "Something about the gem catches your eye oddly." },
                { at: 3, effect: "Full curse activation" }
            ]
        },
        removal: { removeCurseLevel: 3, customRequirement: null }
    });
    return item;
}

/**
 * Create a Blade of Hollow Victories with cursedMeta flags set.
 * Trigger: "uses", threshold: 3, tier: 1.
 */
export function createBladeOfHollowVictories(actor = null) {
    const item = createMockItem({
        name: "Blade of Hollow Victories",
        type: "weapon",
        img: "icons/weapons/swords/sword-guard-worn-brown.webp",
        parent: actor,
        system: { attuned: false, description: { value: "<p>A fine longsword.</p>" } }
    });
    item._setRawFlag(MODULE_ID, "cursedMeta", {
        category: "Cursed Weapons",
        curseType: "psychological",
        tier: 1,
        decoyAppearance: "A fine longsword.",
        trueNature: "On crit, DC 13 Wis save or lose Attack action next turn.",
        tags: ["weapon", "longsword", "psychological"],
        curse: {
            name: "The Hollow Edge",
            description: "On a critical hit, DC 13 Wis save or lose Attack action.",
            effects: [
                { label: "The Hollow Edge", changes: [{ key: "flags.midi-qol.disadvantage.attack.mwak", mode: 0, value: "1" }] }
            ]
        },
        detection: { arcanaDC: 14, hints: ["After a telling strike the wielder mutters a stranger's name."] },
        latent: {
            trigger: "uses",
            threshold: 3,
            escalation: [
                { at: 1, effect: "A heartbeat of wrongness after a solid hit.", playerHint: "For a moment, the sword felt heavier than it should." },
                { at: 3, effect: "Full curse activation" }
            ]
        },
        removal: { removeCurseLevel: 3, customRequirement: null },
        images: { revealed: "icons/weapons/swords/sword-guard-worn-red.webp" }
    });
    return item;
}

/**
 * Create a Ring of Borrowed Time with cursedMeta flags set.
 * Trigger: "attunement", threshold: 5, tier: 2.
 */
export function createRingOfBorrowedTime(actor = null) {
    const item = createMockItem({
        name: "Ring of Borrowed Time",
        type: "equipment",
        img: "icons/equipment/finger/ring-band-worn-gold.webp",
        parent: actor,
        system: { attuned: true, description: { value: "<p>A plain gold band.</p>" } }
    });
    item._setRawFlag(MODULE_ID, "cursedMeta", {
        category: "Cursed Jewelry & Rings",
        curseType: "aging",
        tier: 2,
        decoyAppearance: "A plain gold band.",
        trueNature: "Prevents aging while worn. When removed, wearer ages by time worn.",
        tags: ["jewelry", "ring", "aging", "attunement"],
        curse: {
            name: "Borrowed Time",
            description: "While worn the wearer does not age. When removed they age by the total time worn.",
            effects: [
                { label: "Borrowed Time", changes: [] }
            ]
        },
        detection: { arcanaDC: 17, hints: ["Skin at the ring line looks a shade too smooth."] },
        latent: {
            trigger: "attunement",
            threshold: 5,
            escalation: [
                { at: 1, effect: "Minor aches vanish while the band is on.", playerHint: "Your joints feel unusually loose today." },
                { at: 5, effect: "Full curse activation" }
            ]
        },
        removal: { removeCurseLevel: 5, customRequirement: null }
    });
    return item;
}

/**
 * Create a T3 cursed item for testing removal resistance.
 * Trigger: "uses", threshold: 2, tier: 3.
 */
export function createT3CursedItem(actor = null) {
    const item = createMockItem({
        name: "Ironwedding Plate",
        type: "equipment",
        img: "icons/equipment/chest/breastplate-layered-steel.webp",
        parent: actor,
        system: { attuned: true, description: { value: "<p>Heavy plate armor.</p>" } }
    });
    item._setRawFlag(MODULE_ID, "cursedMeta", {
        category: "Cursed Armor",
        curseType: "binding",
        tier: 3,
        decoyAppearance: "Well-forged plate armor.",
        trueNature: "Fuses to the wearer. Cannot be removed by normal means.",
        tags: ["armor", "plate", "binding"],
        curse: {
            name: "The Wedding",
            description: "The armor fuses to the wearer permanently.",
            effects: [{ label: "Ironwedding", changes: [] }]
        },
        detection: { arcanaDC: 19, hints: ["The plate settles too perfectly against the skin."] },
        latent: {
            trigger: "uses",
            threshold: 2,
            escalation: [
                { at: 1, effect: "The armor feels warm after combat." },
                { at: 2, effect: "Full curse activation" }
            ]
        },
        removal: {
            removeCurseLevel: 7,
            customRequirement: "The armor must be struck by a weapon forged in the same foundry."
        }
    });
    return item;
}

/**
 * Reset mutable global state between tests.
 */
export function resetGlobalState() {
    game.actors = [];
    game.scenes = [];
    game.settings._reset();
    game.users.length = 0;
    Hooks._reset();
    Dialog._reset();
}
