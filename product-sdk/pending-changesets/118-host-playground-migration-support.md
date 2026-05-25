---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk-local-storage": minor
---

### `@parity/product-sdk-host`

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
