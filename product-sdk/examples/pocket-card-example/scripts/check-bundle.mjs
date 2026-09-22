// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The host reads worker JS as Latin-1, so a bundle carrying anything outside
 * ASCII arrives corrupted.
 *
 * esbuild's ascii charset covers string literals and identifiers, and not
 * comments. Without `--minify` the JSDoc of every bundled dependency is copied
 * through verbatim, and `@parity/truapi` alone puts three em dashes in this
 * worker's output. `--legal-comments=none` does not help, because these are
 * ordinary comments rather than licence banners.
 *
 * So the bundle is minified, and this checks the result. The failure it guards
 * against is silent and only shows up on a device.
 */
import { readFileSync, statSync } from "node:fs";

const bundle = new URL("../dist/worker.js", import.meta.url);
const source = readFileSync(bundle, "utf8");

const nonAscii = [...source].findIndex((character) => (character.codePointAt(0) ?? 0) > 0x7f);
if (nonAscii !== -1) {
    const line = source.slice(0, nonAscii).split("\n").length;
    console.error(`dist/worker.js has a non-ASCII character on line ${line}.`);
    console.error("The host reads worker JS as Latin-1, so this bundle would arrive corrupted.");
    process.exit(1);
}

const { size } = statSync(bundle);
console.log(`dist/worker.js is ASCII, ${(size / 1024).toFixed(1)} KiB`);
