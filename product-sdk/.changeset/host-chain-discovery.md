---
"@parity/product-sdk-host": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk": minor
---

Consume TrUAPI host chain discovery. `@parity/product-sdk-host`
gains `getHostChainInfo()`, a cached facade over `chain.getChainInfo()` that
resolves chain roles (`AssetHub`, `Bulletin`, `People`, …) to genesis hashes
and returns `null` on hosts predating discovery. `getChainAPI()` can now be
called with no argument to derive the environment from the host by matching
the discovered asset hub genesis against the bundled descriptors; an explicit
environment is validated the same way, failing with the new `EnvironmentMismatchError` /
`GenesisMismatchError` instead of an opaque unsupported-genesis error. Only the
asset hub is fatal there, since it anchors the environment; a bulletin or
individuality descriptor that disagrees warns and leaves that one chain
throwing on use, as any chain the host cannot serve already does. Calls
that pass an environment keep exactly the previous behavior on legacy hosts;
the zero-arg form needs discovery, so it throws there and outside a container.
`createFakeTruApiClient` / `createFakeHost` model `chain.getChainInfo` behind a
new `chainInfo` option, so tests can drive discovery; omitting it models a host
predating the call. The `chain.getChainInfo` binding this rides on ships in
`@parity/truapi` 0.9.0, adopted separately.

The explicit form is only unchanged on legacy hosts. On a host that serves discovery,
`getChainAPI("paseo")` can now fail where it previously connected:
`EnvironmentMismatchError` when the host's asset hub genesis matches a different bundled
environment, and `GenesisMismatchError` when it matches none and the bundled asset hub
descriptor disagrees with the host. Both surface at the call rather than at the first
storage read, so an unchanged call site fails earlier and with a different error type.
