import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, "../..");
function findIonriftRoot(start) {
    let dir = start;
    for (let i = 0; i < 5; i++) {
        const candidate = path.join(dir, "ionrift-library");
        if (fs.existsSync(candidate)) return dir;
        const parent = path.resolve(dir, "..");
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(repoRoot, "..");
}
const libraryRoot = path.join(findIonriftRoot(repoRoot), "ionrift-library");

export default defineConfig({
    resolve: {
        alias: {
            "../../../../ionrift-library": libraryRoot
        }
    },
    test: {
        environment: "node",
        include: ["scripts/tests/**/*.test.js"],
        setupFiles: ["scripts/tests/setup/install.js"]
    }
});
