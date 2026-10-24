// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "tsup";

export default defineConfig({
    // One output per module, so a bundler drops the modules a consumer does not
    // import. A worker that never calls NaCl then never loads tweetnacl, whose
    // Node `require("crypto")` cannot resolve in a worker.
    entry: ["src/*.ts"],
    splitting: true,
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    treeshake: true,
    define: {
        "import.meta.vitest": "undefined",
    },
});
