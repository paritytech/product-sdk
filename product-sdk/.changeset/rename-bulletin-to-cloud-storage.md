---
"@parity/product-sdk-cloud-storage": major
"@parity/product-sdk": major
---

Rename `@parity/product-sdk-bulletin` to `@parity/product-sdk-cloud-storage` and abstract the public surface away from chain-specific naming. The package is still backed by the Polkadot Bulletin Chain — the rename only affects user-facing types, methods, and configuration so callsites no longer need to know about the underlying implementation.

### Migration

| Before | After |
| --- | --- |
| `@parity/product-sdk-bulletin` | `@parity/product-sdk-cloud-storage` |
| `BulletinClient` | `CloudStorageClient` |
| `BulletinApi` | `CloudStorageApi` |
| `BulletinChain` (preset record) | `CloudStorageNetworks` |
| `BulletinNetwork` (interface) | `CloudStorageNetwork` |
| `BulletinEnvironment` | `CloudStorageEnvironment` |
| `CreateBulletinClientOptions` | `CreateCloudStorageClientOptions` |
| `ProductBulletinError` | `ProductCloudStorageError` |
| `Bulletin*Error` family (our errors) | `CloudStorage*Error` |
| `app.bulletin` | `app.cloudStorage` |
| `bulletin?:` config | `cloudStorage?:` |
| `@parity/product-sdk/bulletin` subpath | `@parity/product-sdk/cloud-storage` |

Upstream re-exports from `@parity/bulletin-sdk` (`AsyncBulletinClient`, `BulletinPreparer`, `MockBulletinClient`, `BulletinClientInterface`, `BulletinTypedApi`, `BulletinError`, `ErrorCode`) remain available on the public surface for power users.

Chain-level identifiers (`chains.bulletin`, `@parity/product-sdk-descriptors/bulletin`, the `paseo` environment) keep their existing names — those packages are explicitly about the chain, not the storage abstraction.
