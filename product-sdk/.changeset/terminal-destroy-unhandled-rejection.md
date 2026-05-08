---
"@parity/product-sdk-terminal": minor
---

**Fix unhandled promise rejection from `destroy()` when in-flight statement subscriptions are torn down. `destroy()` is now `async` (`Promise<void>`).**

`destroy()` previously called `lazyClient.disconnect()` in the same tick as `sessions.dispose()`. `disconnect()` synchronously rejects every still-pending request on the substrate client with `DestroyedError("Client destroyed")` — so the fire-and-forget unsubscribe RPCs that `sessions.dispose()` had just queued never got to leave, and any in-flight statement subscribes rejected. Those rejections surfaced as `Statement subscription error: Client destroyed` console.error logs AND as unhandled promise rejections, which propagate up and crash some test runners.

### How the fix works

The lazy-client is wrapped (`wrapLazyClient`) in a transparent proxy that tracks every server-side unsubscribe fired through `getSubscribeFn`'s teardown callback. `destroy()` then runs:

1. `sessions.dispose()` — synchronous; calls each wrapped subscribe's teardown, which fires the unsubscribe RPC and records a tracking Promise that resolves two microtask hops later.
2. `await lazyClient.awaitPendingUnsubs()` — `Promise.allSettled` over the tracked Promises. Resolves once each tracked teardown has had its microtask window.
3. `lazyClient.disconnect()` — calls `substrateClient.destroy()`. By this point the unsubscribe RPCs have flushed into the WebSocket write queue, so no `DestroyedError` rejections fire on the queued requests.

No `setTimeout` wall-clock guesswork, no `console.error` monkey-patch, no `process.on('unhandledRejection')` global mutation. The two-microtask wait is a scheduling heuristic — not a true completion observer — but it's empirically reliable on Node because the substrate-client's send path is microtask-scheduled, and it removes the global-state hazards of the previous implementation. Pending subscribes (`onSuccess` not yet fired) are cancelled in-band by the underlying `getSubscribeFn` teardown via `cancelRequest()`, which doesn't surface as a rejection.

### API change

`destroy()` now returns `Promise<void>` instead of `void`. Awaiting is recommended (`await adapter.destroy()`) but not required — callers that ignore the return value get fire-and-forget shape. **Marked as `minor`** because the type signature changed (added a return value), even though the change is structurally additive: TypeScript callers ignoring the return continue to type-check.
