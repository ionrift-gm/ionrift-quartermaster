import { Logger } from "../_logger.js";
import { ItemMaskingHelper } from "./ItemMaskingHelper.js";

const MODULE_ID = "ionrift-quartermaster";
const FLAG_LATENT_MAGIC = "latentMagic";
const FLAG_CURSED_META = "cursedMeta";

/**
 * IdentificationService
 *
 * Single entry point for item identification in Quartermaster worlds.
 * Promotes stashed magical properties back onto the item's system data
 * and flips `system.identified = true`. Handles two sources of stashed
 * data, via item flags:
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

        const hasPendingPayload = !!(latent && !latent.promoted)
            || (cursedMeta?.lure && item.system?.identified === false);
        if (!hasPendingPayload) {
            return { identified: false, kind: "none", reason: "already-identified" };
        }

        const updates = { "system.identified": true };
        let kind = "mundane";
        let displayName = item.name;

        const forgedFrom = item.flags?.[MODULE_ID]?.forgedFrom;
        const isCurseForgeLatent = !!(latent && forgedFrom);

        if (isCurseForgeLatent) {
            Object.assign(updates, ItemMaskingHelper.buildPromotionPatch(item.system, latent));
            kind = "cursed-lure";
            displayName = latent.originalName ?? item.name;
        } else if (latent) {
            Object.assign(updates, ItemMaskingHelper.buildPromotionPatch(item.system, latent));
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
            }));
            kind = "cursed-lure";
            displayName = lure.name ?? item.name;
        }

        try {
            await item.update(updates, { curseBypass: true });
        } catch (err) {
            Logger.error("Quartermaster", `IdentificationService: update failed for ${item.name}:`, err.message);
            return { identified: false, kind, reason: "update-failed" };
        }

        if (latent) {
            try {
                await item.setFlag(MODULE_ID, FLAG_LATENT_MAGIC, {
                    ...latent,
                    promoted: true
                });
            } catch (err) {
                Logger.warn("Quartermaster", `IdentificationService: failed to mark latentMagic promoted on ${item.name}:`, err.message);
            }
        }



        if (!silent) {
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
}
