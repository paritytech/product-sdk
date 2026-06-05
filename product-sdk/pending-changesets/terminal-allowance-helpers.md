---
"@parity/product-sdk-terminal": minor
---

**Expose host-papp's allowance service through `@parity/product-sdk-terminal` with CLI-friendly defaults.**

Two new helpers — `getBulletinSigner(adapter, productId, sessionId?)` and `getStatementStoreProver(adapter, productId, sessionId?)` — wrap host-papp's `adapter.allowance` for the common CLI case:

- `sessionId` defaults to the only paired session. When zero or more than one sessions are paired and no id is supplied, both throw `AllowanceError` with `reason: 'NoSession'`.
- The underlying neverthrow `ResultAsync` is unwrapped to a `Promise<T>` that throws `AllowanceError` on failure — matching the throwy/async idiom of `createSessionSigner` and `requestResourceAllocation`.

`AllowanceError` (and the `AllowanceErrorReason` / `AllowanceService` types) are now re-exported from `@parity/product-sdk-terminal`, so consumers don't need a direct `@novasamatech/host-papp` import.

```ts
import {
    createTerminalAdapter,
    getBulletinSigner,
    AllowanceError,
} from "@parity/product-sdk-terminal";

const adapter = createTerminalAdapter({ appId: "my-cli" });
// ... QR pair, await waitForSessions(adapter) ...
const signer = await getBulletinSigner(adapter, "my-cli.dot");
await bulletinClient.tx.TransactionStorage.store({ data }).signAndSubmit(signer);
```

The existing `@parity/product-sdk-terminal/host` subpath (`ensureSlotAccountSigner`, `requestResourceAllocation`, `createSlotAccountSigner`, `getCachedAllocation`) is unchanged. Use the `./host` subpath when you need explicit multi-session handling, batched allocation requests, or cache inspection.
