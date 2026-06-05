import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "../../../ionrift-library/scripts/services/TerrainRegistry.js":
                new URL("./tests/helpers/terrain-registry-stub.js", import.meta.url).pathname
        }
    },
    test: {
        environment: "node",
        include:     ["tests/**/*.test.js"],
        exclude:     ["tests/montecarlo/**"],
        setupFiles:  ["tests/helpers/setup.js"],
        passWithNoTests: false
    }
});
