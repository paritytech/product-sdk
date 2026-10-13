---
"@parity/product-sdk-logger": patch
---

Fix a Node.js warning (`` `--localstorage-file` was provided without a valid path ``) emitted whenever `@parity/product-sdk-logger` was imported under Node. `readEnv()` now returns `process.env[key]` unconditionally when running under Node, and never falls through to the browser-only `localStorage` read — previously it only skipped `localStorage` when the env var happened to be *set*, so any consumer running under Node with the var unset (the common case) still triggered Node's lazy `localStorage.getItem` warning.
