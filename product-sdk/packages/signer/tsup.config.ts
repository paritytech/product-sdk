import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    treeshake: true,
    external: ["@novasamatech/product-sdk", "@novasamatech/host-api"],
    define: {
        "import.meta.vitest": "undefined",
    },
});
