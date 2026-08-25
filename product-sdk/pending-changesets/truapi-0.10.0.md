---
"@parity/product-sdk-host": patch
---

Update `@parity/truapi` to 0.10.0. No SDK API changes: the bump is additive on
truapi's side and nothing in `@parity/product-sdk-host` consumes the new surface
yet. 0.10.0 adds `createWebSocketProvider(url)` / `connectWebSocketHost(url)` for
hosts that serve protocol frames over a WebSocket (so a plain browser tab against
such a host is detected as hosted and shares the cached client), and exports the
`PREVIEWNET_INDIVIDUALITY` / `PREVIEWNET_ASSET_HUB` well-known chains. Bumping
keeps the catalog current with the latest published client.
