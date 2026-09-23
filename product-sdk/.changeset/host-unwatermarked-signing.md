---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

Expose the host's temporary unwatermarked raw-signing calls on `AccountsProvider`:

```ts
signRawUnwatermarkedDeprecated(account: ProductAccount, data: Uint8Array): Promise<Uint8Array>
signRawUnwatermarkedDeprecatedWithLegacyAccount(account: { publicKey: Uint8Array }, data: Uint8Array): Promise<Uint8Array>
```

Both sign `data` with no `<Bytes>` watermark and return the raw signature bytes,
mirroring the `signBytes` of the two `PolkadotSigner` factories. They exist for
runtimes that verify a bare-byte ownership proof — People chain's
`Resources.register_person` `lite_identity_proof` is the one that forced them —
and they are deprecated on the host side too
([host-rust-core#612](https://github.com/paritytech/host-rust-core/issues/612),
implemented in [#731](https://github.com/paritytech/host-rust-core/pull/731),
shipped in `@parity/truapi` 0.16.0). Hosts log a deprecation warning and show a
stronger confirmation prompt, since an unwatermarked signature can authorize a
transaction. Use `signBytes` everywhere a runtime does not force otherwise; both
calls disappear once the runtime accepts watermarked proofs.

**Breaking for implementors.** Both are required members of the exported
`AccountsProvider` interface, so alternative implementations and hand-rolled test
doubles must add them. Callers are unaffected. `createFakeTruApiClient` already
models both.
