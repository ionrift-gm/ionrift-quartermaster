import { MODULE_ID, MODULE_LABEL } from "../../data/moduleId.js";
import { getQuartermasterAdapter } from "../../adapters/getAdapter.js";
import { IdentificationService } from "../identify/IdentificationService.js";
import { Logger } from "../../utils/Logger.js";

/**
 * CacheConverterService
 *
 * Converts existing in-world container actors and tokens (such as pre-placed
 * adventure loot actors, Item Piles containers, and chest tokens) into
 * self-service Quartermaster Caches by mystifying and obscuring magical items
 * in-place.
 */
export class CacheConverterService {

    /**
     * Resolves a target parameter into its underlying Actor and optional Token/TokenDocument.
     * @param {Actor|Token|TokenDocument|string} target
     * @returns {{ actor: Actor|null, token: Token|TokenDocument|null }}
     */
    static resolveTarget(target) {
        if (!target) return { actor: null, token: null };

        // String document ID lookup
        if (typeof target === "string") {
            const actor = game.actors?.get(target) ?? null;
            if (actor) return { actor, token: null };
            const tok = canvas.tokens?.get(target) ?? null;
            if (tok) return { actor: tok.actor ?? null, token: tok };
            return { actor: null, token: null };
        }

        // Token instance on canvas
        if (target.actor && target.document) {
            return { actor: target.actor, token: target };
        }

        // TokenDocument
        if (target.actor && !target.document) {
            return { actor: target.actor, token: target };
        }

        // Actor document
        if (target.documentName === "Actor") {
            return {
                actor: target,
                token: target.isToken ? target.token : null
            };
        }

        return { actor: null, token: null };
    }

    /**
     * Determines whether an actor or token is eligible for Quartermaster cache conversion.
     * @param {Actor|Token|TokenDocument|string} target
     * @returns {boolean}
     */
    static isConvertibleContainer(target) {
        if (!game.user?.isGM) return false;

        const { actor, token } = CacheConverterService.resolveTarget(target);
        if (!actor) return false;

        // Never target player-owned characters
        if (actor.hasPlayerOwner) return false;

        // 1. Explicitly tagged Quartermaster cache or Item Pile container
        if (actor.flags?.[MODULE_ID]?.isQuartermasterCache) return true;
        if (actor.flags?.["item-piles"]?.data?.enabled) return true;

        // 2. System container / loot actor types
        const type = (actor.type || "").toLowerCase();
        if (type === "loot" || type === "container") return true;

        // 3. Tripwire containers or locks
        const twFlags = (token?.document ?? token)?.flags?.["ionrift-tripwire"];
        if (twFlags?.cache || twFlags?.secret || twFlags?.lock) return true;

        // 4. Token/actor named or themed as a container shell
        const nameLower = (actor.name || token?.name || "").toLowerCase();
        const containerKeywords = [
            "chest", "cache", "crate", "barrel", "recess", "storeroom",
            "pile", "loot", "trove", "urn", "vault", "coffer", "box", "sack"
        ];
        if (containerKeywords.some(kw => nameLower.includes(kw))) return true;

        // 5. Any non-combatant NPC containing items
        if (type === "npc" && (actor.items?.size ?? 0) > 0) return true;

        return false;
    }

    /**
     * Checks if the target container holds any mystified or unidentified items.
     * @param {Actor|Token|TokenDocument|string} target
     * @returns {boolean}
     */
    static hasMystifiedItems(target) {
        const { actor } = CacheConverterService.resolveTarget(target);
        if (!actor) return false;

        const items = actor.items?.contents ?? (actor.items ? Array.from(actor.items) : []);
        const isPf2eFamily = game.system?.id === "pf2e" || game.system?.id === "sf2e";

        return items.some(item => {
            const latent = item.flags?.[MODULE_ID]?.latentMagic;
            if (latent && !latent.promoted) return true;
            if (item.flags?.[MODULE_ID]?.cursedMeta?.lure) return true;
            if (isPf2eFamily && item.system?.identification?.status === "unidentified") return true;
            if (!isPf2eFamily && item.system?.identified === false) return true;
            return false;
        });
    }

