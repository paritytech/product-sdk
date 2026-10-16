// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        includeSource: ["src/**/*.ts"],
    },
    define: {
        "import.meta.vitest": "undefined",
    },
});
