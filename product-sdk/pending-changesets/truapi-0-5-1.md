---
"@parity/product-sdk-host": patch
---

Update `@parity/truapi` to 0.5.1. No SDK API changes; the embedded sandbox
client gains a fallback for legacy iframe hosts that don't yet answer the
`truapi-ready` / `truapi-init` MessagePort handoff (it recognizes their
first raw frame instead), and reports a real `"connecting"` status while
waiting for the host channel.
