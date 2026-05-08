/**
 * Node.js ESM loader hook that redirects `verifiablejs/bundler` imports
 * to the nodejs WASM build (which loads .wasm from disk instead of inline).
 *
 * The host-papp SDK imports `verifiablejs/bundler` which inlines .wasm —
 * this doesn't work in Node.js. The nodejs build loads .wasm from the
 * filesystem instead.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

// Find verifiablejs/pkg-nodejs by walking node_modules from host-papp
let nodejsEntry = null;
let hostPappFound = false;
try {
    const require = createRequire(join(process.cwd(), "_"));
    const hostPappPath = dirname(require.resolve("@novasamatech/host-papp"));
    hostPappFound = true;

    let dir = hostPappPath;
    for (let i = 0; i < 10; i++) {
        const candidate = join(dir, "node_modules", "verifiablejs", "pkg-nodejs", "verifiablejs.js");
        if (existsSync(candidate)) {
            nodejsEntry = candidate;
            break;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
} catch {
    // host-papp not installed — loader is a no-op (legitimate during smoke tests).
}

if (hostPappFound && !nodejsEntry) {
    // Found host-papp but couldn't locate verifiablejs/pkg-nodejs after the walk-up.
    // Subsequent imports of `verifiablejs/bundler` will resolve to the inline-WASM
    // build and fail at import time with a cryptic loader error. Warn early.
    //
    // Uses raw console.warn (rather than @parity/product-sdk-logger) because this
    // loader runs before any user code has had a chance to call `configure()` on
    // the logger — routing through the logger would emit via the *default*
    // handler (console.warn) anyway, with extra import overhead for nothing.
    console.warn(
        "[@parity/product-sdk-terminal/register] Found @novasamatech/host-papp but could not locate verifiablejs/pkg-nodejs/verifiablejs.js after walking 10 directories. The Node.js WASM patch will not be applied — host-papp imports may fail. Check that verifiablejs is hoisted into a node_modules dir near host-papp.",
    );
}

export async function resolve(specifier, context, nextResolve) {
    if (specifier === "verifiablejs/bundler" && nodejsEntry) {
        return { shortCircuit: true, url: "verifiablejs-node://shim" };
    }
    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (url === "verifiablejs-node://shim") {
        // The shim runs in the main thread. It loads the CJS module via
        // createRequire with the path we resolved in the loader thread.
        const source = `
import { createRequire } from "node:module";
const _require = createRequire(${JSON.stringify(nodejsEntry)});
const _mod = _require(${JSON.stringify(nodejsEntry)});
export const sign = _mod.sign;
export const member_from_entropy = _mod.member_from_entropy;
export const members_intermediate = _mod.members_intermediate;
export const verify_signature = _mod.verify_signature;
export const members_root = _mod.members_root;
export const validate = _mod.validate;
export default _mod;
`;
        return { shortCircuit: true, format: "module", source };
    }
    return nextLoad(url, context);
}
