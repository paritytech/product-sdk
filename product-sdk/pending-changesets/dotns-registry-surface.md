---
"@parity/product-sdk": minor
---

**Add the DotNS registry surface under `@parity/product-sdk/identity`.**

Introduces reads (`resolveDotNs` / `reverseDotNs` / `isDotNsAvailable`) and writes (`setDotNsRecord` / `prepareDotNsRegistration`), plus `DotNsClientOptions`, `RegisterDotNsArgs`, `SetRecordArgs`, `DotNsRegistration`, a `DotNsError` (`SdkError` marker, `source: "dotns"`), and the `namehash` / `DOT_NODE` helpers. Everything returns a `Result<T, DotNsError>`.

**Reads.** DotNS is an ENS-style set of Revive contracts on Paseo Asset Hub. `resolveDotNs` computes the `.dot` namehash, reads `registry.owner(node)` and `registry.resolver(node)`, then `resolver.addressOf(node)`. It reports three states, because the registry's resolver pointer is configuration rather than proof of existence: `ok(null)` for an unregistered name, `ok({ name, owner })` for a name that is registered but has no forward record yet (registration parks the pointer on the reverse resolver, so this is every name until its owner sets one), and `ok({ name, owner, address })` when it resolves. `isDotNsAvailable` asks `registrarController.available(label)`, the predicate `register` itself enforces. `reverseDotNs` calls `reverseResolver.nameOf(account)`, which the contract already verifies against current ownership.

**Writes** return prepared calls the caller submits with their own signer. `setDotNsRecord` returns a `BatchableCall[]`: `registry.setResolver` first when the node is not yet pointed at the forward resolver, then `resolver.setAddress`. `prepareDotNsRegistration` returns the commit call, the secret, the timing window, and a `prepareRegisterCall()` thunk to invoke after `minCommitmentAge` has elapsed. Register is deferred because it consumes the commitment: building it up front cannot work. Registration is priced with `PopRules.priceWithoutCheck(label, owner)` plus `transferFloor` on the cross-payer path, matching what `register` charges, and a reserved label or an owner below the label's personhood tier fails before the caller pays for the commit.

**`DotNsClientOptions.origin`** is the SS58 account that will submit the calls. Required by the write helpers, which dry-run against it since the resolver and registry writes are owner-gated. Optional for reads.

**Breaking for anyone who imported the old skeletons.** `resolveDotNs` / `reverseDotNs` / `isDotNsAvailable` previously took no options and **threw** `"not yet implemented"`; they now require `DotNsClientOptions` and return a `Result`. `DotNsRecord.address` is optional and both it and `owner` are typed `0x${string}` (H160, not SS58: convert with `h160ToSs58` if needed). `DotNsRecord.expiresAt` is never set, since this deployment has no on-chain expiry. Pre-1.0, so shipped as `minor` per RELEASES.md.

Contract addresses default to the Paseo Asset Hub deployment and are all overridable. `isResolvableDotNsName` is exported alongside `isValidDotNsName`: the registrar only mints single labels, but the registry supports subnodes, so `bob.alice.dot` resolves even though it cannot be registered.
