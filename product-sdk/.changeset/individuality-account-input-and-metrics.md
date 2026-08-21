---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**`readPersonhoodState` now takes an account as well as a username, and every resolved answer carries the numbers behind it.**

Two additions, both purely additive: no existing field changed and no state variant moved.

`readPersonhoodState(chain, { account })` reads an account's standing directly. It *skips* the `Resources.UsernameOwnerOf` lookup rather than adding a read, so the account path costs one round trip less than the username path — which is the common case for a profile or results screen, where an account is already in hand and the name is not. `UsernameUnowned` is unreachable on this path: nothing was looked up, so an account with no records resolves to `NotEnrolled`. Exactly one of `username` or `account` is accepted, checked at runtime: both, or neither, is an `err` result and costs no round trip. The option type rejects the obvious literal but not `{ username: maybeName, account: maybeAccount }` where both are `string | undefined`, so the runtime check is what holds the rule.

Every `Resolved` result now carries `metrics`: `score`, `personhoodThreshold`, `misses`, `allowedMisses` and `window`, from the same pinned snapshot as the state and at no extra read. The state variants only carry payload where the derivation needs it — `Candidate` has a score, `Member` does not — so a UI rendering progress for everyone previously could not read a score off half the union. It can now, without switching on the tag.

**`metrics.misses` is not `Caution.misses`.** The metric is what the window holds *now*. `Caution.misses` is a projection: what it would hold after one more absence, which is what the grace policy is evaluated against. A screen showing "you have missed 2 of the last 8 games" wants the metric.

Two items from the same issue are deliberately not here. The `NotMember` host probe stays out of this read: it can only answer for the local user's own registered key, it needs a prior key registration that writes host-local state, and its `KeyNotRegistered` error — the fresh-install case — says nothing about personhood. `People.AccountToPersonalId` stays unread, because the specification behind this state machine says no PersonalId reaches the client, and the host's own identity model does not carry one either.
