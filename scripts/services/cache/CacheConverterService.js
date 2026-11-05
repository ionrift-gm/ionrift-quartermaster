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
        const piles = game.itempiles?.API;
        if (piles && (piles.isItemPileContainer?.(token ?? actor) || piles.isItemPile?.(actor ?? token))) return true;

        // 2. System container / loot actor types
        if (type === "loot" || type === "container") return true;

        // 3. Tripwire containers or locks
        const doc = token?.document ?? token;
        const twFlags = doc?.flags?.["ionrift-tripwire"];
        if (twFlags?.cache || twFlags?.secret || twFlags?.lock) return true;

        // 4. Explicit Quartermaster container archetype flag
        const arch = actor.getFlag?.(MODULE_ID, "containerArchetype")
            ?? actor.flags?.[MODULE_ID]?.containerArchetype
            ?? doc?.getFlag?.(MODULE_ID, "containerArchetype")
            ?? doc?.flags?.[MODULE_ID]?.containerArchetype;
        if (arch) return true;

        // Never target non-container sheet types, or player-owned non-NPC actors
        if (["character", "familiar", "party", "vehicle", "hazard"].includes(type)) {
            return false;
        }
        if (actor.hasPlayerOwner && type !== "npc" && type !== "monster") {
            return false;
        }

        // Systems with native loot/container actor types (e.g. PF2e/SF2e) use those types for containers;
        // do not treat NPC/creature statblocks as containers unless explicitly flagged above.
        const availableActorTypes = Object.keys(game.system?.documentTypes?.Actor ?? {})
            .concat(Array.isArray(globalThis.Actor?.TYPES) ? globalThis.Actor.TYPES : []);
        const hasNativeContainerActorType = availableActorTypes.some(t => t === "loot" || t === "container");
        if (hasNativeContainerActorType && (type === "npc" || type === "monster")) {
            return false;
        }

        // 5. Fallback for systems without a dedicated loot actor type (e.g. dnd5e adventure containers):
        // match whole-word container nouns only on non-combatant container shells.
        const nameTarget = (actor.name || token?.name || "").trim();
        const containerNounRe = /\b(chest|cache|crate|barrel|recess|storeroom|pile|loot|trove|urn|vault|coffer|box|sack)\b/i;
        if (containerNounRe.test(nameTarget)) return true;

        return false;
    }

    /**
     * Determines whether an actor or token is a non-player creature eligible for
     * automatic corpse mystification upon death.
     * Never targets PCs, familiars, companions, summons, hazards, vehicles, or containers.
     *
     * @param {Actor|Token|TokenDocument|string} target
     * @returns {boolean}
     */
    static isEligibleCorpseActor(target) {
        const { actor, token } = CacheConverterService.resolveTarget(target);
        if (!actor) return false;

        const type = (actor.type || "").toLowerCase();
        if (["character", "pc", "familiar", "party", "vehicle", "hazard", "loot", "container", "group", "army"].includes(type)) {
            return false;
        }
        if (actor.hasPlayerOwner) return false;

        // Exclude Quartermaster caches, Item Piles, and container shells
        if (actor.flags?.[MODULE_ID]?.isQuartermasterCache) return false;
        if (actor.flags?.["item-piles"]?.data?.enabled) return false;
        const piles = game.itempiles?.API;
        if (piles && (piles.isItemPileContainer?.(token ?? actor) || piles.isItemPile?.(actor ?? token))) return false;

        const doc = token?.document ?? token;
        const twFlags = doc?.flags?.["ionrift-tripwire"];
        if (twFlags?.cache || twFlags?.secret || twFlags?.lock) return false;
        if (actor.flags?.[MODULE_ID]?.containerArchetype || doc?.flags?.[MODULE_ID]?.containerArchetype) return false;

        // Exclude summoned creatures and eidolons
        if (actor.flags?.["ionrift-summoning"]?.isSummoned || doc?.flags?.["ionrift-summoning"]?.isSummoned) return false;
        const traits = actor.system?.traits?.value ?? [];
        if (Array.isArray(traits) && traits.some(t => String(t).toLowerCase() === "summoned" || String(t).toLowerCase() === "eidolon")) {
            return false;
        }

        if (CacheConverterService.isConvertibleContainer(target)) return false;

        return type === "npc" || type === "monster" || type === "creature" || Boolean(actor.system?.attributes?.hp || actor.system?.hp);
    }

    /**
     * Checks whether automatic corpse mystification on creature death is enabled.
     * @returns {boolean}
     */
    static isAutoMystifyOnDeathEnabled() {
        if (!game.user?.isGM) return false;
        const adapter = getQuartermasterAdapter();
        if (!adapter?.supports(QM_FEATURES.LATENT_MASKING)) return false;
        try {
            const val = game.settings?.get?.(MODULE_ID, "autoMystifyOnDeath");
            return val ?? true;
        } catch {
            return true;
        }
    }

    /**
     * Checks whether an embedded item is a physical inventory item (as opposed to
     * an innate spell, feat, action, condition, or natural strike).
     * @param {Item|object} item
     * @returns {boolean}
     */
    static _isPhysicalInventoryItem(item) {
        if (!item) return false;
        const type = (item.type || "").toLowerCase();
        const nonPhysicalTypes = new Set([
            "spell", "spellcastingentry", "feat", "feature", "action", "melee", "ranged",
            "lore", "condition", "effect", "affliction", "ancestry", "heritage",
            "background", "class", "subclass", "race", "species", "deity", "facility",
            "campaignfeature", "ability", "power"
        ]);
        if (nonPhysicalTypes.has(type)) return false;

        if (type === "weapon") {
            const weaponSub = (item.system?.type?.value || item.system?.weaponType || "").toLowerCase();
            if (weaponSub === "natural") return false;
        }
        return true;
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
            ui.notifications?.warn?.(game.i18n.localize("ionrift-quartermaster.converter.warnGmOnlyConvert"));
            return null;
        }

        const { actor, token } = CacheConverterService.resolveTarget(target);
        if (!actor) {
            ui.notifications?.warn?.(game.i18n.localize("ionrift-quartermaster.converter.warnNoContainerActorToConvert"));
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
                ui.notifications?.info?.(game.i18n.format("ionrift-quartermaster.converter.notifyConvertedLootCache", { actor: actor.name }));
            } else if (updates.length > 0) {
                ui.notifications?.info?.(
                    updates.length === 1
                        ? game.i18n.format("ionrift-quartermaster.converter.notifyMystifiedItemOne", { actor: actor.name, count: updates.length })
                        : game.i18n.format("ionrift-quartermaster.converter.notifyMystifiedItemOther", { actor: actor.name, count: updates.length })
                );
            } else {
                ui.notifications?.info?.(game.i18n.format("ionrift-quartermaster.converter.notifyNoUnmaskedMagicalItems", { actor: actor.name }));
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
            ui.notifications?.warn?.(game.i18n.localize("ionrift-quartermaster.converter.warnGmOnlyIdentify"));
            return null;
        }

        const { actor } = CacheConverterService.resolveTarget(target);
        if (!actor) {
            ui.notifications?.warn?.(game.i18n.localize("ionrift-quartermaster.converter.warnNoContainerActor"));
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
                    identifiedCount === 1
                        ? game.i18n.format("ionrift-quartermaster.converter.notifyIdentifiedItemOne", { count: identifiedCount, actor: actor.name })
                        : game.i18n.format("ionrift-quartermaster.converter.notifyIdentifiedItemOther", { count: identifiedCount, actor: actor.name })
                );
            } else {
                ui.notifications?.info?.(game.i18n.format("ionrift-quartermaster.converter.notifyNoUnidentifiedItems", { actor: actor.name }));
            }
        }

        Logger.info(MODULE_LABEL, `Bulk identified ${actor.name} (${actor.id}): ${identifiedCount} items revealed.`);
        return identifiedCount;
    }

    /**
     * Mystifies carried magical gear, scrolls, and consumables on a fallen creature
     * in-place without converting the creature into a container actor or altering
     * its token disposition.
     *
     * @param {Actor|Token|TokenDocument|string} target
     * @param {object} [options]
     * @param {boolean} [options.silent=true]
     * @param {boolean} [options.force=false]
     * @returns {Promise<{ actor: Actor, token: Token|TokenDocument|null, count: number, items: Array }|null>}
     */
    static async mystifyCorpse(target, options = {}) {
        if (!game.user?.isGM) return null;

        const { actor, token } = CacheConverterService.resolveTarget(target);
        if (!actor || !CacheConverterService.isEligibleCorpseActor(target)) {
            return null;
        }

        const adapter = getQuartermasterAdapter();
        if (!adapter?.supports(QM_FEATURES.LATENT_MASKING)) {
            return null;
        }

        if (actor.flags?.[MODULE_ID]?.corpseMystified && !options.force) {
            return { actor, token, count: 0, items: [], alreadyMystified: true };
        }

        const items = actor.items?.contents ?? (actor.items ? Array.from(actor.items) : []);
        const isPf2eFamily = game.system?.id === "pf2e" || game.system?.id === "sf2e";
        const updates = [];
        const obscuredDetails = [];

        for (const item of items) {
            if (!CacheConverterService._isPhysicalInventoryItem(item)) continue;

            const qmFlags = item.flags?.[MODULE_ID] ?? {};
            if (qmFlags.cursedMeta?.lure) continue;

            const hasActiveLatent = Boolean(qmFlags.latentMagic && !qmFlags.latentMagic.promoted);
            if (hasActiveLatent && !CacheConverterService._needsPf2eRemask(item, qmFlags, isPf2eFamily)) {
                continue;
            }

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

        if (updates.length > 0) {
            await actor.updateEmbeddedDocuments("Item", updates);
        }

        const mystifiedIds = obscuredDetails.map(d => d.id);
        actor.flags ??= {};
        actor.flags[MODULE_ID] ??= {};
        actor.flags[MODULE_ID].corpseMystified = true;
        actor.flags[MODULE_ID].corpseMystifiedItemIds = mystifiedIds;
        if (typeof actor.setFlag === "function") {
            await actor.setFlag(MODULE_ID, "corpseMystified", true);
            await actor.setFlag(MODULE_ID, "corpseMystifiedItemIds", mystifiedIds);
        }

        if (options.silent === false && updates.length > 0) {
            ui.notifications?.info?.(
                updates.length === 1
                    ? game.i18n.format("ionrift-quartermaster.converter.notifyMystifiedItemOne", { actor: actor.name, count: updates.length })
                    : game.i18n.format("ionrift-quartermaster.converter.notifyMystifiedItemOther", { actor: actor.name, count: updates.length })
            );
        }

        Logger.info(MODULE_LABEL, `Mystified fallen creature ${actor.name} (${actor.id}): ${updates.length} items masked.`);

        return {
            actor,
            token,
            count: updates.length,
            items: obscuredDetails
        };
    }

    /**
     * Restores items that were automatically mystified when a creature fell to 0 HP
     * if the creature is subsequently healed or revived during play.
     *
     * @param {Actor|Token|TokenDocument|string} target
     * @returns {Promise<number|null>}
     */
    static async restoreRevivedCorpse(target) {
        if (!game.user?.isGM) return null;

        const { actor } = CacheConverterService.resolveTarget(target);
        if (!actor) return null;

        const qmFlags = actor.flags?.[MODULE_ID] ?? {};
        if (!qmFlags.corpseMystified) return 0;

        const trackedIds = new Set(Array.isArray(qmFlags.corpseMystifiedItemIds) ? qmFlags.corpseMystifiedItemIds : []);
        const items = actor.items?.contents ?? (actor.items ? Array.from(actor.items) : []);
        let restoredCount = 0;

        for (const item of items) {
            if (trackedIds.size > 0 && !trackedIds.has(item.id)) continue;
            const latent = item.flags?.[MODULE_ID]?.latentMagic;
            if (latent && !latent.promoted) {
                const res = await IdentificationService.identify(item, { silent: true });
                if (res?.identified) restoredCount++;
            }
        }

        if (actor.flags?.[MODULE_ID]) {
            actor.flags[MODULE_ID].corpseMystified = false;
            actor.flags[MODULE_ID].corpseMystifiedItemIds = [];
        }
        if (typeof actor.setFlag === "function") {
            await actor.setFlag(MODULE_ID, "corpseMystified", false);
            await actor.setFlag(MODULE_ID, "corpseMystifiedItemIds", []);
        }

        Logger.info(MODULE_LABEL, `Restored revived creature ${actor.name} (${actor.id}): ${restoredCount} items unmasked.`);
        return restoredCount;
    }

    /**
     * Hook handler for `updateActor`. Mystifies fallen creatures when HP drops to 0 or below,
     * and restores mystified items if the creature is healed back above 0 HP.
     *
     * @param {Actor} actor
     * @param {object} changes
     */
    static async handleActorDeathUpdate(actor, changes) {
        if (!game.user?.isGM) return;
        if (game.users?.activeGM && game.users.activeGM.id !== game.user.id) return;
        if (!CacheConverterService.isAutoMystifyOnDeathEnabled()) return;
        if (!CacheConverterService.isEligibleCorpseActor(actor)) return;

        const rawHpChange = foundry.utils.getProperty(changes, "system.attributes.hp.value")
            ?? foundry.utils.getProperty(changes, "system.hp.value");
        if (rawHpChange === undefined || rawHpChange === null) return;

        const hp = Number(rawHpChange);
        if (!Number.isFinite(hp)) return;

        if (hp <= 0) {
            if (!actor.flags?.[MODULE_ID]?.corpseMystified) {
                await CacheConverterService.mystifyCorpse(actor, { silent: true });
            }
        } else if (actor.flags?.[MODULE_ID]?.corpseMystified) {
            await CacheConverterService.restoreRevivedCorpse(actor);
        }
    }

    /**
     * Hook handler for `updateCombatant`. Mystifies fallen creatures when marked defeated
     * in the combat tracker.
     *
     * @param {Combatant} combatant
     * @param {object} changes
     */
    static async handleCombatantUpdate(combatant, changes) {
        if (!game.user?.isGM) return;
        if (game.users?.activeGM && game.users.activeGM.id !== game.user.id) return;
        if (!CacheConverterService.isAutoMystifyOnDeathEnabled()) return;
        if (changes?.defeated === undefined) return;

        const actor = combatant?.actor ?? combatant?.token?.actor ?? null;
        if (!actor || !CacheConverterService.isEligibleCorpseActor(actor)) return;

        if (changes.defeated === true) {
            if (!actor.flags?.[MODULE_ID]?.corpseMystified) {
                await CacheConverterService.mystifyCorpse(actor, { silent: true });
            }
        } else if (changes.defeated === false && actor.flags?.[MODULE_ID]?.corpseMystified) {
            const currentHp = Number(actor.system?.attributes?.hp?.value ?? actor.system?.hp?.value ?? 1);
            if (currentHp > 0) {
                await CacheConverterService.restoreRevivedCorpse(actor);
            }
        }
    }

    /**
     * Hook handler for `createItem` and `createActiveEffect`. Mystifies fallen creatures
     * when a `dead` condition or status effect is applied directly.
     *
     * @param {Item|ActiveEffect} doc
     */
    static async handleDeathStatusOrCondition(doc) {
        if (!game.user?.isGM) return;
        if (game.users?.activeGM && game.users.activeGM.id !== game.user.id) return;
        if (!CacheConverterService.isAutoMystifyOnDeathEnabled()) return;

        const actor = doc?.parent;
        if (!actor || actor.documentName !== "Actor" || !CacheConverterService.isEligibleCorpseActor(actor)) return;
        if (actor.flags?.[MODULE_ID]?.corpseMystified) return;

        const isDeadCondition = doc.type === "condition" && (
            (doc.system?.slug || doc.slug || "").toLowerCase() === "dead"
            || (doc.name || "").trim().toLowerCase() === "dead"
        );
        const isDeadEffect = (doc.statuses instanceof Set && doc.statuses.has("dead"))
            || (Array.isArray(doc.statuses) && doc.statuses.includes("dead"))
            || doc.flags?.core?.statusId === "dead";

        if (isDeadCondition || isDeadEffect) {
            await CacheConverterService.mystifyCorpse(actor, { silent: true });
        }
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
