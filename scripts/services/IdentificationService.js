import { Logger } from "../_logger.js";
import { ItemMaskingHelper } from "./ItemMaskingHelper.js";
import { PotionEnrichment } from "./PotionEnrichment.js";

const MODULE_ID = "ionrift-quartermaster";
const FLAG_LATENT_MAGIC = "latentMagic";
const FLAG_CURSED_META = "cursedMeta";

/**
 * IdentificationService
 *
 * Single entry point for item identification in Quartermaster worlds.
 * Promotes stashed magical properties back onto the item's system data
 * and flips `system.identified = true`. Stashed payloads live on item flags:
 *
 *   - `latentMagic`: set by the cache masking pipeline on plain
 *     magical items (a +1 Javelin from a loot cache). Carries
 *     magicalBonus, the `mgc` property, and attunement. Marked
 *     `promoted: true` after promotion so a GM can re-obscure.
 *
 *   - Legacy `cursedMeta.lure`: older compendium rows that stash the decoy
 *     on the meta object instead of `latentMagic`. Curse Forge now writes
 *     the same latent shape as cache +1 items and keeps only the curse arc
 *     on `cursedMeta` (plus `lureName` for engine bookkeeping).
 *
 *   - Modern Cursewright rows can carry `cursedMeta` without `lure` once
 *     latent magic is absent or already promoted. Identification then only
 *     flips `system.identified` and records `cursedMeta.gmRevealed` after a
 *     GM-only notice.
 *
 * All identification paths in Quartermaster (GM action, Respite rest
 * activity, future Arcana flow) should route through `identify(item)`.
 * Foundry's native wand toggle is blocked by `_guardIdentify` on items
 * with either of these flags.
 */
export class IdentificationService {

