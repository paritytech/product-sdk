---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**Add a `getNotificationManager()` host wrapper.**

`getNotificationManager()` returns the host's `notificationManager` singleton
(`push` / `cancel`), matching the `getPaymentManager` / `getPreimageManager`
pattern. The module also re-exports `PushNotificationError` (with its
`ScheduleLimitReached` variant, for `instanceof` branching on the host's
pending-notification cap) plus the derived `NotificationId` /
`PushNotificationInput` types.

Lets consumers reach the host push-notification surface without importing
`@novasamatech/host-api(-wrapper)` directly.
