---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
---

Resolve the app name from the host's `system.getProductContext()` for wallet identity, local-storage namespacing and `getAppInfo()`. `createApp()` accepts no options, and `ProductSDKProvider` needs no name prop. The optional `name` setting is deprecated, ignored and logged as a warning when supplied.

Local-storage keys use the full host product ID as their prefix. Apps that stored data under a different configured name must migrate those keys explicitly. Hosts must provide `system.getProductContext()`; a missing or refused context rejects app creation.

The public fake host reports `fake-app.dot` by default and accepts a `productId` option for tests that create apps under a specific host identity.
