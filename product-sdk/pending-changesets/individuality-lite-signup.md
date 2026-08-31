---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**The free lite sign-up: `readLiteSignUpRequirement` decides, `signUpWithLiteInviteTx` builds.**

`Game.sign_up_with_account_lite_invite(account, identifier_key, airdrops)` is the
`Pays::No`, deposit-free game sign-up a lite person's bound account submits —
signed by that account under `withLiteAlias({ tag: "AliasWithAccount" })`.
`signUpWithLiteInviteTx(chain, { account, identifierKey, airdrops, airdropsScheduled })`
builds it unsigned with the same width and count guards as the account sign-up.

`readLiteSignUpRequirement(chain, { account, liteMemberKey? })` is
`readGameSignUpRequirement` plus the lite gates, all at one pinned block. Its
blockers are the new `LiteSignUpBlocker` — a union of the existing
`SignUpBlocker` (which is unchanged, so exhaustive consumers of the account read
keep compiling) and six lite arms: `AliasNotBound` (the proof-authorized
`PeopleLite.set_alias_account` bind leg has not run), `AliasBoundElsewhere` (the
binding exists outside `Score.score_context`), `AnotherAccountInvited` (the
forever `Game.LiteInvites` pin names a different account — carried in the
blocker so a UI can say which), `AccountInUse` (the account is itself a lite
person), `NotLiteMember` (the supplied member key is not an `Included` lite ring
member), and `ContextNotProductDerived` (`readScoreContext` answered that no
stock host can mint the proof). Every lite arm blocks the sign-up itself; the
draw-only split carries over from the account read unchanged.

```ts
const req = await readLiteSignUpRequirement(chain, { account, liteMemberKey });
if (req.ok && req.value.canSignUp) {
    const tx = signUpWithLiteInviteTx(chain, { account, identifierKey, airdrops });
    await submitAndWatch(tx, withLiteAlias(signer, { tag: "AliasWithAccount" }));
}
```

The new `LiteSignUpChain` contract (`PeopleLite.AccountToAlias`,
`PeopleLite.LitePeople`, `Game.LiteInvites`, `Members.Members`, the sign-up
call) is satisfied by paseo and previewnet; devnet predates it. TLDs, product
ids and the 65-byte communication key stay caller-supplied throughout.