    /**
     * Identify an item. Returns a small result object describing what
     * happened. No-op on already-identified items.
     *
     * @param {Item} item
     * @param {object} [options]
     * @param {boolean} [options.silent=false] Skip the user notification.
     * @returns {Promise<{identified: boolean, kind: string, reason?: string}>}
     */
    static async identify(item, { silent = false } = {}) {
        if (!game.user.isGM) {
            return { identified: false, kind: "none", reason: "not-gm" };
        }
        if (!item) {
            return { identified: false, kind: "none", reason: "no-item" };
        }

        const latent = item.getFlag?.(MODULE_ID, FLAG_LATENT_MAGIC) ?? null;
        const cursedMeta = item.getFlag?.(MODULE_ID, FLAG_CURSED_META) ?? null;

        const hasUnpromotedLatent = !!(latent && !latent.promoted);
        const hasCursedOnlyMeta = !!(
            cursedMeta
            && !cursedMeta.lure
            && !hasUnpromotedLatent
            && !cursedMeta.gmRevealed
        );

        const hasPendingPayload = hasUnpromotedLatent
            || (cursedMeta?.lure && item.system?.identified === false)
            || hasCursedOnlyMeta;
        if (!hasPendingPayload) {
            return { identified: false, kind: "none", reason: "already-identified" };
        }

        const updates = { "system.identified": true };
        let kind = "mundane";
        let displayName = item.name;

        const forgedFrom = item.flags?.[MODULE_ID]?.forgedFrom;
        const isCurseForgeLatent = !!(latent && forgedFrom && !latent.promoted);

        if (isCurseForgeLatent) {
            // Prefer twin-doc promotion: CurseForge emits a paired identified
            // twin in the forged compendium that holds the true mechanical
            // state (name, magical bonus, activities with damage, properties).
            // Falls back to the latentMagic flag path for items compiled
            // before the twin model landed.
            const twin = await IdentificationService._resolveIdentifiedTwin(item);
            if (twin) {
                Object.assign(updates, ItemMaskingHelper.buildPromotionPatchFromTwin(item, twin, latent));
                displayName = twin.name ?? latent.originalName ?? item.name;
            } else {
                Object.assign(updates, ItemMaskingHelper.buildPromotionPatch(item.system, latent, item.type, item));
                displayName = latent.originalName ?? item.name;
            }
            kind = "cursed-lure";
        } else if (latent && !latent.promoted) {
            Object.assign(updates, ItemMaskingHelper.buildPromotionPatch(item.system, latent, item.type, item));
            kind = "latent-magic";
            displayName = latent.originalName ?? item.name;
        } else if (cursedMeta?.lure && item.system?.identified === false) {
            const lure = cursedMeta.lure;
            Object.assign(updates, ItemMaskingHelper.buildPromotionPatch(item.system, {
                magicalBonus: lure.magicalBonus,
                attunement: lure.attunement,
                properties: lure.properties,
                ...(lure.name ? { originalName: lure.name } : {}),
                ...(lure.description !== undefined ? { originalDescription: lure.description } : {}),
                ...(lure.rarity ? { originalRarity: lure.rarity } : {}),
                ...(lure.img ? { originalImg: lure.img } : {})
            }, item.type));
            kind = "cursed-lure";
            displayName = lure.name ?? item.name;
        } else if (hasCursedOnlyMeta) {
            // Modern Cursewright item: no lure block; curse is tracked on cursedMeta only.
            kind = "cursed-identified";
            displayName = item.name;
        }

        // Consumables carry a "NaN" string in system.attunement from legacy cache placement
        // (StringField coerces numeric NaN → "NaN"). Include the clear in the SAME atomic
        // update as identified=true so there is no render gap where the attunement icon flashes.
        if (item.type === "consumable") {
            updates["system.attunement"] = "";
        }

        try {
            await item.update(updates, { curseBypass: true });
        } catch (err) {
            Logger.error("Quartermaster", `IdentificationService: update failed for ${item.name}:`, err.message);
            return { identified: false, kind, reason: "update-failed" };
        }

        // Post-identification enrichment for healing potions.
        // Corrects weight, price, description, and MIDI HealActivity
        // unconditionally — these values are not stashed in latentMagic
        // and may be absent or incorrect from the original compendium entry.
        // enrichIdentifiedItem is a no-op for non-healing-potion items.
        await PotionEnrichment.enrichIdentifiedItem(item);

        if (latent) {
            try {
                await item.setFlag(MODULE_ID, FLAG_LATENT_MAGIC, {
                    ...latent,
                    promoted: true
                });
            } catch (err) {
                Logger.warn("Quartermaster", `IdentificationService: failed to mark latentMagic promoted on ${item.name}:`, err.message);
            }

            // Clear IP canStack restriction after identification.
            // Masked scrolls get canStack:"no" to prevent conflation of
            // different spells sharing the name "Unidentified Scroll".
            // Once identified, each scroll has a unique name ("Spell Scroll:
            // Cure Wounds") and normal IP stacking by name should resume.
            const ipCanStack = item.flags?.["item-piles"]?.item?.canStack;
            if (ipCanStack === "no") {
                try {
                    await item.update(
                        { "flags.item-piles.item.canStack": "yes" },
                        { curseBypass: true }
                    );
                } catch (err) {
                    Logger.warn("Quartermaster", `IdentificationService: failed to clear canStack on ${item.name}:`, err.message);
                }
            }

            // §5b: After clearing canStack, attempt to merge this newly-
            // identified item into any existing same-named stack in the
            // actor's inventory (scrolls, potions, anything with latentMagic).
            await IdentificationService._tryMergeIdentifiedStack(item);
        }

        // For CurseForge lures (latentMagic + forgedFrom + cursedMeta), the
        // BlueprintRegistry.registerItemBlueprint called from the createItem hook
        // asynchronously unsets the inline cursedMeta flag and lifts it into
        // BlueprintStore. That async lift races with identify — by the time
        // identify's own awaits (update, setFlag) yield, the lift may have
        // completed and the inline flag is gone.
        //
        // Re-set the inline flag here from the snapshot taken at identify-start
        // so callers see cursedMeta immediately on the document after identify()
        // resolves. This does NOT interfere with the hasCursedOnlyMeta.gmRevealed
        // branch below — that path only runs when !isCurseForgeLatent.
        // _onLureRevealed (async hook) subsequently writes { ...cursedMeta, lureRevealed: true }
        // which correctly extends the restored inline value.
        if (isCurseForgeLatent && cursedMeta) {
            const liveCursedMeta = item.getFlag?.(MODULE_ID, FLAG_CURSED_META);
            if (!liveCursedMeta) {
                try {
                    await item.setFlag(MODULE_ID, FLAG_CURSED_META, cursedMeta);
                } catch (err) {
                    Logger.warn("Quartermaster", `IdentificationService: failed to restore cursedMeta on ${item.name}:`, err.message);
                }
            }
        }

        if (hasCursedOnlyMeta) {
            try {
                await item.setFlag(MODULE_ID, FLAG_CURSED_META, { ...cursedMeta, gmRevealed: true });
            } catch (err) {
                Logger.warn("Quartermaster", `IdentificationService: failed to mark cursedMeta gmRevealed on ${item.name}:`, err.message);
            }
            if (!silent) {
                const curseName = cursedMeta.curse?.name ?? "Unknown Curse";
                const tier = cursedMeta.tier ?? 1;
                ui.notifications.warn(
                    `[GM] ${item.name} is cursed (T${tier}: ${curseName}). The curse is latent; it will not reveal until activated.`,
                    { permanent: false }
                );
            }
        }

        if (!silent && kind !== "cursed-identified") {
            const actorName = item.parent?.name ?? "an unknown holder";
            const suffix = kind === "cursed-lure" ? ". The lure is active." : ".";
            ui.notifications.info(`${displayName} has been identified for ${actorName}${suffix}`);
        }

        Hooks.callAll(`${MODULE_ID}.itemIdentified`, item, { kind, cursedMeta });

        Logger.info("Quartermaster", `IdentificationService: ${kind} -> "${item.name}".`);
        return { identified: true, kind };
    }

