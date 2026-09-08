---
"@parity/product-sdk-terminal": minor
---

**Default to a statement store endpoint that resolves (#365).**

`createTerminalAdapter({ appId })` with no `endpoints` could not reach a statement store at all. Its
default was `SS_PASEO_STABLE_STAGE_ENDPOINTS`, whose host has no A record. The Paseo people chain it
names is not down: it moved to the system slot and its RPC gained a `-system-` segment. host-papp
has not followed, and that constant is unchanged from 0.6.17 through 0.10.0.

The new default is `wss://paseo-people-next-system-rpc.polkadot.io`, which is the chain the Polkadot
app's nightly build connects to, and the one this repo's own `paseo-individuality` descriptor has
addressed all along.

**New: `StatementStoreNetworks`**, replacing the flat endpoint constants.

Keys match `BULLETIN_RPCS` in `@parity/product-sdk-host`, so one network has one name across the SDK.

| Key | Endpoint |
| --- | --- |
| `paseo` | `wss://paseo-people-next-system-rpc.polkadot.io` |
| `previewnet` | `wss://previewnet.substrate.dev/people` |

`previewnet` was live before this change and was not re-exported, so reaching it meant importing
from `@novasamatech/host-papp` directly. `StatementStoreEnvironment` is exported as its key type.

**Removed: `SS_PASEO_STABLE_STAGE_ENDPOINTS`.** Minor rather than patch, because surface is removed,
which on 0.x signals a breaking change. Nothing was reachable through it, so any caller passing it
as `endpoints` was already unable to connect; replace it with `StatementStoreNetworks.paseo`.

`SS_STABLE_STAGE_ENDPOINTS` is still exported. It resolves but refuses connections from outside the
Parity network, which fits an internal-only host rather than a retired one, so it is kept until it
has been retested on VPN.

**Smaller published bundle.** `treeshake` is now on, dropping the in-source test blocks that shipped
as dead code. `dist/index.js` goes from 50,146 to 13,335 bytes, with every export unchanged.

**Pairing needs both sides on the same chain**, and the pairing handshake does not carry one. The
phone picks its people chain per build flavour, so a preview-flavour phone still needs
`endpoints: StatementStoreNetworks.previewnet` passed explicitly.
