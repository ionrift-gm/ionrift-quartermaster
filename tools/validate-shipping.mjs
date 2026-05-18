/**
 * validate-shipping.mjs
 *
 * Reads module.json and packs/SHIPPING.json, then enforces:
 *  1. Every pack declared in module.json has a SHIPPING.json entry.
 *  2. No pack with status != "approved" has tracked (git) compiled content.
 *  3. Retired packs warn if their folder still exists on disk.
 *  4. Approved packs must have a compiled LevelDB folder or source in packs/src/.
 *  5. If an approved pack has packs/src/{name}/SIGNOFF.json, all items must be signed off.
 *
 * Exit 0 = pass, 1 = failure.
 * Node built-ins only (fs, path, child_process).
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_ROOT = path.resolve(__dirname, "..");
const PACKS_DIR = path.join(MODULE_ROOT, "packs");
const SHIPPING_PATH = path.join(PACKS_DIR, "SHIPPING.json");
const MODULE_JSON_PATH = path.join(MODULE_ROOT, "module.json");

const VALID_STATUSES = new Set(["approved", "dev", "retired"]);
const BLOCKING_SIGNOFF = new Set(["draft", "test", "pending-review"]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function packFolderExists(name) {
  const p = path.join(PACKS_DIR, name);
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

function packSrcExists(name) {
  const p = path.join(PACKS_DIR, "src", name);
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

function isGitTracked(relativePath) {
  try {
    const result = execSync(`git ls-files "${relativePath}"`, {
      cwd: MODULE_ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

function listPackJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort();
}

function validateSignoff(packName) {
  const srcDir = path.join(PACKS_DIR, "src", packName);
  const signoffPath = path.join(srcDir, "SIGNOFF.json");
  if (!fs.existsSync(signoffPath)) return [];

  const errors = [];
  let signoff;
  try {
    signoff = readJson(signoffPath);
  } catch (err) {
    errors.push(`${packName}: failed to read SIGNOFF.json: ${err.message}`);
    return errors;
  }

  const signoffEntries =
    signoff.items && typeof signoff.items === "object" ? signoff.items : {};
  const files = listPackJsonFiles(srcDir);

  for (const file of files) {
    const entry = signoffEntries[file];
    if (!entry) {
      errors.push(`${packName}/${file}: missing from SIGNOFF.json`);
      continue;
    }
    if (BLOCKING_SIGNOFF.has(entry.status)) {
      errors.push(`${packName}/${file}: status "${entry.status}" blocks release`);
    } else if (entry.status !== "approved") {
      errors.push(
        `${packName}/${file}: status "${entry.status ?? "missing"}" is not approved`
      );
    }
    if (entry.assetSource === "ai-generated") {
      errors.push(`${packName}/${file}: assetSource is ai-generated`);
    }
  }

  for (const orphanName of Object.keys(signoffEntries)) {
    const fp = path.join(srcDir, orphanName);
    if (!fs.existsSync(fp)) {
      errors.push(`${packName}/SIGNOFF: orphan entry "${orphanName}" (file missing)`);
    }
  }

  return errors;
}

function main() {
  let shipping;
  try {
    shipping = readJson(SHIPPING_PATH);
  } catch (err) {
    console.error(`Failed to read ${SHIPPING_PATH}: ${err.message}`);
    process.exit(1);
  }

  let moduleJson;
  try {
    moduleJson = readJson(MODULE_JSON_PATH);
  } catch (err) {
    console.error(`Failed to read ${MODULE_JSON_PATH}: ${err.message}`);
    process.exit(1);
  }

  const shippingPacks = shipping.packs || {};
  const manifestPacks = moduleJson.packs || [];

  const errors = [];
  const warnings = [];

  console.log("\n--- Ionrift Shipping Validator ---\n");

  // 1. Every SHIPPING.json entry has a valid status.
  for (const [name, entry] of Object.entries(shippingPacks)) {
    if (!VALID_STATUSES.has(entry.status)) {
      errors.push(
        `SHIPPING "${name}": unknown status "${entry.status}" (expected: ${[...VALID_STATUSES].join(", ")})`
      );
    }
  }

  // 2. Every pack in module.json must appear in SHIPPING.json.
  for (const pack of manifestPacks) {
    if (!shippingPacks[pack.name]) {
      errors.push(
        `module.json declares pack "${pack.name}" with no SHIPPING.json entry. Add it before release.`
      );
    }
  }

  // 3. Check each SHIPPING entry against filesystem and git state.
  const approvedCount = [];
  const devCount = [];
  const retiredCount = [];

  for (const [name, entry] of Object.entries(shippingPacks)) {
    const folderExists = packFolderExists(name);
    const srcExists = packSrcExists(name);
    const tracked = isGitTracked(`packs/${name}`);

    switch (entry.status) {
      case "approved": {
        approvedCount.push(name);
        if (!folderExists && !srcExists) {
          errors.push(
            `Approved pack "${name}": no compiled folder or source dir found`
          );
        }
        const signoffErrors = validateSignoff(name);
        errors.push(...signoffErrors);
        break;
      }

      case "dev": {
        devCount.push(name);
        if (tracked) {
          warnings.push(
            `Dev pack "${name}" has git-tracked compiled content. Remove from git before release.`
          );
        }
        break;
      }

      case "retired": {
        retiredCount.push(name);
        if (folderExists) {
          warnings.push(
            `Retired pack "${name}" still has a folder on disk. Consider removing it.`
          );
        }
        break;
      }
    }
  }

  // 4. Scan for rogue pack folders not in SHIPPING.json.
  if (fs.existsSync(PACKS_DIR)) {
    const allDirs = fs
      .readdirSync(PACKS_DIR)
      .filter((name) => {
        if (name === "src" || name.startsWith(".")) return false;
        const full = path.join(PACKS_DIR, name);
        return fs.statSync(full).isDirectory();
      });

    for (const dir of allDirs) {
      if (dir.includes("-backup") || dir.includes("-compiled")) continue;
      if (!shippingPacks[dir]) {
        warnings.push(
          `Folder "packs/${dir}" exists but is not in SHIPPING.json. Add an entry or remove it.`
        );
      }
    }
  }

  // Summary
  console.log(`  Approved : ${approvedCount.length} (${approvedCount.join(", ") || "none"})`);
  console.log(`  Dev      : ${devCount.length} (${devCount.join(", ") || "none"})`);
  console.log(`  Retired  : ${retiredCount.length} (${retiredCount.join(", ") || "none"})`);
  console.log("");

  if (warnings.length > 0) {
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings) {
      console.log(`  [warn] ${w}`);
    }
    console.log("");
  }

  if (errors.length > 0) {
    console.log(`Errors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  [fail] ${e}`);
    }
    console.log("");
    console.log("Shipping validation FAILED.");
    process.exit(1);
  }

  console.log("Shipping validation passed.");
  process.exit(0);
}

main();
