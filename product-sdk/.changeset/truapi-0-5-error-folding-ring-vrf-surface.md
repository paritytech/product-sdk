---
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

**Refine the truapi 0.5.0 surface: central `CallError` folding and the
RFC-0004 Ring VRF ergonomics.**

**CallError folding (truapi ≥0.4 wire).** Every generated method's error
channel is the framework `CallError` envelope
(`Domain | Denied | Unsupported | MalformedFrame | HostFailure`) around the
*versioned* domain error. The host package now folds this centrally:
`toHostErrorPayload` (new, exported) unwraps `Domain` to the real domain
payload — so `mapHostResult` / `unwrapHostResult` / `formatHostError` behave
exactly as in 0.3.x for domain failures — while the framework variants
surface as `HostCallFailedError`s (or thrown `Error`s) whose message carries
the framework tag + reason. **Breaking:** `HostErrorPayload` reverts to the
*domain* payload type (0.14.0 briefly made it the `CallErrorValue` envelope
itself), so `HostCallFailedError.payload` carries the unwrapped domain error
again; the new `HostWireError` type names the wrapped channel.

**Ring VRF surface (truapi RFC-0004).** The proof/alias API keeps the
per-account addressing ergonomics instead of exposing raw
`ProductProofContext`s: `createRingVRFProof(dotNsIdentifier, derivationIndex,
location, message)` derives the context with the RFC's canonical 4-byte
big-endian `derivationIndex` suffix and still resolves to the bare proof
bytes; `getProductAccountAlias(dotNsIdentifier, location, derivationIndex?)`
requires the ring location (**breaking** vs the 0.3.x signature, and replaces
0.14.0's context-shaped overloads) — in `AccountsProvider`, the signer
`HostProvider`, and `SignerManager`. `ProductProofContext` /
`RingLocationJunction` are re-exported from the host package;
`ContextualAlias` stays backed by truapi's generated type. The `RingVRFProof`
response type introduced in 0.14.0 is dropped (the wrapper returns proof
bytes; the response's verification values stay internal), and the signer no
longer re-exports `ProductProofContext` / `RingVRFProof`.
