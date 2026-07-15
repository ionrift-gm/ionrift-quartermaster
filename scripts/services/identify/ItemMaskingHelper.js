import { MODULE_ID } from "../../data/moduleId.js";
/**
 * ItemMaskingHelper
 *
 * Applies dnd5e identification masking to magical items from the Cache
 * Generator. Strips magical identity from names, generates mundane
 * descriptions with subtle quality hints scaled by rarity.
 *
 * All descriptive text is original. No publisher prose is retained.
 *
 * Near-term: uses `system.identified` flag.
 * Backlog: server-authoritative pattern not client-inspectable.
 */

import { TerrainDataRegistry } from "../loot/TerrainDataRegistry.js";
import { applyAuthoredDisguise } from "./AuthoredDisguise.js";

export class ItemMaskingHelper {

    /**
     * Regex matching the curse-reveal HTML block that CurseEngine.activate
     * appends to `system.description.value` when a curse activates. We
     * preserve this block across promotion patches so subsequent
     * migrations / forge re-syncs don't strip the curse text and leave
     * the player staring at the lure description on an activated curse.
     *
     * Keep in sync with the writer in CurseEngine.activate (cursewright).
     */
    static _CURSE_REVEAL_RE = /(<hr>\s*<p class="ionrift-curse-reveal">[\s\S]*?<\/p>|<section[^>]*\bionrift-curse-reveal\b[^>]*>[\s\S]*?<\/section>)/;

    /**
     * If the live item description contains an appended curse-reveal block,
     * splice it back onto the new base description. Idempotent: if the new
     * base already includes the block, returns it unchanged.
     *
     * @param {string} currentDesc Current live `system.description.value`
     * @param {string} newBaseDesc Replacement base (lure or twin desc)
     * @returns {string}
     */
    static _preserveCurseRevealBlock(currentDesc, newBaseDesc) {
        if (typeof currentDesc !== "string" || !currentDesc) return newBaseDesc;
        const match = currentDesc.match(ItemMaskingHelper._CURSE_REVEAL_RE);
        if (!match) return newBaseDesc;
        if (typeof newBaseDesc === "string" && newBaseDesc.includes("ionrift-curse-reveal")) {
            return newBaseDesc;
        }
        return (newBaseDesc ?? "") + match[1];
    }

    /**
     * Default Foundry core `icons/` art when a masked consumable label has no
     * dedicated mapping (keep in sync with dnd5e `json/icon-migration.json`).
     */
    static _DEFAULT_OBSCURED_CONSUMABLE_IMG = "icons/consumables/potions/potion-tube-corked-red.webp";

    /**
     * Per-label art for masked consumable *surface names* from `_maskConsumableName`.
     * Keys must match those strings exactly. Paths from dnd5e icon-migration targets.
     */
    static _OBSCURED_CONSUMABLE_ICON_BY_LABEL = {
        "Sealed Vial":         "icons/consumables/potions/potion-tube-corked-red.webp",
        "Stoppered Flask":     "icons/consumables/potions/potion-flask-stopped-red.webp",
        "Corked Bottle":       "icons/consumables/potions/bottle-round-corked-red.webp",
        "Small Phial":         "icons/consumables/potions/potion-tube-corked-blue.webp",
        "Flask of Oil":        "icons/consumables/potions/potion-flask-corked-orange.webp",
        "Sealed Oil Jar":      "icons/consumables/potions/bottle-bulb-corked-green.webp",
        "Stoppered Oil Flask": "icons/consumables/potions/bottle-round-corked-yellow.webp",
        "Pouch of Dust":       "icons/consumables/potions/bottle-bulb-empty-glass.webp",
        "Small Bead":          "icons/consumables/potions/bottle-circular-corked-labeled-green.webp",
        "Tallow Candle":       "icons/sundries/lights/candle-unlit-white.webp",
        "Stick of Incense":    "icons/consumables/plants/herb-marjoram-basil-oregano-leaf-bunch-green.webp",
        "Tin of Salve":        "icons/consumables/potions/potion-bottle-corked-labeled-green.webp"
    };

    /**
     * Icon for a masked consumable row, keyed by the mundane label shown to players.
     * @param {string|null|undefined} maskedLabel  Value from `detectMagical().baseItemName`
     * @returns {string}
     */
    static obscuredConsumableIconForMaskedLabel(maskedLabel) {
        if (!maskedLabel || typeof maskedLabel !== "string") return this._DEFAULT_OBSCURED_CONSUMABLE_IMG;
        return this._OBSCURED_CONSUMABLE_ICON_BY_LABEL[maskedLabel.trim()]
            ?? this._DEFAULT_OBSCURED_CONSUMABLE_IMG;
    }

    /**
     * Generic Foundry core `icons/` art for scrolls and the consumable default only.
     * Prefer `obscuredConsumableIconForMaskedLabel` when `baseItemName` is known.
     *
     * @param {"scroll"|"consumable"} kind
     * @returns {string|null}
     */
    static _genericIconFor(kind) {
        if (kind === "scroll") return "icons/sundries/scrolls/scroll-worn-beige.webp";
        if (kind === "consumable") return this._DEFAULT_OBSCURED_CONSUMABLE_IMG;
        return null;
    }

    /** Fallback consumable art when no label-specific map applies (legacy API). */
    static get OBSCURED_CONSUMABLE_IMG() {
        return this._DEFAULT_OBSCURED_CONSUMABLE_IMG;
    }

    /** Distinct consumable mask icon paths (for tests and CI migration checks). */
    static get MASKED_CONSUMABLE_ICON_PATHS() {
        return Object.freeze([...new Set([
            this._DEFAULT_OBSCURED_CONSUMABLE_IMG,
            ...Object.values(this._OBSCURED_CONSUMABLE_ICON_BY_LABEL)
        ])]);
    }

    /** Core Foundry art: generic scroll when the scroll name is masked. */
    static get OBSCURED_SCROLL_IMG() {
        return this._genericIconFor("scroll");
    }

    // ── Detection ────────────────────────────────────────────────────

    /**
     * dnd5e consumable subtype / system.type.value for masking decisions.
     * @param {Object} itemMeta
     * @returns {string}
     */
    static _consumableSubtype(itemMeta) {
        if (!itemMeta) return "";
        return (itemMeta.subtype
            ?? itemMeta.system?.type?.value
            ?? itemMeta.system?.consumable?.type
            ?? "").toString().toLowerCase();
    }

