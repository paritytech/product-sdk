import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        includeSource: ["src/**/*.ts"],
    },
    define: {
        "import.meta.vitest": "undefined",
    },
});
