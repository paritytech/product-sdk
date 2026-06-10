---
"@parity/product-sdk-descriptors": patch
---

**Regenerate paseo-asset-hub, summit-asset-hub, and summit-individuality descriptors against current runtimes.**

The auto-drift workflow flagged all three as stale against their live `codeHash`. Regenerated `.papi/metadata/*.scale` blobs and rebuilt bindings against the live runtimes — no public API or decode-shape change reached consumer packages (workspace build + full test suite clean against the regenerated bindings).
