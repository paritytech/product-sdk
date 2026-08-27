---
"@parity/product-sdk-chain-client": patch
"@parity/product-sdk": patch
---

**Say that createChainClient depends on the host, and correct two stale docs.**

`createChainClient` accepts any PAPI descriptor, but every connection goes through the host provider keyed by that descriptor's genesis, with no WebSocket fallback. A chain is therefore reachable only if the active host routes it, which the package docs did not say while offering the path for "custom or pre-release chains". They now say it, and point at `isChainSupported` from `@parity/product-sdk-host` for checking before connecting. See #94 and #102 for the missing standalone path.

Also removes a dead `Environment` union in `chain-client`'s `types.ts` that listed "local" and "westend", neither of which exists. Nothing imported it and the package exports only its root entry, so no consumer saw it.

Also corrects the Previewnet DotNS TLD in two `identity/` comments, from `.dot` to `.test`, matching `dotns-abis.ts` which records verification on both networks.

Docs, comments, and one unreachable type. No behaviour change.
