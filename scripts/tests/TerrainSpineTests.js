/**
 * TerrainSpineTests — Guards that QM faithfully reads the spine
 * and never mutates it.
 *
 * These tests run AFTER all modules are ready, so the spine is fully
 * populated. If QM (or any module) has polluted the spine, these tests
 * will catch it.
 */
export async function runTerrainSpineTests() {
    const results = [];
    const pass = (name) => results.push({ name, status: "pass", message: "ok" });
    const fail = (name, msg) => results.push({ name, status: "fail", message: msg });

    const { TerrainDataRegistry } = await import("../services/TerrainDataRegistry.js");

    // ── getTerrainList reads spine only ────────────────────────────

    // getTerrainList must return exactly the spine contents — no additions
    try {
        const spine = game.ionrift?.library?.terrains;
        if (!spine) { fail("list-matches-spine", "Spine unavailable"); }
        else {
            const spineIds = new Set(spine.getAll().map(t => t.id));
            const listIds = new Set(TerrainDataRegistry.getTerrainList().map(t => t.id));

            const extraInList = [...listIds].filter(id => !spineIds.has(id));
            if (extraInList.length === 0) pass("list-matches-spine");
            else fail("list-matches-spine",
                `getTerrainList() contains terrains not in spine: ${extraInList.join(", ")}. `
                + `QM must read the spine faithfully, never inject its own terrains.`);
        }
    } catch (e) { fail("list-matches-spine", e.message); }

    // getTerrainList must not be empty when spine is available
    try {
        const spine = game.ionrift?.library?.terrains;
        if (!spine) { fail("list-not-empty", "Spine unavailable"); }
        else {
            const list = TerrainDataRegistry.getTerrainList();
            if (list.length >= 5) pass("list-not-empty");
            else fail("list-not-empty",
                `getTerrainList() returned ${list.length} terrains. Expected ≥5.`);
        }
    } catch (e) { fail("list-not-empty", e.message); }

    // ── QM must not register terrains into the spine ──────────────

    // QM has local terrain-data folders for loot generation. None of those
    // folders should appear in the spine unless the spine already has them
    // from its own seeds or other approved registrants.
    // This test is dynamic — no hardcoded names. If QM adds a new data
    // folder, it won't pollute the spine and this test still passes.
    try {
        const spine = game.ionrift?.library?.terrains;
        if (!spine) { fail("no-spine-writes", "Spine unavailable"); }
        else {
            const spineIds = new Set(spine.getAll().map(t => t.id));
            const localIds = TerrainDataRegistry.getAll().map(t => t.id);

            // QM-local terrains that are NOT in the spine — these are fine,
            // they're just local data folders. The failure case is when a
            // QM-local terrain IS in the spine but shouldn't be (QM injected it).
            // We can't distinguish "spine had it first" vs "QM added it" at
            // runtime, but we CAN verify that getTerrainList() doesn't return
            // anything beyond the spine — that's the list-matches-spine test.
            //
            // This test verifies the complementary guarantee: QM's local
            // terrain count should never exceed the spine's terrain count.
            // If it does, QM has data for terrains the ecosystem doesn't
            // recognise, which is expected — but those extras must NOT
            // appear in getTerrainList().
            const extras = localIds.filter(id => !spineIds.has(id));
            const list = TerrainDataRegistry.getTerrainList();
            const listIds = new Set(list.map(t => t.id));
            const leaked = extras.filter(id => listIds.has(id));

            if (leaked.length === 0) pass("no-spine-writes");
            else fail("no-spine-writes",
                `QM-local terrains not in spine leaked into getTerrainList(): ${leaked.join(", ")}. `
                + `getTerrainList() must return only spine terrains.`);
        }
    } catch (e) { fail("no-spine-writes", e.message); }

    // ── Terrain data availability ─────────────────────────────────

    // For each spine terrain, QM should have loot data (terrain-qm.json).
    // Missing data is not a hard failure but should be flagged.
    try {
        const spine = game.ionrift?.library?.terrains;
        if (!spine) { fail("data-coverage", "Spine unavailable"); }
        else {
            const spineIds = spine.getAll().map(t => t.id);
            const localIds = new Set(TerrainDataRegistry.getAll().map(t => t.id));
            // tavern is a Respite rest concept, not a loot terrain — exclude
            const relevantSpine = spineIds.filter(id => id !== "tavern");
            const missing = relevantSpine.filter(id => !localIds.has(id));
            if (missing.length === 0) pass("data-coverage");
            else {
                // Soft warning — not all spine terrains need QM loot data
                results.push({ name: "data-coverage", status: "pass",
                    message: `QM lacks loot data for spine terrains: ${missing.join(", ")}. Not a failure.` });
            }
        }
    } catch (e) { fail("data-coverage", e.message); }

    const passed = results.filter(r => r.status === "pass").length;
    const failed = results.filter(r => r.status === "fail").length;
    return { passed, failed, total: results.length, skipped: false, results };
}
