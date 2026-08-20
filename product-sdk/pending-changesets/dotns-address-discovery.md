---
"@parity/product-sdk": minor
---

**Resolve the DotNS contract addresses from chain state, instead of only trusting the pinned table.**

The addresses in `DOTNS_ADDRESSES` are correct today, but nothing checked that. An earlier default set had no code deployed at any of its addresses, and every read returned "unregistered" with no error anywhere — the same silent shape as the TLD bug fixed in the previous release. This adds the two things that make that detectable.

**`addressSource: "discovered"`** walks the deployment from chain state and trusts nothing compiled into the bundle: `DotnsGateway.DispatcherAddress` (pallet storage) → `dispatcher.TARGET()` → `popController.protocolRegistry()` → `protocolRegistry.get(key)` for the registry, registrar controller, forward resolver, reverse resolver and PoP rules. Four round trips, cached per runtime. The default stays `"pinned"`, which reads nothing.

**`verifyDotNsAddresses(opts)`** does the same walk once and reports every role whose live address differs from the one the client would call, listing all of them rather than the first. Meant for startup: a product that keeps the pinned table can still fail loudly when a redeploy moves something.

Both take their trust root from `DotnsGateway.DispatcherAddress`, a governance-set value on the chain the caller already relies on for every name read — a stronger anchor than a constant in a bundle, though neither defends against a hostile RPC.

**New exports.** `resolveDotNsAddresses`, `discoverDotNsAddresses`, `verifyDotNsAddresses`, `DOTNS_REGISTRY_KEYS`, and the types `DotNsAddresses` and `DotNsGatewayQueryApi`.

**New `DotNsClientOptions` fields.** `addressSource?: "pinned" | "discovered"` (default `"pinned"`) and `gatewayApi?: DotNsGatewayQueryApi`. The gateway API is optional: `runtime.api` is used when it carries the pallet, and is probed rather than assumed, so a chain without `DotnsGateway` — Polkadot and Kusama Asset Hub — fails with a typed error rather than throwing.

**Two new `DotNsErrorReason` members**, so a `switch` over the union in consumer code is no longer exhaustive: `"AddressDiscovery"` when the walk cannot locate the deployment, and `"AddressMismatch"` when verification finds drift. They are separate from `"RegistryCall"` because they are not per-call failures — the first means the client cannot find the deployment at all.

**The registry keys are not the field names.** `registrarController` answers under `bytes32("controller")`, not `"registrar"` — that is the ERC-721 holding name ownership, a different contract at a different address. `resolver` answers under `"resolver"`, not `"contentResolver"`. Both wrong keys return a live address rather than an error, so the mistake surfaces much later as a revert. `protocolRegistry` has no key at all and is reached through the walk.

**Behaviour unchanged by default.** Every existing call keeps reading the pinned table, no new round trips, and no published signature changed. Per-field address overrides continue to win over whichever source is in use.

**Also corrected: Previewnet's TLD is `.test`, not `.dot`.** Documentation only — no behaviour change. The `.dot` fallback for a deployment whose `tld()` getter reverts empty is still correct for anything predating `dotns` `b4096968`, but Previewnet was cited as the live example and is not one. No live deployment is currently known to take that branch.