    /**
     * Whether this row should get potion-style name masking and obscured vial art
     * when `obscureConsumables` is on. Food, feed, and similar mundane consumables
     * stay readable (ItemPoolResolver already puts them in the consumable loot pool).
     *
     * Adventuring gear (lamp oil, holy water, acid, alchemist's fire, antitoxin, basic poison)
     * is excluded: it is sold labeled and is not treated like unidentified magic potions.
     * dnd5e often gives lamp oil consumable subtype "potion"; only "oil of …" is obscured.
     * Obscuring targets potions, oils of, and other named magical consumable tropes.
     *
     * @param {Object} itemMeta
     * @returns {boolean}
     */
    static _isObscurableConsumable(itemMeta) {
        const nameLower = (itemMeta.name || "").toLowerCase();
        const type = (itemMeta.type || "").toLowerCase();
        if (/scroll/i.test(nameLower)) return false;

        const subtype = this._consumableSubtype(itemMeta);

        if (subtype === "food" || subtype === "trinket") return false;

        // dnd5e often types these as subtype "potion"; they stay labeled at purchase and
        // are not run through mystery-vial presentation.
        if (/\bacid\b/i.test(nameLower)) return false;
        if (/basic poison/i.test(nameLower)) return false;
        if (/alchemist'?s\s+fire/i.test(nameLower)) return false;
        if (/holy water/i.test(nameLower)) return false;
        if (/antitoxin/i.test(nameLower)) return false;
        // PHB lamp oil (not Oil of Sharpness, Oil of Slipperiness, etc.)
        if (/\boil\b/i.test(nameLower) && !/oil\s+of/i.test(nameLower)) return false;

        // Subtype can be wrong on flattened rows; keep mundane provisions readable.
        if (/\bfeed\b|\brations?\b/i.test(nameLower)) return false;

        const nameHints = /potion|elixir|philter|draught|oil\s+of|dust|powder|bead|marble|candle|incense|salve|balm|ointment/i.test(nameLower);
        const subtypePotion = subtype === "potion";

        if (type === "consumable" && (nameHints || subtypePotion)) return true;
        if (type !== "consumable" && /potion|elixir|philter|draught|oil\s+of/i.test(nameLower)) return true;
        return false;
    }

    /**
     * @param {Object} itemMeta - Cache item metadata
     * @returns {{ isMagical: boolean, baseItemName: string|null, mundaneDesc: string|null, obscuredImg: string|null }}
     */
    static detectMagical(itemMeta, { terrainTag } = {}) {
        if (!itemMeta) {
            return { isMagical: false, baseItemName: null, mundaneDesc: null, obscuredImg: null };
        }

        const rarity = (itemMeta.rarity || "").toLowerCase().replace(/\s+/g, "");
        const nameLower = (itemMeta.name || "").toLowerCase();

        const obscureConsumables = game?.settings?.get(MODULE_ID, "obscureConsumables") ?? true;
        const obscureScrolls = game?.settings?.get(MODULE_ID, "obscureScrolls") ?? true;
        const obscureMagicalItems = game?.settings?.get(MODULE_ID, "obscureMagicalItems") ?? true;
        const isScroll = /scroll/i.test(nameLower);
        const obscurableConsumable = this._isObscurableConsumable(itemMeta);

        const rarityMagical = rarity !== "" && rarity !== "common" && rarity !== "none";
        const isGearMagic = rarityMagical && !isScroll && !obscurableConsumable;

        // isMagical reflects intrinsic magic independent of display settings.
        // Scrolls are always magical. Potion-like consumables are always magical.
        // Gear uses rarity. Obscure settings control whether masking metadata is produced.
        const isMagical = rarityMagical || isScroll || obscurableConsumable;

        if (!isMagical) {
            return { isMagical: false, baseItemName: null, mundaneDesc: null, obscuredImg: null };
        }

        if (!obscureMagicalItems && isGearMagic) {
            return { isMagical: false, baseItemName: null, mundaneDesc: null, obscuredImg: null };
        }

        const baseItemName = this._deriveBaseItemName(itemMeta);
        const mundaneDesc = this._deriveMundaneDescription(itemMeta, baseItemName, rarity, terrainTag);

        // Obscured art only applied when the corresponding setting is on.
        const obscuredImg = this._resolveObscuredArtPath({
            isScroll,
            obscurableConsumable,
            obscureConsumables,
            obscureScrolls,
            maskedLabel: baseItemName
        });

        return { isMagical, baseItemName, mundaneDesc, obscuredImg };
    }


    /**
     * Generic art for consumables / scrolls when settings hide their identity.
     * Weapons and worn gear keep compendium art so silhouette still matches the masked name.
     *
     * @param {object} opts
     * @param {boolean} opts.isScroll
     * @param {boolean} opts.obscurableConsumable  from `_isObscurableConsumable`
     * @param {boolean} opts.obscureConsumables
     * @param {boolean} opts.obscureScrolls
     * @param {string|null|undefined} opts.maskedLabel  `baseItemName` from detection (masked label)
     */
    static _resolveObscuredArtPath({ isScroll, obscurableConsumable, obscureConsumables, obscureScrolls, maskedLabel }) {
        if (isScroll && obscureScrolls) return this._genericIconFor("scroll");
        if (obscurableConsumable && obscureConsumables) {
            return this.obscuredConsumableIconForMaskedLabel(maskedLabel);
        }
        return null;
    }

    // ── Application ──────────────────────────────────────────────────

    /**
     * Apply a pre-authored disguise from SrdCurseAdapter at pile hand-off.
     *
     * The GM-only SRD cursed compendium stores the player-facing surface
     * (name, art, description) inside `latentMagic` while keeping the true
     * cursed identity on the document name. That inverted shape is correct
     * for pool cards but must be normalised before Item Piles placement so
     * players see the lure and identification can promote the true name.
     *
     * @param {Object} itemData  Full Foundry Item data object (mutated)
     * @returns {boolean} True when a disguise was applied
     */
    static applyAuthoredDisguise(itemData) {
        return applyAuthoredDisguise(itemData);
    }

    /**
     * Mutates itemData to present as a fully mundane item while stashing
     * the real values in `flags.ionrift-quartermaster.latentMagic`.
     *
     * We *do not* flip `system.identified` to false because dnd5e's
     * unidentified sheet view is itself a tell (it hides the tabs, the
     * action badges, and the price row). Instead we take ownership of
     * identification: the item stays `identified = true` and presents as
     * an ordinary Greataxe (or whatever the base type is), right down to
     * name, description, rarity, and price.
     *
     * On identification via `IdentificationService`, all stashed values
     * are promoted back onto `system`.
     *
     * Cursed items that ship a legacy `cursedMeta.lure` blob are skipped:
     * the lure owns surface presentation. Curse Forge compendium rows that
     * already carry authored `latentMagic` plus `forgedFrom` are left as-is.
     * SRD-style cursed stamps (`cursedMeta` without `lure`) still carry real
     * names and art; those go through the same latent masking as other
     * magical cache rows.
     *
     * @param {Object} itemData  - Full Foundry Item data object (mutated)
     * @param {Object} maskInfo  - { baseItemName, mundaneDesc, obscuredImg? }
     */
    static applyMask(itemData, maskInfo) {
        if (!itemData || !maskInfo?.baseItemName) return;

        itemData.system ??= {};

        const qmFlags = itemData.flags?.[MODULE_ID] ?? {};
        if (qmFlags.cursedMeta?.lure) {
            itemData.system.identified = true;
            return;
        }
        if (qmFlags.forgedFrom && qmFlags.latentMagic) {
            return;
        }

        const enrichedMask = { ...maskInfo };
        if (enrichedMask.obscuredImg && itemData.img && itemData.img !== enrichedMask.obscuredImg) {
            enrichedMask.sourceImg = itemData.img;
        }

        const latent = this._stripToLatent(itemData, enrichedMask);
        if (latent) {
            itemData.flags ??= {};
            itemData.flags[MODULE_ID] ??= {};
            itemData.flags[MODULE_ID].latentMagic = latent;
        }

        itemData.system.identified = true;
    }

    /**
     * Mutate `itemData` to its mundane presentation and return a
     * latentMagic block containing the original values.
     *
     * Strips mechanical tells (`magicalBonus`, `mgc`, `attunement`) and
     * surface tells (`name`, `description.value`, `rarity`, `price`) off
     * `system` / top-level, replacing them with neutral equivalents.
     * Returns null if there was nothing worth stashing.
     *
     * @param {Object} itemData
     * @param {Object} maskInfo { baseItemName, mundaneDesc }
     * @returns {Object|null}
     */
    static _stripToLatent(itemData, maskInfo) {
        const system = itemData.system ??= {};
        const latent = {};

        if (system.magicalBonus) {
            latent.magicalBonus = system.magicalBonus;
            system.magicalBonus = "";
        }

        if (Array.isArray(system.properties)) {
            if (system.properties.includes("mgc")) {
                latent.properties = ["mgc"];
                system.properties = system.properties.filter(p => p !== "mgc");
            }
        } else if (system.properties instanceof Set) {
            if (system.properties.has("mgc")) {
                latent.properties = ["mgc"];
                const next = new Set(system.properties);
                next.delete("mgc");
                system.properties = next;
            }
        }

        if (system.attunement && system.attunement !== "") {
            latent.attunement = system.attunement;
            system.attunement = "";
        }

        // Activity / bonus-damage strip: prevents tells like
        // "4d6 lightning damage" from showing on a Stage-1 sheet.
        // dnd5e v5 puts extra damage on the weapon's activities
        // (an added damage part or a whole extra activity like
        // "Lightning Bolt"). We snapshot the entire activities map
        // and any system.damage.bonus line, and promote them back
        // on identification.
        //
        // Consumables are EXCLUDED: a HealingActivity is the item's
        // function, not an identification tell. Stripping it leaves
        // players with an unusable item. Deceptive consumables
        // (Apothecary's Folly) carry their real activity in
        // cursedMeta.realActivity - not here - so they are unaffected.
        if (itemData.type !== "consumable"
                && system.activities
                && Object.keys(system.activities).length > 0) {
            latent.activities = foundry.utils.deepClone(system.activities);
            system.activities = {};
        }

        if (system.damage?.bonus) {
            latent.damageBonus = system.damage.bonus;
            system.damage.bonus = "";
        }

        // Surface masking: name, description, rarity, price
        if (itemData.name && itemData.name !== maskInfo.baseItemName) {
            latent.originalName = itemData.name;
            itemData.name = maskInfo.baseItemName;
        }

        const currentDesc = system.description?.value ?? "";
        if (maskInfo.mundaneDesc && maskInfo.mundaneDesc !== currentDesc) {
            latent.originalDescription = currentDesc;
            system.description = {
                ...(system.description ?? {}),
                value: maskInfo.mundaneDesc
            };
        }

        if (system.rarity && system.rarity !== "common" && system.rarity !== "") {
            latent.originalRarity = system.rarity;
            system.rarity = "common";
        }

        const baseItemKey = (itemData._baseItem || system.type?.baseItem || "").toLowerCase();
        const basePrice = this._lookupBasePrice(baseItemKey, itemData.type, maskInfo.baseItemName);
        if (basePrice !== null) {
            const currentPrice = system.price ?? {};
            if ((currentPrice.value ?? 0) !== basePrice.value
                || (currentPrice.denomination ?? "gp") !== basePrice.denomination) {
                latent.originalPrice = {
                    value: currentPrice.value ?? 0,
                    denomination: currentPrice.denomination ?? "gp"
                };
                system.price = { ...currentPrice, ...basePrice };
            }
        }

        const obscured = maskInfo.obscuredImg;
        if (obscured) {
            const prior = maskInfo.sourceImg ?? null;
            if (itemData.img && itemData.img !== obscured) {
                latent.originalImg = itemData.img;
                itemData.img = obscured;
            } else if (itemData.img === obscured && prior) {
                latent.originalImg = prior;
            }
        }

        return Object.keys(latent).length ? latent : null;
    }

    /**
     * Build an update patch that undoes a `latentMagic` strip. Fields
     * that were never stashed are omitted from the patch so the
     * caller-side state is preserved.
     *
     * Callers are responsible for unsetting the `latentMagic` flag
     * after the patch is applied.
     *
     * @param {Object} system - Current system object (read-only)
     * @param {Object} latent - The latentMagic flag block
     * @param {string} [itemType=""]
     * @param {Item|null} [itemDoc=null] - Live item; required to replace activities on actor documents
     * @returns {Object} update patch
     */
    static buildPromotionPatch(system, latent, itemType = "", itemDoc = null) {
        const patch = {};

        if (latent.magicalBonus) {
            patch["system.magicalBonus"] = latent.magicalBonus;
        }
        if (latent.attunement && itemType !== "consumable") {
            patch["system.attunement"] = latent.attunement;
        }
        if (latent.properties?.length) {
            const current = system?.properties;
            const currentArr = Array.isArray(current)
                ? current
                : current instanceof Set ? Array.from(current) : [];
            patch["system.properties"] = [...new Set([...currentArr, ...latent.properties])];
        }
        if (latent.activities && Object.keys(latent.activities).length > 0) {
            Object.assign(
                patch,
                ItemMaskingHelper.buildActivityPromotionPatch(itemDoc, latent.activities)
            );
        }
        if (latent.damageBonus) {
            patch["system.damage.bonus"] = latent.damageBonus;
        }

        if (latent.originalName) patch["name"] = latent.originalName;
        if (latent.originalDescription !== undefined) {
            // Preserve any curse-reveal block already appended to the live
            // description so an activated curse doesn't visually revert to
            // the lure copy when promotion/migration re-runs.
            const liveDesc = itemDoc?.system?.description?.value
                ?? system?.description?.value
                ?? "";
            patch["system.description.value"] = ItemMaskingHelper
                ._preserveCurseRevealBlock(liveDesc, latent.originalDescription);
        }
        if (latent.originalRarity) patch["system.rarity"] = latent.originalRarity;
        if (latent.originalPrice) {
            patch["system.price"] = {
                value: latent.originalPrice.value ?? 0,
                denomination: latent.originalPrice.denomination ?? "gp"
            };
        }
        if (latent.originalImg) patch["img"] = latent.originalImg;

        const recipeKey = itemDoc?.flags?.["ionrift-cursewright"]?.recipeKey ?? "";
        ItemMaskingHelper._guardPromotionPatch(patch, recipeKey);

        return patch;
    }

    /**
     * @param {object} patch
     * @param {string} [recipeKey]
     * @private
     */
    static _guardPromotionPatch(patch, recipeKey = "") {
        const minting = game.ionrift?.library?.minting;
        if (!minting?.guardPatch) return;
        minting.guardPatch(patch, {
            moduleId: MODULE_ID,
            recipeKey: recipeKey || undefined,
            mode: "update"
        });
    }

    /**
     * Build a promotion patch by copying the relevant `system.*` fields from
     * a TWIN doc (the identified-form compendium item produced by CurseForge
     * alongside the lure). The twin is the source of truth for the identified
     * state - name, rarity, magical bonus, attunement, properties, damage
     * bonus, description, image, AND activities - so promotion becomes a
     * straight whitelist copy instead of a flag-serialise/deserialise round
     * trip.
     *
     * The latent flag (`latentMagic.originalPrice`, `originalImg`, etc.)
     * still wins on the few fields the twin doesn't carry sensibly.
     *
     * @param {Item} liveItem    The actor-owned item being identified
     * @param {Item} twinDoc     The identified-form compendium doc
     * @param {object} [latent]  Optional `latentMagic` flag for tiebreakers
     * @returns {object} update patch
     */
    static buildPromotionPatchFromTwin(liveItem, twinDoc, latent = {}) {
        const patch = {};
        if (!twinDoc) return patch;

        const tSrc    = twinDoc.toObject?.() ?? {};
        const tSystem = tSrc.system ?? {};
        const itemType = liveItem?.type ?? "";

        patch["name"] = tSrc.name;
        if (tSrc.img) patch["img"] = tSrc.img;

        if (tSystem.rarity)       patch["system.rarity"] = tSystem.rarity;
        if (tSystem.magicalBonus) patch["system.magicalBonus"] = tSystem.magicalBonus;
        if (itemType !== "consumable" && tSystem.attunement) {
            patch["system.attunement"] = tSystem.attunement;
        }

        if (Array.isArray(tSystem.properties) && tSystem.properties.length) {
            const current = liveItem?.system?.properties;
            const currentArr = Array.isArray(current)
                ? current
                : current instanceof Set ? Array.from(current) : [];
            patch["system.properties"] = [...new Set([...currentArr, ...tSystem.properties])];
        }

        if (tSystem.damage?.bonus) {
            patch["system.damage.bonus"] = tSystem.damage.bonus;
        }
        if (tSystem.damage?.base) {
            patch["system.damage.base"] = foundry.utils.deepClone(tSystem.damage.base);
        }
        if (tSystem.damage?.versatile) {
            patch["system.damage.versatile"] = foundry.utils.deepClone(tSystem.damage.versatile);
        }
        if (tSystem.type) {
            patch["system.type"] = foundry.utils.deepClone(tSystem.type);
        }
        if (tSystem.range) {
            patch["system.range"] = foundry.utils.deepClone(tSystem.range);
        }
        if (tSystem.mastery) {
            patch["system.mastery"] = tSystem.mastery;
        }

        const desc = latent?.originalDescription
            ?? liveItem?.flags?.[MODULE_ID]?.cursedMeta?.decoyAppearance
            ?? tSystem.description?.value;
        if (desc !== undefined) {
            // Preserve any curse-reveal block already appended to the live
            // description so an activated curse doesn't visually revert to
            // the lure copy when CurseMigrator / syncFromForgedTemplate runs.
            const liveDesc = liveItem?.system?.description?.value ?? "";
            patch["system.description.value"] = ItemMaskingHelper
                ._preserveCurseRevealBlock(liveDesc, desc);
        }

        // Activities: per-id patch using the twin's raw activity data.
        const twinActivities = tSystem.activities;
        const twinActList = twinActivities
            ? (typeof twinActivities.values === "function"
                ? [...twinActivities.values()]
                : Object.values(twinActivities))
            : [];
        const twinHasFormula = twinActList.some((act) =>
            act?.damage?.parts?.[0]?.formula
            || (act?.damage?.base?.number != null && act?.damage?.base?.denomination != null));
        const latentActs = latent?.activities ?? null;
        const latentHasPartsFormula = latentActs
            && Object.values(latentActs).some((act) => act?.damage?.parts?.[0]?.formula);

        if (latentHasPartsFormula) {
            Object.assign(
                patch,
                ItemMaskingHelper.buildActivityPromotionPatch(liveItem, latentActs)
            );
        } else if (twinHasFormula) {
            Object.assign(
                patch,
                ItemMaskingHelper.buildActivityPromotionPatch(liveItem, twinActivities)
            );
        } else if (latentActs && Object.keys(latentActs).length > 0) {
            Object.assign(
                patch,
                ItemMaskingHelper.buildActivityPromotionPatch(liveItem, latentActs)
            );
        }

        // Price comes from the latent flag - the twin keeps SRD pricing which
        // is fine, but the lure's originalPrice is the authored intent.
        if (latent?.originalPrice) {
            patch["system.price"] = {
                value:        latent.originalPrice.value ?? 0,
                denomination: latent.originalPrice.denomination ?? "gp"
            };
        }

        const recipeKey = liveItem?.flags?.["ionrift-cursewright"]?.recipeKey
            ?? twinDoc?.flags?.["ionrift-cursewright"]?.recipeKey
            ?? "";
        ItemMaskingHelper._guardPromotionPatch(patch, recipeKey);

        return patch;
    }

    /**
     * Normalize a legacy `{ formula: "1d12" }` damage part to dnd5e 5.x
     * `{ number, denomination, types }` so MappingField rows expose a formula.
     *
     * @param {object|null|undefined} part
     * @returns {object|null|undefined}
     */
    static _normalizeDamagePart(part) {
        if (!part) return part;

        const normalized = foundry.utils.deepClone(part);
        const legacyFormula = normalized.formula
            ?? (normalized.custom?.enabled ? normalized.custom.formula : null);

        if (legacyFormula && normalized.number == null && normalized.denomination == null) {
            const match = String(legacyFormula).match(/^(\d+)d(\d+)$/i);
            if (match) {
                normalized.number = Number(match[1]);
                normalized.denomination = Number(match[2]);
            } else {
                normalized.custom = { enabled: true, formula: String(legacyFormula) };
            }
            delete normalized.formula;
        }

        if (normalized.types instanceof Set) {
            normalized.types = [...normalized.types];
        } else if (Array.isArray(normalized.types)) {
            normalized.types = [...normalized.types];
        }

        return normalized;
    }

    /**
     * Normalize a latent or twin activity row for dnd5e 5.x promotion.
     *
     * @param {object} act
     * @returns {object}
     */
    static _normalizeActivityForPromotion(act) {
        const clone = foundry.utils.deepClone(act ?? {});
        clone.type = clone.type ?? "attack";

        if (Array.isArray(clone.damage?.parts)) {
            clone.damage.parts = clone.damage.parts.map(
                (part) => ItemMaskingHelper._normalizeDamagePart(part)
            );
        } else if (clone.damage?.parts?.[0]?.formula) {
            clone.damage.parts = [
                ItemMaskingHelper._normalizeDamagePart(clone.damage.parts[0])
            ];
        }

        const firstPart = clone.damage?.parts?.[0];
        const legacyFormula = act?.damage?.parts?.[0]?.formula;
        if (legacyFormula && firstPart?.number != null && firstPart?.denomination != null) {
            delete clone.damage.base;
        }

        return clone;
    }

    /**
     * Per-activity update keys for dnd5e 5.x. Live documents use a MappingField
     * collection; assigning `system.activities` as one object is ignored.
     *
     * @param {Item|object|null} itemOrSystem - Live Item, or plain system data
     * @param {object} latentActivities
     * @returns {object}
     */
    static buildActivityPromotionPatch(itemOrSystem, latentActivities) {
        const patch = {};
        const normalized = ItemMaskingHelper._normalizeActivitiesInput(latentActivities);
        if (!normalized || !Object.keys(normalized).length) return patch;

        const newIds = new Set(Object.keys(normalized));
        const acts = itemOrSystem?.system?.activities ?? itemOrSystem?.activities;
        if (acts) {
            const liveIds = typeof acts.keys === "function" ? [...acts.keys()] : Object.keys(acts);
            for (const id of liveIds) {
                // Only delete IDs that aren't being replaced. Deleting and
                // recreating the same key in one flat update conflicts -
                // dnd5e's MappingField processes the delete and the new
                // activity never lands.
                if (!newIds.has(id)) {
                    patch[`system.activities.-=${id}`] = null;
                }
            }
        }

        for (const [id, act] of Object.entries(normalized)) {
            patch[`system.activities.${id}`] = ItemMaskingHelper._normalizeActivityForPromotion(act);
        }
        ItemMaskingHelper._guardPromotionPatch(patch);
        return patch;
    }

    /**
     * Normalize dnd5e activity input from plain objects or live collections.
     *
     * @param {object|Collection|null|undefined} activities
     * @returns {object}
     */
    static _normalizeActivitiesInput(activities) {
        if (!activities) return {};

        if (typeof activities.get === "function" && typeof activities.keys === "function") {
            const out = {};
            for (const id of activities.keys()) {
                const act = activities.get(id);
                out[id] = act?.toObject?.() ?? act;
            }
            if (Object.keys(out).length) return out;
        }

        const out = {};
        for (const [id, act] of Object.entries(activities)) {
            out[id] = act?.toObject?.() ?? act;
        }
        return out;
    }

    // ── Base Item Price Lookup ───────────────────────────────────────

    /**
     * Best-effort base-price lookup. Exact fidelity is not the goal;
     * we want the masked price to sit in the mundane range so a magical
     * Greataxe doesn't stand out next to a mundane Greataxe in the
     * same cache.
     *
     * Precedence:
     *   1. dnd5e baseItem id (weapons, armor)
     *   2. Category heuristic by type + derived base name
     *   3. null (keep existing price)
     */
    static _lookupBasePrice(baseItemKey, type, baseItemName) {
        if (baseItemKey && this._BASE_ITEM_PRICES[baseItemKey]) {
            return this._BASE_ITEM_PRICES[baseItemKey];
        }

        const nameLower = (baseItemName || "").toLowerCase();
        const t = (type || "").toLowerCase();

        if (t === "weapon") return { value: 15, denomination: "gp" };
        if (t === "armor" || t === "equipment") {
            if (/\bshield\b/.test(nameLower)) return { value: 10, denomination: "gp" };
            if (/\bring\s+mail\b/.test(nameLower)) {
                return this._BASE_ITEM_PRICES.ringmail ?? { value: 30, denomination: "gp" };
            }
            if (/\b(?:cloak|robe|hat|belt|boots|gloves|gauntlets|bracers|circlet|hood)\b/.test(nameLower)) {
                return { value: 5, denomination: "gp" };
            }
            if (/\b(?:ring|amulet|pendant|necklace)\b/.test(nameLower)) {
                return { value: 5, denomination: "gp" };
            }
            return { value: 20, denomination: "gp" };
        }
        if (t === "consumable") {
            if (/potion|elixir|philter|draught/.test(nameLower)) return { value: 50, denomination: "gp" };
            if (/scroll/.test(nameLower)) return { value: 25, denomination: "gp" };
            return { value: 10, denomination: "gp" };
        }
        if (t === "loot" || t === "tool") return { value: 5, denomination: "gp" };

        return null;
    }

    // Base-item prices drawn from dnd5e SRD reference values. Not meant
    // to be exhaustive - anything missing falls through to the category
    // heuristic above, which only needs to land in the "looks mundane"
    // range to do its job.
    static _BASE_ITEM_PRICES = {
        longsword:      { value: 15, denomination: "gp" },
        shortsword:     { value: 10, denomination: "gp" },
        greatsword:     { value: 50, denomination: "gp" },
        rapier:         { value: 25, denomination: "gp" },
        scimitar:       { value: 25, denomination: "gp" },
        dagger:         { value: 2,  denomination: "gp" },
        handaxe:        { value: 5,  denomination: "gp" },
        battleaxe:      { value: 10, denomination: "gp" },
        greataxe:       { value: 30, denomination: "gp" },
        waraxe:         { value: 30, denomination: "gp" },
        warhammer:      { value: 15, denomination: "gp" },
        lighthammer:    { value: 2,  denomination: "gp" },
        maul:           { value: 10, denomination: "gp" },
        morningstar:    { value: 15, denomination: "gp" },
        mace:           { value: 5,  denomination: "gp" },
        club:           { value: 1,  denomination: "sp" },
        greatclub:      { value: 2,  denomination: "sp" },
        quarterstaff:   { value: 2,  denomination: "sp" },
        flail:          { value: 10, denomination: "gp" },
        glaive:         { value: 20, denomination: "gp" },
        halberd:        { value: 20, denomination: "gp" },
        pike:           { value: 5,  denomination: "gp" },
        spear:          { value: 1,  denomination: "gp" },
        javelin:        { value: 5,  denomination: "sp" },
        trident:        { value: 5,  denomination: "gp" },
        warpick:        { value: 5,  denomination: "gp" },
        shortbow:       { value: 25, denomination: "gp" },
        longbow:        { value: 50, denomination: "gp" },
        handcrossbow:   { value: 75, denomination: "gp" },
        lightcrossbow:  { value: 25, denomination: "gp" },
        heavycrossbow:  { value: 50, denomination: "gp" },
        sling:          { value: 1,  denomination: "sp" },
        blowgun:        { value: 10, denomination: "gp" },
        whip:           { value: 2,  denomination: "gp" },
        net:            { value: 1,  denomination: "gp" },
        lance:          { value: 10, denomination: "gp" },
        padded:         { value: 5,   denomination: "gp" },
        leather:        { value: 10,  denomination: "gp" },
        studdedleather: { value: 45,  denomination: "gp" },
        hide:           { value: 10,  denomination: "gp" },
        chainshirt:     { value: 50,  denomination: "gp" },
        scalemail:      { value: 50,  denomination: "gp" },
        breastplate:    { value: 400, denomination: "gp" },
        halfplate:      { value: 750, denomination: "gp" },
        ringmail:       { value: 30,  denomination: "gp" },
        chainmail:      { value: 75,  denomination: "gp" },
        splint:         { value: 200, denomination: "gp" },
        plate:          { value: 1500, denomination: "gp" },
        shield:         { value: 10,  denomination: "gp" }
    };

    // ── Name Derivation ──────────────────────────────────────────────

    /**
     * Priority:
     *   1. Named-item override map (compound magical names to base type)
     *   2. Consumable type masking (potions, scrolls, wands, rods)
     *   3. system.type.baseItem field
     *   4. Strip "of X" suffixes, "+N", and magical prefixes
     *   5. Wondrous type map on the stripped label (equipment lacking baseItem)
     *   6. Stripped label fallback
     */
    static _deriveBaseItemName(itemMeta) {
        const rawName = (itemMeta.name || "").trim();
        const nameLower = rawName.toLowerCase();
        const type = (itemMeta.type || "").toLowerCase();
        const baseItem = itemMeta._baseItem || itemMeta.baseItem || "";
        const subtype = this._consumableSubtype(itemMeta);

        // 1. Named-item overrides (famous magical items -> base weapon/armor type)
        for (const [pattern, base] of this._NAMED_ITEM_OVERRIDES) {
            if (pattern.test(nameLower)) return base;
        }

        // 2. Consumable masking: potions, scrolls, oils get generic names
        const consumableMask = this._maskConsumableName(nameLower, type, subtype);
        if (consumableMask) return consumableMask;

        // 3. Wand/rod/staff masking (type or name-based)
        const obscureMagicalItems = game?.settings?.get(MODULE_ID, "obscureMagicalItems") ?? true;
        if (obscureMagicalItems) {
            const focusMask = this._maskFocusName(nameLower, type);
            if (focusMask) return focusMask;
        }

        // 4. dnd5e baseItem field (with terse-ID expansion for armor)
        if (baseItem && typeof baseItem === "string") {
            const expanded = this._BASE_ITEM_NAMES[baseItem.toLowerCase()];
            if (expanded) return expanded;
            return this._capitalise(baseItem);
        }

        // 5. Strip "of X" suffixes, "+N", and magical prefixes before wondrous scan
        let strippedName = rawName;
        strippedName = strippedName.replace(/\s*\+\d+\s*$/g, "").trim();
        strippedName = strippedName.replace(/\s+of\s+.+$/i, "").trim();
        for (const pattern of this._PREFIX_PATTERNS) {
            const next = strippedName.replace(pattern, "").trim();
            if (next.length > 2) strippedName = next;
        }
        const strippedLower = strippedName.toLowerCase();

        // 6. Wondrous type map on stripped label, then full name if needed
        if (type === "equipment" || type === "armor" || type === "loot") {
            const wondrousMask = this._matchWondrousType(strippedLower)
                ?? (strippedLower !== nameLower ? this._matchWondrousType(nameLower) : null);
            if (wondrousMask) return wondrousMask;
        }

        return strippedName || rawName;
    }

    static _capitalise(str) {
        const words = str
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/[-_]/g, " ")
            .split(/\s+/);
        return words
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(" ");
    }

