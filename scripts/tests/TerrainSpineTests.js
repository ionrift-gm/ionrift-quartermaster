/**
 * TerrainSpineTests - Guards QM's terrain registry under strict sovereignty.
 *
 * Contract:
 *   - QM never reads other modules' registries at runtime.
 *   - QM seeds its picker from `game.ionrift.library.terrains.getBase()` only.
 *   - QM may extend the picker with terrains it ships locally via terrain-qm.json.
 *   - Every entry returned by getTerrainList() carries id, label, and category.
 */
export async function runTerrainSpineTests() {
    const results = [];
    const pass = (name) => results.push({ name, status: "pass", message: "ok" });
    const fail = (name, msg) => results.push({ name, status: "fail", message: msg });

    const { TerrainDataRegistry } = await import("../services/TerrainDataRegistry.js");

    // ── Kernel base is present ─────────────────────────────────────

    try {
        const lib = game.ionrift?.library?.terrains;
        if (!lib?.getBase) {
            fail("kernel-base-available", "library.terrains.getBase() not available");
        } else {
            const baseIds = new Set(lib.getBase().map(t => t.id));
            const listIds = new Set(TerrainDataRegistry.getTerrainList().map(t => t.id));
            const missing = [...baseIds].filter(id => !listIds.has(id));
            if (missing.length === 0) pass("kernel-base-available");
            else fail("kernel-base-available",
                `Kernel base terrains missing from QM list: ${missing.join(", ")}`);
        }
    } catch (e) { fail("kernel-base-available", e.message); }

    // ── List shape ─────────────────────────────────────────────────

    try {
        const list = TerrainDataRegistry.getTerrainList();
        const broken = list.filter(t => !t.id || !t.label || !t.category);
        if (broken.length === 0) pass("list-entries-have-shape");
        else fail("list-entries-have-shape",
            `Entries missing id/label/category: ${broken.map(t => t.id ?? "<no id>").join(", ")}`);
    } catch (e) { fail("list-entries-have-shape", e.message); }

    try {
        const list = TerrainDataRegistry.getTerrainList();
        if (list.length >= 5) pass("list-not-empty");
        else fail("list-not-empty",
            `getTerrainList() returned ${list.length} terrains. Expected ≥5 (kernel base).`);
    } catch (e) { fail("list-not-empty", e.message); }

    // ── Module-shipped extensions surface correctly ────────────────

    // If QM has loaded a non-base terrain (e.g. arctic, ruins) from
    // terrain-qm.json, it should appear in getTerrainList() with its declared
    // label and category. Don't hardcode terrain ids - derive from local data.
    try {
        const lib = game.ionrift?.library?.terrains;
        const baseIds = new Set((lib?.getBase?.() ?? []).map(t => t.id));
        const localExtras = TerrainDataRegistry.getAll()
            .filter(t => !baseIds.has(t.id));
        const listIds = new Set(TerrainDataRegistry.getTerrainList().map(t => t.id));
        const missing = localExtras
            .filter(t => !listIds.has(t.id))
            .map(t => t.id);
        if (missing.length === 0) pass("local-terrains-surface");
        else fail("local-terrains-surface",
            `QM-shipped terrains absent from picker list: ${missing.join(", ")}`);
    } catch (e) { fail("local-terrains-surface", e.message); }

    // ── No accidental dependence on Respite ────────────────────────

    // QM's getTerrainList() must not reflect terrains that exist only because
    // Respite registered them into the shared spine. Under strict sovereignty
    // QM should never read the spine's full getAll(), only its base.
    try {
        const lib = game.ionrift?.library?.terrains;
        const baseIds = new Set((lib?.getBase?.() ?? []).map(t => t.id));
        const allSpineIds = new Set((lib?.getAll?.() ?? []).map(t => t.id));
        const respiteAdditions = [...allSpineIds].filter(id => !baseIds.has(id));
        const localIds = new Set(TerrainDataRegistry.getAll().map(t => t.id));
        const listIds = new Set(TerrainDataRegistry.getTerrainList().map(t => t.id));
        const leaked = respiteAdditions.filter(id => listIds.has(id) && !localIds.has(id));
        if (leaked.length === 0) pass("no-cross-module-leak");
        else fail("no-cross-module-leak",
            `QM picker shows terrains it does not ship: ${leaked.join(", ")}`);
    } catch (e) { fail("no-cross-module-leak", e.message); }

    const passed = results.filter(r => r.status === "pass").length;
    const failed = results.filter(r => r.status === "fail").length;
    return { passed, failed, total: results.length, skipped: false, results };
}
