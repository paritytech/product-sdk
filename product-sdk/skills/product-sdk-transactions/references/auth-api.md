# `@parity/product-sdk-auth` API Reference

QR/mobile sign-in + session signing for Polkadot product **CLIs**. The root
entrypoint is runtime-agnostic (no terminal UI); terminal-rendering helpers live
under the `./ui` subpath so headless consumers don't pull them in.

Package version documented: **0.6.0**. Re-verify names/signatures against the
shipped `dist/index.d.ts` before relying on them (`node -e "import('@parity/product-sdk-auth').then(m => console.log(Object.keys(m)))"`).

## Root entrypoint (`@parity/product-sdk-auth`)

### `createAuthClient(config: AuthConfig): AuthClient`

Builds a product-bound auth client. All adapter creation, address derivation, and
session-storage scoping read from `config`, so the same code serves any product.
The client runs `@parity/product-sdk-terminal`'s adapter (the truapi core), acting as
`productId` for every call.

```ts
interface AuthConfig {
  dappId: string;          // the CLI's own id; names its storage dir ~/.polkadot-apps/<dappId>
  productId: string;       // dotNS id, e.g. "my-cli.dot"; derives the product account (//product//{productId}/{index})
  derivationIndex: number; // 0 = default product account
  network?: TerminalNetworkName | TerminalNetwork; // default "paseo-next-v2", or an entry of TerminalNetworks
  storageDir?: string;     // default ~/.polkadot-apps/<dappId>; the session lives in its core/ and product/
  approvals?: TerminalApprovals; // answers the core's approval prompts; default approves them
}
```

`productId` must be a dotNS id (ending in `.dot`, `.paseo` or `.testnet`) or `localhost`;
the core refuses any other id. `TerminalNetworks`, `TerminalNetwork`, `TerminalNetworkName`
and `TerminalApprovals` come from `@parity/product-sdk-terminal`.

### `AuthClient`

| Method | Signature | Purpose |
|--------|-----------|---------|
| `connect` | `() => Promise<ConnectResult>` | Resolve login state: existing session (address only) or a QR payload + login handle. |
| `waitForLogin` | `(handle: LoginHandle, onStatus: (s: LoginStatus) => void) => Promise<string \| null>` | Await the running login; returns the SS58 product address or `null` on failure. |
| `getSessionSigner` | `() => Promise<SessionHandle \| null>` | Build a signer from the persisted session. `null` if none. Owns the core's worker thread — call `.destroy()`. |
| `findSession` | `() => Promise<LogoutHandle \| null>` | Look up the paired session for sign-out. `null` if not signed in. |
| `waitForLogout` | `(handle: LogoutHandle, onStatus: (s: LogoutStatus) => void) => Promise<void>` | Disconnect the session (notifies the phone) and clear local files. |
| `requestAllocation` | `(session: SessionHandle, resources?: AllocatableResource[]) => Promise<AllocationOutcome[]>` | RFC-0010 resource allocation for `productId`. Default: `DEFAULT_RESOURCES`. The core increases an existing allowance. |
| `clearLocalAppStorage` | `(appsDir?: string) => Promise<void>` | Removes the session's `core/` and `product/` folders in `storageDir`, plus any old `<dappId>_*` session files in `appsDir` (default `~/.polkadot-apps`). Nothing else is touched. |

```ts
type ConnectResult =
  | { kind: "existing"; address: string; addresses: SessionAddresses }
  | { kind: "qr"; qrCode: string; login: LoginHandle };

type LoginStatus =
  | { step: "waiting" }
  | { step: "paired" }
  | { step: "success"; address: string; addresses: SessionAddresses }
  | { step: "error"; message: string };

type LogoutStatus =
  | { step: "disconnecting"; address: string }
  | { step: "success"; address: string }
  | { step: "partial"; address: string; reason: string } // local cleared, remote unreachable
  | { step: "error"; message: string };

interface SessionAddresses {
  rootAddress: string;             // SS58 of the mobile root account (input for lookupUsername, from @parity/product-sdk-individuality)
  productAddress: string;          // SS58 of the derived product account — signs on-chain
  productH160: `0x${string}`;      // same product pubkey as a 20-byte EVM address (Revive/contracts)
}

interface SessionHandle {
  address: string;
  addresses: SessionAddresses;
  signer: CommonSignerTxCreator;
  adapter: TerminalAdapter;        // pass to terminal helpers (deriveProductPublicKey, submitPreimage, ...)
  session: TerminalSession;
  destroy(): void;                 // REQUIRED — stops the adapter's core thread
}

interface LoginHandle {
  adapter: TerminalAdapter;
  session: Promise<TerminalSession>; // the login connect() started; resolves once the phone finishes pairing
}
interface LogoutHandle { adapter: TerminalAdapter; address: string }
```

