---
"@parity/product-sdk-terminal": minor
---

**Expose host-papp's allowance service through `@parity/product-sdk-terminal` with CLI-friendly defaults — including cache-only probes that never trigger a wallet prompt.**

Four new helpers:

- `getBulletinSigner(adapter, productId, sessionId?): Promise<PolkadotSigner>` — prompt-allowed fetch (cache hit, or wallet round-trip on miss).
- `getStatementStoreProver(adapter, productId, sessionId?): Promise<StatementProver>` — same for the statement-store path.
- `hasBulletinAllowance(adapter, productId, sessionId?): Promise<boolean>` — **cache-only probe**, never prompts the wallet. Resolves `true` when an allowance slot for `(sessionId, productId, bulletin)` is already cached on disk; `false` when it isn't. Use for login health checks, readiness probes, or any path that must not surface a phone dialog.
- `hasStatementStoreAllowance(adapter, productId, sessionId?): Promise<boolean>` — same for statement-store.

All four share the same defaulting + error idiom:

- `sessionId` defaults to the only paired session. When zero or more than one sessions are paired and no id is supplied, all four throw `AllowanceError` with `reason: 'NoSession'`.
- The fetching helpers (`getBulletinSigner` / `getStatementStoreProver`) unwrap host-papp's neverthrow `ResultAsync` to a `Promise<T>` that throws `AllowanceError` on failure — matching the throwy/async idiom of `createSessionSigner` and `requestResourceAllocation`.
- The cache-only helpers (`has*Allowance`) read host-papp's encrypted on-disk allowance file directly via a vendored mirror of host-papp's `AllowanceRepository` codec. The mirror will be retired once host-papp exposes a cache-only probe on its public surface; the public surface here won't change.

`AllowanceError` (and the `AllowanceErrorReason` / `AllowanceService` types) are now re-exported from `@parity/product-sdk-terminal`, so consumers don't need a direct `@novasamatech/host-papp` import.

```ts
import {
    createTerminalAdapter,
    getBulletinSigner,
    hasBulletinAllowance,
    AllowanceError,
} from "@parity/product-sdk-terminal";

const adapter = createTerminalAdapter({ appId: "my-cli" });
// ... QR pair, await waitForSessions(adapter) ...

if (await hasBulletinAllowance(adapter, "my-cli.dot")) {
    // happy path — no wallet prompt risk
    const signer = await getBulletinSigner(adapter, "my-cli.dot");
    await bulletinClient.tx.TransactionStorage.store({ data }).signAndSubmit(signer);
} else {
    console.log("Approve the allowance request on your phone…");
    const signer = await getBulletinSigner(adapter, "my-cli.dot");
    // …
}
```

The existing `@parity/product-sdk-terminal/host` subpath (`ensureSlotAccountSigner`, `requestResourceAllocation`, `createSlotAccountSigner`, `getCachedAllocation`) is unchanged. Use the `./host` subpath when you need explicit multi-session handling, batched allocation requests, or cache inspection.
