---
"@parity/product-sdk-host": patch
"@parity/product-sdk": patch
---

Add `@deprecated` JSDoc markers so deprecated surface shows struck-through in editors and has a stated migration target. `host`'s `createHostLocalStorage` and `createHostPreimageManager` are identical aliases of `getHostLocalStorage`/`getPreimageManager` (single cached client); the App API's `getProductAccount`, `getAnonymousAlias` and `createProof` are sync stubs that return `null` or throw and should be reached through `SignerManager` directly. Documentation only; no runtime change.