    // ── Consumable Name Masking ──────────────────────────────────────
    // PHB adventuring gear liquids (acid, holy water, alchemist's fire, antitoxin) are
    // intentionally not mapped here; see `_isObscurableConsumable`.

    /**
     * @param {string} nameLower
     * @param {string} type
     * @param {string} [subtype=""]  from `_consumableSubtype`
     */
    static _maskConsumableName(nameLower, type, subtype = "") {
        const obscureConsumables = game?.settings?.get(MODULE_ID, "obscureConsumables") ?? true;
        const obscureScrolls = game?.settings?.get(MODULE_ID, "obscureScrolls") ?? true;

        if (/scroll/i.test(nameLower)) {
            return obscureScrolls ? "Unidentified Scroll" : null;
        }

        if (!obscureConsumables) return null;

        const st = (subtype || "").toLowerCase();

        if (type === "consumable" || /potion|elixir|philter|draught|oil of/i.test(nameLower)) {
            if (/potion|elixir|philter|draught/i.test(nameLower)) return _pick(this._POTION_NAMES);
            if (/oil\s+of/i.test(nameLower))   return _pick(this._OIL_NAMES);
            if (/dust|powder/i.test(nameLower)) return "Pouch of Dust";
            if (/bead|marble/i.test(nameLower)) return "Small Bead";
            if (/candle/i.test(nameLower))      return "Tallow Candle";
            if (/incense/i.test(nameLower))     return "Stick of Incense";
            if (/salve|balm|ointment/i.test(nameLower)) return "Tin of Salve";
            if (
                st === "potion"
                && this._isObscurableConsumable({ name: nameLower, type, subtype: st })
            ) {
                return _pick(this._POTION_NAMES);
            }
        }
        return null;
    }

