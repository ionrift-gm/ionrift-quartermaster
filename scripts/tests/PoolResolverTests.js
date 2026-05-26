/**
 * PoolResolverTests — Guards the cache generator's role-pack resolver.
 *
 * Contract:
 *   - The module-shipped role pack (e.g. ionrift-quartermaster.quartermaster-containers)
 *     is always returned by the resolver, regardless of `lootPoolSources`.
 *     This is canonical QM content. `lootPoolSources` is a third-party source
 *     list (dnd5e.items et al) consumed by ItemPoolResolver, plus a registry
 *     of materialised overlay packs that the GM can toggle. It must never
 *     gate QM's own bundled content.
 *
 *   - Materialised overlay packs (world.quartermaster-*) ARE gated by
 *     `lootPoolSources`. OverlayItemMaterialiser auto-registers them on
 *     install; the GM can disable individual overlay packs through the
 *     LootPoolConfigApp.
 *
 *   - The container pool index must contain at least one entry in a default
 *     world. A regression where this returned [] previously surfaced as
 *     "No container matched" in the Cache Generator with the compendium
 *     visibly populated.
 *
 * Tests temporarily mutate the `lootPoolSources` setting and restore the
 * original value in a finally block. They register through the kernel's
 * test harness so they run in the live world via the Forge Tests panel.
 */

const MODULE_ID = "ionrift-quartermaster";
const CONTAINERS_PACK_ID = `${MODULE_ID}.quartermaster-containers`;

