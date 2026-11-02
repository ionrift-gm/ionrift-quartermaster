import { MODULE_ID, DEFAULT_ITEM_ICON } from "../../data/moduleId.js";
/**
 * LootPoolCompiler
 *
 * Resolves the 2024 SRD template-first architecture into discrete loot-ready items.
 * The dnd5e.equipment24 pack ships named weapon templates (Dragon Slayer, Holy Avenger,
 * etc.) as GM-application shells with no base subtype and weight=0 - not loot items.
 * This service expands them into a full permutation matrix:
 *   template × base weapon × bonus tier to discrete item
 *
 * Output: world.quartermaster-compiled-pool (GM-only world compendium)
 * Hash-gated: only recompiles when lootPoolSources config changes.
 * Guards: GM-only, dnd5e only.
 *
 * Structural pattern mirrors SrdCurseAdapter.js.
 */

import { Logger, MODULE_LABEL } from "../../utils/Logger.js";
import { ItemPoolResolver } from "./ItemPoolResolver.js";
import { isSrdCursedLootName, isSrdCursedTemplateName } from "../curse/SrdCurseCatalog.js";

import { enforcePackOwnership, assignPackToCompiledFolder, stableHash } from "../packs/CompendiumConfigHelper.js";
import { QM_FEATURES } from "../../data/QMFeatures.js";

import {
    keyToIdentifier,
    findSourceDoc,
    WEAPON_TEMPLATES,
    RANGE_STUB_EXPANSIONS,
    TIER_RARITY,
    SHIELD_BONUS_RARITY,
    ARMOR_BONUS_RARITY,
    BASE_ARMORS,
    GENERIC_WEAPON_BASES,
    ADAMANTINE_MITHRAL_BASES,
    RESISTANCE_BASES,
    RESISTANCE_TYPES,
    SPECIFIC_ARMOR_TEMPLATES,
    WONDROUS_TEMPLATE_SHELLS,
    NAMED_ECONOMY_ENRICHMENT,
    SLAYING_AMMO_TEMPLATE,
    SLAYING_AMMO_BASES,
    SLAYING_CREATURE_TYPES,
    SLAYING_AMMO_PRICE,
    ARCHITECTURE_2024_PACKS
} from "./LootPoolTemplateCatalog.js";

export class LootPoolItemBuilders {
    static _buildTemplateItem(templateDoc, baseDoc, templateName, baseName, tier) {
        const data   = templateDoc.toObject();
        const base   = baseDoc.toObject();
        const system = data.system ??= {};

        // Name: "Dragon Slayer Longsword +1"
        data.name = `${templateName} ${baseName} +${tier}`;

        // Image: prefer template image; fall back to base weapon image
        if (!data.img || data.img === DEFAULT_ITEM_ICON) {
            data.img = base.img ?? data.img;
        }

        // Rarity: derived from bonus tier
        system.rarity = TIER_RARITY[tier] ?? "uncommon";

        // Weight: 2024 template weight=0 is unreliable. Inherit from base weapon.
        // Never downgrade a valid template weight (some future packs may fix this).
        const templateWeight = this._extractWeight(system);
        if (templateWeight === 0) {
            const baseWeight = this._extractWeight(base.system ?? {});
            if (baseWeight > 0) {
                this._assignWeight(system, baseWeight);
            }
        }

        // Subtype / baseItem: template has blank subtype, inherit from base
        system.type ??= {};
        if (!system.type.value || system.type.value === "-") {
            system.type.value = base.system?.type?.value ?? "";
        }
        if (!system.type.baseItem) {
            system.type.baseItem = base.system?.type?.baseItem ?? baseName.toLowerCase();
        }

        // Bonus tier stamp: stored on magicalBonus so CacheGenerator can reference it
        system.magicalBonus = `+${tier}`;

        // Flags: mint batch for reconcile tracking
        this._stampCompiledFlags(data,
            `compiled-pool-${templateName.toLowerCase().replace(/\s+/g, "-")}-${baseName.toLowerCase().replace(/\s+/g, "-")}-${tier}`,
            { template: templateName, base: baseName, tier }
        );

        // Strip enchantment-type effects from the template. Weapon templates
        // carry enchantment shells (for the GM drag-to-apply workflow) that
        // corrupt compiled items via {} placeholder changes. Their rider
        // effects (bonus damage, slaying, etc.) are non-enchantment type
        // and survive this filter. Also clear item-level rider tracking
        // so surviving effects aren't skipped by Actor.allApplicableEffects().
        this._stripEnchantmentShells(data);

        this._cleanCompiledDescription(data);

        return data;
    }

