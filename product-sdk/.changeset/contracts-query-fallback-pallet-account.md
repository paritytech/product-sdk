---
"@parity/product-sdk-contracts": patch
---

**Use the pallet-revive account as the read-only query fallback origin.**

When no wallet is connected, contract query dry-runs need an origin purely for gas estimation. Previously this fell back to the `//Alice` dev account, which is misleading and tied query behavior to a dev seed.

It now falls back to pallet-revive's own pallet account, mirroring `Pallet::<T>::account_id()` (`PalletId(*b"py/reviv").into_account_truncating()`). The 32-byte AccountId is the PalletId `TYPE_ID` (`b"modl"`) followed by the id (`b"py/reviv"`), zero padded, which SS58-encodes to `5EYCAe5ijiYfhaAUBd6H9WGRTsvwFFc7GnhQkiHvBYxdvpbV`. The address is derived from those bytes in code rather than hardcoded, so it stays verifiably in sync with the runtime definition.