    static _POTION_NAMES = [
        "Sealed Vial", "Stoppered Flask", "Corked Bottle", "Small Phial"
    ];

    static _OIL_NAMES = [
        "Flask of Oil", "Sealed Oil Jar", "Stoppered Oil Flask"
    ];

    // ── Focus Item Masking (wands, rods, staves) ─────────────────────

    static _maskFocusName(nameLower, type) {
        if (/\bwand\b/i.test(nameLower))  return _pick(this._WAND_NAMES);
        if (/\brod\b/i.test(nameLower))   return _pick(this._ROD_NAMES);
        if (/\bstaff\b/i.test(nameLower) && type !== "weapon") return _pick(this._STAFF_NAMES);
        return null;
    }

    static _WAND_NAMES  = ["Carved Stick", "Thin Wooden Rod", "Tapered Stick"];
    static _ROD_NAMES   = ["Ornate Rod", "Heavy Short Rod", "Metal Rod"];
    static _STAFF_NAMES = ["Walking Staff", "Worn Wooden Staff", "Tall Staff"];

    // ── Wondrous Type Map ────────────────────────────────────────────

    static _matchWondrousType(nameLower) {
        for (const [pattern, label] of this._WONDROUS_MAP) {
            if (pattern.test(nameLower)) return label;
        }
        return null;
    }

