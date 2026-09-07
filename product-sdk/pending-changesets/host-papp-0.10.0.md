---
"@parity/product-sdk-terminal": minor
"@parity/product-sdk-auth": minor
---

**Pair with a 0.9.0+ host.** `@novasamatech/host-papp` and its three lockstep siblings move from `^0.8.9` to `0.10.0`.

The old caret admitted only `>=0.8.9 <0.9.0`. host-papp 0.9.0 changed the pairing envelope from P-256 / AES-GCM to X25519 / ChaCha20-Poly1305 and shrank the encryption keys from 65 bytes to 32, and the handshake codec is fixed-width SCALE, so an SDK on the old pin could not complete a handshake. Both shipping mobile hosts moved to the new envelope in mid-August 2026, so this has been broken in the field since then.

**Existing paired sessions are invalidated. Users re-pair once.** The persisted session storage key moved `SsoSessionsV3` → `SsoSessionsV4`, so sessions written by an earlier CLI run are not read. `UserSecretsV2_<sessionId>.json` files are left behind but cause no errors, and the `DeviceIdentity` blob is unaffected. Same shape of break as the 0.8.7-1 bump.

**The on-disk allowance cache is versioned 1 → 2 and stale files are dropped.** Its entries belong to sessions that can no longer exist, and two fields changed shape, so a v1 file is discarded rather than half-read. The first allocation after upgrading is one extra round trip.

**Breaking, for anyone importing these types directly:**

- `AllocatableResource` — `SmartContractAllowance`'s payload is now a tagged `{ tag: "Index"; value: number } | { tag: "Raw"; value: Uint8Array }` instead of a bare `number`.
- `ApAllocationOutcome` — `AutoSigning` drops `productDerivationSecret` and gains `ringVrfDomainEntropy`.
- `CachedAllocation` — `SmartContractAllowance.dest` is a string (`"Index::7"`, `"Raw::0x…"`), and the `AutoSigning` entry carries `ringVrfDomainEntropy`.

`ProductAccountRef` is unchanged: the SDK still takes a plain `derivationIndex` and emits the `Index` variant for you.

**Not taking 0.10.1 or newer.** They raise their `polkadot-api` floor to `>=3` and this workspace is on PAPI 2. 0.10.0 is wire-identical to 0.10.2 for pairing, handshake, signing and resource allocation, so nothing is lost by holding here. A `polkadot-api` override keeps host-papp's open `>=2` range from pulling a second PAPI copy into the graph.

**This restores pairing, not phone-paired signing.** Product-account derivation in `@parity/product-sdk-keys` predates RFC-0022 and does not match any current host, so a signature still carries the wrong address. That is a separate, pre-existing defect, tracked on its own.
