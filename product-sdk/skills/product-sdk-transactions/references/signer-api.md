# @parity/product-sdk-signer API Reference

> **`SS58String`** is a branded `string` type from `@parity/product-sdk-address`.

## SignerManager

Core orchestrator for signer management across the Host API and dev accounts.

```ts
import { SignerManager } from "@parity/product-sdk-signer";
```

### Constructor

```ts
new SignerManager(options?: SignerManagerOptions)
```

### Methods

#### connect

```ts
connect(providerType?: ProviderType): Promise<Result<SignerAccount[], SignerError>>
```

Connect to a provider. Defaults to the Host API; pass `"dev"` for dev accounts (testing).
The SDK is designed for container-only usage — `connect()` with no argument always targets the Host API.

#### selectAccount

```ts
selectAccount(address: string): Result<SignerAccount, SignerError>
```

Select an account by SS58 address.

#### getSigner

```ts
getSigner(): PolkadotSigner | null
```

Get the `PolkadotSigner` for the currently selected account.

#### signRaw

```ts
signRaw(data: Uint8Array): Promise<Result<Uint8Array, SignerError>>
```

Sign arbitrary bytes with the currently selected account.

#### subscribe

```ts
subscribe(callback: (state: SignerState) => void): () => void
```

Subscribe to state changes. Returns an unsubscribe function.

#### destroy

```ts
destroy(): void
```

Destroy the manager and release all resources.

---

## Providers

### DevProvider

```ts
import { DevProvider } from "@parity/product-sdk-signer";

const provider = new DevProvider({ names: ["Alice", "Bob"] });
```

### HostProvider

```ts
import { HostProvider } from "@parity/product-sdk-signer";

const provider = new HostProvider({
  ss58Prefix: 42,
  requestTransactionSubmitPermission: true,
});
```

---

## Error Classes

All errors extend `SignerError`:

- `HostUnavailableError`
- `HostRejectedError`
- `HostDisconnectedError`
- `SigningFailedError`
- `NoAccountsError`
- `TimeoutError`
- `AccountNotFoundError`
- `DestroyedError`

### Type Guards

```ts
function isHostError(e: SignerError): boolean
```

---

## Types

### SignerAccount

```ts
interface SignerAccount {
  address: SS58String;
  h160Address: `0x${string}`;
  publicKey: Uint8Array;
  name: string | null;
  source: ProviderType;
  getSigner(): PolkadotSigner;
}
```

### SignerState

```ts
interface SignerState {
  status: ConnectionStatus;
  accounts: readonly SignerAccount[];
  selectedAccount: SignerAccount | null;
  activeProvider: ProviderType | null;
  error: SignerError | null;
}
```

### ConnectionStatus

```ts
type ConnectionStatus = "disconnected" | "connecting" | "connected";
```

### ProviderType

```ts
type ProviderType = "host" | "dev";
```

### Result

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
```
