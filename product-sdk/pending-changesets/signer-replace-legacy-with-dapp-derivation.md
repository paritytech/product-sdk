---
"@parity/product-sdk-signer": patch
"@parity/product-sdk": patch
---

**`SignerManager.connect("host")` now derives a product account from `dappName` instead of calling the host's legacy-account enumeration.**

On Proof-of-Personhood / product-account hosts (Polkadot Desktop today, Polkadot Mobile going forward), `accounts.getLegacyAccounts()` is hard-coded to return `[]` by design — the host exposes only per-dapp product accounts via enumeration and never the user's identity account. Pre-this-PR, calling `app.wallet.connect()` on such hosts surfaced `NoAccountsError`, which made the simplest possible "connect a wallet" flow unusable.

### What changed

`HostProvider.tryConnect()`:

- The legacy-fetch branch (`provider.getLegacyAccounts()` → `mapAccounts(...)` → `NoAccountsError` on empty) is replaced with a derivation branch (`fetchProductSignerAccount(dappName + ".dot", 0)`).
- When `dappName` is not set, OR the host rejects the derivation (typically because the dotNS identifier isn't registered for this user), `connect()` resolves with `ok([])` rather than throwing. Consumers can still drive the explicit signing paths (`wallet.signMessageWithDotNsIdentity`, `accounts.getLegacyAccountSigner`).
- `HostProviderOptions` gains a `dappName?: string` field, wired through automatically from `SignerManager` (consumers don't pass it directly).
- The `AccountsProvider` interface drops the now-unused `getLegacyAccounts` field. `getLegacyAccountSigner` is **kept** — it's the load-bearing primitive for explicit-name signing (used by `wallet.signMessageWithDotNsIdentity`).

### No public API change

- `SignerManager` constructor, `connect()`, and all other methods: unchanged.
- `HostProvider` constructor: unchanged (`dappName` is additive).
- `app.wallet.connect()` return shape: unchanged (`{ accounts: Account[] }`).
- `getLegacyAccountSigner`, `getProductAccount`, `getProductAccountAlias`, `getUserId`, `createRingVRFProof`, `subscribeAccountConnectionStatus`: unchanged.

### Behavioral note for consumers

Anyone catching `NoAccountsError` to gate UI on Polkadot Desktop will see the error go away — `connect()` now resolves with one product-derived account (when the host can derive it) or an empty list (when it can't). Most consumers handle empty arrays gracefully; if you guarded on `NoAccountsError` specifically, switch to checking `accounts.length === 0`.

The `dappName` you pass to `createApp({ name })` or `new SignerManager({ dappName })` is now also the dotNS identifier the host derives the product account from. `.dot` is appended automatically if missing. If your `dappName` isn't a valid registered dotNS identifier, the host will reject the derivation and `connect()` will resolve with `[]` — usable for explicit-name signing flows but no enumerated account.