### `resolveSigner(authClient: AuthClient, options?: SignerOptions): Promise<ResolvedSigner>`

The blessed "give me a signer" call. Precedence:

1. `options.suri` → dev signer. Accepts a well-known dev name (`//Alice` … `//Ferdie`)
   OR a full BIP-39 mnemonic with an optional `//<path>` derivation suffix.
2. Persisted QR session → session signer (via `authClient.getSessionSigner()`).
3. Neither → throws `SignerNotAvailableError`.

```ts
interface SignerOptions { suri?: string }        // takes priority over the session
type SignerSource = "dev" | "session";

interface ResolvedSigner {
  signer: CommonSignerTxCreator;
  address: string;
  source: SignerSource;
  session?: TerminalSession;       // QR/mobile only (undefined for dev signers)
  addresses?: SessionAddresses;    // QR/mobile only
  destroy(): void;                 // call in a finally — no-op for dev signers
}
```

`class SignerNotAvailableError extends Error` — thrown when no signer can be resolved.
`parseDevAccountName(suri: string): DevAccountName | null` — parse a `//Alice`-style dev SURI (exact-case, `//` prefix required).

### Allocations (RFC-0010)

```ts
const DEFAULT_RESOURCES: AllocatableResource[]; // BulletinAllowance, StatementStoreAllowance, SmartContractAllowance { tag: "Index", value: 0 }

// Standalone twin of authClient.requestAllocation — for callers that already have an adapter + productId.
function requestResourceAllocation(
  adapter: TerminalAdapter,
  productId: string,
  resources?: AllocatableResource[],   // default DEFAULT_RESOURCES
): Promise<AllocationOutcome[]>;       // one outcome per resource, in order; refusals are outcomes, transport failures throw

// Bucket outcomes by tag. Order-sensitive: outcomes[i] maps to resources[i].
function summarizeOutcomes(
  outcomes: AllocationOutcome[],
  resources: AllocatableResource[],
): { granted: AllocatableResource[]; rejected: AllocatableResource[]; unavailable: AllocatableResource[] };

type AllocationOutcome = "Allocated" | "Rejected" | "NotAvailable"; // re-export from terminal (@parity/truapi)
type AllocatableResource;            // re-export from terminal (@parity/truapi); tags: BulletinAllowance,
                                     // StatementStoreAllowance, SmartContractAllowance, AutoSigning
type ResourceTag = AllocatableResource["tag"];
```

### Session-signer primitives (re-exported from `@parity/product-sdk-terminal`)

```ts
// createSessionSigner is terminal's createSessionSignerForAccount
createSessionSigner(adapter: TerminalAdapter, ref: ProductAccountRef, options?: SessionSignerOptions): Promise<CommonSignerTxCreator>;
deriveProductPublicKey(adapter: TerminalAdapter, ref: ProductAccountRef): Promise<Uint8Array>;
sessionRootPublicKey(session: TerminalSession): Uint8Array;  // the wallet's root, NOT a product account
type ProductAccountRef;              // { productId, derivationIndex, publicKey? }
```

The first two are async: the core asks the paired wallet for the product's subtree key
(one round trip on a cold cache). Pass `ref.publicKey` to `createSessionSigner` to skip it.
See `keys-api.md` for why the fetch is unavoidable. With a `SessionHandle`, use
`handle.adapter`.

## `./ui` entrypoint (`@parity/product-sdk-auth/ui`)

Terminal-rendering helpers, isolated so the root stays headless.

```ts
renderQrCode(data, options?): Promise<string>; // re-exported from terminal
renderLoginStatus(status: LoginStatus): string;
renderLogoutStatus(status: LogoutStatus): string;
```

## Lifecycle notes

- Every handle that owns an adapter (`SessionHandle`, `ResolvedSigner` with
  `source: "session"`) runs the truapi core in a worker thread. **Always `destroy()` in a `finally`** —
  otherwise the thread keeps the Node process alive and the CLI hangs on exit.
- The session lives in `~/.polkadot-apps/<dappId>/core` and `.../product` (or under
  `storageDir`). Do not point two CLIs at the same `storageDir`.
- Requires Node ≥22. Do not bundle `@parity/product-sdk-terminal` into one file: the
  core's worker and WASM load from files beside it.
- `connect()`/`waitForLogin()` only authenticate and persist the session; they do
  not return a signer. Call `resolveSigner()`/`getSessionSigner()` afterward.
- A freshly paired session has no allowances — run `requestAllocation()` once
  (approved on the phone) before statement-store / Bulletin / contract writes.
