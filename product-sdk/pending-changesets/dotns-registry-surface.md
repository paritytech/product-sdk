---
"@parity/product-sdk": minor
---

**Add the DotNS registry surface under `@parity/product-sdk/identity`.**

Introduces reads (`resolveDotNs` / `reverseDotNs` / `isDotNsAvailable`) and writes (`setDotNsRecord` / `prepareDotNsRegistration`), plus `DotNsClientOptions`, `RegisterDotNsArgs`, `SetRecordArgs`, `DotNsRegistration`, a `DotNsError` (`SdkError` marker, `source: "dotns"`), and the `namehash` / `DOT_NODE` helpers. Reads return `Result<T, DotNsError>` — `ok(null)` for an unregistered name / unset primary name.

**Reads.** DotNS is an ENS-style system: `resolveDotNs` computes the `.dot` namehash, then calls `registry.resolver(node)` → `resolver.addressOf(node)` (+ `registry.owner(node)`); `reverseDotNs` calls `reverseResolver.nameOf(account)`. All via `@parity/product-sdk-contracts`. `DotNsRecord.expiresAt` is omitted — this deployment has no on-chain name-expiry.

**Writes** return prepared `BatchableCall`s the caller submits with their own signer (surface stays signer-free). `setDotNsRecord` prepares one `resolver.setAddress` call. `prepareDotNsRegistration` returns the commit + register calls plus `{ secret, minCommitmentAge, maxCommitmentAge, price }` for the two-transaction commit → wait → register-and-pay flow (register's payable value = `PopRules.price(label)`).

This replaces the previous `resolveDotNs` / `reverseDotNs` / `isDotNsAvailable` skeletons, which took no options and **threw** `"not yet implemented"`. **Breaking for anyone who imported them**: the signatures now require a `DotNsClientOptions` and return a `Result` instead of throwing. (Pre-1.0, so shipped as `minor` per RELEASES.md.)

Defaults target the Paseo Asset Hub deployment; all contract addresses are overridable via `DotNsClientOptions`. The on-chain round-trip is validated against a live/forked chain, not unit-tested in-package. See `docs/product-sdk/dotns-registry-support.md`.