    /**
     * Build a discrete ammunition item with a bonus tier applied.
     *
     * @param {Item} baseDoc  e.g. the Arrow item document
     * @param {string} base   e.g. "Arrow"
     * @param {number} tier   1 | 2 | 3
     * @returns {object} Plain item data
     */
    static _buildAmmoItem(baseDoc, base, tier) {
        const data   = baseDoc.toObject();
        const system = data.system ??= {};

        data.name = `${base} +${tier}`;
        system.rarity = TIER_RARITY[tier] ?? "uncommon";
        system.magicalBonus = `+${tier}`;

        this._stampCompiledFlags(data,
            `compiled-pool-ammo-${base.toLowerCase().replace(/\s+/g, "-")}-${tier}`,
            { template: "ammo-stub", base, tier }
        );

        // Defensive: strip any enchantment shells from the base ammo item.
        // Mundane ammo shouldn't have enchantments, but guard against future
        // dnd5e changes to base items.
        this._stripEnchantmentShells(data);

        return data;
    }

    /**
     * Build a discrete generic +N weapon from a mundane base weapon row.
     *
     * @param {Item} baseDoc
     * @param {string} baseName
     * @param {number} tier
     * @returns {object}
     */
    static _buildGenericBonusWeapon(baseDoc, baseName, tier) {
        const data   = baseDoc.toObject();
        const system = data.system ??= {};
        const basePrice = system.price?.value ?? 0;

        data.name = `${baseName} +${tier}`;
        system.rarity = TIER_RARITY[tier] ?? "uncommon";
        system.magicalBonus = `+${tier}`;
        if (system.price !== null && typeof system.price === "object") {
            system.price = { ...system.price, value: basePrice, denomination: system.price.denomination ?? "gp" };
        } else {
            system.price = { value: basePrice, denomination: "gp" };
        }

        this._stampCompiledFlags(data,
            `compiled-pool-weapon-${baseName.toLowerCase().replace(/\s+/g, "-")}-${tier}`,
            { template: "Weapon, +1, +2, or +3", base: baseName, tier }
        );

        this._stripEnchantmentShells(data);
        return data;
    }

    /**
     * True when a source row is already a loot-ready generic +N item (not a
     * zero-weight 2024 template shell that ItemPoolResolver excludes).
     *
     * @param {object} entry
     * @returns {boolean}
     */
    static _isLootReadyGenericPlusEntry(entry) {
        const doc = typeof entry?.toObject === "function" ? entry.toObject() : entry;
        const name = (doc?.name ?? "").trim();
        if (!name || !/\+\d\b/.test(name)) return false;
        if (ItemPoolResolver._isZeroWeightWeaponTemplate(doc)) return false;
        if (ItemPoolResolver._isZeroWeightArmorTemplate(doc)) return false;
        return ItemPoolResolver._extractWeight(doc) > 0;
    }

    /**
     * True when a compendium row is a mundane weapon base suitable for +N expansion.
     *
     * @param {object} entry
     * @returns {boolean}
     */
    static _isLootReadyWeaponBase(entry) {
        const doc = typeof entry?.toObject === "function" ? entry.toObject() : entry;
        if ((doc?.type ?? "").toLowerCase() !== "weapon") return false;
        const name = (doc.name ?? "").trim();
        if (!name || /\+\d\b/.test(name)) return false;
        if (ItemPoolResolver._isZeroWeightWeaponTemplate(doc)) return false;
        const subtype = (doc.system?.type?.value ?? "").trim();
        if (!subtype || subtype === "-") return false;
        return ItemPoolResolver._extractWeight(doc) > 0;
    }

