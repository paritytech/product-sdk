---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Read a game's prize draws and whether you won any of them, all at one block.**

```ts
import { readPrizeStatus } from "@parity/product-sdk-individuality";

const status = await readPrizeStatus(chain, {
    registrant: { tag: "Account", accountAddress },
});
if (status.ok && status.value.tag === "Draws") {
    for (const draw of status.value.draws) {
        if (draw.outcome.tag === "Won") console.log(draw.eventId, draw.phase);
    }
}
```

**This exists as one function because the composition is the hard part.** `readCurrentGame` and
`readAirdropDraw` each pin their own finalized block when called alone, so assembling this by
hand reads two blocks and can report a draw as still registering while it already holds its
winners. `readPrizeStatus` pins once and hands the snapshot to every inner read.

**Claiming after the game ends is the ordinary case, and it needs a count only you have.**
`airdrops_scheduled` lives on `Game.Game`, which holds the *running* game — but a claim window
runs to the draw's `end_time`, by which point the chain has moved on and the ended game's draw
count is unreadable. So pass what you captured while it ran:

```ts
await readPrizeStatus(chain, { game: { index: 41, airdropsScheduled: 2 }, registrant });
```

Supplying `game` skips the game read entirely — four fewer storage reads — so `game` on the
result is `null` even if that index happens to be the running one. The result reports
`drawCountFrom: "chain" | "caller"` so a consumer knows which it got.

**There is no probe fallback, deliberately.** Probing event ids upward cannot distinguish a draw
that was cleaned up from one that was never scheduled, so a short answer would read as "you won
nothing" — the one wrong answer that matters here. Between games with no captured game, the
result is `NoGame` carrying the upcoming schedule, rather than a guess.

`readPrizeStatus` deliberately does not scan `Airdrop.Registrations`; `readDrawRegistration`
does, and ships in the same wave.

Internally, block pinning moved into one place so the inner reads can share a snapshot. No public
API changed for that, and `readCurrentGame` / `readAirdropDraw` still pin their own block when
called directly.
