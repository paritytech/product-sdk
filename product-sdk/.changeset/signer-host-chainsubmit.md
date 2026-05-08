---
"@parity/product-sdk-signer": patch
---

**Fix invalid `TransactionSubmit` permission tag sent during `HostProvider.connect()`.**

After a successful `HostProvider.connect()`, the SDK proactively requests the host's transaction-submit permission so subsequent signing calls don't fail with `PermissionDenied`. The request was being built as `enumValue("v1", { tag: "TransactionSubmit" })`, but `@novasamatech/host-api@0.7.7`'s v1 `RemotePermission` codec defines the legal variants as **Remote | WebRTC | ChainSubmit | PreimageSubmit | StatementSubmit** — no `TransactionSubmit`. The codec's tag-keyed dispatch table returned `undefined` for that tag and the encoder threw client-side before the request reached the host:

```
GenericError: Unknown error: inner[tag] is not a function
```

The throw was caught, but `formatError` collapsed the wrapped result to its outer tag (`"v1"`) and surfaced the unhelpful warning:

```
[signer:host] TransactionSubmit permission rejected by host { error: "v1" }
```

Misleading — it suggested a host-side rejection when in fact it was a schema mismatch between `@parity/product-sdk-signer@0.2.0` and `@novasamatech/host-api@0.7.7` and the host never saw the request.

`TransactionSubmit` was the variant name in earlier host-api revisions and was renamed to `ChainSubmit` in 0.7. `@parity/product-sdk-signer` was not updated to match.

### What changed

- The permission request now uses `tag: "ChainSubmit"` (with explicit `value: undefined`, which the codec requires for unit-shaped variants).
- `HostProviderOptions.requestTransactionSubmitPermission` is renamed to `requestChainSubmitPermission`. The old name is kept as a `@deprecated` alias and still controls the same code path — no source-level migration needed for existing callers.
- `formatError` now walks `{ tag, value }` errors recursively and surfaces the inner Error name + message instead of just the outermost tag. Future schema drift between host-api and the SDK produces legible warnings:
  - Before: `error: "v1"`
  - After: `error: "v1 → GenericError: Unknown error: inner[tag] is not a function"`
- All log lines mentioning the old `TransactionSubmit` tag now reference `ChainSubmit`.

Severity: cosmetic in isolation (`connect()` returned ok and signing actually worked because the permission was effectively no-op'd) — but every product app on these versions emitted a misleading warning per connect, and anyone debugging downstream signing failures got pointed at the wrong layer. Fix is a one-tag rename plus better error formatting.