    static _WONDROUS_MAP = [
        [/\bcrystal\s*ball\b/i,              "Glass Sphere"],
        [/\bioun\s*stone\b|\bioun\b/i,       "Polished Stone"],
        [/\b(?:cloak|mantle|cape)s?\b/i,     "Cloak"],
        [/\b(?:gloves|gauntlets)\b/i,        "Gloves"],
        [/\b(?:bracers|vambrace)s?\b/i,      "Bracers"],
        [/\b(?:boots|slippers)\b/i,          "Boots"],
        [/\b(?:belt|girdle)s?\b/i,           "Belt"],
        [/\b(?:amulet|periapt|pendant|medallion|brooch)s?\b/i, "Pendant"],
        [/\bnecklace\b/i,                    "Necklace"],
        [/\bring\s+mail\b/i,                 "Ring Mail"],
        [/\bring\b/i,                       "Ring"],
        [/\b(?:robe|vestment)s?\b/i,         "Robe"],
        [/\b(?:hat|cap|hood)s?\b/i,          "Hat"],
        [/\bhelms?\b/i,                      "Helm"],
        [/\bheadbands?\b/i,                  "Headband"],
        [/\bcirclets?\b/i,                   "Circlet"],
        [/\b(?:goggles|lenses)\b/i,          "Goggles"],
        [/^eyes\b/i,                         "Goggles"],
        [/\bhaversack\b|\bbag\b|\bsack\b/i,  "Leather Bag"],
        [/\b(?:tome|manual|libram)s?\b|\bbook\b/i, "Old Book"],
        [/\borb\b/i,                         "Glass Sphere"],
        [/\bfigurine\b/i,                    "Small Figurine"],
        [/\bmirror\b/i,                      "Hand Mirror"],
        [/\bstone\b/i,                       "Polished Stone"],
        [/\b(?:gem|jewel)\b/i,               "Cut Gemstone"],
        [/\b(?:carpet|rug)\b/i,              "Woven Rug"],
        [/\bbroom\b/i,                       "Broom"],
        [/\bcandle\b/i,                      "Candle"],
        [/\b(?:deck|cards)\b/i,              "Card Deck"],
        [/\brope\b/i,                        "Coil of Rope"],
        [/\b(?:lantern|lamp)\b/i,            "Lantern"],
        [/\bhorn\b/i,                        "Horn"],
        [/\b(?:bottle|flask|decanter)\b/i,   "Sealed Bottle"],
        [/\bquiver\b/i,                      "Quiver"],
        [/\bshield\b/i,                      "Shield"],
    ];

