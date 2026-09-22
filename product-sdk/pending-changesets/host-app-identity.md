---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
---

Resolve wallet identity from the host's `system.getProductContext()`. Derive the app name, local-storage prefix and `getAppInfo().name` by removing only the final domain suffix: `my-app.dot` uses `my-app`, preserving existing storage. Local development IDs stay unchanged.

`createApp()` works without configuration, and `ProductSDKProvider` needs no name prop. The optional `name` setting is deprecated, ignored and logged as a warning when supplied. The public fake host supplies a fixed product context for app tests.
