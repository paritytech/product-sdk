---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

Add game registration in one call, so every product that signs players up for the weekly game (the game's app and chat, the personhood product) runs the same steps and gives the same answers.

- `registerForGame(chain, capabilities, options)` reads the seat, binds the lite alias when the free route needs it, decides the prize-draw entries at the best block, then hands the call, signed under the origin its route needs, to a `submit` capability. Registration is judged by the chain's clock, and the sign-up resolves at the best block unless `waitFor: "finalized"` is asked for. The draws never block the sign-up: a draw that is not open yet, or a read that fails, costs the tickets, and the outcome says why. An abort before the broadcast sends nothing.
- Every outcome, and every `GameRegistrationError`, carries a report and names the step that failed and whether a retry can help; `registrationRetryDelay` gives the backoff. A declined signature is never asked for again.
- `readGameSeat` and the pure `deriveSeat` give the route (`returning`, `free`, `deposit` or `unfunded`), so every product shows the same answer.
- `bindGameSeat` runs the bind on its own: a current binding and a bind that cannot succeed ask for no proof, the `Game.LiteInvites` pin is checked before it goes out, and a bind no block holds within `timeoutMs` fails with `landingUnknown`.
- `GAME_PRODUCT_NAME`, `GAME_ACCOUNT_INDEX` and `gameProductId` name the game account in one place.
- The new `@parity/product-sdk-individuality/host` entry builds the capabilities from a host with `hostGameRegistrationCapabilities`, submitting through `@parity/product-sdk-tx`. The main entry imports neither.
