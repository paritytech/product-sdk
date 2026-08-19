---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
"@parity/product-sdk-auth": patch
---

**Account to username: `lookupUsername` reads `Resources.Consumers` (#302).**

The SDK could answer "who owns username X" and not the direction products actually need on a results
or profile screen: "what is this account's username". `lookupUsername(chain, { account })` answers it
from `Resources.Consumers`, which is keyed by account and carries both names plus the credibility.
Two apps and the host's own Rust core each hand-rolled this decode; this replaces all three.

```ts
const result = await lookupUsername(chain, { account: rootAddress });
if (result.ok && result.value) console.log(displayUsername(result.value));
```

**An account with no consumer record is `ok(null)`, not an error.** The chain was asked and answered.
Everything that can genuinely fail arrives on the `err` channel as a `ProductIndividualityError`,
with `IndividualityDecodeError` for a shape the descriptor says is impossible.

The record is `{ liteUsername, fullUsername, credibility }`, plus three pure helpers:
`displayUsername` (the claimed name, else the lite one), `canClaimFullUsername`, and `usernameBase`.

Four properties come from the pallet rather than from the descriptor, and none is visible to the
compiler:

- **A lite username is always present and always `<letters>.<digits>`**; a full username is letters
  only, with no dot.
- **`fullUsername === null` is the chain's own precondition for claiming a bare name**, which is what
  `canClaimFullUsername` reports. The chain writes `full_username` and `Credibility::Person` in the
  same statement, so "has a full name" and "is a person" are equivalent by construction.
- **A demoted person keeps `Person` and keeps their full username.** `credibility.demoted` is the
  only signal separating them from a person in good standing, which is why it is surfaced.
- **An empty username decodes to absent**, and a name that is not valid UTF-8 fails loudly rather
  than becoming U+FFFD.

`displayUsername` is the same rule the host applies for `account.getUserId().primaryUsername`, so for
the signed-in user the two should agree and a disagreement means a stale session snapshot.

The chain parameter is typed structurally as `ConsumersChain`, so anything with the storage shape
satisfies it, including a test double. A compile-time assertion in `@parity/product-sdk` checks a real
`getChainAPI` client still satisfies it, so a descriptor regeneration that changes the entry fails
`pnpm typecheck` rather than failing at runtime in a product.

**Breaking, and the reason for the minor: `resolvePeopleUsernameOwner` now returns `SS58String`
rather than `0x` hex.** It reads storage that yields SS58, and `Resources.Consumers` is keyed by
SS58, so the old hex return made every account to username round trip carry a manual conversion.
`wallet.signMessageWithDotNsIdentity` is unaffected: its `accountId` result is still `0x` hex.

`@parity/product-sdk-auth` gets a documentation fix only. Its `SessionAddresses.rootAddress` doc, and
the `product-sdk-transactions` skill that repeats it, both told callers `rootAddress` was "the right
input for `lookupUsername`" while no such function existed anywhere in the repo. Both now name the
package it lives in.

Re-exported from the umbrella as `@parity/product-sdk/individuality`. Documented by the
`product-sdk-individuality` skill.
