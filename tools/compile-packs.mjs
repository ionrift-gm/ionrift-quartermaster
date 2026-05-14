/**
 * compile-packs.mjs
 *
 * Compiles approved compendium packs from JSON source files (packs/src/<name>/)
 * into LevelDB databases (packs/<name>/) using @foundryvtt/foundryvtt-cli.
 *
 * Run during the release workflow after npm ci. Replaces the old
 * append-approved-packs-to-zip.mjs which shipped raw LevelDB files from git.
 *
 * Usage:
 *   node tools/compile-packs.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { compilePack } from "@foundryvtt/foundryvtt-cli";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.resolve(__dirname, "..");
const SHIPPING_PATH = path.join(MODULE_ROOT, "packs", "SHIPPING.json");
const SRC_ROOT = path.join(MODULE_ROOT, "packs", "src");
const OUT_ROOT = path.join(MODULE_ROOT, "packs");

async function main() {
    if (!fs.existsSync(SHIPPING_PATH)) {
        console.error("compile-packs: SHIPPING.json not found");
        process.exit(1);
    }

    const shipping = JSON.parse(fs.readFileSync(SHIPPING_PATH, "utf8"));
    const names = Object.entries(shipping.packs || {})
        .filter(([, entry]) => entry && entry.status === "approved")
        .map(([name]) => name)
        .sort();

    if (names.length === 0) {
        console.log("compile-packs: no approved packs to compile");
        return;
    }

    for (const name of names) {
        const srcDir = path.join(SRC_ROOT, name);
        const outDir = path.join(OUT_ROOT, name);

        if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
            console.error(`compile-packs: missing source directory: packs/src/${name}`);
            process.exit(1);
        }

        // Ensure output directory exists and is clean
        if (fs.existsSync(outDir)) {
            fs.rmSync(outDir, { recursive: true, force: true });
        }
        fs.mkdirSync(outDir, { recursive: true });

        console.log(`  compile: packs/src/${name} → packs/${name}`);
        await compilePack(srcDir, outDir, { log: true });
    }

    console.log(`compile-packs: compiled ${names.length} pack(s) successfully`);
}

main().catch((err) => {
    console.error("compile-packs: fatal error:", err);
    process.exit(1);
});
