---
"@parity/product-sdk-terminal": patch
---

Optional-chain the `NodeJS.ErrnoException` code read in the file-cache error handlers. `allowance-cache.ts` and `node-storage.ts` read `(err as NodeJS.ErrnoException).code` without a guard, so a non-Error throw would itself throw on `.code` inside the catch and mask the original failure. Match `json-cache.ts`, which already uses `?.code`.
