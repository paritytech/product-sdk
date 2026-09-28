---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Watch the game, a registration and a participant record at the best block.**

- `watchCurrentGame(chain, onValue, onError)` follows `Game.Game`, decoded by `toCurrentGame`, and is `null` between games.
- `watchPlayer(chain, { player }, onValue, onError)` follows `Game.Players`, and is `null` for a player with no record.
- `watchParticipant(chain, { player }, onValue, onError)` follows `Score.Participants`, decoded by `toPersonhoodParticipant`.

Each returns the function that stops it, and passes the best block the value was read at. A value that fails to decode goes to `onError` and the watch keeps running, while a failed subscription goes to `onError` as a `ProductIndividualityError` and ends. PAPI emits once per best block whether or not the value changed, so a watch only delivers a value that differs from the last.

The contracts are `CurrentGameWatchChain`, `PlayerWatchChain` and `ParticipantWatchChain`, which a client from `getChainAPI` or `fromPapi` satisfies as it is.
