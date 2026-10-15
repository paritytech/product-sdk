---
"@parity/product-sdk-auth": patch
---

Terminal adapter cleanup no longer swallows failures silently. The six `adapter.destroy().catch(() => {})` sites now route through a `destroyQuietly` helper that logs the failure at debug via `@parity/product-sdk-logger` (matching how sibling packages log), so a WebSocket that fails to tear down leaves a trace instead of a silent resource leak. The caller's flow is still never failed by a cleanup error.