    /**
     * Discover mundane weapon bases from enabled source compendiums.
     * @param {Map<string, {item: Item, packId: string}>} allByName
     * @returns {string[]}
     */
    static _discoverGenericWeaponBases(allByName, report = null) {
        const templateNames = new Set(Object.keys(WEAPON_TEMPLATES).map(n => n.toLowerCase()));
        const discovered = [];

        for (const { item, packId } of allByName.values()) {
            try {
                const doc = typeof item?.toObject === "function" ? item.toObject() : item;
                const name = (doc?.name ?? "").trim();
                if (!name || templateNames.has(name.toLowerCase())) continue;
                if (!this._isLootReadyWeaponBase(doc)) continue;
                discovered.push(name);
            } catch (err) {
                this._recordSkip(report, {
                    name:   item?.name ?? "(weapon base scan)",
                    packId: packId ?? "",
                    phase:  "source",
                    reason: err,
                });
            }
        }

        if (discovered.length >= 8) {
            return [...new Set(discovered)].sort((a, b) => a.localeCompare(b));
        }

        const merged = new Set(discovered);
        for (const baseName of GENERIC_WEAPON_BASES) {
            const entry = findSourceDoc(allByName, null, baseName);
            if (entry?.item && this._isLootReadyWeaponBase(entry.item)) {
                merged.add(baseName);
            }
        }
        return [...merged].sort((a, b) => a.localeCompare(b));
    }

    /**
     * Expand the Weapon +N stub into discrete base × tier rows.
     * @param {Map<string, {item: Item, packId: string}>} allByName
     * @returns {object[]}
     */
    static _expandGenericWeaponBonus(allByName, report = null) {
        const expanded = [];
        const bases = this._discoverGenericWeaponBases(allByName, report);

        for (const baseName of bases) {
            const baseEntry = findSourceDoc(allByName, null, baseName);
            const baseDoc = baseEntry?.item ?? null;
            if (!baseDoc || !this._isLootReadyWeaponBase(baseDoc)) continue;

            for (const tier of [1, 2, 3]) {
                const itemName = `${baseName} +${tier}`;
                const existing = findSourceDoc(allByName, null, itemName);
                if (existing?.item && this._isLootReadyGenericPlusEntry(existing.item)) {
                    continue;
                }
                const data = this._safeExpand(
                    report, "expand", itemName, baseEntry.packId,
                    () => this._buildGenericBonusWeapon(baseDoc, baseName, tier)
                );
                if (data) expanded.push(data);
            }
        }

        if (expanded.length === 0) {
            Logger.warn(
                MODULE_LABEL,
                `LootPoolCompiler: generic weapon +N expansion produced 0 rows ` +
                `(discovered ${bases.length} weapon bases). Check lootPoolSources include dnd5e.equipment24.`
            );
        }

        return expanded;
    }

    /**
     * Build a discrete armor item from a template shell + base armor stats.
     *
     * @param {Item} templateDoc
     * @param {string} baseName       e.g. "Chain Mail"
     * @param {{ subtype: string, weight: number, price: number }} baseData
     * @param {{ name: string, rarity: string, price: number, weight?: number, subtype?: string, bonusTier?: number }} opts
     * @returns {object} Plain item data
     */
    static _buildArmorItem(templateDoc, baseName, baseData, opts) {
        const data         = templateDoc.toObject();
        const templateName = data.name;
        const system       = data.system ??= {};

        data.name = opts.name;

        system.rarity = opts.rarity;
        system.price  = { value: opts.price, denomination: "gp" };

        system.type ??= {};
        system.type.value    = opts.subtype ?? baseData.subtype ?? "";
        system.type.baseItem = baseName.toLowerCase();

        const weight = opts.weight ?? baseData.weight ?? 0;
        this._assignWeight(system, weight);

        if (opts.bonusTier !== undefined) {
            system.magicalBonus = `+${opts.bonusTier}`;
        } else {
            delete system.magicalBonus;
        }

        const slugBase = baseName.toLowerCase().replace(/\s+/g, "-");
        const slugName = (opts.name || "").toLowerCase().replace(/\s+/g, "-");
        this._stampCompiledFlags(data,
            opts.bonusTier !== undefined
                ? `compiled-pool-armor-${slugBase}-${opts.bonusTier}`
                : `compiled-pool-armor-${slugName}`,
            opts.bonusTier !== undefined
                ? { template: templateName, base: baseName, tier: opts.bonusTier }
                : { template: templateName, base: baseName }
        );

        if (!opts.keepActivities) this._clearArmorActivities(data);

        // Strip enchantment effects. The 2024 SRD templates carry enchantment-
        // type ActiveEffects that are template-application shells (designed for
        // dragging onto base items). On a compiled discrete item these are
        // meaningless and can corrupt data via {} placeholder changes.
        if (opts.resistanceType) {
            // Resistance items: filter down to only the matching rider effect.
            this._filterResistanceEffects(data, opts.resistanceType);
        } else if (!opts.keepActivities) {
            // +N / Adamantine / Mithral: strip all enchantment shells.
            // Keep any non-enchantment effects (defensive).
            this._stripEnchantmentShells(data);
        }
        // keepActivities items (Efreeti Chain, Etherealness): leave effects
        // untouched - they may carry real rider effects or status grants.

        this._cleanCompiledDescription(data);

        return data;
    }

