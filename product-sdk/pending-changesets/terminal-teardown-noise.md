---
"@parity/product-sdk-terminal": minor
---

**Stop `adapter.destroy()` from logging benign `DestroyedError` teardown noise, and export the filter consumers were hand-rolling.**

Destroying the terminal adapter while a statement-subscription observable is still live makes `@novasamatech/statement-store` log `Statement subscription error: DestroyedError: Client destroyed` to `console.error` from a detached finalizer — often after `destroy()`'s Promise has resolved. Draining the tracked unsubscribe RPCs does not cover that observable's error emission, so the line still escaped, and every consumer (bulletin-deploy, playground-cli, d3pot) hand-rolled the same `/DestroyedError|Client destroyed/` filter to keep clean CLI output.

`destroy()` now runs the disconnect, plus a short tail past it, under a scoped `console.error` filter that drops only the benign teardown line and restores itself afterward — every other `console.error` passes through untouched, so a genuine error during teardown is still visible. This restores (and narrows) the suppression a previous refactor had removed in favour of an ordering-only approach that didn't reach the upstream finalizer.

Also exports `isBenignTeardownError(error: unknown): boolean`, the predicate `destroy()` uses, so consumers wiring their own subscription `onError` handlers can drop the benign line without reinventing the regex.
