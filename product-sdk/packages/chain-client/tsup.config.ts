import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    treeshake: true,
    external: ["@parity/product-sdk-descriptors"],
    define: {
        "import.meta.vitest": "undefined",
    },
});