export async function runPoolResolverTests() {
    const results = [];
    const pass = (name, message = "ok") => results.push({ name, status: "pass", message });
    const fail = (name, msg) => results.push({ name, status: "fail", message: msg });

    let originalLootPoolSources;
    try {
        originalLootPoolSources = game.settings.get(MODULE_ID, "lootPoolSources");
    } catch (e) {
        return {
            passed: 0,
            failed: 1,
            total: 1,
            skipped: false,
            results: [{ name: "settings-readable", status: "fail", message: e.message }]
        };
    }

    const { __testables__ } = await import("../services/CacheGenerator.js");
    const { resolveQmContainerPacks, loadContainerPoolIndex, readEnabledPackSources } = __testables__;

    const restore = async () => {
        try {
            await game.settings.set(MODULE_ID, "lootPoolSources", originalLootPoolSources);
        } catch (e) {
            results.push({
                name: "settings-restored",
                status: "fail",
                message: `Could not restore lootPoolSources: ${e.message}`
            });
        }
    };

    const setPoolSources = async (arr) => {
        await game.settings.set(MODULE_ID, "lootPoolSources", JSON.stringify(arr));
    };

    /**
     * Build a synthetic container pool entry shaped like the index that
     * loadContainerPoolIndex() produces. `source` is the materialised
     * `_sourceCollection` id; pass the bundled pack id to simulate a
     * baked-in container or any `world.quartermaster-*` id to simulate
     * an overlay-shipped one.
     */
    const BUNDLED_COLLECTION = CONTAINERS_PACK_ID;
    const makeContainerEntry = (terrains, source = BUNDLED_COLLECTION, name = `entry-${source}-${terrains.join("-")}`) => ({
        name,
        flags: {
            "ionrift-quartermaster": {
                containerMeta: { terrains, capacityLbs: 50 }
            }
        },
        _sourceCollection: source
    });

    const bundledPackPresent = !!game.packs.get(CONTAINERS_PACK_ID);

    try {
        // ── Bundled module pack present at all ────────────────────────
        try {
            if (bundledPackPresent) {
                pass("bundled-containers-pack-loaded",
                    `${CONTAINERS_PACK_ID} is available in game.packs`);
            } else {
                fail("bundled-containers-pack-loaded",
                    `${CONTAINERS_PACK_ID} not in game.packs. Module pack failed to load.`);
            }
        } catch (e) { fail("bundled-containers-pack-loaded", e.message); }

        if (!bundledPackPresent) {
            // Cannot exercise the resolver meaningfully without the pack.
            return finalise(results, restore);
        }

        // ── 1. Default lootPoolSources includes the bundled pack ──────
        // The current default value is ["dnd5e.items", "dnd5e.tradegoods",
        // "world.ionrift-forged-scrolls"]. This is the regression case:
        // a fresh world had this default, the previous resolver applied the
        // list as an allowlist, and the bundled container pack was excluded.
        try {
            await setPoolSources([
                "dnd5e.items",
                "dnd5e.tradegoods",
                "world.ionrift-forged-scrolls"
            ]);
            const packs = resolveQmContainerPacks();
            const ids = packs.map(p => p.collection);
            if (ids.includes(CONTAINERS_PACK_ID)) {
                pass("module-pack-survives-default-lootpoolsources",
                    `Resolver returned ${ids.length} pack(s) including the bundled pack.`);
            } else {
                fail("module-pack-survives-default-lootpoolsources",
                    `Resolver returned [${ids.join(", ") || "<empty>"}]. Bundled pack missing under default lootPoolSources. This is the regression that hid all bundled containers.`);
            }
        } catch (e) { fail("module-pack-survives-default-lootpoolsources", e.message); }

        // ── 2. Empty lootPoolSources still includes the bundled pack ──
        try {
            await setPoolSources([]);
            const packs = resolveQmContainerPacks();
            const ids = packs.map(p => p.collection);
            if (ids.includes(CONTAINERS_PACK_ID)) {
                pass("module-pack-survives-empty-lootpoolsources");
            } else {
                fail("module-pack-survives-empty-lootpoolsources",
                    `Resolver returned ${ids.length} pack(s); bundled pack absent with empty lootPoolSources.`);
            }
        } catch (e) { fail("module-pack-survives-empty-lootpoolsources", e.message); }

        // ── 3. Unparseable lootPoolSources still includes the bundled pack ──
        try {
            await game.settings.set(MODULE_ID, "lootPoolSources", "{not-json");
            const enabled = readEnabledPackSources();
            if (enabled !== null) {
                fail("unparseable-lootpoolsources-yields-null",
                    `readEnabledPackSources returned a Set instead of null for "{not-json".`);
            } else {
                pass("unparseable-lootpoolsources-yields-null");
            }
            const packs = resolveQmContainerPacks();
            const ids = packs.map(p => p.collection);
            if (ids.includes(CONTAINERS_PACK_ID)) {
                pass("module-pack-survives-unparseable-lootpoolsources");
            } else {
                fail("module-pack-survives-unparseable-lootpoolsources",
                    `Resolver returned ${ids.length} pack(s); bundled pack absent when lootPoolSources is unparseable.`);
            }
        } catch (e) { fail("module-pack-survives-unparseable-lootpoolsources", e.message); }

        // ── 4. Overlay packs are gated by lootPoolSources ─────────────
        // Find any world.quartermaster-* pack that happens to be installed.
        // If none are present (clean world without overlays), skip this
        // assertion rather than fail.
        try {
            const overlayPackCollections = [];
            for (const pack of game.packs) {
                if (pack.metadata?.type !== "Item") continue;
                const col = pack.collection;
                if (col?.startsWith("world.quartermaster-")) overlayPackCollections.push(col);
            }

            if (!overlayPackCollections.length) {
                results.push({
                    name: "overlay-packs-respect-lootpoolsources",
                    status: "skip",
                    message: "No world.quartermaster-* packs installed; cannot exercise overlay gating."
                });
            } else {
                const sample = overlayPackCollections[0];

                await setPoolSources([sample]);
                let packs = resolveQmContainerPacks();
                const includedWhenEnabled = packs.some(p => p.collection === sample);

                await setPoolSources([]);
                packs = resolveQmContainerPacks();
                const excludedWhenDisabled = !packs.some(p => p.collection === sample);

                if (includedWhenEnabled && excludedWhenDisabled) {
                    pass("overlay-packs-respect-lootpoolsources",
                        `Overlay pack ${sample} included when listed, excluded when removed.`);
                } else {
                    fail("overlay-packs-respect-lootpoolsources",
                        `Overlay gating asymmetric: includedWhenEnabled=${includedWhenEnabled}, excludedWhenDisabled=${excludedWhenDisabled}`);
                }
            }
        } catch (e) { fail("overlay-packs-respect-lootpoolsources", e.message); }

        // ── 5. Container pool index is non-empty in default world ─────
        // This is the user-visible regression test. If this fails, the cache
        // generator will show "No container matched" with the compendium
        // visibly populated.
        try {
            await setPoolSources([
                "dnd5e.items",
                "dnd5e.tradegoods",
                "world.ionrift-forged-scrolls"
            ]);
            const index = await loadContainerPoolIndex();
            if (Array.isArray(index) && index.length > 0) {
                pass("container-pool-index-not-empty",
                    `Loaded ${index.length} container entries under default lootPoolSources.`);
            } else {
                fail("container-pool-index-not-empty",
                    `loadContainerPoolIndex() returned ${index?.length ?? 0} entries under default lootPoolSources. Cache generator will show "No container matched".`);
            }
        } catch (e) { fail("container-pool-index-not-empty", e.message); }

        // ── 6. Terrain match accepts "any" universal tag ──────────────
        // The bundled fallback containers ship tagged ["any"]. They must be
        // valid candidates for every theme, not silently dropped by the
        // terrain filter.
        try {
            const { containerMatchesTerrain } = __testables__;
            const anyEntry = makeContainerEntry(["any"]);
            const forestEntry = makeContainerEntry(["forest"]);
            const both = makeContainerEntry(["forest", "swamp"]);
            const checks = [
                ["any-tagged matches forest theme",   containerMatchesTerrain(anyEntry, "forest")    === true],
                ["any-tagged matches catacombs theme", containerMatchesTerrain(anyEntry, "catacombs") === true],
                ["forest-tagged matches forest theme", containerMatchesTerrain(forestEntry, "forest") === true],
                ["forest-tagged misses swamp theme",   containerMatchesTerrain(forestEntry, "swamp")  === false],
                ["multi-tagged matches each named",    containerMatchesTerrain(both, "swamp")         === true]
            ];
            const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
            if (failed.length === 0) pass("terrain-match-accepts-any");
            else fail("terrain-match-accepts-any",
                `containerMatchesTerrain misclassifies: ${failed.join("; ")}`);
        } catch (e) { fail("terrain-match-accepts-any", e.message); }

        // ── 7. Blended pool mixes bundled with overlay-shipped ────────
        // When both bundled-module entries and overlay-shipped entries are
        // available for a theme, the blended pool must reach both sides
        // across many trials. Ratio is RNG-bound by CONTAINER_BUNDLED_BIAS;
        // we assert only that both sides are reachable.
        try {
            const { selectBlendedContainerPool, CONTAINER_BUNDLED_BIAS } = __testables__;
            const OVERLAY_COLLECTION = "world.quartermaster-bone-dust";
            const bundled1 = makeContainerEntry(["any"],    BUNDLED_COLLECTION, "bundled-uni-1");
            const bundled2 = makeContainerEntry(["forest"], BUNDLED_COLLECTION, "bundled-forest");
            const overlay1 = makeContainerEntry(["forest"], OVERLAY_COLLECTION, "overlay-forest-1");
            const overlay2 = makeContainerEntry(["forest"], OVERLAY_COLLECTION, "overlay-forest-2");
            const byTerrain = [bundled1, bundled2, overlay1, overlay2];

            let bundledHits = 0;
            let overlayHits = 0;
            const trials = 200;
            for (let i = 0; i < trials; i++) {
                const pool = selectBlendedContainerPool(byTerrain);
                const isAllBundled = pool.every(e => e._sourceCollection === BUNDLED_COLLECTION);
                const isAllOverlay = pool.every(e => e._sourceCollection === OVERLAY_COLLECTION);
                if (isAllBundled && pool.length === 2) bundledHits++;
                else if (isAllOverlay && pool.length === 2) overlayHits++;
            }
            // With 0.5 bias and 200 trials we expect ~100 each side; assert
            // both > 30 to allow for RNG slop without flake.
            if (bundledHits > 30 && overlayHits > 30) {
                pass("blended-pool-mixes-bundled-and-overlay",
                    `${trials} trials: bundled ${bundledHits}, overlay ${overlayHits} (bias ${CONTAINER_BUNDLED_BIAS}).`);
            } else {
                fail("blended-pool-mixes-bundled-and-overlay",
                    `${trials} trials produced bundled=${bundledHits}, overlay=${overlayHits}. Expected both > 30.`);
            }
        } catch (e) { fail("blended-pool-mixes-bundled-and-overlay", e.message); }

        // ── 8. Blended pool falls through when one side empty ─────────
        try {
            const { selectBlendedContainerPool } = __testables__;
            const bundled = makeContainerEntry(["forest"], BUNDLED_COLLECTION, "only-bundled");
            const overlay = makeContainerEntry(["forest"], "world.quartermaster-bone-dust", "only-overlay");

            const onlyBundledPool = selectBlendedContainerPool([bundled]);
            const onlyOverlayPool = selectBlendedContainerPool([overlay]);

            const bundledOk = onlyBundledPool.length === 1 && onlyBundledPool[0] === bundled;
            const overlayOk = onlyOverlayPool.length === 1 && onlyOverlayPool[0] === overlay;
            if (bundledOk && overlayOk) pass("blended-pool-falls-through-when-one-side-empty");
            else fail("blended-pool-falls-through-when-one-side-empty",
                `bundledOnly=${bundledOk}, overlayOnly=${overlayOk}`);
        } catch (e) { fail("blended-pool-falls-through-when-one-side-empty", e.message); }

        // ── 9. isBundledContainerEntry separates source compendiums ───
        try {
            const { isBundledContainerEntry } = __testables__;
            const bundled = makeContainerEntry(["any"], BUNDLED_COLLECTION, "b");
            const overlay = makeContainerEntry(["any"], "world.quartermaster-core", "o");
            const ok = isBundledContainerEntry(bundled) === true
                && isBundledContainerEntry(overlay) === false;
            if (ok) pass("bundled-entry-detection");
            else fail("bundled-entry-detection", "Source-compendium classifier misclassified an entry.");
        } catch (e) { fail("bundled-entry-detection", e.message); }

        // ── 10. Owner-theme filter treats missing ownerThemes as universal ─
        // Bundled containers ship with cacheTypes but no ownerThemes. When an
        // overlay container declares ownerThemes, the previous filter would
        // drop every bundled entry from the picker because they failed the
        // ownerTheme inclusion check. The current filter must treat a missing
        // or empty ownerThemes as a universal match.
        try {
            const { containerOwnerThemeMatches } = __testables__;
            const bundledNoOwner = {
                name: "bundled-legacy",
                flags: { "ionrift-quartermaster": { containerMeta: {
                    terrains: ["forest"],
                    cacheTypes: ["stash", "camp_supplies"]
                }}}
            };
            const overlayDeclared = {
                name: "overlay-arcana",
                flags: { "ionrift-quartermaster": { containerMeta: {
                    terrains: ["forest"],
                    ownerThemes: ["arcana", "armaments"]
                }}}
            };
            const overlayEmpty = {
                name: "overlay-empty-list",
                flags: { "ionrift-quartermaster": { containerMeta: {
                    terrains: ["forest"],
                    ownerThemes: []
                }}}
            };

            const checks = [
                ["bundled w/o ownerThemes matches arcana",     containerOwnerThemeMatches(bundledNoOwner, "arcana")     === true],
                ["bundled w/o ownerThemes matches unspecified", containerOwnerThemeMatches(bundledNoOwner, "unspecified") === true],
                ["overlay declared excludes mismatched theme",  containerOwnerThemeMatches(overlayDeclared, "apothecary") === false],
                ["overlay declared matches a listed theme",     containerOwnerThemeMatches(overlayDeclared, "arcana")     === true],
                ["overlay empty list treated as universal",     containerOwnerThemeMatches(overlayEmpty, "armaments")     === true]
            ];
            const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
            if (failed.length === 0) pass("owner-theme-missing-is-universal");
            else fail("owner-theme-missing-is-universal",
                `containerOwnerThemeMatches misclassifies: ${failed.join("; ")}`);
        } catch (e) { fail("owner-theme-missing-is-universal", e.message); }

        return finalise(results, restore);
    } catch (e) {
        fail("test-harness", `Unexpected harness error: ${e.message}`);
        return finalise(results, restore);
    }
}

async function finalise(results, restore) {
    await restore();
    const passed = results.filter(r => r.status === "pass").length;
    const failed = results.filter(r => r.status === "fail").length;
    return { passed, failed, total: results.length, skipped: false, results };
}