    // ── Named Item Overrides ─────────────────────────────────────────
    // Maps famous compound magical names to their base physical type.

    static _NAMED_ITEM_OVERRIDES = [
        [/flame\s*tongue/i,             "Longsword"],
        [/frost\s*brand/i,              "Longsword"],
        [/sun\s*blade/i,                "Longsword"],
        [/moon\s*blade/i,               "Longsword"],
        [/vicious\s+\w+/i,             null], // fall through to baseItem
        [/vorpal/i,                     "Greatsword"],
        [/dancing\s+sword/i,            "Longsword"],
        [/holy\s*avenger/i,             "Longsword"],
        [/luck\s*blade/i,               "Shortsword"],
        [/defender/i,                   "Longsword"],
        [/dragon\s*slayer/i,            "Longsword"],
        [/giant\s*slayer/i,             "Greataxe"],
        [/berserker\s*axe/i,            "Greataxe"],
        [/dwarven\s*thrower/i,          "Warhammer"],
        [/hammer\s*of\s*thunderbolts/i, "Maul"],
        [/javelin\s*of\s*lightning/i,   "Javelin"],
        [/trident\s*of\s*fish/i,        "Trident"],
        [/mace\s*of\s*(disruption|smiting|terror)/i, "Mace"],
        [/oathbow/i,                    "Longbow"],
        [/dagger\s*of\s*venom/i,        "Dagger"],
        [/sword\s*of\s*wounding/i,      "Longsword"],
        [/sword\s*of\s*sharpness/i,     "Longsword"],
        [/nine\s*lives\s*stealer/i,     "Longsword"],
        [/sword\s*of\s*life/i,          "Greatsword"],
        [/scimitar\s*of\s*speed/i,      "Scimitar"],
        [/staff\s*of/i,                 "Walking Staff"],
        [/animated\s*shield/i,          "Shield"],
        [/spell\s*guard/i,              "Shield"],
        [/arrow[\s-]*catching/i,        "Shield"],
    ].filter(([, v]) => v !== null);

    static _PREFIX_PATTERNS = [
        /^(Greater|Superior|Supreme|Lesser|Minor|Cursed)\s+/i,
    ];

    // Terse dnd5e baseItem identifiers that need full mundane names.
    // Weapons generally capitalise fine ("longsword" -> "Longsword"),
    // but armor IDs lose their type suffix without this map.
    static _BASE_ITEM_NAMES = {
        splint:        "Splint Armor",
        plate:         "Plate Armor",
        halfplate:     "Half Plate Armor",
        chainmail:     "Chain Mail",
        chainshirt:    "Chain Shirt",
        ringmail:      "Ring Mail",
        scalemail:     "Scale Mail",
        breastplate:   "Breastplate",
        leather:       "Leather Armor",
        studdedleather:"Studded Leather Armor",
        hide:          "Hide Armor",
        padded:        "Padded Armor",
        shield:        "Shield",
        handcrossbow:  "Hand Crossbow",
        heavycrossbow: "Heavy Crossbow",
        lightcrossbow: "Light Crossbow",
        shortbow:      "Shortbow",
        longbow:       "Longbow",
        greatclub:     "Greatclub",
        greatsword:    "Greatsword",
        greataxe:      "Greataxe",
        battleaxe:     "Battleaxe",
        handaxe:       "Handaxe",
        lighthammer:   "Light Hammer",
        warhammer:     "Warhammer",
        waraxe:        "War Axe",
        warpick:       "War Pick",
        morningstar:   "Morningstar",
        quarterstaff:  "Quarterstaff",
        shortsword:    "Shortsword",
        longsword:     "Longsword",
    };

    // ── Mundane Description Assembly ─────────────────────────────────

