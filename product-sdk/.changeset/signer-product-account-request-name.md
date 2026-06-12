---
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

**Add `productAccount.requestName` opt-out and a public `HostProvider.getUserId()`.**

When `HostProviderOptions.productAccount` is set, `connect()` populates
`SignerAccount.name` from the host primary username via `getUserId()`.
That host call triggers an identity-permission prompt, which is wasted
for apps that don't display the name.

Two additions, both backward-compatible (default behavior unchanged):

- **`productAccount.requestName`** (default `true`). Set it to `false` to
  skip the `getUserId()` fetch entirely — no name, no prompt — for apps
  with their own display chain (e.g. registry username → fallback).
- **`HostProvider.getUserId(): Promise<Result<{ primaryUsername }, SignerError>>`**.
  Fetch the name lazily on demand — e.g. on a profile screen — for apps
  that opted out at connect, or that want to react to a `PermissionDenied`
  / `NotConnected` rejection explicitly rather than silently getting a
  nameless account. Mirrors the existing `getProductAccount` /
  `getProductAccountAlias` public methods.

Existing `productAccount` consumers see no change.

```ts
// Default: name fetched at connect (host identity prompt), as before.
new HostProvider({ productAccount: { dotNsIdentifier: "myapp.dot" } });

// Opt out of the connect-time prompt; fetch the name later if needed.
const provider = new HostProvider({
  productAccount: { dotNsIdentifier: "myapp.dot", requestName: false },
});
// ...later, when a screen actually needs the name:
const result = await provider.getUserId();
if (result.ok) console.log(result.value.primaryUsername);
```
