import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    treeshake: true,
    external: ["@novasamatech/host-api-wrapper", "@novasamatech/host-api"],
    define: {
        "import.meta.vitest": "undefined",
    },
});
