---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Read the roster of the running game: player indices, group members, communication identifiers and credit candidates.**

- `readPlayerIndices(chain, { player })` reads `Game.PlayerToIndex`, one index per round.
- `readGroupMembers(chain, { round, ownIndex, playerCount, maxGroupSize })` resolves every occupied seat of one group through `Game.IndexToPlayer`.
- `readCommunicationIdentifier(chain, { account })` reads the 65-byte key an account registered at sign-up from `Game.CommunicationIdentifiers`.
- `readCreditCandidates(chain, { attestee })` reads the game and the roster at one block and names every credit the attestee could earn, one per co-player per round, hashed with `creditHash`. Matching them against `readCredits` separates the awarded credits from the pending ones.
- `numberOfGroups` and `groupSeats` are the pure group arithmetic of the pallet, empty seats included.

The roster exists from the end of the shuffle until `PlayerProcess::Step2ClearIndices` drains it, so `CurrentGame` now carries `playerCount`, read from the game state, which is `null` outside that window. Read the game first, and cache the candidates if they have to outlive it.

**Breaking for implementors.** `playerCount` is a required member of the exported `CurrentGame` interface, so hand-built values and test doubles must add it. Callers are unaffected.
