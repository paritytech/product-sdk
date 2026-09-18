---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

Add `bindHost({ client, signal, apiVersion })` to use an existing host connection from a CLI script or another embedding environment.

The binding borrows the ready TrUAPI client and follows its owner's abort signal without opening another connection or disposing the transport. It accepts stable TrUAPI 0.17.x and rejects unsupported versions before changing SDK state. The returned unbind function is idempotent. Browser discovery and test overrides remain available.
