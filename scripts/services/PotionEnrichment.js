/**
 * PotionEnrichment
 *
 * Corrects SRD healing-potion data at two points in the pipeline:
 *
 *   1. Pile-placement (CacheGeneratorApp.resolveItemData) — patches
 *      plain item-data objects before they reach Item Piles.
 *
 *   2. Identification (IdentificationService.identify) — patches the
 *      live Foundry Item document after latentMagic is promoted.
 *      This is the authoritative pass: it guarantees correct weight,
 *      price, description, and MIDI HealActivity regardless of what
 *      the compendium entry held when the item was first masked.
 *
 * All tier data is canonically defined in _TIERS and consumed by both passes.
 */
export class PotionEnrichment {

    /**
     * Canonical tier table.
     * @type {Array<{ test: RegExp, formula: string, weight: number, price: number, description: string }>}
     */
    static _TIERS = [
        {
            test:    /\bsupreme\b/i,
            formula: "10d4 + 20",
            weight:  0.5,
            price:   500,
            rarity:  "legendary",
            uses:    { max: 1, spent: 0, recovery: [] },
            description: "<p>A shimmering, opalescent liquid swirls inside this heavy crystal vial. The stopper is sealed with silver wax pressed with a radiant sun motif.</p>"
        },
        {
            test:    /\bsuperior\b/i,
            formula: "8d4 + 8",
            weight:  0.5,
            price:   250,
            rarity:  "rare",
            uses:    { max: 1, spent: 0, recovery: [] },
            description: "<p>A deep violet liquid fills this thick glass flask, catching light with a faint inner luminescence. The cork is bound with copper wire.</p>"
        },
        {
            test:    /\bgreater\b/i,
            formula: "4d4 + 4",
            weight:  0.5,
            price:   100,
            rarity:  "uncommon",
            uses:    { max: 1, spent: 0, recovery: [] },
            description: "<p>A vivid red liquid settles inside this bulbous vial. It catches the light with a warm, rose-gold shimmer and smells faintly of honeyed herbs.</p>"
        }
    ];

    /** Fallback tier (base Potion of Healing). */
    static _BASE_TIER = {
        formula: "2d4 + 2",
        weight:  0.5,
        price:   50,
        rarity:  "common",
        uses:    { max: 1, spent: 0, recovery: [] },
        description: "<p>A clear red liquid swirls inside this small vial. It catches the light with a faint rosy shimmer and smells lightly of berries.</p>"
    };

    // Keep legacy alias so CacheGeneratorApp call-sites don't break.
    /** @deprecated Use _TIERS — kept for CacheGeneratorApp callers. */
    static _HEAL_TIERS = PotionEnrichment._TIERS;

    /** PHB-standard weight for all healing potion tiers (lb). */
    static _BASE_WEIGHT = 0.5;

    // ── Lookup ─────────────────────────────────────────────────────────────

    /**
     * Resolve tier data for a healing potion by name.
     *
     * @param {string} name  Item display name.
     * @returns {{ formula: string, weight: number, price: number, description: string }|null}
     *          Tier data, or null if name is not a healing potion.
     */
    static getTierData(name) {
        if (!name || typeof name !== "string") return null;
        const n = name.trim();
        const isHealPotion =
            /^potion of (supreme|superior|greater) healing$/i.test(n)
            || /^potion of healing(\s*\([^)]+\))?$/i.test(n);
        if (!isHealPotion) return null;