    /**
     * Remove template-era activities from a compiled armor item.
     * Most armor enchantments are passive (bonus to AC, resistance, etc.).
     * Items with real actions (Plate of Etherealness) set keepActivities=true
     * to bypass this.
     * @param {object} data  Plain item data (mutated in place)
     */
    static _clearArmorActivities(data) {
        // dnd5e 2024 stores activities as a keyed object on system.activities.
        // Wipe it so no template enchantment-application actions leak through.
        if (data.system) data.system.activities = {};
    }

    /**
     * Strip enchantment-type ActiveEffects from a compiled armor item.
     * Used for +N, Adamantine, and Mithral templates whose enchantment effects
     * are template-application shells (not meaningful on discrete items).
     * Non-enchantment effects (rare, but defensive) are preserved.
     * Also clears item-level rider tracking to prevent orphaned references.
     * @param {object} data  Plain item data (mutated in place)
     */
    static _stripEnchantmentShells(data) {
        if (!Array.isArray(data.effects)) return;
        data.effects = data.effects.filter(e => e.type !== "enchantment");
        this._clearRiderFlags(data);
    }

    /**
     * Clear the item-level flags.dnd5e.riders data from compiled items.
     *
     * The dnd5e 2024 system stores rider effect/activity references on the
     * item's flags (flags.dnd5e.riders.effect, flags.dnd5e.riders.activity).
     * The Actor's allApplicableEffects() checks this flag and SKIPS any
     * effect whose ID appears in it. On compiled items where we've removed
     * the parent enchantments, these references create orphaned riders that
     * are invisible in the UI and never apply to the actor.
     *
     * @param {object} data  Plain item data (mutated in place)
     */
    static _clearRiderFlags(data) {
        if (data.flags?.dnd5e?.riders) {
            delete data.flags.dnd5e.riders;
        }
    }

    /**
     * Filter the effects array on a resistance armor item so only the
     * rider effect matching the specific damage type survives.
     *
     * The template "Armor of Resistance" carries all 10 resistance
     * enchantments. Each enchantment has:
     *   - A parent effect (type "enchantment") with changes that modify
     *     the item (name, description, price, rarity). These are template-
     *     application shells containing {} placeholders - not loot-ready.
     *   - A child rider effect (referenced by the ITEM's
     *     flags.dnd5e.riders.effect array). The rider grants actual
     *     resistance to the wearer via system.traits.dr changes.
     *
     * Critical: after filtering, we must clear the item-level
     * flags.dnd5e.riders so the surviving rider effect is treated as a
     * standalone ActiveEffect. Without this, the dnd5e Actor's
     * allApplicableEffects() skips any effect whose ID appears in
     * parent.getFlag("dnd5e", "riders.effect") - making the resistance
     * invisible AND non-functional.
     *
     * @param {object} data          Plain item data (mutated in place)
     * @param {string} resistType    e.g. "Lightning"
     */
    static _filterResistanceEffects(data, resistType) {
        if (!Array.isArray(data.effects) || !data.effects.length) return;
        const type = resistType.toLowerCase();

        // Step 1: Collect rider effect IDs from the ITEM-level flags.
        // The dnd5e 2024 system tracks riders at the item level
        // (flags.dnd5e.riders.effect), not on individual effect objects.
        const riderIds = new Set(data.flags?.dnd5e?.riders?.effect ?? []);

        // Step 2: Filter effects. Keep rider effects that match the
        // resistance type, drop everything else.
        data.effects = data.effects.filter(effect => {
            const isEnchantmentShell = effect.type === "enchantment";
            const name = (effect.name ?? "").toLowerCase();

            // Always drop parent enchantment shells - they contain template
            // application changes (e.g. name to "{} of Acid Resistance") that
            // corrupt compiled items.
            if (isEnchantmentShell) return false;

            // Locale-safe: check changes for resistance trait key first, then fall back to name
            const hasTraitChange = effect.changes?.some(c =>
                c.key === "system.traits.dr.value" && String(c.value).toLowerCase() === type.toLowerCase()
            );
            if (hasTraitChange) return true;

            return name.includes(type.toLowerCase());
        });

        // Step 3: Clear item-level rider tracking so surviving effects
        // behave as standalone ActiveEffects. Without this, the Actor's
        // allApplicableEffects() would skip them as orphaned riders.
        this._clearRiderFlags(data);
    }

