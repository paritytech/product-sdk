// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
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
    // Mark novasama packages as external: they're runtime dependencies that are
    // dynamically imported (host-api-wrapper) or statically re-exported (host-api),
    // resolved from the consumer's node_modules rather than bundled.
    external: ["@novasamatech/host-api-wrapper", "@novasamatech/host-api"],
});
