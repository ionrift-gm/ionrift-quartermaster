/**
 * add-keys-to-src.mjs  (one-shot migration, delete after use)
 *
 * Adds _key fields to QM src JSON files so @foundryvtt/foundryvtt-cli
 * compilePack() can write them into LevelDB. Also splits the array-format
 * _folders.json into individual single-object files per Foundry CLI convention.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..", "packs", "src", "quartermaster-containers");

const files = fs.readdirSync(SRC).filter(f => f.endsWith(".json"));

for (const file of files) {
    const fullPath = path.join(SRC, file);
    const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));

    if (Array.isArray(raw)) {
        // _folders.json array format — split into individual files
        console.log(`Splitting array file: ${file} (${raw.length} entries)`);
        for (const entry of raw) {
            const id = entry._id;
            const type = entry._type || "folder";
            const key = `!folders!${id}`;
            const newEntry = { _key: key, ...entry };
            delete newEntry._type; // CLI uses type field, not _type for folders
            // Write as _folder_<id>.json
            const outFile = path.join(SRC, `_folder_${id}.json`);
            fs.writeFileSync(outFile, JSON.stringify(newEntry, null, 2), "utf8");
            console.log(`  Created: _folder_${id}.json → _key=${key}`);
        }
        // Remove the old array file
        fs.unlinkSync(fullPath);
        console.log(`  Removed: ${file}`);
    } else if (raw._id && !raw._key) {
        // Single object without _key — determine key prefix from type
        const id = raw._id;
        let keyPrefix = "!items"; // default for this pack
        if (raw._type === "folder" || raw.type === "folder") {
            keyPrefix = "!folders";
        }
        const key = `${keyPrefix}!${id}`;
        const updated = { _key: key, ...raw };
        fs.writeFileSync(fullPath, JSON.stringify(updated, null, 2), "utf8");
        console.log(`Updated: ${file} → _key=${key}`);
    } else if (raw._key) {
        console.log(`Already has _key: ${file}`);
    } else {
        console.log(`SKIPPED (no _id): ${file}`);
    }
}

console.log("\nDone. Verify with: node tools/validate-packs-local.mjs");