        for (const tier of PotionEnrichment._TIERS) {
            if (tier.test.test(n)) return tier;
        }
        return PotionEnrichment._BASE_TIER;
    }

    /**
     * Alias used by the CacheGeneratorApp call-site.
     * @param {string} name
     * @returns {{ formula: string, weight: number }|null}
     */
    static getHealFormula(name) {
        return PotionEnrichment.getTierData(name);
    }

    // ── Pile-placement helpers (mutate plain data objects) ─────────────────

    /**
     * Correct item weight to the PHB-standard value.
     * Handles both legacy (number) and current ({ value, units }) formats.
     *
     * @param {object} itemData      Plain item data object (mutated in place).
     * @param {number} correctWeight PHB-correct weight in lbs.
     */
    static correctWeight(itemData, correctWeight) {
        if (!itemData.system) return;
        const w = itemData.system.weight;
        if (w !== null && typeof w === "object") {
            w.value = correctWeight;
        } else {
            itemData.system.weight = { value: correctWeight, units: "lb" };
        }
    }

    /**
     * Build a standard dnd5e HealActivity payload matching the SRD Consume shape.
     *
     * @param {string} formula  Healing roll formula (e.g. "2d4 + 2").
     * @returns {object}        Activity data object with a fresh `_id`.
     */
    static _buildHealActivityData(formula) {
        const id = foundry.utils.randomID(16);
        return {
            _id: id,
            type: "heal",
            name: "Consume",
            identifier: "consume",
            activation: { type: "bonus", value: 1, condition: "", override: false },
            consumption: {
                targets: [{ type: "itemUses", value: "1", target: "", scaling: {} }],
                scaling: { allowed: false, max: "" },
                spellSlot: true
            },
            description: { chatFlavor: "" },
            duration: { concentration: false, value: "", units: "inst", special: "", override: false },
            effects: [],
            range: { units: "self", special: "", override: false },
            target: {
                template: {
                    count: "", contiguous: false, type: "", size: "",
                    width: "", height: "", units: "ft", stationary: false
                },
                affects: { count: "", type: "self", choice: false, special: "" },
                prompt: true,
                override: false
            },
            healing: {
                number: null,
                denomination: null,
                bonus: "",
                types: ["healing"],
                custom: { enabled: true, formula },
                scaling: { mode: "", number: null, formula: "" }
            },
            uses: { spent: 0, recovery: [], max: "" },
            sort: 0,
            img: ""
        };
    }

    /**
     * Inject a standard dnd5e HealActivity onto a plain item data object.
     * Only call when `system.activities` is absent or empty.
     *
     * @param {object} itemData  Plain item data object (mutated in place).
     * @param {string} formula   Healing roll formula (e.g. "2d4 + 2").
     */
    static injectHealActivity(itemData, formula) {
        const activity = PotionEnrichment._buildHealActivityData(formula);

        if (!itemData.system) itemData.system = {};
        if (!itemData.system.activities) itemData.system.activities = {};
        itemData.system.activities[activity._id] = activity;
    }

    /**
     * Enrich a plain potion item-data object so the masked / pre-mask state
     * has everything dnd5e needs to make it consumable in the actor sheet:
     * `system.type.value = "potion"`, `system.uses.max = 1`, a HealActivity
     * if none is present, and the canonical PHB weight.
     *
     * Drives both the masked (pre-identification) appearance — where the
     * surface name is e.g. "Corked Bottle" but the player must still be able
     * to drink it — and the post-identification "Potion of Healing" stack.
     *
     * Name-driven gate: callers don't need to pre-set `system.type.value`,
     * which dnd5e 2024 PHB ships blank on some Potion of Healing variants.
     * That blank field was the bug — the old guard
     * `data.system?.type?.value === "potion"` skipped enrichment for those
     * entries, leaving the masked actor item with no charges or activity.
     *
     * @param {object} data  Plain item data object (mutated in place).
     * @returns {boolean}    True when the item was a recognised potion.
     */
    static enrichPileItemData(data) {
        if (!data || data.type !== "consumable") return false;
        const tier = PotionEnrichment.getTierData(data.name);
        if (!tier) return false;

        data.system ??= {};

        // Consumable type: dnd5e routes use behaviour off this field.
        data.system.type = data.system.type ?? {};
        if (!data.system.type.value) {
            data.system.type.value = "potion";
        }

        // Weight: tier value (PHB-canonical, 0.5 lb for healing tiers).
        PotionEnrichment.correctWeight(data, tier.weight);

        // Limited Uses: ensure `max` is populated so the Charges column
        // shows N/N rather than "—". `spent` defaults to 0; `recovery`
        // empty array renders as "Never" in the dnd5e details panel.
        data.system.uses = data.system.uses ?? {};
        const currentMax = Number(data.system.uses.max);
        if (!Number.isFinite(currentMax) || currentMax < 1) {
            data.system.uses.max = tier.uses.max;
            data.system.uses.spent = data.system.uses.spent ?? 0;
            if (!Array.isArray(data.system.uses.recovery)) {
                data.system.uses.recovery = [...tier.uses.recovery];
            }
        }

        // HealActivity: only inject when the item has no activity at all.
        // SRD compendium entries usually carry one already; CurseForge mints
        // copy the activity over. The injection is the fallback for entries
        // that ship empty (some 2024 PHB variants do).
        const acts = data.system.activities;
        const hasActivity = acts && Object.keys(acts).length > 0;
        if (!hasActivity) {
            PotionEnrichment.injectHealActivity(data, tier.formula);
        }

        return true;
    }

    // ── Post-identification enrichment (live Foundry Item) ─────────────────

    /**
     * Patch a live Foundry Item document after it has been identified.
     *
     * This is the authoritative enrichment pass. It guarantees correct
     * weight, price, description, and MIDI HealActivity on healing
     * potions regardless of what the source compendium entry held when
     * the item was first masked.
     *
     * Called by IdentificationService.identify() after buildPromotionPatch
     * is applied. Operates on the item's post-promotion state.
     *
     * Safe to call on non-potions — returns early with no-op.
     *
     * @param {Item} item  Live Foundry Item document (actor-owned).
     * @returns {Promise<void>}
     */
    static async enrichIdentifiedItem(item) {
        if (!item) return;

        // Resolve name from the promoted document — use _source.name to
        // bypass dnd5e's unidentified getter (item should be identified by
        // now, but belt-and-suspenders).
        const resolvedName = item._source?.name ?? item.name ?? "";
        const tier = PotionEnrichment.getTierData(resolvedName);
        if (!tier) return;  // Not a healing potion — nothing to do.

        const patch = {};

        // ── Attunement ──────────────────────────────────────────────────
        // Force-clear attunement unconditionally. Healing potions never
        // require attunement in dnd5e 2024. buildPromotionPatch guards this
        // at identification time, but belt-and-suspenders for any path that
        // bypasses that guard (e.g. existing world items with stale flags).
        patch["system.attunement"] = "";

        // ── Weight ──────────────────────────────────────────────────────
        // _stripToLatent never stashes weight, so identification never
        // restores it. Apply unconditionally.
        const currentWeight = item.system?.weight;
        if (typeof currentWeight === "object" && currentWeight !== null) {
            if ((currentWeight.value ?? 0) !== tier.weight) {
                patch["system.weight.value"] = tier.weight;
            }
        } else {
            patch["system.weight"] = { value: tier.weight, units: "lb" };
        }

        // ── Price ───────────────────────────────────────────────────────
        // latentMagic.originalPrice is stored from the pre-mask compendium
        // value. If that value was 0 (legacy dnd5e.items entries), promotion
        // restores 0. Override with the PHB-authoritative price.
        const currentPrice = item.system?.price ?? {};
        if ((currentPrice.value ?? 0) !== tier.price
                || (currentPrice.denomination ?? "gp") !== "gp") {
            patch["system.price"] = { value: tier.price, denomination: "gp" };
        }

        // ── Description ─────────────────────────────────────────────────
        // If the promoted description is empty (compendium had no text, or
        // originalDescription was ""), inject the canonical flavour text.
        const currentDesc = (item.system?.description?.value ?? "").trim();
        if (!currentDesc) {
            patch["system.description.value"] = tier.description;
        }

        // ── Rarity ──────────────────────────────────────────────────────
        // SRD entries for superior/supreme tiers ship with rarity: "" —
        // override unconditionally with the PHB-authoritative value.
        // Without this, the dnd5e sheet shows no magic icon on the item.
        if (tier.rarity && item.system?.rarity !== tier.rarity) {
            patch["system.rarity"] = tier.rarity;
        }

        // ── Uses ────────────────────────────────────────────────────────
        // Some SRD compendium entries omit uses.max, causing the charge
        // column to display "–" instead of "1/1". Potions are always
        // single-use — enforce unconditionally when max is absent or zero.
        const currentUsesMax = item.system?.uses?.max;
        if (!currentUsesMax || Number(currentUsesMax) < 1) {
            patch["system.uses.max"] = tier.uses.max;
            patch["system.uses.spent"] = item.system?.uses?.spent ?? 0;
        }

        // ── MIDI HealActivity ───────────────────────────────────────────
        // Inject only when ALL of these are true:
        //   a) midi-qol is active
        //   b) the item has no activities (or only empty activities map)
        //   c) the item is a potion-type consumable (not a roll-only item)
        const midiActive = !!game.modules?.get("midi-qol")?.active;
        const acts = item.system?.activities;
        // `item.system.activities` on a live dnd5e document is a MappingField /
        // Collection, NOT a plain object. Object.values() on a Collection does
        // not enumerate entries correctly — so any type-check via
        // `some(a => a.type === "heal")` silently returns false even when
        // activities are present (confirmed: duplicate Midi Heal root cause).
        // Use the Collection's own `size` property when available, then fall
        // back to Object.keys for plain toObject() results.
        const activityCount = acts
            ? (typeof acts.size === "number" ? acts.size : Object.keys(acts).length)
            : 0;
        // If ANY activity exists, skip injection — healing potions have exactly
        // one activity type. A second pass must never add a duplicate.
        const hasNoHealActivity = activityCount === 0;

        if (midiActive && hasNoHealActivity) {
            const activityData = PotionEnrichment._buildHealActivityData(tier.formula);
            patch[`system.activities.${activityData._id}`] = activityData;
        }

        if (Object.keys(patch).length === 0) return;

        try {
            await item.update(patch, { curseBypass: true });
        } catch (err) {
            console.warn(
                "[PotionEnrichment] enrichIdentifiedItem: update failed for",
                resolvedName, ":", err.message
            );
        }
    }
}
