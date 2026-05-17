import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include:     ["tests/**/*.test.js"],
        exclude:     ["tests/montecarlo/**"],
        setupFiles:  ["tests/helpers/setup.js"],
        passWithNoTests: false
    }
});
