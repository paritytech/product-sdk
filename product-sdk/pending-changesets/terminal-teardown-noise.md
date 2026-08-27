---
"@parity/product-sdk-terminal": minor
---

**Stop `adapter.destroy()` from logging benign `DestroyedError` teardown noise, and export the filter consumers were hand-rolling.**

Destroying the terminal adapter while a statement-subscription observable is still live makes `@novasamatech/statement-store` log `Statement subscription error: Client destroyed` to `console.error` synchronously, from inside `disconnect()`. Draining the tracked unsubscribe RPCs does not cover that observable's error emission, so the line still escaped, and every consumer (bulletin-deploy, playground-cli, d3pot) hand-rolled a filter to keep clean CLI output.

`destroy()` now runs the disconnect under a scoped `console.error` filter that drops only the benign teardown line and restores itself in a `finally` — every other `console.error` passes through untouched, so a genuine error during teardown is still visible, and overlapping `destroy()`s can't strand the patch. This restores (and narrows) the suppression a previous refactor had removed in favour of an ordering-only approach that didn't reach the upstream error.

Also exports `isBenignTeardownError(error: unknown): boolean`, the predicate `destroy()` uses. It matches on the message text (`Client destroyed`), not the error name, so it never swallows another package's `DestroyedError` — notably `@parity/product-sdk-signer`'s. Export it so a consumer with its own `console.error` guard can drop the same line without reinventing the match.
