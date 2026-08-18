---
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

**Wrap `account.signVrf` (RFC-0023) in the accounts surface (#288).**

Producing an sr25519 VRF over a caller-supplied Merlin transcript previously meant
reaching for the raw `getTruApi()` client. `AccountsProvider` now has
`signVrf(account, transcriptLabel, items)`, with `HostProvider.signVrf` and
`SignerManager.signVrf` alongside `createRingVRFProof`. Bytes in, bytes out: the adapter
owns the hex encoding and the tagged derivation-index selector, and errors use the same
`Result` channel as every other account call.

New exported types, also re-exported from `@parity/product-sdk-signer`:
`VrfTranscriptItem`, `VrfSignature`, and `ProductAccountLookup`
(`{ dotNsIdentifier, derivationIndex? }`), which a `ProductAccount` satisfies.

**Breaking for implementors.** `signVrf` is a required member of the exported
`AccountsProvider` interface, so alternative implementations and hand-rolled test doubles
must add it. Callers are unaffected, and the fake at `@parity/product-sdk-host/testing`
already implements it.

**Host-only.** There is no `DevProvider` implementation and the e2e test host does not
expose the call, so this returns `HOST_UNAVAILABLE` outside a host container, matching
`createRingVRFProof`. Use `createFakeHost()` for local tests.

The caller owns four things the types cannot enforce:

- *Domain separation* — a label borrowed from another protocol makes the output
  replayable across both.
- *Freshness* — the VRF is deterministic, so per-round values must enter the transcript
  as items; otherwise every call returns the same signature.
- *Size* — hosts cap the transcript at 32 items and 8 KiB total and reject anything
  larger as an unknown error. The SDK does not pre-validate.
- *Authorization* — an `AutoSigning` allowance makes these calls silent. It is not
  VRF-scoped, so granting it also authorizes other signing with that account.

Hosts predating the call reject it through the error channel rather than hanging.
