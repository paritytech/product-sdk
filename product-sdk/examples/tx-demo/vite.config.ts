import { defineConfig } from "vite";

export default defineConfig({
    base: "./",
    // Strip `import.meta.vitest` blocks so workspace packages that embed
    // in-source vitest tests don't leak top-level `await import(...)` into
    // the production bundle. See https://vitest.dev/guide/in-source.html.
    define: {
        "import.meta.vitest": "undefined",
    },
    server: {
        port: 5200,
    },
    build: {
        outDir: "dist",
    },
});
