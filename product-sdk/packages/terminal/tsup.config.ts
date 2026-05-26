// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "tsup";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    entry: ["src/index.ts", "src/register.ts", "src/testing.ts", "src/host.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    define: {
        "import.meta.vitest": "undefined",
    },
    onSuccess: async () => {
        copyFileSync(join(here, "src", "loader.mjs"), join(here, "dist", "loader.mjs"));
    },
});
