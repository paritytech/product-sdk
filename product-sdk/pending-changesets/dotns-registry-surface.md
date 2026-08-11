---
"@parity/product-sdk": minor
---

**Add the DotNS registry surface under `@parity/product-sdk/identity`.**

Introduces `resolveDotNs` / `reverseDotNs` / `isDotNsAvailable` (reads) and `registerDotNs` / `setDotNsRecord` (writes), plus `DotNsClientOptions`, `RegisterDotNsArgs`, `SetRecordArgs`, a `DotNsError` (`SdkError` marker, `source: "dotns"`), and the `namehash` / `DOT_NODE` helpers. Reads return `Result<T, DotNsError>` — `ok(null)` for an unregistered name / unset primary name.

**Reads are wired to chain.** DotNS is an ENS-style system: `resolveDotNs` computes the `.dot` namehash, then calls `registry.resolver(node)` → `resolver.addressOf(node)` (+ `registry.owner(node)`), via `@parity/product-sdk-contracts`; `reverseDotNs` calls `reverseResolver.nameOf(account)`. Defaults target the Paseo Asset Hub deployment. `DotNsRecord.expiresAt` is omitted — this deployment has no on-chain name-expiry.

This replaces the previous `resolveDotNs` / `reverseDotNs` / `isDotNsAvailable` skeletons, which took no options and **threw** `"not yet implemented"`. **Breaking for anyone who imported them**: the signatures now require a `DotNsClientOptions` and return a `Result` instead of throwing. (Pre-1.0, so shipped as `minor` per RELEASES.md.)

**Writes are not wired yet.** `registerDotNs` / `setDotNsRecord` throw `DotNsError("NotWired", …)` — registration is a commit-reveal-pay flow deferred to a follow-up PR (`TODO(dotns-abi)` markers). See `docs/product-sdk/dotns-registry-support.md`.
