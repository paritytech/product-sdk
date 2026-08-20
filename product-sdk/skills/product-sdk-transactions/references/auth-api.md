# `@parity/product-sdk-auth` API Reference

QR/mobile sign-in + session signing for Polkadot product **CLIs**. The root
entrypoint is runtime-agnostic (no terminal UI); terminal-rendering helpers live
under the `./ui` subpath so headless consumers don't pull them in.

Package version documented: **0.2.0**. Re-verify names/signatures against the
shipped `dist/index.d.ts` before relying on them (`node -e "import('@parity/product-sdk-auth').then(m => console.log(Object.keys(m)))"`).

## Root entrypoint (`@parity/product-sdk-auth`)

### `createAuthClient(config: AuthConfig): AuthClient`

Builds a product-bound auth client. All adapter creation, address derivation, and
session-storage scoping read from `config`, so the same code serves any product.

```ts
interface AuthConfig {
  dappId: string;          // scopes ~/.polkadot-apps/${dappId}_* + the SSO pairing
  productId: string;       // derives the product account (/product/{productId}/{index})
  derivationIndex: number; // 0 = default product account
  peopleEndpoints: string[]; // People-parachain RPC endpoints
}
```

### `AuthClient`

| Method | Signature | Purpose |
|--------|-----------|---------|
| `connect` | `() => Promise<ConnectResult>` | Resolve login state: existing session (address only) or a QR payload + login handle. |
| `waitForLogin` | `(handle: LoginHandle, onStatus: (s: LoginStatus) => void) => Promise<string \| null>` | Await the running login; returns the SS58 product address or `null` on failure. |
| `getSessionSigner` | `() => Promise<SessionHandle \| null>` | Build a signer from the persisted session. `null` if none. Owns a WebSocket — call `.destroy()`. |
| `findSession` | `() => Promise<LogoutHandle \| null>` | Look up the paired session for sign-out. `null` if not signed in. |
| `waitForLogout` | `(handle: LogoutHandle, onStatus: (s: LogoutStatus) => void) => Promise<void>` | Disconnect the session (notifies the phone) and clear local files. |
| `requestAllocation` | `(session: UserSession, resources?: AllocatableResource[], onExisting?: OnExistingAllowancePolicy) => Promise<AllocationOutcome[]>` | RFC-0010 resource allocation. Defaults: `DEFAULT_RESOURCES`, `onExisting: "Ignore"`. |
| `clearLocalAppStorage` | `(dir?: string) => Promise<void>` | Best-effort removal of this app's `${dappId}_*` files under `~/.polkadot-apps/`. |

```ts
type ConnectResult =
  | { kind: "existing"; address: string; addresses: SessionAddresses }
  | { kind: "qr"; qrCode: string; login: LoginHandle };

type LoginStatus =
  | { step: "waiting" }
  | { step: "paired" }
  | { step: "pending"; stage: string }
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
  signer: PolkadotSigner;
  userSession: UserSession;
  destroy(): void;                 // REQUIRED — tears down the adapter WebSocket
}

interface LoginHandle { adapter: TerminalAdapter; authPromise: /* sso.authenticate() */ }
interface LogoutHandle { adapter: TerminalAdapter; address: string; session: UserSession }
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
  signer: PolkadotSigner;
  address: string;
  source: SignerSource;
  userSession?: UserSession;       // QR/mobile only (undefined for dev signers)
  addresses?: SessionAddresses;    // QR/mobile only
  destroy(): void;                 // call in a finally — no-op for dev signers
}
```

`class SignerNotAvailableError extends Error` — thrown when no signer can be resolved.
`parseDevAccountName(suri: string): DevAccountName | null` — parse a `//Alice`-style dev SURI (exact-case, `//` prefix required).

### Allocations (RFC-0010)

```ts
const DEFAULT_RESOURCES: AllocatableResource[]; // BulletInAllowance, StatementStoreAllowance, SmartContractAllowance(0)

// Standalone twin of authClient.requestAllocation — for callers that already have a session + productId.
function requestResourceAllocation(
  session: UserSession,
  productId: string,
  resources?: AllocatableResource[],   // default DEFAULT_RESOURCES
  onExisting?: OnExistingAllowancePolicy, // default "Ignore"
): Promise<AllocationOutcome[]>;

// Bucket outcomes by tag. Order-sensitive: outcomes[i] maps to resources[i].
function summarizeOutcomes(
  outcomes: AllocationOutcome[],
  resources: AllocatableResource[],
): { granted: AllocatableResource[]; rejected: AllocatableResource[]; unavailable: AllocatableResource[] };

type AllocationOutcome;              // re-export of terminal's ApAllocationOutcome; .tag: "Allocated" | "Rejected" | …
type AllocatableResource;            // re-export from terminal ({ tag, value })
type ResourceTag = AllocatableResource["tag"];
type OnExistingAllowancePolicy;      // re-export from terminal
```

### Session-signer primitives (re-exported from `@parity/product-sdk-terminal`)

```ts
createSessionSigner(session: UserSession, ref: ProductAccountRef): PolkadotSigner;
deriveProductPublicKey(session: UserSession, ref: ProductAccountRef): Uint8Array; // CLI counterpart of keys' deriveProductAccountPublicKey
sessionRootPublicKey(session: UserSession): Uint8Array;
const INCOMPLETE_SESSION_MESSAGE: string;
type ProductAccountRef;              // { productId, derivationIndex }
```

## `./ui` entrypoint (`@parity/product-sdk-auth/ui`)

Terminal-rendering helpers, isolated so the root stays headless.

```ts
renderQrCode(payload): Promise<string>;        // re-exported from terminal
renderLoginStatus(status: LoginStatus): string;
renderLogoutStatus(status: LogoutStatus): string;
```

## Lifecycle notes

- Every handle that owns an adapter (`SessionHandle`, `ResolvedSigner` with
  `source: "session"`) holds a live WebSocket. **Always `destroy()` in a `finally`** —
  otherwise the Node event loop stays alive and the CLI hangs on exit.
- `connect()`/`waitForLogin()` only authenticate and persist the session; they do
  not return a signer. Call `resolveSigner()`/`getSessionSigner()` afterward.
- A freshly paired session has no allowances — run `requestAllocation()` once
  (approved on the phone) before statement-store / Bulletin / contract writes.
