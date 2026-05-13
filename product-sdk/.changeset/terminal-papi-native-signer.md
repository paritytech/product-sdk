---
"@parity/product-sdk-terminal": patch
---

**Fix transaction signing for chains with runtime-specific signed extensions (e.g. `AsPgas` on Paseo Next v2).**

`createSessionSigner` / `createSessionSignerForAccount` previously built their `PolkadotSigner` through `getPolkadotSignerFromPjs`, which translates PAPI's signed-extension map into the fixed Polkadot.js payload shape via a hardcoded mapper table covering eight extensions (`CheckGenesis`, `CheckNonce`, `CheckMortality`, `CheckSpecVersion`, `CheckTxVersion`, `ChargeTransactionPayment`, `ChargeAssetTxPayment`, `CheckMetadataHash`). Anything else threw at signing time:

```
PJS does not support this signed-extension: AsPgas
```

This blocked every transaction on Paseo Next v2's Asset Hub — including the `Revive.map_account()` extrinsic that's prerequisite for product-account contract interactions.

### How the fix works

Swaps the PJS bridge for PAPI's own `getPolkadotSigner`. The new flow:

- PAPI assembles the SCALE-encoded signing payload from the chain's `metadata.extrinsic.signedExtensions` — every extension survives end-to-end as opaque bytes, including extensions PAPI's PJS adapter doesn't know about.
- Our signer routes those bytes to `session.signRaw({ data: { tag: "Payload", value: <hex> } })` — the tagged-bytes wire route in `@novasamatech/host-papp` that signs payloads verbatim, with no `<Bytes>...</Bytes>` envelope.
- The mobile wallet signs the bytes as-is; we return the signature to PAPI, which assembles the final extrinsic.

Arbitrary-byte signing (`signer.signBytes`) still routes through `session.signRaw` with the `Bytes` tag — keeps the anti-phishing wrap, correct for non-extrinsic user data.

### Public API

Unchanged. `createSessionSigner(session, adapter)` and `createSessionSignerForAccount(session, ref)` keep their signatures and return `PolkadotSigner` as before.

### What the fix unblocks

- `Revive.map_account()` and other Paseo Next v2 Asset Hub extrinsics that include the `AsPgas` signed extension.
- Any future runtime-specific signed extension — the chain's metadata is the source of truth; PAPI hashes whatever the chain declared, the wallet signs whatever PAPI assembled.
- `playground-cli dot init` on Paseo Next v2 (was blocked on the asset-hub mapping step).
