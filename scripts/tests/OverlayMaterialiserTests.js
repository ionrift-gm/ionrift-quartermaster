/**
 * OverlayMaterialiserTests - Guards OverlayItemMaterialiser's recursive item
 * walker against the "silent empty pack" regression.
 *
 * Background:
 *   Some QM overlays nest items by terrain (e.g. items/containers/catacombs/
 *   *.json and items/containers/ruins/*.json) while others ship a flat
 *   structure (items/containers/*.json). A previous one-level walker only
 *   enumerated files at items/{packDir}/*.json and silently produced no
 *   compendium when every packDir contained only subdirectories. That
 *   manifested as "B&D pack toggled on but no Quartermaster: Bone & Dust
 *   compendium appeared" with no error in the console.
 *
 * Contract:
 *   - _collectItemsRecursive must walk nested directories.
 *   - It must skip _folders.json files (those are loaded separately).
 *   - It must skip directories starting with "." (dotfiles / metadata).
 *   - It must return parsed item objects in any encounter order.
 *
 * The walker accepts an injected `overlay` dependency so the test can run
 * without touching the live filesystem.
 */

export async function runOverlayMaterialiserTests() {
    const results = [];
    const pass = (name, message = "ok") => results.push({ name, status: "pass", message });
    const fail = (name, msg) => results.push({ name, status: "fail", message: msg });

    let OverlayItemMaterialiser;
    try {
        ({ OverlayItemMaterialiser } = await import("../services/OverlayItemMaterialiser.js"));
    } catch (e) {
        fail("materialiser-importable", e.message);
        return finalise(results);
    }

    /**
     * Build an in-memory overlay stub. `tree` maps relative paths to file
     * contents (JSON objects). Directory listings are derived from the tree.
     */
    const buildFakeOverlay = (tree) => {
        const norm = (p) => p.replace(/^\/+|\/+$/g, "");
        const allPaths = Object.keys(tree).map(norm);

        return {
            listOverlayDir: async (_moduleId, _sublayer, subDir) => {
                const base = norm(subDir);
                const prefix = base ? `${base}/` : "";
                const direct = new Set();
                const subdirs = new Set();
                for (const p of allPaths) {
                    if (!p.startsWith(prefix)) continue;
                    const rest = p.slice(prefix.length);
                    if (!rest) continue;
                    const slash = rest.indexOf("/");
                    if (slash === -1) direct.add(rest);
                    else subdirs.add(rest.slice(0, slash));
                }
                return { files: [...direct], dirs: [...subdirs] };
            },
            readOverlayFile: async (_moduleId, _sublayer, path) => {
                return tree[norm(path)] ?? null;
            }
        };
    };

    // ── 1. Flat layout (Core / F&S shape) ─────────────────────────────
    try {
        const flat = buildFakeOverlay({
            "items/containers/_folders.json": [],
            "items/containers/sealed-bark-cylinder.json": { name: "Sealed Bark Cylinder" },
            "items/containers/reed-bundle-wrap.json":     { name: "Reed Bundle Wrap" }
        });
        const items = await OverlayItemMaterialiser._collectItemsRecursive(
            "core", "items/containers", { overlay: flat, moduleId: "ionrift-quartermaster" }
        );
        const names = items.map(i => i.name).sort();
        if (names.length === 2 && names[0] === "Reed Bundle Wrap" && names[1] === "Sealed Bark Cylinder") {
            pass("flat-layout-collects-items");
        } else {
            fail("flat-layout-collects-items", `expected 2 items, got ${names.length}: ${names.join(", ")}`);
        }
    } catch (e) { fail("flat-layout-collects-items", e.message); }

    // ── 2. Nested terrain layout (B&D shape) ──────────────────────────
    // The regression that motivated this suite: with all items nested in
    // terrain subfolders, the old walker returned zero items.
    try {
        const nested = buildFakeOverlay({
            "items/containers/_folders.json":                       [{ _id: "fA", name: "Catacombs" }, { _id: "fB", name: "Ruins" }],
            "items/containers/catacombs/bone-ossuary-box.json":     { name: "Bone Ossuary Box",  folder: "fA" },
            "items/containers/catacombs/carved-sarcophagus.json":   { name: "Carved Sarcophagus", folder: "fA" },
            "items/containers/ruins/collapsed-wall-cavity.json":    { name: "Collapsed Wall Cavity", folder: "fB" },
            "items/containers/ruins/moss-covered-stone-chest.json": { name: "Moss-covered Stone Chest", folder: "fB" }
        });
        const items = await OverlayItemMaterialiser._collectItemsRecursive(
            "bone-dust", "items/containers", { overlay: nested, moduleId: "ionrift-quartermaster" }
        );
        if (items.length === 4) {
            pass("nested-terrain-layout-collects-all-items");
        } else {
            fail("nested-terrain-layout-collects-all-items",
                `expected 4 items, got ${items.length}: ${items.map(i => i.name).join(", ")}`);
        }
    } catch (e) { fail("nested-terrain-layout-collects-all-items", e.message); }

    // ── 3. Mixed layout (root items + nested subfolders) ──────────────
    // Future overlays may keep generic items at the root and put
    // terrain-specific variants in subfolders. Both should be picked up.
    try {
        const mixed = buildFakeOverlay({
            "items/containers/_folders.json":                  [{ _id: "fA", name: "Forest" }],
            "items/containers/generic-sack.json":              { name: "Generic Sack" },
            "items/containers/forest/woven-vine-chest.json":   { name: "Woven Vine Chest", folder: "fA" }
        });
        const items = await OverlayItemMaterialiser._collectItemsRecursive(
            "demo", "items/containers", { overlay: mixed, moduleId: "ionrift-quartermaster" }
        );
        const names = items.map(i => i.name).sort();
        if (names.length === 2 && names.includes("Generic Sack") && names.includes("Woven Vine Chest")) {
            pass("mixed-layout-collects-root-and-nested");
        } else {
            fail("mixed-layout-collects-root-and-nested",
                `expected Generic Sack + Woven Vine Chest, got: ${names.join(", ")}`);
        }
    } catch (e) { fail("mixed-layout-collects-root-and-nested", e.message); }

    // ── 4. _folders.json is excluded from item collection ────────────
    // The walker is explicitly responsible for items; folder definitions
    // are read separately. Treating _folders.json as an item would create
    // a phantom no-name document and break the chunked createDocuments call.
    try {
        const treeWithFolders = buildFakeOverlay({
            "items/treasure/_folders.json":         [{ _id: "fA", name: "Catacombs" }],
            "items/treasure/catacombs/_folders.json": [],
            "items/treasure/catacombs/jade-burial-amulet.json": { name: "Jade Burial Amulet" }
        });
        const items = await OverlayItemMaterialiser._collectItemsRecursive(
            "bone-dust", "items/treasure", { overlay: treeWithFolders, moduleId: "ionrift-quartermaster" }
        );
        if (items.length === 1 && items[0].name === "Jade Burial Amulet") {
            pass("folders-file-excluded-from-items");
        } else {
            fail("folders-file-excluded-from-items",
                `expected 1 item (Jade Burial Amulet), got ${items.length}: ${items.map(i => i.name).join(", ")}`);
        }
    } catch (e) { fail("folders-file-excluded-from-items", e.message); }

    // ── 5. Dot-prefixed directories are skipped ──────────────────────
    // Sidecar metadata (._tmp, .cache, etc.) must not be walked.
    try {
        const treeWithDots = buildFakeOverlay({
            "items/gems/jade-piece.json":             { name: "Jade Piece" },
            "items/gems/.tmp/should-not-appear.json": { name: "Ghost Item" }
        });
        const items = await OverlayItemMaterialiser._collectItemsRecursive(
            "core", "items/gems", { overlay: treeWithDots, moduleId: "ionrift-quartermaster" }
        );
        if (items.length === 1 && items[0].name === "Jade Piece") {
            pass("dot-prefixed-dirs-skipped");
        } else {
            fail("dot-prefixed-dirs-skipped",
                `expected 1 item (Jade Piece), got: ${items.map(i => i.name).join(", ")}`);
        }
    } catch (e) { fail("dot-prefixed-dirs-skipped", e.message); }

    // ── 6. Items without a name are dropped ──────────────────────────
    // Foundry rejects items with no name and the chunked create would fail
    // partway through. The walker filters them out preemptively.
    try {
        const treeWithBlanks = buildFakeOverlay({
            "items/trinkets/ok.json":      { name: "Trinket A" },
            "items/trinkets/blank.json":   { name: "" },
            "items/trinkets/missing.json": { type: "item" }
        });
        const items = await OverlayItemMaterialiser._collectItemsRecursive(
            "core", "items/trinkets", { overlay: treeWithBlanks, moduleId: "ionrift-quartermaster" }
        );
        if (items.length === 1 && items[0].name === "Trinket A") {
            pass("nameless-items-dropped");
        } else {
            fail("nameless-items-dropped",
                `expected 1 item (Trinket A), got ${items.length}: ${items.map(i => i.name).join(", ")}`);
        }
    } catch (e) { fail("nameless-items-dropped", e.message); }

    // ── 7. Deeply nested directories (3+ levels) are walked ──────────
    // Guards against any future "we walk N levels deep" assumption.
    // No overlay author has needed depth 3 yet, but the contract is
    // "walk until you hit the leaves", not "walk one level".
    try {
        const deep = buildFakeOverlay({
            "items/treasure/region/sub-region/locality/buried-cache.json": { name: "Buried Cache" },
            "items/treasure/region/sub-region/surface-find.json":           { name: "Surface Find" }
        });
        const items = await OverlayItemMaterialiser._collectItemsRecursive(
            "demo", "items/treasure", { overlay: deep, moduleId: "ionrift-quartermaster" }
        );
        const names = items.map(i => i.name).sort();
        if (names.length === 2 && names.includes("Buried Cache") && names.includes("Surface Find")) {
            pass("deeply-nested-dirs-walked");
        } else {
            fail("deeply-nested-dirs-walked",
                `expected Buried Cache + Surface Find, got: ${names.join(", ")}`);
        }
    } catch (e) { fail("deeply-nested-dirs-walked", e.message); }

    // ── 8. Runtime guard: every installed sublayer has content ────────
    // The bug we just fixed was silent: install completed, manifest was
    // healthy, the world compendium simply did not exist. This live-world
    // check asserts that every materialised overlay carries at least one
    // item, so a future silent regression surfaces here instead of in
    // "where are my containers" support tickets.
    //
    // Skips cleanly when no QM overlays are installed (default world).
    try {
        const lib = game.ionrift?.library?.overlay;
        const sublayers = lib?.listInstalledSublayers
            ? await lib.listInstalledSublayers("ionrift-quartermaster")
            : [];

        if (!sublayers.length) {
            results.push({
                name: "every-installed-sublayer-has-materialised-pack",
                status: "pass",
                message: "Skipped: no QM overlays installed in this world."
            });
        } else {
            const broken = [];
            for (const sublayer of sublayers) {
                const manifest = await lib.getLocalManifest("ionrift-quartermaster", sublayer);
                if (!manifest?.overlayId) continue;
                const active = await lib.isOverlayActive(
                    manifest.overlayId, "ionrift-quartermaster", sublayer
                );
                if (!active) continue;
                const pack = game.packs.get(`world.quartermaster-${sublayer}`);
                const size = pack?.index?.size ?? 0;
                if (!pack || size === 0) {
                    broken.push(`${sublayer} (active, ${pack ? "pack exists but empty" : "no pack"})`);
                }
            }
            if (broken.length === 0) {
                pass("every-installed-sublayer-has-materialised-pack",
                    `checked ${sublayers.length} sublayer(s).`);
            } else {
                fail("every-installed-sublayer-has-materialised-pack",
                    `Silent materialisation failure: ${broken.join("; ")}.`);
            }
        }
    } catch (e) { fail("every-installed-sublayer-has-materialised-pack", e.message); }

    return finalise(results);
}

function finalise(results) {
    const passed = results.filter(r => r.status === "pass").length;
    const failed = results.filter(r => r.status === "fail").length;
    return { passed, failed, total: results.length, skipped: false, results };
}