    /**
     * Strip template-era instructional content from compiled item descriptions.
     * Removes the "Make Magical Items with Templates" section and any embedded
     * roll tables (e.g. "Armor of Resistance Type"), since the compiled item is
     * already a discrete, concrete permutation.
     * @param {object} data  Plain item data (mutated in place)
     */
    static _cleanCompiledDescription(data) {
        const desc = data.system?.description?.value;
        if (!desc || typeof desc !== "string") return;

        let cleaned = desc;

        // ── 1. Strip <section class="secret"> blocks ──────────────────────────
        // dnd5e 2024 wraps template instructions ("Make Magical Items with
        // Templates") in a secret GM section. Compiled items need none of it.
        cleaned = cleaned.replace(
            /<section[^>]*class="[^"]*secret[^"]*"[^>]*>[\s\S]*?<\/section>/gi,
            ""
        );

        // ── 2. Strip all @Embed references ────────────────────────────────────
        // Template shells contain @Embed[RollTable...] for the resistance type
        // table and @Embed[JournalEntry...] for template instructions.
        // Compiled items are concrete - they don't need any embedded content.
        cleaned = cleaned.replace(
            /(<[^>]+>)?\s*@Embed\[[^\]]*\](?:\{[^}]*\})?(<\/[^>]+>)?/gi,
            ""
        );

        // ── 3. Strip "Make Magical Items with Templates" literal text block ───
        // Fallback: if the section wasn't in a <section> tag but inline.
        cleaned = cleaned.replace(
            /(<[^>]*>)?\s*Make Magical Items with Templates[\s\S]*/i,
            ""
        );

        // ── 4. "The GM chooses the type..." lead-in sentence ──────────────────
        cleaned = cleaned.replace(
            /The GM chooses the type or determines it randomly[^.]*\./gi,
            ""
        );

        // ── 5. Footer "- Armor of Resistance Type" link ───────────────────────
        cleaned = cleaned.replace(
            /[-\u2013]\s*(<[^>]*>)?[^<]*Armor of Resistance Type[^<]*(<\/[^>]*>)?/gi,
            ""
        );

        // ── 6. Debris cleanup ─────────────────────────────────────────────────
        cleaned = cleaned.replace(/(<p>\s*<\/p>\s*){2,}/g, "");
        cleaned = cleaned.replace(/(<br\s*\/?>\s*){2,}/gi, "<br>");
        cleaned = cleaned.trim();

        data.system.description.value = cleaned;
    }

    /**
     * Expand 2024 SRD armor template shells into discrete loot-ready items.
     *
     * @param {Map<string, {item: Item, packId: string}>} allByName
     * @returns {object[]}
     */
    static _isLootReadyNamedArmorOutput(entry) {
        const doc = typeof entry?.toObject === "function" ? entry.toObject() : entry;
        if ((doc?.type ?? "").toLowerCase() !== "equipment") return false;
        if (ItemPoolResolver._isZeroWeightArmorTemplate(doc)) return false;
        const subtype = (doc.system?.type?.value ?? "").trim().toLowerCase();
        if (!["heavy", "medium", "light", "shield"].includes(subtype)) return false;
        return ItemPoolResolver._extractWeight(doc) > 0;
    }

    /**
     * Expand armor template shells into discrete loot-ready rows.
     * @param {Map<string, {item: Item, packId: string}>} allByName
     * @returns {object[]}
     */
    static _expandArmorTemplates(allByName, report = null) {
        const expanded = [];

        const shouldSkip = (name, templateDoc) => {
            try {
                const entry = findSourceDoc(allByName, null, name);
                if (!entry?.item) return false;
                if (entry.item === templateDoc) return false;
                if (this._isLootReadyGenericPlusEntry(entry.item)) return true;
                if (this._isLootReadyNamedArmorOutput(entry.item)) return true;
                return false;
            } catch (err) {
                this._recordSkip(report, { name, phase: "expand", reason: err });
                return true;
            }
        };

        const lookupTemplate = (name) => findSourceDoc(allByName, null, name)?.item ?? null;

        const lookupBaseData = (baseName) => {
            const entry = findSourceDoc(allByName, null, baseName);
            if (!entry) return null;
            try {
                const base = entry.item.toObject();
                const sys  = base.system ?? {};
                return {
                    subtype: sys.type?.value ?? "",
                    weight:  this._extractWeight(sys),
                    price:   sys.price?.value ?? 0,
                };
            } catch (err) {
                this._recordSkip(report, {
                    name:   baseName,
                    packId: entry.packId ?? "",
                    phase:  "source",
                    reason: err,
                });
                return null;
            }
        };

        const templateMeta = (templateDoc) => {
            const obj = templateDoc.toObject();
            const sys = obj.system ?? {};
            return {
                rarity: sys.rarity ?? "",
                price:  sys.price?.value ?? 0,
            };
        };

        const pushArmor = (templateDoc, baseName, baseData, opts, packId = "") => {
            const data = this._safeExpand(report, "expand", opts.name, packId, () => {
                if (shouldSkip(opts.name, templateDoc)) return null;
                return this._buildArmorItem(templateDoc, baseName, baseData, opts);
            });
            if (data) expanded.push(data);
        };

        // +N armor stub: 13 bases × 3 tiers
        const plusStub = lookupTemplate("Armor, +1, +2, or +3");
        if (plusStub) {
            for (const baseName of BASE_ARMORS) {
                const baseData = lookupBaseData(baseName);
                if (!baseData) continue;
                for (const tier of [1, 2, 3]) {
                    const rarity = baseName === "Shield"
                        ? SHIELD_BONUS_RARITY[tier]
                        : ARMOR_BONUS_RARITY[tier];
                    pushArmor(plusStub, baseName, baseData, {
                        name:      `${baseName} +${tier}`,
                        rarity,
                        price:     baseData.price,
                        bonusTier: tier,
                    });
                }
            }
        }

        // Adamantine / Mithral: medium + heavy bases (8 each)
        for (const templateName of ["Adamantine Armor", "Mithral Armor"]) {
            if (isSrdCursedTemplateName(templateName)) continue;
            const templateDoc = lookupTemplate(templateName);
            if (!templateDoc) continue;
            const { rarity, price } = templateMeta(templateDoc);
            const prefix = templateName.replace(/\s+Armor$/, "");
            for (const baseName of ADAMANTINE_MITHRAL_BASES) {
                const baseData = lookupBaseData(baseName);
                if (!baseData) continue;
                pushArmor(templateDoc, baseName, baseData, {
                    name:   `${prefix} ${baseName}`,
                    rarity: rarity || "uncommon",
                    price:  price || 400,
                });
            }
        }

        // Armor of Resistance: all bases except shield × 10 damage types (120)
        const resistTemplate = lookupTemplate("Armor of Resistance");
        if (resistTemplate) {
            const { rarity, price } = templateMeta(resistTemplate);
            for (const baseName of RESISTANCE_BASES) {
                const baseData = lookupBaseData(baseName);
                if (!baseData) continue;
                for (const resistType of RESISTANCE_TYPES) {
                    pushArmor(resistTemplate, baseName, baseData, {
                        name:          `${baseName} of Resistance (${resistType})`,
                        rarity:        rarity || "rare",
                        price:         price || 4000,
                        resistanceType: resistType,
                    });
                }
            }
        }

        // Specific named templates (Demon Armor, Elven Chain, etc.)
        for (const { template, base, opts: overrides = {} } of SPECIFIC_ARMOR_TEMPLATES) {
            if (isSrdCursedTemplateName(template)) continue;
            const templateDoc = lookupTemplate(template);
            if (!templateDoc) continue;
            const baseData = lookupBaseData(base);
            if (!baseData) continue;
            const meta = templateMeta(templateDoc);
            pushArmor(templateDoc, base, baseData, {
                name:           overrides.name ?? template,
                rarity:         overrides.rarity ?? meta.rarity,
                price:          overrides.price ?? meta.price,
                weight:         overrides.weight,
                subtype:        overrides.subtype,
                keepActivities: overrides.keepActivities ?? false,
            });
        }

        return expanded;
    }

}

export function applyLootPoolItemBuilders(TargetClass) {
    for (const key of Object.getOwnPropertyNames(LootPoolItemBuilders)) {
        if (key === "length" || key === "name" || key === "prototype") continue;
        const desc = Object.getOwnPropertyDescriptor(LootPoolItemBuilders, key);
        if (desc) Object.defineProperty(TargetClass, key, desc);
    }
}
