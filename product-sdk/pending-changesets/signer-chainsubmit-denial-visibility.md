---
"@parity/product-sdk-signer": patch
---

**A denied `ChainSubmit` permission is now logged at `warn`.** `HostProvider.connect()` requests `ChainSubmit` up front and, by design, never fails `connect()` on the outcome — the consumer can still use read-only paths, and the first sign call surfaces a clear error. But that meant a denial, which guarantees every later sign call fails with `PermissionDenied`, was only ever logged at `debug`, invisible at the default `warn` level. A grant still logs at `debug`; a denial now logs at `warn`. No API changed — `connect()`'s contract and the thrown-request `catch` path are untouched.
