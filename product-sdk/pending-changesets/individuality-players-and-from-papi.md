---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**`readCurrentGame` answers "is this player in?", and takes a PAPI client directly.**

Pass `players` and the running game carries a `registration` read at the same pinned
block. One person is keyed twice in `Game.Players` — by account and, once recognized,
by alias — so every key the caller holds goes in and any hit is `Registered`. A key
read that fails is `Unknown`, never `NotRegistered`, and does not fail the game read;
leave `players` out and it is `Unchecked`. That path needs the new `GamePlayersChain`
on top of `GameChain`; the existing call without `players` is unchanged.

```ts
const game = await readCurrentGame(chain, {
  players: [{ tag: "Account", accountAddress }, { tag: "Alias", alias }],
});
if (game.ok && game.value.tag === "Running") {
  game.value.registration.tag; // Registered | NotRegistered | Unknown | Unchecked
}
```

`fromPapi(client, api)` builds the chain shape every read here takes from a
`PolkadotClient` and typed API the caller already holds, for products that resolve
their own connection instead of using `@parity/product-sdk-chain-client`.
