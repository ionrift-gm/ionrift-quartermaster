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
            Object.assign(updates, ItemMaskingHelper.buildPromotionPatch(item.system, latent, item.type));
            kind = "cursed-lure";
            displayName = latent.originalName ?? item.name;
        } else if (latent && !latent.promoted) {
            Object.assign(updates, ItemMaskingHelper.buildPromotionPatch(item.system, latent, item.type));
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

            // §5b: After clearing canStack, attempt to merge this scroll
            // into any existing same-named stack in the actor's inventory.
            await IdentificationService._tryMergeScrollStack(item);
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
     * After a scroll is identified its name is restored (e.g. "Spell Scroll: Cure Wounds").
     * If the owning actor already holds another stack with that exact name,
     * merge this item's quantity into it and delete this item.
     *
     * Only runs on actor-owned items; pile items are left alone.
     *
     * @param {Item} item  The freshly-identified scroll item.
     * @returns {Promise<void>}
     */
    static async _tryMergeScrollStack(item) {
        const actor = item.parent;
        // Only merge into actor inventories, not piles or unowned items.
        if (!actor || actor.documentName !== "Actor") return;
        // The name is now the restored spell name. Find a different item
        // with the same name and a quantity flag (canStack:"yes").
        const resolvedName = item._source?.name ?? item.name;
        const siblings = actor.items.filter(
            (i) =>
                i.id !== item.id &&
                (i._source?.name ?? i.name) === resolvedName
        );
        if (!siblings.length) return;
        // Pick the first match and absorb this item's qty into it.
        const target = siblings[0];
        const myQty  = item.system?.quantity ?? 1;
        const tgtQty = target.system?.quantity ?? 1;
        try {
            await target.update(
                { "system.quantity": tgtQty + myQty },
                { curseBypass: true }
            );
            await item.delete({ curseBypass: true });
            Logger.info(
                "Quartermaster",
                `IdentificationService: merged scroll "${resolvedName}" (qty +${myQty}) into existing stack.`
            );
        } catch (err) {
            Logger.warn(
                "Quartermaster",
                `IdentificationService: scroll merge failed for "${resolvedName}":`,
                err.message
            );
        }
    }
}
