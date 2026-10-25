import { MODULE_ID, MODULE_LABEL } from "../../data/moduleId.js";
import { getQuartermasterAdapter } from "../../adapters/getAdapter.js";
import { QM_FEATURES } from "../../data/QMFeatures.js";
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

        const type = (actor.type || "").toLowerCase();

        // 1. Explicitly tagged Quartermaster cache or Item Pile container
        if (actor.flags?.[MODULE_ID]?.isQuartermasterCache) return true;
        if (actor.flags?.["item-piles"]?.data?.enabled) return true;

        // 2. System container / loot actor types
        if (type === "loot" || type === "container") return true;

        // 3. Tripwire containers or locks
        const twFlags = (token?.document ?? token)?.flags?.["ionrift-tripwire"];
        if (twFlags?.cache || twFlags?.secret || twFlags?.lock) return true;

        // Never target player-owned characters
        if (type === "character" && actor.hasPlayerOwner) return false;

        // 4. Token/actor named or themed as a container shell
        const nameLower = (actor.name || token?.name || "").toLowerCase();
        const containerKeywords = [
            "chest", "cache", "crate", "barrel", "recess", "storeroom",
            "pile", "loot", "trove", "urn", "vault", "coffer", "box", "sack"
        ];
        if (containerKeywords.some(kw => nameLower.includes(kw))) return true;

        // Never target player-owned characters
        if (actor.hasPlayerOwner) return false;

        // 5. Any non-combatant NPC/monster containing items
        if ((type === "npc" || type === "monster") && (actor.items?.size ?? 0) > 0) return true;

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
        const isPf2eFamily = game.system?.id === "pf2e" || game.system?.id === "sf2e";
        const updates = [];
        const obscuredDetails = [];

        for (const item of items) {
            const qmFlags = item.flags?.[MODULE_ID] ?? {};

            // Skip authored Cursewright lures
            if (qmFlags.cursedMeta?.lure) continue;

            // Skip items already masked by Quartermaster, unless a PF2e item has a leaked name or runes
            const hasActiveLatent = Boolean(qmFlags.latentMagic && !qmFlags.latentMagic.promoted);
            if (hasActiveLatent && !CacheConverterService._needsPf2eRemask(item, qmFlags, isPf2eFamily)) {
                continue;
            }

            // Detect if item is magical according to system adapter rules
            const itemData = CacheConverterService._buildUnmaskedItemSnapshot(item, qmFlags.latentMagic);
            const mask = adapter.detectMagicalForCache(itemData);
            if (!mask?.isMagical) continue;

            const update = adapter.buildMaskUpdate(
                hasActiveLatent ? CacheConverterService._wrapItemForRemask(item, itemData) : item,
                mask
            );
            if (update) {
                updates.push(update);
                obscuredDetails.push({
                    id: item.id,
                    originalName: itemData.name || item.name,
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

        const supportsMasking = adapter.supports(QM_FEATURES.LATENT_MASKING);
        if (!supportsMasking && typeof actor.update === "function") {
            const ownerPerm = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
            if ((actor.ownership?.default ?? 0) < ownerPerm) {
                await actor.update({ "ownership.default": ownerPerm });
            }
        }

        // Optional Item Piles integration: initialize token(s) as Item Pile containers
        if (options.setupItemPiles !== false) {
            const piles = game.itempiles?.API;
            if (piles && typeof piles.turnTokensIntoItemPiles === "function") {
                const TokenClass = globalThis.foundry?.canvas?.placeables?.Token;
                const resolvedToken = (typeof TokenClass === "function" && token instanceof TokenClass)
                    ? token
                    : (token?.object ?? globalThis.canvas?.tokens?.get?.(token?.id ?? "") ?? null);
                const candidateTokens = resolvedToken
                    ? [resolvedToken]
                    : (globalThis.canvas?.tokens?.placeables?.filter?.(t => t.actor?.id === actor.id) ?? []);

                for (const targetToken of candidateTokens) {
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
        }

        if (!options.silent) {
            if (!supportsMasking) {
                ui.notifications?.info?.(`Quartermaster: Converted ${actor.name} into a loot cache.`);
            } else if (updates.length > 0) {
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

    /**
     * Detects whether a PF2e item that already carries `latentMagic` still leaks
     * its original magical name or active runes and should be re-masked in-place.
     *
     * @param {Item|object} item
     * @param {object} qmFlags
     * @param {boolean} isPf2eFamily
     * @returns {boolean}
     */
    static _needsPf2eRemask(item, qmFlags, isPf2eFamily) {
        if (!isPf2eFamily) return false;
        const latent = qmFlags?.latentMagic;
        if (!latent || latent.promoted) return false;

        const runes = item.system?.runes;
        const hasActiveRunes = Boolean(
            runes && (
                Number(runes.potency) > 0
                || Number(runes.striking) > 0
                || Number(runes.resilient) > 0
                || Number(runes.reinforcing) > 0
                || (Array.isArray(runes.property) && runes.property.length > 0)
            )
        );
        if (hasActiveRunes) return true;

        const unidentifiedName = (item.system?.identification?.unidentified?.name ?? "").trim();
        if (!unidentifiedName) return false;

        const trueName = (
            latent.originalName
            || item.system?.identification?.identified?.name
            || item._source?.name
            || item.name
            || ""
        ).trim();
        if (!trueName) return false;

        const unidLower = unidentifiedName.toLowerCase();
        const trueLower = trueName.toLowerCase();
        const trueNoBonus = trueLower.replace(/^\s*\+[1-3]\s+/, "").trim();
        return unidLower === trueLower || unidLower === trueNoBonus;
    }

    /**
     * Reconstructs an item data snapshot with any previously stashed `latentMagic`
     * fields restored so re-masking or detection sees the true unmasked state.
     *
     * @param {Item|object} item
     * @param {object|null|undefined} latent
     * @returns {object}
     */
    static _buildUnmaskedItemSnapshot(item, latent) {
        const itemData = typeof item.toObject === "function" ? item.toObject() : foundry.utils.deepClone(item);
        itemData.system ??= {};

        const liveIdentifiedName = item.system?.identification?.identified?.name || item.name;
        if (latent?.originalName) {
            itemData.name = latent.originalName;
        } else if (liveIdentifiedName && (!itemData.name || liveIdentifiedName.length > itemData.name.length)) {
            itemData.name = liveIdentifiedName;
        }

        if (latent?.originalRarity) {
            itemData.system.traits ??= {};
            itemData.system.traits.rarity = latent.originalRarity;
        }
        if (Array.isArray(latent?.originalTraits) && latent.originalTraits.length) {
            itemData.system.traits ??= {};
            const current = Array.isArray(itemData.system.traits.value) ? itemData.system.traits.value : [];
            itemData.system.traits.value = [...new Set([...current, ...latent.originalTraits])];
        }
        if (latent?.originalPrice) {
            itemData.system.price = foundry.utils.deepClone(latent.originalPrice);
        }
        if (latent?.originalRunes) {
            itemData.system.runes = foundry.utils.deepClone(latent.originalRunes);
        }
        if (latent?.originalDescription !== undefined) {
            itemData.system.description ??= {};
            itemData.system.description.value = latent.originalDescription;
        }
        if (latent?.originalImg) {
            itemData.img = latent.originalImg;
        }
        return itemData;
    }

    /**
     * Wraps an unmasked snapshot as an item-like object for `adapter.buildMaskUpdate`.
     * @param {Item|object} item
     * @param {object} itemData
     * @returns {object}
     */
    static _wrapItemForRemask(item, itemData) {
        return {
            id: item.id ?? itemData._id,
            _id: item.id ?? itemData._id,
            name: itemData.name,
            type: itemData.type,
            img: itemData.img,
            system: itemData.system,
            flags: itemData.flags,
            toObject: () => foundry.utils.deepClone(itemData)
        };
    }
}
