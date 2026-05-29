// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
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
        port: 5210,
    },
    build: {
        outDir: "dist",
    },
});
