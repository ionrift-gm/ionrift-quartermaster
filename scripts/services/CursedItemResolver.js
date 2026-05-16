/**
 * CursedItemResolver — Single authoritative service for cursed item
 * name resolution and pack document loading.
 *
 * Context: Foundry V14 + dnd5e applies a name getter to Item documents
 * (and index entries) that returns "Unidentified [type]" when
 * system.identified is false. This service centralises the bypass so
 * every call-site resolves the real GM-facing identity consistently.
 *
 * Previously this resolution chain was duplicated across 8 independent
 * sites in CurseRegistry, CacheGeneratorApp, SignatureLedgerApp,
 * StandalonePoolRegistry, and CursedImportApp. See refactor_plan.md §2.
 *
 * @module CursedItemResolver
 */

const QM_ID = "ionrift-quartermaster";

export class CursedItemResolver {

    /**
     * Canonical GM-facing display name from a document, index entry,
     * or raw data object.
     *
     * Priority:
     *   1. flags[QM_ID].latentMagic.originalName  — set by CurseForge (gmName ?? match)
     *   2. flags[QM_ID].cursedMeta.lureName        — explicit recipe lure name
     *   3. flags[QM_ID].cursedMeta.lure.name       — nested lure object name
     *   4. doc._source?.name                       — raw stored name, bypasses dnd5e getter
     *   5. doc.name                                — last resort (may be 'Unidentified X')
     *
     * @param {object} docOrData - A full Foundry Item document, an index entry,
     *   or a plain data object with `.flags` and `.name` properties.
     * @returns {string} The resolved display name.
     */
    static resolveDisplayName(docOrData) {
        const qmFlags = docOrData?.flags?.[QM_ID] ?? {};
        const meta    = qmFlags.cursedMeta ?? {};
        return qmFlags.latentMagic?.originalName
            ?? meta.lureName
            ?? meta.lure?.name
            ?? docOrData?._source?.name
            ?? docOrData?.name
            ?? "Unknown";
    }

    /**
     * Load full documents from a compendium pack.
     *
     * Never use getIndex() for name-resolution purposes — Foundry V14
     * applies dnd5e's name getter to index entries, so items with
     * system.identified=false return "Unidentified Consumable" as
     * entry.name, and custom nested flags are unreliably populated.
     *
     * @param {string} packId - The full pack ID (e.g. "ionrift-cursewright.cursewright-items")
     * @returns {Promise<Item[]>} Full document array, or empty array on failure.
     */
    static async loadPackDocuments(packId) {
        try {
            const pack = game.packs.get(packId);
            if (!pack) return [];
            return await pack.getDocuments();
        } catch {
            return [];
        }
    }

    /**
     * Build a UUID→name map for all documents in a pack.
     * Uses loadPackDocuments + resolveDisplayName.
     *
     * @param {string} packId - The full pack ID
     * @returns {Promise<Map<string, string>>} Map of UUID → resolved display name
     */
    static async buildNameMap(packId) {
        const map = new Map();
        const docs = await CursedItemResolver.loadPackDocuments(packId);
        const pack = game.packs.get(packId);
        if (!pack) return map;

        for (const doc of docs) {
            const uuid = `Compendium.${pack.collection}.Item.${doc.id}`;
            map.set(uuid, CursedItemResolver.resolveDisplayName(doc));
        }
        return map;
    }

    /**
     * Build a UUID→name map from the "forged" world pack.
     * Tries "world.ionrift-cursewright-forged", then "world.ionrift-forged-cursed".
     *
     * @returns {Promise<Map<string, string>>} Map of UUID → resolved display name
     */
    static async buildForgedNameMap() {
        const forgedPack = game.packs.get("world.ionrift-cursewright-forged")
                        ?? game.packs.get("world.ionrift-forged-cursed");
        if (!forgedPack) return new Map();
        return CursedItemResolver.buildNameMap(forgedPack.collection);
    }

    /**
     * Force identified:true on item data that has cursedMeta or forgedFrom flags.
     * Mutates the data object in-place and returns it for chaining.
     *
     * Context: CurseForge items ship with system.identified=false so they
     * masquerade in the compendium. When pulled into the cache generator
     * preview or transferred to actors, the identified flag must be forced
     * to true so dnd5e displays the lure name.
     *
     * @param {object} data - Item data object (mutated in-place)
     * @returns {object} The same data object, for chaining.
     */
    static ensureIdentified(data) {
        if (data?.system?.identified === false) {
            data.system = { ...data.system, identified: true };
        }
        return data;
    }
}
