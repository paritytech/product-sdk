---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
---

`PaymentManager` follows the host's payments by id. `topUp({ id, amount, source, into? })` and `requestPayment({ id, amount, destination, from? })` take a 32-byte id the product chooses, so starting one again after a restart is answered `AlreadyExists` instead of moving funds twice. `requestPayment` resolves with nothing, `subscribePaymentStatus(id, …)` follows a payment by that id, and the new `subscribeTopUpStatus(id, …)` follows a top-up to `Claimed { finalized: true }`, `ClaimedPartially` or `NotClaimed`. `newPaymentId()` makes a random id for a product with nothing to derive one from. Breaking: the positional `topUp(amount, source, into?)` and `requestPayment(amount, destination, from?)` signatures and the `{ id }` response are gone. Needs the `@parity/truapi` release that carries payments by id; `RemotePermission` gains `BalanceAccess` with it. `subscribeBalance` needs `BalanceAccess`: the balance is the user's, per purse, and a grant revoked while subscribed ends the subscription with `PermissionDenied`.
