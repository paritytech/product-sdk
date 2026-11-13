---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
---

Adds `getNftPurseManager()`, a manager for the host's NFT purses with all 15 calls of `truApi.nftPurse`. A call returns the host's answer. A call that fails throws an `Error` with the host's error as `cause`, and the new `hostErrorName(error)` returns the name of that error, for example `OperationExists` or `Unsupported`. The subscriptions `observeOperationStatus`, `listenPaymentInbox` and `listenOneTimePayment` are opened again after a host connection reset. `isNftPurseOperationFinished(status)` returns true when an operation is finished. The package also exports the purse types of `@parity/truapi` and constants for the main purse id and the host's limits. `getNftPurseManager()` returns `null` outside a host. On a host that has no NFT purses every call fails with `Unsupported`.
