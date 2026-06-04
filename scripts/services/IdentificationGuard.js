const MODULE_ID = "ionrift-quartermaster";
const FLAG_CURSED_META = "cursedMeta";
const FLAG_LATENT_MAGIC = "latentMagic";

/**
 * Blocks naive `system.identified` writes on actor-owned items when
 * `gmOnlyIdentification` is enabled. Routes GM wand clicks through
 * IdentificationService when a Quartermaster payload is pending.
 *
 * Must register on every connected client; preUpdateItem is local to
 * the client that initiates the update.
 */
export class IdentificationGuard {

    /** @type {boolean} */
    static _initialized = false;

    static init() {
        if (IdentificationGuard._initialized) return;
        IdentificationGuard._initialized = true;
        Hooks.on("preUpdateItem", IdentificationGuard.guardIdentify);
    }

    /**
     * @param {Item} item
     * @param {object} change
     * @param {object} options
     * @returns {boolean|void} Return false to cancel the update.
     */
    static guardIdentify(item, change, options /*, userId */) {
        if (!game.settings.get(MODULE_ID, "gmOnlyIdentification")) return;
        if (!foundry.utils.hasProperty(change, "system.identified")) return;
        if (options?.curseBypass) return;

        // World sidebar items (no parent actor): GMs prepare freely.
        if (!item?.parent) return;

        // Item Piles containers: transfer ops bundle identified side-effects.
        if (item.parent?.flags?.["item-piles"]?.data?.enabled) return;

        const meta     = item.getFlag?.(MODULE_ID, FLAG_CURSED_META);
        const latent   = item.getFlag?.(MODULE_ID, FLAG_LATENT_MAGIC);
        const infected = item.getFlag?.(MODULE_ID, "infectedCount") ?? 0;

        const hasLatentOrInfected = !!(latent && !latent.promoted) || infected > 0;
        const isIPNormalisationPass = hasLatentOrInfected && change?.system?.quantity !== undefined;
        if (isIPNormalisationPass) {
            delete change.system.identified;
            if (change.system && Object.keys(change.system).length === 0) delete change.system;
            if (!change.system && !change.name && !change.img && !change.flags) return false;
            return;
        }

        if (game.user.isGM) {
            const hasPendingPayload = !!(latent || meta);
            if (hasPendingPayload) {
                Promise.resolve().then(() =>
                    game.ionrift?.quartermaster?.identificationService?.identify(item)
                );
                return false;
            }
            return;
        }

        return false;
    }
}
