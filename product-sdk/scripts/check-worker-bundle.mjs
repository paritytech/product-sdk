// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Checks that JavaScript can run as a product worker.
 *
 * A worker runs in a sandbox the host controls, and two kinds of bundle fail there only on a
 * device:
 *
 * - One that carries a character outside ASCII. The host reads worker JS as Latin-1, so the
 *   bundle arrives corrupted. esbuild's ascii charset covers literals and identifiers but not
 *   comments, so an unminified bundle copies every dependency's JSDoc through.
 * - One that reaches for a global the sandbox does not give: `WebAssembly`, `indexedDB`, `eval`,
 *   `new Function` or `require`.
 *
 * Usage:
 *
 *   node scripts/check-worker-bundle.mjs dist/worker.js [more.js ...]
 *       checks built bundles.
 *   node scripts/check-worker-bundle.mjs --package packages/chat [--package ...]
 *       bundles each package's built `.` export as a worker would (ESM, minified, neutral
 *       platform) and checks it. Build the package first.
 *
 * Exits with 1 on the first failing input.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FORBIDDEN = ["WebAssembly", "indexedDB", "eval(", "new Function(", "require("];

/** The first problem of `source`, or undefined when it can run as a worker. */
function problemOf(source) {
    const nonAscii = [...source].findIndex((character) => (character.codePointAt(0) ?? 0) > 0x7f);
    if (nonAscii !== -1) {
        const character = source[nonAscii];
        const point = character.codePointAt(0).toString(16).padStart(4, "0").toUpperCase();
        const context = source.slice(Math.max(0, nonAscii - 40), nonAscii + 40);
        return `a non-ASCII character '${character}' (U+${point}) near ...${context}...`;
    }
    const found = FORBIDDEN.filter((name) => source.includes(name));
    if (found.length > 0) return `references globals a worker does not have: ${found.join(", ")}`;
    return undefined;
}

/** The built file of a package's `.` export. */
function packageEntry(directory) {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const root = manifest.exports?.["."];
    const entry = typeof root === "string" ? root : (root?.import ?? manifest.main);
    if (!entry) throw new Error(`${directory} declares no "." export`);
    return resolve(directory, entry);
}

async function bundlePackage(directory) {
    const { build } = await import("esbuild");
    const result = await build({
        entryPoints: [packageEntry(directory)],
        bundle: true,
        write: false,
        format: "esm",
        target: "es2022",
        platform: "neutral",
        mainFields: ["module", "main"],
        conditions: ["import"],
        minify: true,
        charset: "ascii",
        legalComments: "none",
        logLevel: "silent",
    });
    return result.outputFiles[0].text;
}

const args = process.argv.slice(2);
const inputs = [];
for (let index = 0; index < args.length; index++) {
    if (args[index] === "--package") inputs.push({ kind: "package", name: args[++index] });
    else inputs.push({ kind: "file", name: args[index] });
}
if (inputs.length === 0) {
    console.error("usage: check-worker-bundle.mjs <bundle.js ...> | --package <directory> [...]");
    process.exit(2);
}

for (const input of inputs) {
    let source;
    let problem;
    try {
        source =
            input.kind === "file"
                ? readFileSync(resolve(input.name), "utf8")
                : await bundlePackage(input.name);
        problem = problemOf(source);
    } catch (error) {
        const reasons = error.errors?.map((failure) => failure.text) ?? [String(error)];
        problem = `does not bundle for a worker: ${reasons.join("; ")}`;
    }
    if (problem) {
        console.error(`${input.name}: ${problem}`);
        console.error("A worker bundle must be ASCII and use only the globals the host's sandbox gives.");
        process.exit(1);
    }
    console.log(`${input.name}: worker-safe, ${(source.length / 1024).toFixed(1)} KiB`);
}
