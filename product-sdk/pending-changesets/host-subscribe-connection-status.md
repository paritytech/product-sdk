---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**Export `subscribeConnectionStatus` for host-channel connection state.**

Watching whether the host channel is up previously meant importing `@parity/truapi/sandbox`
directly. The callback fires synchronously with the current status and again on every change;
the returned function unsubscribes. Repeats of the status you already hold are suppressed.

```ts
import { subscribeConnectionStatus, type HostConnectionStatus } from "@parity/product-sdk-host";

const unsubscribe = subscribeConnectionStatus((status) => setStatus(status));
```

This is the **transport** channel — for the host's account-level connection, use
`AccountsProvider.subscribeAccountConnectionStatus`. The type is `HostConnectionStatus` because
`@parity/product-sdk-signer` already exports `ConnectionStatus` for a signer provider's lifecycle:
same three states, different meaning.

Also fixes a stuck status. `@parity/truapi` 0.7.0 never clears its cached client when the pipe
closes, so a subscriber arriving after a disconnect reported `"connecting"` — permanently, and for
every other subscriber too. This holds `"disconnected"` until a real `"connected"` arrives.

**Testing.** `@parity/product-sdk-host/testing` gains `emitConnectionStatus(status)`, also on
`FakeHost`, so a product can drive its reconnecting / offline UI. `setTruApiClient` now notifies live
subscribers when it injects or clears a client.

**Breaking for implementors.** `emitConnectionStatus` is a required member of the exported `FakeHost`
interface, so hand-rolled test doubles must add it. Callers of `createFakeHost()` are unaffected.
