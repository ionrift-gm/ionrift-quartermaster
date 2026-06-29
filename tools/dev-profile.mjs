/**
 * dev-profile.mjs
 *
 * Local-only pack composition: move compendium folders between packs/ and
 * packs/.staging/ to match a named profile in dev-profiles.json.
 *
 * Usage:
 *   node tools/dev-profile.mjs status
 *   node tools/dev-profile.mjs switch <profileId>
 *
 * Copy dev-profiles.example.json to dev-profiles.json (gitignored) and edit.
 * Close Foundry before switch (LevelDB locks).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.resolve(__dirname, "..");
const PROFILES_PATH = path.join(MODULE_ROOT, "dev-profiles.json");
const PROFILES_EXAMPLE_PATH = path.join(MODULE_ROOT, "dev-profiles.example.json");
const MODULE_JSON_PATH = path.join(MODULE_ROOT, "module.json");
const STAGING_ROOT = path.join(MODULE_ROOT, "packs", ".staging");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** @param {{ requireLocal?: boolean }} [opts] */
function loadProfiles(opts = {}) {
  if (fs.existsSync(PROFILES_PATH)) {
    return readJson(PROFILES_PATH);
  }
  if (opts.requireLocal) {
    console.error(
      `Missing dev-profiles.json. Copy dev-profiles.example.json to dev-profiles.json, then edit.`
    );
    process.exit(1);
  }
  if (fs.existsSync(PROFILES_EXAMPLE_PATH)) {
    console.warn("Using dev-profiles.example.json (copy to dev-profiles.json to customize).\n");
    return readJson(PROFILES_EXAMPLE_PATH);
  }
  console.error("No dev-profiles.json or dev-profiles.example.json found.");
  process.exit(1);
}

function manifestPackNames() {
  const m = readJson(MODULE_JSON_PATH);
  return (m.packs || []).map((p) => p.name);
}

function packDir(name) {
  return path.join(MODULE_ROOT, "packs", name);
}

function stagingDir(name) {
  return path.join(STAGING_ROOT, name);
}

function status() {
  const data = loadProfiles();
  const names = manifestPackNames();
  console.log("\n--- Dev pack profiles ---\n");
  console.log("Manifest packs:", names.join(", "));
  console.log("");

  for (const [id, prof] of Object.entries(data.profiles || {})) {
    const mount = new Set(prof.mount || []);
    console.log(`[${id}] ${prof.description || ""}`);
    for (const n of names) {
      const live = fs.existsSync(packDir(n));
      const staged = fs.existsSync(stagingDir(n));
      let loc = "missing";
      if (live) loc = "packs/";
      else if (staged) loc = "packs/.staging/";
      const want = mount.has(n) ? "mount" : "stash";
      console.log(`    ${n}: ${loc} (profile: ${want})`);
    }
    console.log("");
  }
}

function switchProfile(profileId) {
  const data = loadProfiles({ requireLocal: true });
  const prof = data.profiles?.[profileId];
  if (!prof) {
    console.error(`Unknown profile: ${profileId}`);
    process.exit(1);
  }

  const mount = new Set(prof.mount || []);
  fs.mkdirSync(STAGING_ROOT, { recursive: true });

  const names = manifestPackNames();
  for (const n of names) {
    const live = packDir(n);
    const st = stagingDir(n);
    const wantMount = mount.has(n);

    if (wantMount) {
      if (!fs.existsSync(live) && fs.existsSync(st)) {
        console.log(`restore ${n}: .staging -> packs/`);
        fs.renameSync(st, live);
      }
    } else if (fs.existsSync(live)) {
      if (fs.existsSync(st)) {
        console.error(
          `Refuse: ${path.relative(MODULE_ROOT, st)} already exists. Remove it first.`
        );
        process.exit(1);
      }
      console.log(`stash ${n}: packs/ -> .staging/`);
      fs.renameSync(live, st);
    }
  }

  console.log(`\nSwitched to profile "${profileId}". Restart Foundry if it was running.\n`);
}

const cmd = process.argv[2];
const arg = process.argv[3];
if (cmd === "status") {
  status();
} else if (cmd === "switch" && arg) {
  switchProfile(arg);
} else {
  console.log("Usage: node tools/dev-profile.mjs status");
  console.log("       node tools/dev-profile.mjs switch <profileId>");
  process.exit(1);
}
