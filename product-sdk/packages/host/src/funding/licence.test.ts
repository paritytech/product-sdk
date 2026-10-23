// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/**
 * getcash (`@getsome/*`, `@getcash/*`) is GPL-3.0; product-sdk is Apache-2.0.
 * The funding provider module was written from the funding RFC and the core,
 * and no package here may import getcash. Biome's restricted-imports rule
 * matches whole module names only, so this scans for the scopes, subpaths
 * included.
 */
test("no package imports getcash", () => {
    const packages = fileURLToPath(new URL("../../..", import.meta.url));
    const offenders: string[] = [];
    const scan = (dir: string) => {
        for (const name of readdirSync(dir)) {
            if (name === "node_modules" || name === "dist") continue;
            const path = join(dir, name);
            if (statSync(path).isDirectory()) scan(path);
            else if (/\.(ts|tsx|js|mjs|json)$/.test(name)) {
                const source = readFileSync(path, "utf8");
                if (/["'`]@(getsome|getcash)\//.test(source) && !path.endsWith("licence.test.ts")) {
                    offenders.push(relative(packages, path));
                }
            }
        }
    };
    for (const pkg of readdirSync(packages)) {
        const dir = join(packages, pkg);
        if (statSync(dir).isDirectory()) scan(dir);
    }
    expect(offenders).toEqual([]);
});
