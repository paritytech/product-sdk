---
"@parity/product-sdk": minor
---

**Add the DotNS registry surface under `@parity/product-sdk/identity`.**

Introduces `resolveDotNs` / `reverseDotNs` / `isDotNsAvailable` (reads) and `registerDotNs` / `setDotNsRecord` (write submittables), plus `DotNsClientOptions`, `RegisterDotNsArgs`, `SetRecordArgs`, and a `DotNsError` (`SdkError` marker, `source: "dotns"`). Reads return `Result<T, DotNsError>` — `ok(null)` for an unregistered name / unset primary name.

This replaces the previous `resolveDotNs` / `reverseDotNs` / `isDotNsAvailable` skeletons, which took no options and **threw** `"not yet implemented"`. **Breaking for anyone who imported them**: the signatures now require a `DotNsClientOptions` and return a `Result` instead of throwing. (Pre-1.0, so shipped as `minor` per RELEASES.md.)

**Not yet wired to chain.** The on-chain registry contract calls are stubbed: every call returns / throws `DotNsError("NotWired", …)` until the deployed DotNS registry ABI is confirmed (the in-repo `CDM_REGISTRY_ABI` is a contract-deployment registry, not DotNS name resolution). The surface, validation, error model, and types are final; only the encode/decode-against-ABI remains. See `TODO(dotns-abi)` markers and `docs/product-sdk/dotns-registry-support.md`.
