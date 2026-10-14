---
"@parity/product-sdk-cloud-storage": patch
---

Cloud storage uploads work on polkadot-api 3 again: `@parity/bulletin-sdk` moves to 0.5.0, which submits through `createSubmitAndWatch`, and `verifyStored` reads the hex `content_hash` polkadot-api 3 returns.
