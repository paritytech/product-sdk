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
import { isErrorOf } from "@parity/result";

const result = await manager.createRingVRFProof(handle, context, ring, message);
if (!result.ok && isErrorOf(result.error, HostRejectedError)) {
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
`createRingVRFProof`, `getUserId`, `signVrf` and `getProductAccount`. A provider method
that throws instead of rejecting keeps its own error on `cause` rather than losing it,
which is the shape a host predating a call fails in.

**`nonTransient` now answers consistently, which is a behaviour change.** It is classified
from the host's error at every method instead of only at `getProductAccount`, so a signed-out
host (`NotConnected`) reports `nonTransient: true` from `registerRingVrfKey`,
`listRingVrfKeys`, `getProductAccountAlias`, `createRingVRFProof`, `getUserId` and `signVrf`,
where it previously reported `false`. Those six could not classify before, because the error
they needed had already been discarded. If you branch on `nonTransient`, a signed-out user now
reaches your read-only path on all seven calls rather than one, which is what the field is
documented to mean. Nothing inside the SDK changes behaviour: its one internal reader takes
its value from `getProductAccount`, which already classified correctly.

`HostUnavailableError` also takes an optional `ErrorOptions` now, and a failed
accounts-provider load carries the error the loader threw, instead of only its message text.

Reading `cause` at this layer means depending on `@parity/truapi` for the cast. Consumers
wanting fully-typed handling without one should call `getAccountsProvider()` from
`@parity/product-sdk-host`, where TrUAPI's types already flow through untouched — the same
place `ringVrfSign` and `findRingVrfKeyHandle` live.
