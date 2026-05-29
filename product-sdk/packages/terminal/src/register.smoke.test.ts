// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test for the `--import @parity/product-sdk-terminal/register` flow.
 *
 * Spawns a child Node process with the register hook attached and confirms
 * that `verifiablejs/bundler` resolves through the loader to the
 * `pkg-nodejs` build (the WASM-from-disk one). Without the hook, the import
 * either fails to resolve or returns the inline-WASM build that breaks at
 * use time.
 *
 * This catches:
 *  - Typos / regressions in `loader.mjs` that would make the hook silently
 *    no-op (the most likely way the dev-experience falls off a cliff).
 *  - Build issues where `dist/register.js` doesn't reach `dist/loader.mjs`
 *    (the tsup `onSuccess` step copies the loader into dist).
 *
 * Requires `pnpm build` to have run — the test imports the built artifacts
 * the way a real consumer would.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const registerPath = join(here, "..", "dist", "register.js");
const loaderPath = join(here, "..", "dist", "loader.mjs");

interface ChildResult {
    stdout: string;
    stderr: string;
    code: number | null;
}

/** Run `node [args...] -e <script>` and capture exit + output. */
function runNode(args: string[], script: string, timeoutMs = 10_000): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        const child = spawn("node", [...args, "-e", script], { stdio: "pipe" });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => {
            stdout += d.toString();
        });
        child.stderr.on("data", (d) => {
            stderr += d.toString();
        });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`child timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.on("exit", (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code });
        });
        child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
    });
}

describe("register hook smoke", () => {
    test("dist/register.js + dist/loader.mjs both exist after build", () => {
        // Helpful pre-check: if these are missing, the rest of the suite
        // produces a less obvious failure (Cannot find module ...register.js).
        expect(existsSync(registerPath), `missing build artifact: ${registerPath}`).toBe(true);
        expect(existsSync(loaderPath), `missing build artifact: ${loaderPath}`).toBe(true);
    });

    test("with --import register, verifiablejs/bundler resolves to the nodejs WASM build", async () => {
        const script = `
            import("verifiablejs/bundler")
                .then((m) => {
                    // pkg-nodejs exposes the same surface as pkg-bundler;
                    // checking for the WASM-backed functions confirms the
                    // module loaded and the bindings are wired up.
                    const expected = ["sign", "member_from_entropy", "members_intermediate", "members_root"];
                    const missing = expected.filter((k) => typeof m[k] !== "function");
                    if (missing.length > 0) {
                        console.log("MISSING_EXPORTS:" + missing.join(","));
                        process.exit(2);
                    }
                    console.log("OK");
                })
                .catch((e) => {
                    console.log("IMPORT_FAILED:" + e.message);
                    process.exit(3);
                });
        `;

        const { stdout, stderr, code } = await runNode(["--import", registerPath], script);
        expect(stderr, `unexpected stderr: ${stderr}`).not.toMatch(/IMPORT_FAILED|MISSING_EXPORTS/);
        expect(code, `child exited with code ${code}; stdout=${stdout} stderr=${stderr}`).toBe(0);
        expect(stdout).toContain("OK");
    });

    test("without --import, verifiablejs/bundler does NOT resolve from terminal's package", async () => {
        // Negative control: proves the loader hook is doing real work.
        // Without --import, verifiablejs is a transitive dep of host-papp,
        // not directly resolvable from terminal's eval context.
        const script = `
            import("verifiablejs/bundler")
                .then(() => { console.log("UNEXPECTED_OK"); process.exit(0); })
                .catch((e) => { console.log("EXPECTED_FAIL:" + e.message.slice(0, 80)); process.exit(0); });
        `;

        const { stdout, code } = await runNode([], script);
        expect(code).toBe(0);
        expect(stdout).toContain("EXPECTED_FAIL");
        expect(stdout).not.toContain("UNEXPECTED_OK");
    });
});
