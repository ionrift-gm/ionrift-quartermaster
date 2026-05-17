import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["*.test.js"],
        setupFiles: ["../helpers/setup.js"],
        passWithNoTests: false
    }
});