    /**
     * Resolve the identified-twin compendium doc for a CurseForge-minted
     * item. Routed through the public Cursewright API so QM stays free of
     * direct cross-module file imports.
     *
     * Returns null when:
     *   - Cursewright isn't loaded
     *   - The item is a deceptive single-use (no twin emitted)
     *   - The forged pack was deleted manually
     *   - The recipe key is missing (legacy item from a pre-twin compile)
     *
     * @param {Item} item
     * @returns {Promise<Item|null>}
     */
    static async _resolveIdentifiedTwin(item) {
        const forge = game.ionrift?.cursewright?.forge;
        if (!forge || typeof forge.findIdentifiedTwin !== "function") return null;
        try {
            return await forge.findIdentifiedTwin(item);
        } catch (err) {
            Logger.warn("Quartermaster", `IdentificationService: twin lookup failed for "${item.name}":`, err.message);
            return null;
        }
    }

    /**
     * Query whether an item has any stashed identification payload
     * (latent magic or a cursed lure). Used by guards to recognise
     * items that must route through this service.
     *
     * @param {Item} item
     * @returns {boolean}
     */
    static hasLatentPayload(item) {
        if (!item) return false;
        const latent = item.getFlag?.(MODULE_ID, FLAG_LATENT_MAGIC);
        const cursedMeta = item.getFlag?.(MODULE_ID, FLAG_CURSED_META);
        return !!(latent || cursedMeta);
    }

    /**
     * Read-only summary of an item's latent identification state.
     * Intended for sibling modules (civics/shop appraisal, etc.) that
     * need to know the *real* price or rarity without calling `identify`.
     *
     * Returns null for items with no Quartermaster-managed payload.
     *
     * Shape:
     *   {
     *     kind: "latent-magic" | "cursed-lure" | "mundane",
     *     identified: boolean,
     *     originalPrice: { value, denomination } | null,
     *     originalRarity: string | null,
     *     originalName: string | null,
     *     mintBatch: string | null
     *   }
     *
     * @param {Item} item
     * @returns {object|null}
     */
    static getLatentSummary(item) {
        if (!item) return null;
        const flags = item.flags?.[MODULE_ID] ?? {};
        const latent = flags.latentMagic ?? null;
        const cursedMeta = flags.cursedMeta ?? null;
        const mintBatch = flags.mintBatch ?? null;

        if (!latent && !cursedMeta && !mintBatch) return null;

        const forgedFrom = flags.forgedFrom;
        let kind = "mundane";
        if (latent && forgedFrom) kind = "cursed-lure";
        else if (latent) kind = "latent-magic";
        else if (cursedMeta) kind = "cursed-lure";

        const originalPrice = latent?.originalPrice
            ?? cursedMeta?.lure?.price
            ?? null;
        const originalRarity = latent?.originalRarity
            ?? cursedMeta?.lure?.rarity
            ?? null;
        const originalName = latent?.originalName
            ?? cursedMeta?.lure?.name
            ?? cursedMeta?.lureName
            ?? null;

        return {
            kind,
            identified: item.system?.identified !== false,
            originalPrice,
            originalRarity,
            originalName,
            mintBatch
        };
    }

    /**
     * After an item is identified its name is restored (e.g. "Spell Scroll:
     * Cure Wounds" or "Potion of Healing"). If the owning actor already
     * holds another stack with that exact name, merge this item's quantity
     * into it and delete this item.
     *
     * `infectedCount` is summed onto the target before delete. Without that
     * step the freshly-identified stack's poison count is destroyed when
     * the source is deleted, leaving an understated count on the merged row.
     *
     * Only runs on actor-owned items; pile items are left alone.
     *
     * @param {Item} item  The freshly-identified item.
     * @returns {Promise<void>}
     */
    static async _tryMergeIdentifiedStack(item) {
        const actor = item.parent;
        if (!actor || actor.documentName !== "Actor") return;
        const resolvedName = item._source?.name ?? item.name;
        const siblings = actor.items.filter(
            (i) =>
                i.id !== item.id &&
                (i._source?.name ?? i.name) === resolvedName
        );
        if (!siblings.length) return;
        const target = siblings[0];
        const myQty       = item.system?.quantity ?? 1;
        const tgtQty      = target.system?.quantity ?? 1;
        const myInfected  = Number(item.getFlag?.(MODULE_ID, "infectedCount") ?? 0) || 0;
        const tgtInfected = Number(target.getFlag?.(MODULE_ID, "infectedCount") ?? 0) || 0;
        const sumInfected = myInfected + tgtInfected;

        const updates = { "system.quantity": tgtQty + myQty };
        if (sumInfected > 0) {
            updates[`flags.${MODULE_ID}.infectedCount`] = sumInfected;
        }

        try {
            await target.update(updates, { curseBypass: true });
            await item.delete({ curseBypass: true });
            Logger.info(
                "Quartermaster",
                `IdentificationService: merged "${resolvedName}" (qty +${myQty}, infected +${myInfected} → ${sumInfected}) into existing stack.`
            );
        } catch (err) {
            Logger.warn(
                "Quartermaster",
                `IdentificationService: stack merge failed for "${resolvedName}":`,
                err.message
            );
        }
    }
}