    static _deriveMundaneDescription(itemMeta, baseItemName, rarity, terrainTag) {
        const type = (itemMeta.type || "").toLowerCase();
        const baseItem = (itemMeta._baseItem || itemMeta.baseItem || "").toLowerCase();
        const displayName = baseItemName || itemMeta.name || "item";
        const nameLower = (itemMeta.name || "").toLowerCase();
        const subtype = this._consumableSubtype(itemMeta);

        // Consumables get dedicated appearance descriptions
        const consumableDesc = this._consumableDescription(nameLower, type, subtype);
        if (consumableDesc) return consumableDesc;

        // Focus items (wand/rod/staff)
        const focusDesc = this._focusDescription(nameLower);
        if (focusDesc) return focusDesc;

        // Category physical description + quality hints
        const category = this._categorise(type, baseItem, itemMeta.name);

        // Terrain-specific description override (Layer 2).
        // Check TerrainDataRegistry first; fall back to generic pools.
        const terrainPool = terrainTag
            ? TerrainDataRegistry.getItemDescriptions(terrainTag, category)
            : [];
        const pool = terrainPool.length
            ? terrainPool
            : (this._PHYSICAL_DESCRIPTIONS[category] ?? this._PHYSICAL_DESCRIPTIONS.generic);
        const physical = _pick(pool);
        const hints = this._selectHints(rarity);

        const parts = [physical.replace(/\{name\}/g, displayName)];
        for (const h of hints) parts.push(h);

        return `<p>${parts.join(" ")}</p>`;
    }

    // ── Consumable Descriptions ──────────────────────────────────────

    /**
     * @param {string} nameLower
     * @param {string} type
     * @param {string} [subtype=""]
     */
    static _consumableDescription(nameLower, type, subtype = "") {
        const obscureScrolls = game?.settings?.get(MODULE_ID, "obscureScrolls") ?? true;
        const obscureConsumables = game?.settings?.get(MODULE_ID, "obscureConsumables") ?? true;
        const st = (subtype || "").toLowerCase();

        if (/potion|elixir|philter|draught/i.test(nameLower)) {
            if (!obscureConsumables) return null;
            return `<p>${_pick(this._POTION_APPEARANCES)}</p>`;
        }
        if (/oil\s+of/i.test(nameLower)) {
            if (!obscureConsumables) return null;
            return `<p>${_pick(this._OIL_APPEARANCES)}</p>`;
        }
        if (st === "potion" && !/potion|elixir|philter|draught/i.test(nameLower)) {
            if (!obscureConsumables) return null;
            return `<p>${_pick(this._POTION_APPEARANCES)}</p>`;
        }
        if (/scroll/i.test(nameLower) && (type === "consumable" || type === "loot")) {
            if (!obscureScrolls) return null;
            return `<p>${_pick(this._SCROLL_APPEARANCES)}</p>`;
        }
        return null;
    }

    static _POTION_APPEARANCES = [
        "A thick, ruby-coloured liquid that clings to the glass. Smells faintly sweet.",
        "Pale blue and slightly luminescent. Odourless when stoppered.",
        "Murky green with flecks of gold suspended in it. Warm to the touch.",
        "Clear as water but heavier than expected. A single bubble rises slowly.",
        "Deep amber, like old honey. Smells faintly of dried herbs.",
        "Swirling silver and grey, never quite settling. The cork is sealed with wax.",
        "Warm to the touch, with a faint rose tint. The glass is unusually smooth.",
        "Nearly black with a thin oily film on the surface. Sealed tight.",
        "Bright orange with fine sediment at the bottom. Shaking it produces tiny sparks of colour.",
        "Cloudy white, viscous. Smells of nothing, which is unusual for something this old.",
    ];

    static _OIL_APPEARANCES = [
        "A small jar of translucent oil. Slightly slippery on the outside.",
        "Dark oil in a squat flask. Smells faintly metallic.",
        "Thin, almost watery oil with a faint amber sheen.",
        "Viscous and cool to the touch. The cork is stained with drips.",
    ];

    static _SCROLL_APPEARANCES = [
        "A rolled scroll, bound with a plain strip of leather. The inner face has not been read aloud or studied yet.",
        "A sealed scroll case. Whatever is inside stays folded until someone opens it properly.",
        "Tightly rolled parchment, ink visible only at the edge. Nothing readable without unrolling it.",
        "A scroll tied with cord and wax. The hand inside could be anything until it is opened with care.",
    ];

    // ── Focus Descriptions (wand/rod/staff) ──────────────────────────

    static _focusDescription(nameLower) {
        if (/\bwand\b/i.test(nameLower)) return `<p>${_pick(this._WAND_APPEARANCES)}</p>`;
        if (/\brod\b/i.test(nameLower))  return `<p>${_pick(this._ROD_APPEARANCES)}</p>`;
        if (/\bstaff\b/i.test(nameLower)) return `<p>${_pick(this._STAFF_APPEARANCES)}</p>`;
        return null;
    }

    static _WAND_APPEARANCES = [
        "A slender wooden stick, about a foot long. Smooth and slightly warm.",
        "Tapered dark wood with a faint grain pattern. Light for its length.",
        "A thin stick with a polished tip. The wood has a slight sheen.",
        "Pale wood, gently curved. A few faint notches along one side.",
    ];

    static _ROD_APPEARANCES = [
        "A heavy short rod of dark metal. Cool to the touch. No markings.",
        "An ornate rod, about an arm's length. The grip is wrapped in worn leather.",
        "A metal rod with a flared end. Heavier than it looks.",
    ];

    static _STAFF_APPEARANCES = [
        "A tall wooden staff, smooth from years of handling. Good for walking.",
        "Dark hardwood with a slight twist to the grain. The base is iron-shod.",
        "A plain staff, shoulder height. The wood is unusually dense.",
        "A walking staff with a gnarled head. Worn but solid.",
    ];

    // ── Category Classification ──────────────────────────────────────

    static _categorise(type, baseItem, name = "") {
        const n = (name || "").toLowerCase();
        const b = (baseItem || "").toLowerCase();
        const term = b || n;

        if (type === "weapon") {
            if (/sword|rapier|scimitar|blade/i.test(term))                       return "sword";
            if (/axe|hatchet/i.test(term))                                        return "axe";
            if (/bow|crossbow/i.test(term))                                       return "ranged";
            if (/mace|club|flail|hammer|maul/i.test(term))                        return "bludgeon";
            if (/dagger|knife/i.test(term))                                       return "dagger";
            if (/spear|pike|lance|javelin|trident|glaive|halberd/i.test(term))    return "polearm";
            if (/whip/i.test(term))                                               return "whip";
            if (/staff|quarterstaff/i.test(term))                                 return "staff_weapon";
            return "weapon_generic";
        }
        if (type === "equipment" || type === "armor") {
            if (/\bshield\b/i.test(term))                                              return "shield";
            if (/plate|mail|breastplate|splint|half plate/i.test(term))                return "heavy_armor";
            if (/leather|hide|studded|chain shirt|scale/i.test(term))                  return "light_armor";
            if (/\b(?:gloves|gauntlets)\b/i.test(term))                                return "gloves";
            if (/\b(?:cloak|mantle|cape)s?\b/i.test(term))                            return "cloak";
            if (/\b(?:boots|slippers)\b/i.test(term))                                  return "boots";
            if (/\b(?:bracers|vambrace)s?\b/i.test(term))                              return "bracers";
            if (/\b(?:belt|girdle)s?\b/i.test(term))                                   return "belt";
            if (/\b(?:robe|vestment)s?\b/i.test(term))                                 return "robe";
            if (/\b(?:amulet|necklace|pendant|periapt|medallion|brooch)s?\b/i.test(term)) return "necklace";
            if (/\bhelms?\b/i.test(term))                                              return "headwear";
            if (/\b(?:headband|circlet)s?\b/i.test(term))                              return "headwear";
            if (/\bring\s+mail\b/i.test(term))                                         return "heavy_armor";
            if (/\bring\b/i.test(term))                                                return "ring";
            if (/\bhaversack\b|\bbag\b|\bsack\b/i.test(term))                          return "bag";
            return "armor_generic";
        }
        if (type === "consumable") {
            if (/potion|elixir|philter|draught/i.test(n))                          return "potion";
            if (/scroll/i.test(n))                                                 return "scroll";
            return "consumable_generic";
        }
        return "generic";
    }

