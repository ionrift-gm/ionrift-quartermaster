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
import { applyItemMaskingProseCatalog } from "./ItemMaskingProseCatalog.js";

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

        const rarity = (itemMeta.rarity || itemMeta.system?.rarity || "").toLowerCase().replace(/\s+/g, "");
        const nameLower = (itemMeta.name || "").toLowerCase();

        const obscureConsumables = game?.settings?.get(MODULE_ID, "obscureConsumables") ?? true;
        const obscureScrolls = game?.settings?.get(MODULE_ID, "obscureScrolls") ?? true;
        const obscureMagicalItems = game?.settings?.get(MODULE_ID, "obscureMagicalItems") ?? true;
        const isScroll = /scroll/i.test(nameLower);
        const obscurableConsumable = this._isObscurableConsumable(itemMeta);

        const hasMagicalProperty = Array.isArray(itemMeta.system?.properties)
            ? itemMeta.system.properties.includes("mgc")
            : (itemMeta.system?.properties instanceof Set ? itemMeta.system.properties.has("mgc") : false);
        const hasMagicalBonus = Boolean(itemMeta.system?.magicalBonus);
        const rarityMagical = (rarity !== "" && rarity !== "common" && rarity !== "none") || hasMagicalProperty || hasMagicalBonus;
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
        // Spell scrolls are the exception: their cast activity is named
        // after the spell and links it, so it is put aside until the
        // scroll is identified (dnd5e re-caches the spell on first cast).
        const isScrollConsumable = itemData.type === "consumable"
            && (system.type?.value === "scroll" || system.type?.subtype === "scroll" || itemData.flags?.[MODULE_ID]?.isScroll || /scroll/i.test(itemData.name ?? ""));
        if ((itemData.type !== "consumable" || isScrollConsumable)
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

}


// ── Utility ──────────────────────────────────────────────────────────

function _pick(arr) {
    if (!arr?.length) return "";
    return arr[Math.floor(Math.random() * arr.length)];
}


applyItemMaskingProseCatalog(ItemMaskingHelper);
