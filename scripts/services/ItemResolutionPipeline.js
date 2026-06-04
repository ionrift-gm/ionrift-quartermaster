import { ItemMaskingHelper } from "./ItemMaskingHelper.js";
import { PotionEnrichment } from "./PotionEnrichment.js";

const MODULE_ID = "ionrift-quartermaster";

const FORGED_PACK_IDS = new Set([
    "world.ionrift-cursewright-forged",
    "world.ionrift-forged-cursed"
]);

/**
 * Resolves cache generator meta-objects into Foundry-ready item data payloads
 * for Item Piles placement. Extracted from CacheGeneratorApp._onCanvasDrop.
 */
export class ItemResolutionPipeline {

    /**
     * Load a compendium item, recovering from stale UUIDs after a CurseForge recompile.
     *
     * @param {object} metaObj
     * @returns {Promise<Item|null>}
     */
    static async _resolveCompendiumDocument(metaObj) {
        const packId = metaObj.sourceCompendium;
        const docId  = metaObj._compendiumId;
        if (!packId || !docId) return null;

        const pack = game.packs.get(packId);
        if (!pack) return null;

        try {
            const doc = await pack.getDocument(docId);
            if (doc) return doc;
        } catch { /* stale document id after pack recreate */ }

        if (!FORGED_PACK_IDS.has(packId)) return null;

        const nameKey = (metaObj._lureSurfaceName ?? metaObj.name ?? "").trim().toLowerCase();
        if (!nameKey) return null;

        const docs = await pack.getDocuments();
        for (const candidate of docs) {
            // Skip identified-twin reference docs - caches only ever place
            // lures, and twin names can collide (lureIsSurface potions).
            if (candidate.flags?.["ionrift-cursewright"]?.role === "identified") continue;
            const qm = candidate.flags?.[MODULE_ID] ?? {};
            const latent = qm.latentMagic ?? {};
            const meta   = qm.cursedMeta ?? {};
            const labels = [
                latent.originalName,
                meta.lureName,
                candidate._source?.name,
                candidate.name
            ].filter(Boolean).map(n => String(n).trim().toLowerCase());
            if (labels.includes(nameKey)) return candidate;
        }
        return null;
    }

