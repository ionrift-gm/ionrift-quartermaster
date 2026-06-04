/**
 * CursedItemResolver - Single authoritative service for cursed item
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
     *   1. flags[QM_ID].latentMagic.originalName  - set by CurseForge (gmName ?? match)
     *   2. flags[QM_ID].cursedMeta.lureName        - explicit recipe lure name
     *   3. flags[QM_ID].cursedMeta.lure.name       - nested lure object name
     *   4. doc._source?.name                       - raw stored name, bypasses dnd5e getter
     *   5. doc.name                                - last resort (may be 'Unidentified X')
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
     * Never use getIndex() for name-resolution purposes - Foundry V14
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
     * Also populates a secondary `_byDocId` map on the returned Map so that
     * callers can fall back to docId-based matching when stored UUIDs reference
     * a pack that has been destroyed and recreated (new document IDs).
     *
     * @param {string} packId - The full pack ID
     * @returns {Promise<Map<string, string>>} Map of UUID → resolved display name
     *   with `_byDocId: Map<string, string>` secondary index.
     */
    static async buildNameMap(packId) {
        const map = new Map();
        map._byDocId = new Map();
        const docs = await CursedItemResolver.loadPackDocuments(packId);
        const pack = game.packs.get(packId);
        if (!pack) return map;

        for (const doc of docs) {
            const name = CursedItemResolver.resolveDisplayName(doc);
            const uuid = `Compendium.${pack.collection}.Item.${doc.id}`;
            map.set(uuid, name);
            map._byDocId.set(doc.id, name);
        }
        return map;
    }

    /**
     * Resolve a display name from the name map, falling back to docId matching
     * when the full UUID doesn't match (orphaned after pack recompilation).
     *
     * @param {Map<string, string>} nameMap - Result of buildForgedNameMap()
     * @param {string} uuid - Stored entry UUID to look up
     * @returns {string|undefined} Resolved name, or undefined if not found.
     */
    static resolveFromMap(nameMap, uuid) {
        if (!nameMap || !uuid) return undefined;
        const direct = nameMap.get(uuid);
        if (direct) return direct;
        // Fallback: extract docId from the UUID and try the secondary index
        const docId = uuid.split(".").pop();
        return docId ? nameMap._byDocId?.get(docId) : undefined;
    }

    /**
     * Build a UUID→name map from the "forged" world pack.
     * Tries "world.ionrift-cursewright-forged", then "world.ionrift-forged-cursed".
     *
     * Also includes entries from the shipped compendium
     * ("ionrift-cursewright.cursewright-items") because pool entries may reference
     * either UUID domain depending on how they were seeded.
     *
     * @returns {Promise<Map<string, string>>} Map of UUID → resolved display name
     */
    static async buildForgedNameMap() {
        const map = new Map();
        map._byDocId = new Map();

        // 1. Forged world pack (custom compiled items)
        const forgedPack = game.packs.get("world.ionrift-cursewright-forged")
                        ?? game.packs.get("world.ionrift-forged-cursed");
        if (forgedPack) {
            const forgedMap = await CursedItemResolver.buildNameMap(forgedPack.collection);
            for (const [k, v] of forgedMap) map.set(k, v);
            for (const [k, v] of forgedMap._byDocId ?? []) map._byDocId.set(k, v);
        }

        // 2. Shipped compendium (pool entries may reference these UUIDs)
        const shippedPack = game.packs.get("ionrift-cursewright.cursewright-items");
        if (shippedPack) {
            const shippedMap = await CursedItemResolver.buildNameMap(shippedPack.collection);
            for (const [k, v] of shippedMap) {
                if (!map.has(k)) map.set(k, v);
            }
            for (const [k, v] of shippedMap._byDocId ?? []) {
                if (!map._byDocId.has(k)) map._byDocId.set(k, v);
            }
        }

        return map;
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
