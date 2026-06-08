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
    // Mark novasama packages as external since they're optional peer dependencies
    // that are dynamically imported or re-exported. `@parity/truapi` is a hard
    // runtime dependency, kept external so it's imported at runtime rather than
    // inlined into the host bundle.
    external: ["@novasamatech/host-api-wrapper", "@novasamatech/host-api", "@parity/truapi"],
});
