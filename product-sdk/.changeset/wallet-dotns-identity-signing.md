---
"@parity/product-sdk-signer": minor
"@parity/product-sdk-terminal": patch
"@parity/product-sdk-host": patch
"@parity/product-sdk-statement-store": patch
"@parity/product-sdk": minor
---

**Sign messages with the account that owns a People / People Lite DotNS username, plus a catalog bump to `@novasamatech/host-api` 0.8.8.**

### `@parity/product-sdk` — `wallet.signMessageWithDotNsIdentity`

- `wallet.signMessageWithDotNsIdentity({ peopleChain, username?, message })` — resolves `Resources.UsernameOwnerOf` on the supplied People / Individuality chain descriptor, then signs the message with that account through the host's legacy-account signing path. Returns `{ username, accountId, signature }`.
- A matching `useWallet` action surfaces the same call from React.
- Falls back to the host's primary DotNS username when none is supplied (via the host's `accounts.getUserId()` — triggers a host identity-permission prompt).

**Implementation note (worth knowing for consumers).** The owning account is named explicitly via the host's `getLegacyAccountSigner({ publicKey })` rather than matched against an enumerated wallet list. On Proof-of-Personhood / product-account hosts (e.g. Polkadot Desktop), the connected-accounts list returned by `getLegacyAccounts()` is intentionally empty — the host exposes only per-dapp product accounts via enumeration and never surfaces the user's identity account. Such hosts still sign with that account when it's *named explicitly* (typically behind a user-approval prompt), and that's the path this flow uses.

**Chain-connection lifecycle is automatic.** The SDK reuses an existing chain client when `app.chain.connect({ ..., <name>: peopleChain })` was called upfront (matched by genesis), and falls back to opening a transient connection otherwise. For long-running apps, call `app.chain.connect` once at startup to avoid the cold-path cost.

### `@parity/product-sdk-signer` — `SignerManager.getUserId()`

`SignerManager.getUserId()` wraps the existing `HostProvider.getUserId()` for callers that want to fetch the host primary username without going through a product-account-derivation flow. Returns `HostUnavailableError` when not connected via host, `DestroyedError` after `destroy()`.

### Catalog bump — `@novasamatech/host-api` family `^0.8.7` → `^0.8.8`

`@novasamatech/host-api`, `@novasamatech/host-api-wrapper`, `@novasamatech/host-papp`, `@novasamatech/statement-store`, `@novasamatech/storage-adapter`, and `@novasamatech/substrate-slot-sr25519-wasm` move from `^0.8.7` to `^0.8.8`. The headline from upstream is the **legacy sign-request protocol** (PR #218): new `signRawLegacy` / `createTransactionLegacy` UserSession methods plus the matching SCALE codecs (`SignRawLegacyRequest`/`Response`, `CreateTransactionLegacyRequest`, `LegacyTransaction`). This is the protocol scaffolding the new `signMessageWithDotNsIdentity` flow relies on for signing with a wallet's identity account.

No session/secrets codec changes — `terminal`'s `testing.ts` codec mirror round-trips cleanly against 0.8.8; both interop suites pass.

### Example

```ts
import { createApp } from "@parity/product-sdk";
import { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality";

const app = await createApp({ name: "my-app" });

// Recommended: connect the People chain upfront to share one chainHead
// subscription across every subsequent identity sign.
await app.chain.connect({ people: paseo_individuality });

// No prior `app.wallet.connect()` required — the signing flow names the
// identity account directly and the host prompts the user to approve.
//
// Omit `username` to sign with the host's primary username (the one shown
// for the currently-logged-in user), or pass it explicitly to sign with a
// specific People-chain identity the user owns.
const { username, accountId, signature } = await app.wallet.signMessageWithDotNsIdentity({
    peopleChain: paseo_individuality,
    message: "verifying ownership",
});
```
