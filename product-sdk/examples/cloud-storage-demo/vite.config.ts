// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
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
