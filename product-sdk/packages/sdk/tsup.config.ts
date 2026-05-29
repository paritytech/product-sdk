// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        "address/index": "src/address/index.ts",
        "cloud-storage/index": "src/cloud-storage/index.ts",
        "chain/index": "src/chain/index.ts",
        "contracts/index": "src/contracts/index.ts",
        "core/index": "src/core/index.ts",
        "crypto/index": "src/crypto/index.ts",
        "host/index": "src/host/index.ts",
        "identity/index": "src/identity/index.ts",
        "react/index": "src/react/index.ts",
        "local-storage/index": "src/local-storage/index.ts",
        "wallet/index": "src/wallet/index.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    treeshake: true,
    external: ["react"],
    define: {
        "import.meta.vitest": "undefined",
    },
});
