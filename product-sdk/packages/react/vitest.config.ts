// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Hooks render against a DOM; every other package in the workspace runs in Node.
        environment: "jsdom",
        includeSource: ["src/**/*.ts", "src/**/*.tsx"],
    },
    define: {
        "import.meta.vitest": "undefined",
    },
});
