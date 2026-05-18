import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * When the dnd5e system is installed under the Foundry Data folder, its
 * `icon-migration.json` lists every Foundry core `icons/...` path the SRD pack
 * uses after the v4+ asset rename. Quartermaster masked icons should always
 * pick filenames that appear in that set so they resolve at runtime.
 *
 * @returns {Set<string>|null}  Set of migration target paths, or null if file missing
 */
export function dnd5eIconMigrationTargets() {
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationPath = join(here, "../../../../systems/dnd5e/json/icon-migration.json");
    if (!existsSync(migrationPath)) return null;
    const raw = JSON.parse(readFileSync(migrationPath, "utf8"));
    return new Set(Object.values(raw));
}
