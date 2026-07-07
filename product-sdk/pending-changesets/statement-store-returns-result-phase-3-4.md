---
"@parity/product-sdk-statement-store": minor
"@parity/product-sdk": minor
---

Convert the fallible write operations of `@parity/product-sdk-statement-store` from a mixed throw/boolean model to returning a `Result` (phase 3.4 of the SDK-wide throw→Result initiative).

**Breaking:**

- `StatementStoreClient.publish` now returns `Promise<Result<void, StatementStoreError>>` instead of `Promise<boolean>`. Previously it threw `StatementConnectionError` / `StatementDataTooLargeError` for preconditions and **swallowed the submit error into `false`** — losing the failure reason. Now every failure is on the `err` channel with its cause: `StatementConnectionError` (not connected), `StatementDataTooLargeError` / `StatementEncodingError` (encoding), or `StatementSubmitError` (network rejected the submission, previously discarded).
- `ChannelStore.write` now returns `Promise<Result<void, StatementStoreError>>` (propagated from `publish`).
- `StatementStoreError` (and all its subclasses) implements the shared `SdkError` marker (`source: "statement-store"`).

Migrate `const ok = await client.publish(data); if (ok) {…}` to `const r = await client.publish(data); if (r.ok) {…} else handle(r.error)`. **Note:** because the old return was a `boolean`, a bare `if (result)` check now silently always passes (a `Result` object is truthy) — audit call sites for `.ok`.

**Unchanged:**

- `subscribe` (returns an `Unsubscribable`, not a fallible outcome), `connect` (lifecycle; still throws `StatementConnectionError`), the pure helpers (`encodeData`/`decodeData`/`toHex`/`fromHex`/`createTopic`/`createChannel`/`createExpiry`), and `createTransport` are unchanged.
