/**
 * validate-packs-local.mjs
 *
 *   node tools/validate-packs-local.mjs            # full compile + verify (local)
 *   node tools/validate-packs-local.mjs --verify-only  # verify packs/ output (CI)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { ClassicLevel } from "classic-level";
import { stageJournalPackSrc } from "./journal-pack-staging.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.resolve(__dirname, "..");
const SHIPPING_PATH = path.join(MODULE_ROOT, "packs", "SHIPPING.json");
const SRC_ROOT = path.join(MODULE_ROOT, "packs", "src");
const OUT_ROOT = path.join(MODULE_ROOT, "packs");
const STAGING = path.join(MODULE_ROOT, "packs", ".validation-staging");

const VERIFY_ONLY = process.argv.includes("--verify-only");
const MIN_GUIDE_BODY_CHARS = 80;

function stripHtml(html) {
    return (html ?? "")
        .replace(/<style[\s>][\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s>][\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&[a-z#0-9]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function pageBodyChars(value) {
    if (!value) return 0;
    if (value.type === "text") return stripHtml(value.text?.content ?? "").length;
    if (value.type === "image") {
        return stripHtml(value.image?.caption ?? value.text?.content ?? "").length;
    }
    return stripHtml(value.text?.content ?? "").length;
}

function verifyGuideJournalBodies(packName, allEntries) {
    if (!packName.includes("guide")) return;

    const byKey = new Map(allEntries);
    const journals = allEntries.filter(([key]) => key.startsWith("!journal!"));

    for (const [journalKey, journal] of journals) {
        const journalId = journal._id ?? journalKey.replace(/^!journal!/, "");
        const pageIds = Array.isArray(journal.pages)
            ? journal.pages.filter((id) => typeof id === "string")
            : [];

        if (!pageIds.length) {
            const legacyChars = stripHtml(journal.text?.content ?? "").length;
            if (legacyChars < MIN_GUIDE_BODY_CHARS) {
                fail(
                    `${packName}: journal "${journal.name}" has no page refs and legacy body is ${legacyChars} chars (need ≥${MIN_GUIDE_BODY_CHARS})`,
                );
            } else {
                pass(`${packName}: journal "${journal.name}" legacy body ${legacyChars} chars`);
            }
            continue;
        }

        pass(`${packName}: journal "${journal.name}" lists ${pageIds.length} page ref(s)`);

        let substantivePages = 0;
        for (const pageId of pageIds) {
            const pageKey = `!journal.pages!${journalId}.${pageId}`;
            const page = byKey.get(pageKey);
            if (!page) {
                fail(`${packName}: missing page ldb key ${pageKey}`);
                continue;
            }
            const chars = pageBodyChars(page);
            if (chars >= MIN_GUIDE_BODY_CHARS) {
                substantivePages++;
                pass(`${packName}: page "${page.name}" ${chars} chars`);
            } else {
                fail(
                    `${packName}: page "${page.name}" only ${chars} chars (need ≥${MIN_GUIDE_BODY_CHARS})`,
                );
            }
        }

        if (substantivePages === 0) {
            fail(`${packName}: journal "${journal.name}" has no substantive page bodies`);
        }
    }
}

const EXPECTED = {
    "quartermaster-containers": {
        minEntries: 13,
        requiredKeys: [
            "!items!cac5a45974b8a96b",
            "!items!88bdd4175d86e72c",
            "!items!8f74223eda8fbb3d",
            "!items!92404d5855536ff3",
            "!items!17dcc25742e2735c",
            "!items!f02d7c531943fa21",
            "!items!9a27e1408d685a95",
            "!items!89ad937677946cea",
            "!items!c9933fcbbb24e2c0",
            "!items!7510211eb4e4d0c6",
            "!items!c1516a6b2e2a2719",
            "!items!e54ba35535404b4d",
            "!folders!c9cb7fc62085af7d",
        ],
        requiredFlags: {
            containerMeta: (entries) => entries.some(
                ([, v]) => v?.flags?.["ionrift-quartermaster"]?.containerMeta !== undefined,
            ),
        },
    },
    "quartermaster-guide-gm": {
        minEntries: 6,
        requiredKeys: [
            "!journal!qmGuideJournal01",
            "!journal.pages!qmGuideJournal01.qmCacheGuide002",
            "!journal.pages!qmGuideJournal01.qmIdentGuide003",
            "!journal.pages!qmGuideJournal01.qmSetupGuide001",
            "!journal.pages!qmGuideJournal01.qmLedgerGuide004",
            "!journal.pages!qmGuideJournal01.qmTipsGuide005",
        ],
        requiredFlags: {},
    },
};

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
    const modeLabel = VERIFY_ONLY ? "verify compiled output (--verify-only)" : "simulated clean CI build";
    console.log("\n══════════════════════════════════════════════════════");
    console.log(`  Pack Validation (${modeLabel})`);
    console.log("══════════════════════════════════════════════════════\n");

    if (!VERIFY_ONLY) {
        if (fs.existsSync(STAGING)) {
            fs.rmSync(STAGING, { recursive: true, force: true });
        }
        fs.mkdirSync(STAGING, { recursive: true });
    }

    const shipping = JSON.parse(fs.readFileSync(SHIPPING_PATH, "utf8"));
    const approvedPacks = Object.entries(shipping.packs || {})
        .filter(([, entry]) => entry?.status === "approved")
        .map(([name]) => name)
        .sort();

    console.log(`Shipping manifest: ${approvedPacks.length} approved pack(s)\n`);

    for (const name of approvedPacks) {
        console.log(`── ${name} ${"─".repeat(50 - name.length)}`);

        const srcDir = path.join(SRC_ROOT, name);
        const outDir = VERIFY_ONLY
            ? path.join(OUT_ROOT, name)
            : path.join(STAGING, name);

        if (VERIFY_ONLY) {
            if (!fs.existsSync(outDir)) {
                fail(`Compiled pack directory missing: packs/${name} (was compile-packs.mjs run first?)`);
                continue;
            }
            pass(`Using compiled output: packs/${name}`);
        } else {
            if (!fs.existsSync(srcDir)) {
                fail(`Source directory missing: packs/src/${name}`);
                continue;
            }

            const sourceFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith(".json"));
            pass(`Source directory: ${sourceFiles.length} JSON file(s)`);

            try {
                const staged = stageJournalPackSrc(MODULE_ROOT, srcDir);
                try {
                    await compilePack(staged.srcDir, outDir, { log: false });
                } finally {
                    if (staged.cleanup) staged.cleanup();
                }
                pass("Compiled successfully");
            } catch (e) {
                fail(`Compilation failed: ${e.message}`);
                continue;
            }
        }

        const outputFiles = fs.readdirSync(outDir);

        for (const required of REQUIRED_BOOTSTRAP_FILES) {
            if (outputFiles.includes(required)) {
                pass(`Bootstrap file: ${required}`);
            } else {
                fail(`Missing bootstrap file: ${required}`);
            }
        }

        for (const pattern of REQUIRED_BOOTSTRAP_PATTERNS) {
            const match = outputFiles.find((f) => pattern.test(f));
            if (match) {
                pass(`Bootstrap file: ${match}`);
            } else {
                fail(`Missing bootstrap file matching: ${pattern}`);
            }
        }

        const ldbFiles = outputFiles.filter((f) => f.endsWith(".ldb"));
        if (ldbFiles.length > 0) {
            pass(`Data files: ${ldbFiles.length} .ldb file(s)`);
        } else {
            fail("No .ldb data files produced");
        }

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

            if (allEntries.length >= expect.minEntries) {
                pass(`Entry count: ${allEntries.length} (expected ≥${expect.minEntries})`);
            } else {
                fail(`Entry count: ${allEntries.length} (expected ≥${expect.minEntries})`);
            }

            const keySet = new Set(allEntries.map(([k]) => k));
            for (const reqKey of expect.requiredKeys) {
                if (keySet.has(reqKey)) {
                    pass(`Key present: ${reqKey}`);
                } else {
                    fail(`Key missing: ${reqKey}`);
                }
            }

            for (const [label, checkFn] of Object.entries(expect.requiredFlags)) {
                if (checkFn(allEntries)) {
                    pass(`Flag check: ${label}`);
                } else {
                    fail(`Flag check failed: ${label}`);
                }
            }

            verifyGuideJournalBodies(name, allEntries);

            await db.close();
        } catch (e) {
            fail(`DB read failed: ${e.message}`);
            try { await db?.close(); } catch { /* ignore */ }
        }

        console.log();
    }

    if (!VERIFY_ONLY && fs.existsSync(STAGING)) {
        fs.rmSync(STAGING, { recursive: true, force: true });
    }

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