    /**
     * Resolve a cache meta-object into a Foundry-ready item data payload.
     *
     * @param {object} metaObj   Cache generator meta-object
     * @param {string} mintBatch Batch ID for curse tracking
     * @returns {Promise<object>} Plain item data ready for Item Piles
     */
    static async resolve(metaObj, mintBatch) {
        let data = null;
        if (metaObj.sourceCompendium && metaObj._compendiumId) {
            const pack = game.packs.get(metaObj.sourceCompendium);
            if (pack) {
                const doc = await ItemResolutionPipeline._resolveCompendiumDocument(metaObj);
                if (doc) {
                    data = doc.toObject();
                    // CurseForge items have system.identified=false by design.
                    // dnd5e preserves that raw false in toObject(), which causes
                    // IP's _transferItems to crash reading .type from unexpected
                    // object shapes. Force identified:true - the lure identity is
                    // carried by latentMagic flags, not by the identified field.
                    const qmF = data.flags?.[MODULE_ID] ?? {};
                    if (data.system && data.system.identified === false
                            && (qmF.cursedMeta || qmF.forgedFrom)) {
                        data.system.identified = true;
                    }
                    // Potion enrichment runs on every healing-potion shape,
                    // including dnd5e 2024 PHB entries that ship with a blank
                    // `system.type.value`. The helper sets type, weight,
                    // `system.uses.max = 1`, and injects a HealActivity when
                    // none is present, so the masked actor item still shows
                    // charges and a Consume activity in the inventory.
                    PotionEnrichment.enrichPileItemData(data);
                    // Strip attunement from all consumables.
                    // dnd5e's #migrateAttunement runs on every getDocument() call and
                    // converts legacy integer attunement values (e.g. 1 → "required")
                    // even on Potions of Healing that have no attunement requirement.
                    // The SRD source shows "Attunement Not Required" but the migration
                    // corrupts it in memory. Clear it unconditionally for consumables -
                    // no consumable in dnd5e 2024 requires attunement.
                    if (data.type === "consumable" && data.system) {
                        data.system.attunement = "";
                    }
                    // Strip all active effects from pile item data.
                    // dnd5e auto-applies an item's effects[] to the owning actor when
                    // the item is added to inventory — so a Potion of Climbing in an
                    // unopened chest would give the pile actor "Climber", Poison would
                    // apply its secondary damage effect, etc.
                    // Effects must be absent from the pile payload; they'll be present
                    // on the compendium item and apply normally when a player uses the
                    // item from their own inventory after looting.
                    if (Array.isArray(data.effects) && data.effects.length > 0) {
                        data.effects = [];
                    }
                }
            }
        }
        if (!data) {
            // Safe generic fallback (compendium resolution is preferred; see _pickContainer)
            const w = Number(metaObj.weight);
            data = {
                name: metaObj.name,
                type: metaObj.type ?? "loot",
                img: metaObj.img,
                system: {
                    price: { value: metaObj.price ?? 0, denomination: "gp" },
                    weight: { value: Number.isFinite(w) ? w : 0, units: "lb" }
                }
            };
            if (metaObj.capacityLbs !== undefined) {
                data.type = "backpack";
                data.system.capacity = { type: "weight", value: metaObj.capacityLbs };
            }
        }

        // Vital: Stamp the mintBatch flag on all generated items so curses can be tracked
        if (mintBatch) {
            foundry.utils.setProperty(data, `flags.${MODULE_ID}.mintBatch`, mintBatch);
        }

        // For infected entries: strip Cursewright meta BEFORE the masking check.
        // This is critical for standalone cursed items (Cursewright item as resolution
        // source) which have latentMagic set - if we check hasLatentMagic before
        // stripping, masking is skipped and the lure name is revealed immediately.
        // Stamp infectedCount (literal poison count) at the same time.
        const isInfected = !!(metaObj._infectedCount && metaObj._totalQty);
        if (isInfected) {
            // Store the literal count of poisoned potions, not a probability ratio.
            // The ratio (infectedCount / system.quantity) is computed on demand at
            // use time so depletion stays accurate as potions are consumed.
            foundry.utils.setProperty(data, `flags.${MODULE_ID}.infectedCount`, metaObj._infectedCount);
            // Strip Cursewright meta BEFORE masking so applyMask doesn't see
            // cursedMeta.lure and early-return. latentMagic is stripped AFTER
            // masking below - applyMask will temporarily re-inject it.
            if (data.flags?.[MODULE_ID]) {
                delete data.flags[MODULE_ID].cursedMeta;
                delete data.flags[MODULE_ID].forgedFrom;
            }
            // Do NOT set system.identified = true here.
            // QM design: mask by renaming, not by identified=false.
        }

        // Apply identification masking for magical items.
        // Infected entries are always treated as magical.
        const hasLatentMagic = !!(data.flags?.[MODULE_ID]?.latentMagic);
        if ((metaObj._isMagical || isInfected) && !hasLatentMagic) {
            const obscuredFallback = ItemMaskingHelper.detectMagical({
                name: data.name,
                rarity: data.system?.rarity ?? metaObj.rarity ?? "",
                type: data.type ?? metaObj.type ?? "loot",
                _baseItem: data.system?.type?.baseItem
            }).obscuredImg;
            ItemMaskingHelper.applyMask(data, {
                baseItemName: metaObj._baseItemName,
                mundaneDesc: metaObj._mundaneDesc,
                obscuredImg: metaObj._obscuredImg ?? obscuredFallback,
                sourceImg: metaObj._maskSourceImg
            });
        }

        // NOTE: latentMagic is intentionally PRESERVED on infected items.
        // applyMask re-injects latentMagic as the recovery stash for
        // identification. Previously this was stripped to prevent
        // _guardIdentify interference with IP's quantity updates. The
        // narrowed guard (qty-gated at L428 of CurseEngine.js) now
        // handles this correctly:
        //   - IP normalisation ({identified, quantity}) → strips identified, qty passes
        //   - GM wand ({identified} only) → routes to IdentificationService
        // Without latentMagic, IdentificationService finds no payload
        // and the GM cannot identify the masked potion.

        // Stamp canStack "yes" on masked items (IP maps string keys; boolean is ignored).
        // IP checks flags["item-piles"].item.canStack before merging stacks.
        // Without an explicit stackable stamp, IP runs a normalisation pass that touches
        // system.identified, triggering _guardIdentify and causing the
        // alternating Corked Bottle / Potion of Healing reveal bug.
        //
        // EXCEPTION: Spell scrolls must NOT be stackable. Different scrolls share
        // the same masked name ("Unidentified Scroll") but contain different spells.
        // If canStack is "yes", IP merges them on the player's actor, conflating
        // a Scroll of Fireball and a Scroll of Lightning Bolt into one stack.
        //
        // EXCEPTION: Infected potions must NOT be stackable. Different infected
        // stacks share the same masked name but carry distinct infectedCount values.
        // Without canStack, IP always CREATEs on transfer; InfectedStackManager.mergeStack
        // intercepts and merges infected stacks manually.
        const isScroll = data.system?.type?.value === "scroll"
            || /scroll/i.test(data.name || "");
        const hasInfectedCount = (data.flags?.[MODULE_ID]?.infectedCount ?? 0) > 0;
        if (!isScroll && data.flags?.[MODULE_ID]?.latentMagic && !hasInfectedCount) {
            data.flags["item-piles"] = data.flags["item-piles"] ?? {};
            data.flags["item-piles"].item = data.flags["item-piles"].item ?? {};
            data.flags["item-piles"].item.canStack = "yes";
        }
        // Scrolls: explicitly prevent stacking. IP's transferItems merges
        // items by name match during transfers - two "Unidentified Scroll"
        // entries become one with incremented quantity, overwriting the
        // latentMagic.originalName of the first. canStack:"no" tells IP
        // to treat each scroll as a distinct, non-mergeable item.
        // After identification, scrolls get unique names ("Spell Scroll:
        // Cure Wounds") and dnd5e's normal stacking resumes naturally.
        if (isScroll && data.flags?.[MODULE_ID]?.latentMagic) {
            data.flags["item-piles"] = data.flags["item-piles"] ?? {};
            data.flags["item-piles"].item = data.flags["item-piles"].item ?? {};
            data.flags["item-piles"].item.canStack = "no";
        }

        // Strip compendium source references from masked items.
        // IP uses flags.core.sourceId to re-resolve from compendium.
        // Without it, IP transfers our masked data as-is.
        if (data.flags?.[MODULE_ID]?.latentMagic || isInfected) {
            if (data.flags?.core?.sourceId) delete data.flags.core.sourceId;
            if (data._stats?.compendiumSource) delete data._stats.compendiumSource;
        }

        return data;
    }

    /**
     * Stamp system.quantity and assign a unique _id for Item Piles.
     * Item Piles _createItemPile flattens { item, quantity } to item data only
     * and drops the wrapper quantity - stack size must live on the item payload.
     *
     * @param {object} itemData  Resolved item data
     * @param {number} qty       Stack quantity
     * @returns {object}         Same itemData, mutated
     */
    static stampQuantity(itemData, qty) {
        const q = Math.max(1, Math.floor(Number(qty)) || 1);
        foundry.utils.setProperty(itemData, "system.quantity", q);
        // Assign a unique _id so Item Piles doesn't collapse distinct entries into one row.
        itemData._id = foundry.utils.randomID();
        return itemData;
    }
}
