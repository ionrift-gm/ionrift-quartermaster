/**
 * append-approved-packs-to-zip.mjs
 *
 * Appends each approved pack directory (from packs/SHIPPING.json) into
 * module.zip at repo root. Run after the main zip step (which excludes packs/*).
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.resolve(__dirname, "..");
const SHIPPING_PATH = path.join(MODULE_ROOT, "packs", "SHIPPING.json");
const ZIP_PATH = path.join(MODULE_ROOT, "module.zip");

function main() {
  if (!fs.existsSync(ZIP_PATH)) {
    console.error("append-approved-packs-to-zip: module.zip not found");
    process.exit(1);
  }

  const shipping = JSON.parse(fs.readFileSync(SHIPPING_PATH, "utf8"));
  const names = Object.entries(shipping.packs || {})
    .filter(([, entry]) => entry && entry.status === "approved")
    .map(([name]) => name)
    .sort();

  for (const name of names) {
    const rel = path.join("packs", name);
    const abs = path.join(MODULE_ROOT, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      console.error(`append-approved-packs-to-zip: missing pack directory: ${rel}`);
      process.exit(1);
    }
    console.log(`  zip append: ${rel}`);
    execFileSync("zip", ["-r", ZIP_PATH, rel], { cwd: MODULE_ROOT, stdio: "inherit" });
  }

  if (names.length === 0) {
    console.log("append-approved-packs-to-zip: no approved packs to append");
  }
}

main();