    // ── Physical Descriptions (arrays, random pick) ──────────────────

    static _PHYSICAL_DESCRIPTIONS = {
        sword: [
            "A {name} with a straight blade and a leather-wrapped grip.",
            "A {name}. The edge is even and the tang is firmly set.",
            "A {name} with a simple cross-guard. The fuller runs clean.",
        ],
        axe: [
            "A {name} with a broad head and a solid haft.",
            "A {name}. Heavy and well-balanced. Built for purpose.",
            "A {name} with a thick blade and an ash handle.",
        ],
        ranged: [
            "A {name}. Well-strung and balanced. Someone maintained this.",
            "A {name} with a smooth draw. The string is fresh.",
            "A {name}. The limbs are straight and the nocking point is clean.",
        ],
        bludgeon: [
            "A {name}. Solid and heavy. Practical, if unglamorous.",
            "A {name} with a dense head and a reinforced shaft.",
            "A {name}. The striking face is flat and even.",
        ],
        dagger: [
            "A {name}. Short blade, leather-wrapped grip.",
            "A {name} with a tapered point and a simple guard.",
            "A {name}. The sheath is plain but well-fitted.",
        ],
        polearm: [
            "A {name}. Long reach and a weighted tip.",
            "A {name} with a riveted head and a hardwood shaft.",
            "A {name}. The haft is smooth, worn by use.",
        ],
        whip: [
            "A {name}. Braided leather, supple but firm.",
            "A {name} with a knotted handle and a frayed tip.",
        ],
        staff_weapon: [
            "A {name}. Hardwood, iron-shod at the base.",
            "A {name}. Smooth and dense, balanced for striking.",
        ],
        weapon_generic: [
            "A {name}. Functional and maintained.",
            "A {name}. Nothing about it demands attention.",
        ],
        shield: [
            "A {name}. Dented from use but structurally sound.",
            "A {name} with a simple boss and leather straps.",
            "A {name}. The face is scratched but the rim is true.",
        ],
        heavy_armor: [
            "A {name}. Heavy and well-fitted. Regularly maintained.",
            "A {name} with solid rivets and an even surface.",
            "A {name}. The plates overlap cleanly. Functional.",
        ],
        light_armor: [
            "A {name}. Supple and fitted. Someone wore this often.",
            "A {name} with reinforced stitching at the shoulders.",
            "A {name}. Flexible and lightly oiled.",
        ],
        armor_generic: [
            "A {name}. Serviceable protection.",
            "A {name}. Worn but intact. No obvious damage.",
        ],
        ring: [
            "A simple metal ring. Slightly tarnished.",
            "A thin band, unadorned. Smooth on the inside.",
            "A ring of dark metal. No inscription visible.",
        ],
        cloak: [
            "A {name} of plain-woven cloth. Hooded.",
            "A {name}, travel-stained but whole.",
            "A {name} with a simple clasp. The fabric is dense.",
        ],
        boots: [
            "A pair of {name}. Worn soles but intact uppers.",
            "A pair of {name}. Leather, well-fitted. Lightly scuffed.",
            "A pair of {name} with sturdy stitching.",
        ],
        gloves: [
            "A pair of {name}. Soft leather, fitted close.",
            "A pair of {name}. Flexible and lightly padded.",
        ],
        headwear: [
            "A {name}. Simple metalwork, unadorned.",
            "A {name}. Light for its size. Sits comfortably.",
        ],
        bracers: [
            "A pair of {name}. Riveted leather, well-shaped.",
            "A pair of {name}. Snug fit, reinforced at the wrist.",
        ],
        belt: [
            "A {name} of thick leather with a plain buckle.",
            "A {name}. Wide and sturdy. Several notch holes.",
        ],
        robe: [
            "A {name} of heavy cloth. Simple cut, deep hood.",
            "A {name}. The hem is clean and the seams are tight.",
        ],
        necklace: [
            "A {name} on a plain chain. No visible stone.",
            "A {name}. Simple metalwork, sits flat against the chest.",
        ],
        bag: [
            "A {name} of stitched leather. Buckled shut.",
            "A {name}. Weathered but intact. The straps are solid.",
        ],
        consumable_generic: [
            "A small item of uncertain purpose. Seems intact.",
            "A sealed container. The contents are not immediately obvious.",
        ],
        generic: [
            "A {name}. Nothing remarkable at first glance.",
            "A {name}. Ordinary in every obvious way.",
            "A {name}. Unremarkable, but well-kept.",
        ],
    };

    // ── Quality Hint System ──────────────────────────────────────────
    // Rarity scales the number and intensity of hints appended to the
    // physical description. Hints are subtle tells, not identifications.

    static _selectHints(rarity) {
        const r = (rarity || "").toLowerCase().replace(/\s+/g, "");
        switch (r) {
            case "uncommon":  return [_pick(this._HINTS_SUBTLE)];
            case "rare":      return [_pick(this._HINTS_MODERATE), _pick(this._HINTS_SENSORY)];
            case "veryrare":  return [_pick(this._HINTS_NOTABLE), _pick(this._HINTS_SENSORY)];
            case "legendary":
            case "artifact":  return [_pick(this._HINTS_NOTABLE), _pick(this._HINTS_NOTABLE_ALT)];
            default:          return [_pick(this._HINTS_SUBTLE)];
        }
    }

    static _HINTS_SUBTLE = [
        "Well-maintained, with no sign of rust or wear.",
        "Unusually clean for something found here.",
        "The craftsmanship is a cut above average.",
        "Looks almost new despite the surroundings.",
        "The stitching is tight and even throughout.",
        "Polished to a soft sheen. Someone valued this.",
        "The proportions are precise. Carefully made.",
        "No maker's mark, but the work is deliberate.",
        "Sits well in the hand. Balanced.",
        "The surface is free of blemishes.",
    ];

    static _HINTS_MODERATE = [
        "The balance feels precise, almost deliberate.",
        "Faint engravings trace the surface, too fine for casual work.",
        "The material has an unusual lustre that catches the light.",
        "Lighter than expected for its size.",
        "The fit and finish suggest a specialist workshop.",
        "No maker's mark, but the quality speaks for itself.",
        "The edges are crisp, as though it were finished yesterday.",
        "Every join is flush. No gap or seam is visible.",
        "The grain of the material runs in an unusual pattern.",
        "A faint scent clings to it, something unfamiliar.",
    ];

    static _HINTS_NOTABLE = [
        "The metal holds a faint warmth even in cold air.",
        "Reflects light in a way that seems almost intentional.",
        "The grip settles into the hand as though shaped for it.",
        "Faint patterns in the grain, barely visible unless you look closely.",
        "A resonance when tapped, like a tuning fork.",
        "The edges are impossibly sharp, with no sign of recent honing.",
        "An odd weight to it, as though the centre of gravity shifts.",
        "The surface is flawless. Not a scratch, not a mark.",
        "It feels older than it looks. Much older.",
        "There is a stillness about it. The air near it feels calm.",
    ];

    static _HINTS_NOTABLE_ALT = [
        "The material is unfamiliar. Not quite steel, not quite stone.",
        "Looking at it too long produces a faint sense of vertigo.",
        "It hums faintly when no one is touching it.",
        "Dust does not seem to settle on its surface.",
        "The temperature around it is noticeably different.",
        "It feels heavier when you are not looking at it.",
        "Light bends slightly at its edges.",
        "A faint vibration, like a heartbeat, when held.",
    ];

    static _HINTS_SENSORY = [
        "Cool to the touch, even in warm air.",
        "Faintly warm. Not from the surroundings.",
        "Smoother than the material should allow.",
        "A slight tingle where it contacts skin.",
        "Smells faintly of iron and something floral.",
        "The weight shifts subtly as you turn it.",
        "Produces a faint tone when set down on stone.",
        "The texture changes depending on how you hold it.",
    ];
}

// ── Utility ──────────────────────────────────────────────────────────

function _pick(arr) {
    if (!arr?.length) return "";
    return arr[Math.floor(Math.random() * arr.length)];
}
