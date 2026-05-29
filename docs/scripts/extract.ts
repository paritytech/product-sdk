// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// Pre-extract step for `docs:extract`.
//
// Discovers documentable packages via the workspace registry and writes a
// `typedoc.generated.json` whose `entryPoints` list is built dynamically.
// TypeDoc is then invoked against the generated config.
//
// This lets adding/renaming/removing a package "just work" — the registry
// picks up any folder under `packages/` that contains `package.json` + a
// `src/index.ts`. Tooling-only packages without `src/index.ts` (e.g.
// `descriptors`) are skipped automatically.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverPackages } from "./lib/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(__dirname, "..");
const PACKAGES_DIR = resolve(DOCS_ROOT, "..", "product-sdk", "packages");
const BASE_CONFIG_PATH = resolve(DOCS_ROOT, "typedoc.json");
const GENERATED_CONFIG_PATH = resolve(DOCS_ROOT, "typedoc.generated.json");

const baseConfig = JSON.parse(readFileSync(BASE_CONFIG_PATH, "utf8")) as Record<string, unknown>;
const registry = discoverPackages(PACKAGES_DIR);
if (registry.folders.size === 0) {
  console.error(`No documentable packages discovered in ${PACKAGES_DIR}`);
  process.exit(1);
}

const entryPoints = [...registry.folders]
  .sort()
  .map((folder) => `../product-sdk/packages/${folder}`);

const generatedConfig = { ...baseConfig, entryPoints };
writeFileSync(GENERATED_CONFIG_PATH, JSON.stringify(generatedConfig, null, 2) + "\n", "utf8");

console.log(`docs:extract — ${entryPoints.length} package(s): ${[...registry.folders].sort().join(", ")}`);

const child = spawn("typedoc", ["--options", GENERATED_CONFIG_PATH], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("close", (code) => process.exit(code ?? 0));
