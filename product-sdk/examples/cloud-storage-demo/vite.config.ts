import { defineConfig } from "vite";

export default defineConfig({
    base: "./",
    define: {
        "import.meta.vitest": "undefined",
    },
    server: {
        port: 5230,
    },
    build: {
        outDir: "dist",
    },
});
