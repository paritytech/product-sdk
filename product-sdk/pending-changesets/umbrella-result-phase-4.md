---
"@parity/product-sdk": minor
---

Complete the SDK-wide throw→`Result` initiative at the umbrella (phase 4 of 4).

- **Re-export the shared `Result` model from `@parity/product-sdk`:** `Result`, `ok`, `err`, `isSdkError`, and the `SdkError` marker type are now available directly from the umbrella, so apps can `import { ok, err, isSdkError } from "@parity/product-sdk"` without reaching into `@parity/product-sdk-result`.
- **`createApp().cloudStorage` now returns `Result`:** `upload` → `Promise<Result<string, ProductCloudStorageError>>` and `fetch` → `Promise<Result<Uint8Array, ProductCloudStorageError>>`, matching the leaf packages. This removes the temporary unwrap-and-rethrow shim `fetch` carried since phase 3.3. `computeCid` is unchanged (pure; throws on invalid input).

A consolidated migration guide is published at `guides/migrating-to-result`.