    /**
     * Converts an existing container actor or token into a Quartermaster Cache by
     * mystifying all contained magical items in-place.
     *
     * @param {Actor|Token|TokenDocument|string} target
     * @param {object} [options]
     * @param {boolean} [options.silent=false]
     * @param {boolean} [options.setupItemPiles=true]
     * @returns {Promise<{ actor: Actor, count: number, items: Array }|null>}
     */
    static async convertContainer(target, options = {}) {
        if (!game.user?.isGM) {
            ui.notifications?.warn?.("Only the GM can convert containers.");
            return null;
        }

        const { actor, token } = CacheConverterService.resolveTarget(target);
        if (!actor) {
            ui.notifications?.warn?.("No valid container actor found to convert.");
            return null;
        }

        const adapter = getQuartermasterAdapter();
        const items = actor.items?.contents ?? (actor.items ? Array.from(actor.items) : []);
        const updates = [];
        const obscuredDetails = [];

        for (const item of items) {
            const qmFlags = item.flags?.[MODULE_ID] ?? {};

            // Skip items already masked by Quartermaster
            if (qmFlags.latentMagic && !qmFlags.latentMagic.promoted) continue;

            // Skip authored Cursewright lures
            if (qmFlags.cursedMeta?.lure) continue;

            // Detect if item is magical according to system adapter rules
            const itemData = item.toObject();
            const mask = adapter.detectMagicalForCache(itemData);
            if (!mask?.isMagical) continue;

            const update = adapter.buildMaskUpdate(item, mask);
            if (update) {
                updates.push(update);
                obscuredDetails.push({
                    id: item.id,
                    originalName: item.name,
                    maskedName: mask.baseItemName ?? item.name
                });
            }
        }

        // Apply item mystifications in an atomic batch
        if (updates.length > 0) {
            await actor.updateEmbeddedDocuments("Item", updates);
        }

        // Tag actor as a Quartermaster cache
        await actor.setFlag(MODULE_ID, "isQuartermasterCache", true);

        // Optional Item Piles integration: initialize token as an Item Pile container
        if (options.setupItemPiles !== false) {
            const piles = game.itempiles?.API;
            if (piles && typeof piles.turnTokensIntoItemPiles === "function") {
                const targetToken = token instanceof Token
                    ? token
                    : (token?.object ?? canvas.tokens?.get(token?.id ?? "") ?? null);

                if (targetToken && !piles.isItemPile(targetToken.actor ?? targetToken)) {
                    try {
                        await piles.turnTokensIntoItemPiles([targetToken], {
                            pileSettings: {
                                type: "container",
                                isContainer: true,
                                closeOnInteract: true
                            }
                        });
                    } catch (err) {
                        Logger.warn(MODULE_LABEL, "Could not turn token into Item Pile container:", err);
                    }
                }
            }
        }

        if (!options.silent) {
            if (updates.length > 0) {
                ui.notifications?.info?.(
                    `Quartermaster: Mystified ${actor.name} (${updates.length} ${updates.length === 1 ? "item" : "items"} obscured).`
                );
            } else {
                ui.notifications?.info?.(`Quartermaster: ${actor.name} contains no unmasked magical items.`);
            }
        }

        Logger.info(MODULE_LABEL, `Converted container ${actor.name} (${actor.id}): ${updates.length} items masked.`);

        return {
            actor,
            token,
            count: updates.length,
            items: obscuredDetails
        };
    }

    /**
     * Reveals and identifies all masked items on a container actor or token.
     *
     * @param {Actor|Token|TokenDocument|string} target
     * @param {object} [options]
     * @param {boolean} [options.silent=false]
     * @returns {Promise<number|null>} Number of items identified
     */
    static async bulkIdentify(target, options = {}) {
        if (!game.user?.isGM) {
            ui.notifications?.warn?.("Only the GM can identify container items.");
            return null;
        }

        const { actor } = CacheConverterService.resolveTarget(target);
        if (!actor) {
            ui.notifications?.warn?.("No valid container actor found.");
            return null;
        }

        const items = actor.items?.contents ?? (actor.items ? Array.from(actor.items) : []);
        const isPf2eFamily = game.system?.id === "pf2e" || game.system?.id === "sf2e";
        let identifiedCount = 0;

        for (const item of items) {
            const latent = item.flags?.[MODULE_ID]?.latentMagic;
            const cursedMeta = item.flags?.[MODULE_ID]?.cursedMeta;
            const isUnidentified = isPf2eFamily
                ? item.system?.identification?.status === "unidentified"
                : item.system?.identified === false;

            if ((latent && !latent.promoted) || cursedMeta?.lure || isUnidentified) {
                const res = await IdentificationService.identify(item, { silent: true });
                if (res?.identified) identifiedCount++;
            }
        }

        if (!options.silent) {
            if (identifiedCount > 0) {
                ui.notifications?.info?.(
                    `Quartermaster: Identified ${identifiedCount} ${identifiedCount === 1 ? "item" : "items"} on ${actor.name}.`
                );
            } else {
                ui.notifications?.info?.(`Quartermaster: No unidentified items found on ${actor.name}.`);
            }
        }

        Logger.info(MODULE_LABEL, `Bulk identified ${actor.name} (${actor.id}): ${identifiedCount} items revealed.`);
        return identifiedCount;
    }
}
