---
"@parity/product-sdk-terminal": minor
"@parity/product-sdk-auth": minor
---

**The terminal now runs the truapi core instead of `@novasamatech/host-papp`.**

The core handles pairing, the session, allowances and signing. It is the same Rust core every Polkadot host runs, started here in a Node worker thread through `@parity/truapi-host/node`.

**What users and data see**

- **Users pair once more.** Sessions from the earlier backend are not read. Auth's `clearLocalAppStorage` removes their `<appsDir>/<dappId>_*` files; terminal-only users can delete `~/.polkadot-apps/<appId>_*.json`.
- **Product addresses and entropy are unchanged for lowercase product ids.** The core lowercases and NFC-normalises `productId` before deriving, so `"My-App.dot"` now gives the account and entropy of `"my-app.dot"`.
- **`appId` must be a dotNS id** (ending in `.dot`, `.paseo` or `.testnet`) or `localhost`. The core refuses any other id.
- **`storageDir` is now the app's own directory.** It defaults to `~/.polkadot-apps/<appId>/`; the session lives in `core/` and the product's storage in `product/`. It is no longer a parent directory shared by several apps, so do not point two apps at the same `storageDir`.
- **Requires Node ≥22.** Do not bundle the package into one file: the core's worker and WASM load from files beside it.

**`@parity/product-sdk-terminal` API**

- `createTerminalAdapter` is now `async`. The adapter has `appId`, `storageDir`, `runtime`, `session`, `authState`, `onAuthStateChange`, `login`, `logout`, `client` and `destroy`. `logout` resolves once the wallet has been told, and rejects when it could not be reached within 30 s.
- Signers and helpers take the adapter instead of a `UserSession`: `createSessionSigner`, `createSessionSignerForAccount`, `deriveProductPublicKey`, `deriveEntropy`, `getStatementStoreProver` and `requestResourceAllocation`.
- `requestResourceAllocation(adapter, resources, { productId? })` returns one outcome per resource: `"Allocated"`, `"Rejected"` or `"NotAvailable"`. It has no `onExisting` option, because the core increases an existing allowance.
- New: `submitPreimage`, `submitStatement`, `defaultStorageDir`, `approveAll`, and the `approvals` option for answering the core's approval prompts.
- `StatementStoreNetworks` is replaced by `TerminalNetworks`, keyed by network with genesis hashes and endpoints for People, Bulletin and Asset Hub. Only `"paseo-next-v2"` is defined; `previewnet` is gone.
- Removed:
  - `waitForSessions`, `getProductSubtreePublicKey`, `ProductSubtreeOptions` and `INCOMPLETE_SESSION_MESSAGE`.
  - `getBulletinSigner`, `hasBulletinAllowance`, `hasStatementStoreAllowance`, `ensureSlotAccountSigner`, `createSlotAccountSigner`, `getCachedAllocation` and `sendResourceAllocation`. Use `submitPreimage`, `getStatementStoreProver` and `requestResourceAllocation`; the allowance keys stay in the core.
  - `createNodeStorageAdapter`, `isBenignTeardownError`, `SS_STABLE_STAGE_ENDPOINTS` and `StatementStoreEnvironment`.
  - `AllowanceError`, `ApAllocationOutcome`, `OnExistingAllowancePolicy`, `RequestResourceAllocationOptions`, and the re-exported host-papp types (`PappAdapter`, `UserSession`, `PairingStatus` and the rest).
  - The `./host` and `./testing` subpaths.

**`@parity/product-sdk-auth` API**

- `AuthConfig.peopleEndpoints` is replaced by `network`. There are new `storageDir` and `approvals` options.
- `AuthConfig.productId` must be a dotNS id. The client acts as it for every call, and keeps its session under `dappId`.
- `SessionHandle` now has `adapter` and `session` in place of `userSession`. `ResolvedSigner.userSession` is now `session`.
- `LoginHandle.authPromise` is now `session`, and `LogoutHandle.session` is removed.
- `requestAllocation(handle, resources?)` takes the `SessionHandle` and has no `onExisting` argument.
- `requestResourceAllocation(adapter, productId, resources?)` takes the adapter, and returns the string outcomes above.
- The Bulletin resource tag is `BulletinAllowance` (it was `BulletInAllowance`).
- `LoginStatus` has no `pending` step.
- `clearLocalAppStorage` removes only the session's `core/` and `product/` folders in `storageDir`, plus the old `<dappId>_*` files.
- `INCOMPLETE_SESSION_MESSAGE` and `OnExistingAllowancePolicy` are removed.
