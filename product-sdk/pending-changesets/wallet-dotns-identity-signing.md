---
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

**Sign messages with the account that owns a People / People Lite DotNS username.**

New on `@parity/product-sdk`:

- `wallet.signMessageWithDotNsIdentity({ peopleChain, username?, message })` — resolves `Resources.UsernameOwnerOf` on the supplied People / Individuality chain descriptor, matches the resolved owner against connected wallet accounts, and signs with `getSigner().signBytes(...)`.
- A matching `useWallet` action surfaces the same call from React.
- Falls back to the host's primary DotNS username when none is supplied (`SignerManager.getUserId()` under the hood — see below).

Chain-connection lifecycle is automatic: the SDK reuses an existing chain client when `app.chain.connect({ ..., <name>: peopleChain })` was called upfront (matched by genesis), and falls back to opening a transient connection otherwise. For long-running apps, call `app.chain.connect` once at startup to avoid the cold-path cost.

New on `@parity/product-sdk-signer`:

- `SignerManager.getUserId()` — wraps the existing `HostProvider.getUserId()` for non-product-account use cases (host identity fetch without product-account derivation). Returns `HostUnavailableError` when not connected via host, `DestroyedError` after `destroy()`.

```ts
import { createApp } from "@parity/product-sdk";
import { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality";

const app = await createApp({ name: "my-app" });
await app.wallet.connect();

// Recommended: connect the People chain upfront to share one chainHead
// subscription across every subsequent identity sign.
await app.chain.connect({ people: paseo_individuality });

const { username, accountId, signature } = await app.wallet.signMessageWithDotNsIdentity({
    peopleChain: paseo_individuality,
    message: "verifying ownership",
});
```
