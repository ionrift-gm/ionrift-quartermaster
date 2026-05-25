/**
 * validate-packs-local.mjs
 *
 * Simulates a clean CI build: compiles JSON sources into fresh LevelDB databases,
 * then opens them and verifies every expected entry is present. Run locally to
 * validate the release pipeline without needing a clean machine.
 *
 * Usage: node tools/validate-packs-local.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { ClassicLevel } from "classic-level";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.resolve(__dirname, "..");
const SHIPPING_PATH = path.join(MODULE_ROOT, "packs", "SHIPPING.json");
const SRC_ROOT = path.join(MODULE_ROOT, "packs", "src");
const STAGING = path.join(MODULE_ROOT, "packs", ".validation-staging");

// ── Expected pack contents ──────────────────────────────────────────────
const EXPECTED = {
    "quartermaster-containers": {
        minEntries: 16,  // 15 containers + 1 folder. Base pack ships multi-terrain workhorses only; single-terrain specialty and arctic/mountain ship via overlay.
        requiredKeys: [
            "!items!cad633fce7164c9f",   // Ancient Stone Coffer
            "!items!cac5a45974b8a96b",   // Battered Wooden Chest
            "!items!88bdd4175d86e72c",   // Carved Stone Box
            "!items!7ec84679167cdc90",   // Clay Burial Urn
            "!items!8f74223eda8fbb3d",   // Clay Sealed Urn
            "!items!92404d5855536ff3",   // Dwarven Tool Chest
            "!items!17dcc25742e2735c",   // Hollowed Tree Stump
            "!items!f02d7c531943fa21",   // Iron Lockbox
            "!items!9a27e1408d685a95",   // Old Adventurer's Pack
            "!items!89ad937677946cea",   // Reed Basket
            "!items!9085f6df4d29c628",   // Sailor's Waterproof Box
            "!items!c9933fcbbb24e2c0",   // Tarred Reed Bundle
            "!items!7510211eb4e4d0c6",   // Waxed Leather Satchel
            "!items!c1516a6b2e2a2719",   // Worn Leather Sack
            "!items!e54ba35535404b4d",   // Woven Bamboo Box
            "!folders!c9cb7fc62085af7d", // Containers folder
        ],
        requiredFlags: {
            // At least one container must have ionrift-quartermaster containerMeta for terrain routing
            containerMeta: (entries) => entries.some(
                ([, v]) => v?.flags?.["ionrift-quartermaster"]?.containerMeta !== undefined
            ),
        },
    },
};

// ── Bootstrap file checks ───────────────────────────────────────────────
const REQUIRED_BOOTSTRAP_FILES = ["CURRENT"];
const REQUIRED_BOOTSTRAP_PATTERNS = [/^MANIFEST-\d+$/];

let failures = 0;
let passes = 0;

function pass(msg) {
    passes++;
    console.log(`  ✅ ${msg}`);
}

function fail(msg) {
    failures++;
    console.error(`  ❌ ${msg}`);
}

async function main() {
    console.log("\n══════════════════════════════════════════════════════");
    console.log("  Pack Validation (simulated clean CI build)");
    console.log("══════════════════════════════════════════════════════\n");

    // Clean staging area
    if (fs.existsSync(STAGING)) {
        fs.rmSync(STAGING, { recursive: true, force: true });
    }
    fs.mkdirSync(STAGING, { recursive: true });

    // Load shipping manifest
    const shipping = JSON.parse(fs.readFileSync(SHIPPING_PATH, "utf8"));
    const approvedPacks = Object.entries(shipping.packs || {})
        .filter(([, entry]) => entry?.status === "approved")
        .map(([name]) => name)
        .sort();

    console.log(`Shipping manifest: ${approvedPacks.length} approved pack(s)\n`);

    for (const name of approvedPacks) {
        console.log(`── ${name} ${"─".repeat(50 - name.length)}`);

        const srcDir = path.join(SRC_ROOT, name);
        const outDir = path.join(STAGING, name);

        // 1. Source directory exists?
        if (!fs.existsSync(srcDir)) {
            fail(`Source directory missing: packs/src/${name}`);
            continue;
        }

        const sourceFiles = fs.readdirSync(srcDir).filter(f => f.endsWith(".json"));
        pass(`Source directory: ${sourceFiles.length} JSON file(s)`);

        // 2. Compile
        try {
            await compilePack(srcDir, outDir, { log: false });
            pass("Compiled successfully");
        } catch (e) {
            fail(`Compilation failed: ${e.message}`);
            continue;
        }

        // 3. Bootstrap files present?
        const outputFiles = fs.readdirSync(outDir);

        for (const required of REQUIRED_BOOTSTRAP_FILES) {
            if (outputFiles.includes(required)) {
                pass(`Bootstrap file: ${required}`);
            } else {
                fail(`Missing bootstrap file: ${required}`);
            }
        }

        for (const pattern of REQUIRED_BOOTSTRAP_PATTERNS) {
            const match = outputFiles.find(f => pattern.test(f));
            if (match) {
                pass(`Bootstrap file: ${match}`);
            } else {
                fail(`Missing bootstrap file matching: ${pattern}`);
            }
        }

        // 4. LDB data file present?
        const ldbFiles = outputFiles.filter(f => f.endsWith(".ldb"));
        if (ldbFiles.length > 0) {
            pass(`Data files: ${ldbFiles.length} .ldb file(s)`);
        } else {
            fail("No .ldb data files produced");
        }

        // 5. Open the DB and verify contents
        const expect = EXPECTED[name];
        if (!expect) {
            console.log("  ⏭️  No entry expectations defined, skipping content check");
            continue;
        }

        let db;
        try {
            db = new ClassicLevel(outDir, {
                keyEncoding: "utf8",
                valueEncoding: "json",
                createIfMissing: false,
            });

            const allEntries = [];
            for await (const [key, value] of db.iterator()) {
                allEntries.push([key, value]);
            }

            // Entry count
            if (allEntries.length >= expect.minEntries) {
                pass(`Entry count: ${allEntries.length} (expected ≥${expect.minEntries})`);
            } else {
                fail(`Entry count: ${allEntries.length} (expected ≥${expect.minEntries})`);
            }

            // Required keys
            const keySet = new Set(allEntries.map(([k]) => k));
            for (const reqKey of expect.requiredKeys) {
                if (keySet.has(reqKey)) {
                    pass(`Key present: ${reqKey}`);
                } else {
                    fail(`Key missing: ${reqKey}`);
                }
            }

            // Required flag checks
            for (const [label, checkFn] of Object.entries(expect.requiredFlags)) {
                if (checkFn(allEntries)) {
                    pass(`Flag check: ${label}`);
                } else {
                    fail(`Flag check failed: ${label}`);
                }
            }

            await db.close();
        } catch (e) {
            fail(`DB read failed: ${e.message}`);
            try { await db?.close(); } catch { /* ignore */ }
        }

        console.log();
    }

    // Cleanup
    fs.rmSync(STAGING, { recursive: true, force: true });

    // Summary
    console.log("══════════════════════════════════════════════════════");
    if (failures === 0) {
        console.log(`  🟢 ALL PASSED (${passes} checks)`);
        console.log("  Release ZIP will produce working compendiums.");
    } else {
        console.log(`  🔴 ${failures} FAILURE(S), ${passes} passed`);
        console.log("  DO NOT release until all checks pass.");
    }
    console.log("══════════════════════════════════════════════════════\n");

    process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error("Validation script crashed:", err);
    process.exit(1);
});
