/**
 * filter-manifest.mjs
 *
 * Reads module.json and packs/SHIPPING.json, keeps only approved packs,
 * prunes packFolders, writes .build/module.json for release packaging.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.resolve(__dirname, "..");
const SHIPPING_PATH = path.join(MODULE_ROOT, "packs", "SHIPPING.json");
const MODULE_JSON_PATH = path.join(MODULE_ROOT, "module.json");
const OUT_DIR = path.join(MODULE_ROOT, ".build");
const OUT_PATH = path.join(OUT_DIR, "module.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * @param {unknown} nodes
 * @param {Set<string>} approved
 */
function filterPackFolders(nodes, approved) {
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const next = { ...node };
    if (Array.isArray(next.packs)) {
      next.packs = next.packs.filter((packName) => approved.has(packName));
    }
    if (Array.isArray(next.folders)) {
      next.folders = filterPackFolders(next.folders, approved);
    }
    const hasPacks = Array.isArray(next.packs) && next.packs.length > 0;
    const hasFolders = Array.isArray(next.folders) && next.folders.length > 0;
    if (hasPacks || hasFolders) out.push(next);
  }
  return out;
}

function main() {
  const shipping = readJson(SHIPPING_PATH);
  const moduleJson = readJson(MODULE_JSON_PATH);

  const approved = new Set(
    Object.entries(shipping.packs || {})
      .filter(([, entry]) => entry && entry.status === "approved")
      .map(([name]) => name)
  );

  const filtered = { ...moduleJson };
  filtered.packs = (moduleJson.packs || []).filter((pack) => approved.has(pack.name));

  if (moduleJson.packFolders) {
    filtered.packFolders = filterPackFolders(moduleJson.packFolders, approved);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(filtered, null, 4)}\n`, "utf8");

  console.log(`Filtered manifest: ${OUT_PATH}`);
  console.log(`  Shipped pack names: ${[...approved].join(", ") || "(none)"}`);
}

main();
