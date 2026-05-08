#!/bin/bash
# Patch verifiablejs/bundler to load WASM via base64 embed instead of inline import.
# Required for bun runtime. Node.js/tsx users should use the ESM loader hook instead:
#   --import @polkadot-apps/terminal/register

BUNDLER_JS=$(find node_modules -path "*/verifiablejs/pkg-bundler/verifiablejs.js" 2>/dev/null | head -1)
[ -z "$BUNDLER_JS" ] && exit 0

# Skip if already patched
head -1 "$BUNDLER_JS" | grep -q "__wbg_set_wasm" && exit 0

BUNDLER_DIR=$(dirname "$BUNDLER_JS")
# -w 0 disables line wrapping on Linux; -i is macOS flag
WASM_B64=$(base64 -w 0 "$BUNDLER_DIR/verifiablejs_bg.wasm" 2>/dev/null || base64 -i "$BUNDLER_DIR/verifiablejs_bg.wasm" 2>/dev/null || base64 "$BUNDLER_DIR/verifiablejs_bg.wasm")

cat > "$BUNDLER_JS" << SHIM
import { __wbg_set_wasm } from "./verifiablejs_bg.js";
import * as bg from "./verifiablejs_bg.js";

const wasmBytes = Uint8Array.from(atob("$WASM_B64"), c => c.charCodeAt(0));
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, { "./verifiablejs_bg.js": bg });
__wbg_set_wasm(wasmInstance.exports);
wasmInstance.exports.__wbindgen_start();

export * from "./verifiablejs_bg.js";
SHIM
