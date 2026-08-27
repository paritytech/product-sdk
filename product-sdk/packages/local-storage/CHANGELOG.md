# @parity/product-sdk-local-storage

## 0.3.6

### Patch Changes

- Updated dependencies [46e3592]
- Updated dependencies [46e3592]
- Updated dependencies [46e3592]
- Updated dependencies [46e3592]
- Updated dependencies [46e3592]
  - @parity/product-sdk-host@0.17.0

## 0.3.5

### Patch Changes

- Updated dependencies [3655724]
- Updated dependencies [3655724]
- Updated dependencies [3655724]
- Updated dependencies [3655724]
  - @parity/product-sdk-host@0.16.0

## 0.3.4

### Patch Changes

- Updated dependencies [70c30f3]
  - @parity/product-sdk-host@0.15.1

## 0.3.3

### Patch Changes

- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
  - @parity/product-sdk-host@0.15.0

## 0.3.2

### Patch Changes

- Updated dependencies [8ab88ba]
  - @parity/product-sdk-host@0.14.1

## 0.3.1

### Patch Changes

- Updated dependencies [c3fccfa]
- Updated dependencies [c3fccfa]
  - @parity/product-sdk-host@0.14.0

## 0.3.0

### Minor Changes

- cb0098f: **Ship dev-only test fakes under a new `/testing` subpath on each package.**

  Each package now exports a working in-memory fake of its interface from a
  dedicated `/testing` entry, so SDK-dependent app code can be unit-tested with no
  host container, chain, or wallet:

  - `@parity/product-sdk-local-storage/testing` — `createFakeHostLocalStorage`
  - `@parity/product-sdk-signer/testing` — `createFakeSignerProvider`, `fakeSignerAccount`
  - `@parity/product-sdk-statement-store/testing` — `createFakeStatementTransport`
  - `@parity/product-sdk-contracts/testing` — `createFakeContractRuntime`, `fakeDryRunResult`
  - `@parity/product-sdk-host/testing` — `createFakeTruApiClient`, `createFakeHost`, `setTruApiClient`
  - `@parity/product-sdk/testing` — `createFakeApp`, plus re-exports of the
    local-storage, signer, contracts, and host fakes

  The fakes are framework-agnostic, live behind separate build entries, and are
  absent from every package's main entry, so production bundles are unaffected.
  `@parity/product-sdk-host` additionally gains a module-level test seam
  (`setTruApiClient`, exposed only through `/testing`) that the host accessors
  consult before the sandbox client; it defaults to `null`, so production
  behavior is unchanged.

  See the new "Testing your app" guide in the docs for usage.

### Patch Changes

- Updated dependencies [cb0098f]
- Updated dependencies [cb0098f]
- Updated dependencies [cb0098f]
  - @parity/product-sdk-host@0.13.0

## 0.2.12

### Patch Changes

- Updated dependencies [f81fc2b]
- Updated dependencies [f81fc2b]
- Updated dependencies [f81fc2b]
  - @parity/product-sdk-host@0.12.0

## 0.2.11

### Patch Changes

- Updated dependencies [ef14a41]
  - @parity/product-sdk-host@0.11.0

## 0.2.10

### Patch Changes

- Updated dependencies [8dd1232]
  - @parity/product-sdk-host@0.10.3

## 0.2.9

### Patch Changes

- Updated dependencies [c39332e]
  - @parity/product-sdk-host@0.10.2

## 0.2.8

### Patch Changes

- Updated dependencies [9ce5ab2]
  - @parity/product-sdk-host@0.10.1

## 0.2.7

### Patch Changes

- Updated dependencies [acb2228]
- Updated dependencies [acb2228]
  - @parity/product-sdk-host@0.10.0

## 0.2.6

### Patch Changes

- Updated dependencies [2124e02]
- Updated dependencies [2124e02]
  - @parity/product-sdk-host@0.9.0

## 0.2.5

### Patch Changes

- Updated dependencies [a2fd276]
  - @parity/product-sdk-host@0.8.0

## 0.2.4

### Patch Changes

- Updated dependencies [d4bc935]
  - @parity/product-sdk-host@0.7.1

## 0.2.3

### Patch Changes

- Updated dependencies [f6bdaaf]
  - @parity/product-sdk-host@0.7.0

## 0.2.2

### Patch Changes

- Updated dependencies [dc3a452]
- Updated dependencies [dc3a452]
  - @parity/product-sdk-host@0.6.1

## 0.2.1

### Patch Changes

- Updated dependencies [551c1bb]
  - @parity/product-sdk-host@0.6.0

## 0.2.0

### Minor Changes

- 7610e61: ### `@parity/product-sdk-host`

  - New wrappers: `getChatManager`, `getThemeProvider`, `deriveEntropy`, `requestPermission`, `requestDevicePermission`.
  - New container helpers: `createHostLocalStorage`.
  - New TruAPI re-exports: `createHostPreimageManager`, `formatHostError`.
  - New type re-exports: `ProductAccountId`, `SignedStatement`, `Statement`, `Topic`, `ChatManager`, `ChatMessageContent`, `ChatReceivedAction`, `ChatRoom`, `ChatRoomRegistrationResult`, `ChatBotRegistrationResult`, `ChatCustomMessageRenderer`, `ChatCustomMessageRendererParams`, `ThemeMode`, `ThemeProvider`, `DevicePermissionKind`, `RemotePermissionItem`.

  ### `@parity/product-sdk-chain-client`

  - New exports: `WellKnownChain` constant + `WellKnownChainHash` type for canonical genesis-hash lookups.

  ### `@parity/product-sdk-local-storage`

  - Widened the typed KV interface to match the upstream Novasama surface: `readBytes` / `writeBytes` methods and keyed `clear(key)`. Test mocks updated accordingly.

  ### Umbrella

  - `@parity/product-sdk`: minor cascade per `RELEASES.md` — any constituent minor bump cascades the umbrella.

  No consumer-facing source-compat breaks: all changes are additive expansions of public exports.

### Patch Changes

- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
  - @parity/product-sdk-host@0.5.0

## 0.1.5

### Patch Changes

- Updated dependencies [4c13257]
  - @parity/product-sdk-host@0.4.0

## 0.1.4

### Patch Changes

- Updated dependencies [bdeb144]
  - @parity/product-sdk-host@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [1cc3790]
  - @parity/product-sdk-host@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [5d81610]
- Updated dependencies [5d81610]
  - @parity/product-sdk-host@0.2.1

## 0.1.1

### Patch Changes

- 646d591: **Build + docs cleanup affecting published artifacts.**

  No public API changes. Two improvements that change shipped bytes:

  - `tsup` `treeshake: true` is now enabled across every package's build config (#48), so dead in-source vitest test code is stripped from the published bundles. Smaller install footprint with no behavior change.
  - `@packageDocumentation` blocks and TSDoc comments added across the SDK (#38), surfaced in the published `.d.ts` files for editor hover docs and the docs site.

  Packages already taking a `minor` bump in this release (`bulletin`, `chain-client`, `contracts`, `descriptors`, `host`, `keys`, `signer`, `statement-store`, `tx`, `sdk`) inherit these changes via that bump and are not listed here.

- Updated dependencies [646d591]
- Updated dependencies [646d591]
  - @parity/product-sdk-logger@0.1.1
  - @parity/product-sdk-host@0.2.0

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-host@0.1.0
  - @parity/product-sdk-logger@0.1.0
