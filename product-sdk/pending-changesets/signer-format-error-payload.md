---
"@parity/product-sdk-signer": patch
---

A host error whose payload is a plain object no longer reads `[object Object]`. `formatError`, which builds the message of every `Host rejected … request` error and the `failed to get product account` log line, now serializes an object payload as JSON (bigints as decimal strings; byte arrays as hex, long ones cut to their first 64 bytes; a nested `Error` with its name, message, cause and own fields such as `code` and `data`; an object met twice as `[repeated]`, which also cuts cycles; elided past 500 characters) and shows a `{ reason }` payload under a tag as its reason. A product-account rejection that logged `Domain → V1 → Unknown ([object Object])` now carries the host's payload.
