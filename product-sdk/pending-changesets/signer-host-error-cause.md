---
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

**Preserve the underlying host error as `cause` on `HostRejectedError` (#289).**

Six of the seven `HostProvider` account methods discarded the host's own error once they
had formatted it into a message, so a signer-layer consumer could only recover the reason
by matching on the message text. They now pass it through, and `HostRejectedError` accepts
it as a third optional `ErrorOptions` argument, the same way `SigningFailedError` and
`AllowanceExpiredError` already did.

`error.cause` is the raw TrUAPI envelope, untouched — `scale.CallErrorValue<Versioned…Error>`
for the call that failed. Its tagged union narrows exhaustively and already separates a
domain rejection from a transport failure, so no hand-written gate is needed to tell the
two apart:

```ts
import type { scale, VersionedHostAccountCreateProofError } from "@parity/truapi";

const result = await manager.createRingVRFProof(handle, context, ring, message);
if (result.isErr() && result.error instanceof HostRejectedError) {
    const raw = result.error.cause as scale.CallErrorValue<VersionedHostAccountCreateProofError>;
    if (raw.tag === "Domain" && raw.value.value.tag === "NotAllowlisted") {
        // Degrade: this host has no allowlist source yet.
    }
}
```

`NotAllowlisted` on a cross-product proof or `ringVrfSign` is the expected steady-state
answer on core-based hosts rather than a fault — the gate compares the key handle's owner
against the calling product and reads no manifest, so no allowlist entry can exist yet
(paritytech/host-rust-core#373). Android prompts and succeeds on the same request, so a
product spanning both needs to branch on this to degrade per host.

Covers `registerRingVrfKey`, `listRingVrfKeys`, `getProductAccountAlias`,
`createRingVRFProof`, `getUserId`, `signVrf` and `getProductAccount`.

**Additive.** The parameter is optional and third, so `nonTransient` keeps its position and
no existing call site changes. Messages, `name` and `nonTransient` are all unchanged, and
consumers matching on the message text keep working.

Reading `cause` at this layer means depending on `@parity/truapi` for the cast. Consumers
wanting fully-typed handling without one should call `getAccountsProvider()` from
`@parity/product-sdk-host`, where TrUAPI's types already flow through untouched — the same
place `ringVrfSign` and `findRingVrfKeyHandle` live.
