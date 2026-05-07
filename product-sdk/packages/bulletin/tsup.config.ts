import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    treeshake: true,
    define: {
        "import.meta.vitest": "undefined",
    },
    // Mark product-sdk as external since it's an optional peer dependency
    // that's dynamically imported
    external: ["@novasamatech/product-sdk"],
});
