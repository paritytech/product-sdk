---
"@parity/product-sdk-individuality": patch
---

**Reads no longer fail with `Block 0x… is not pinned` after the host reconnects.**

The reads in this package pin a finalized block and read at its hash. When the host loses its chain connection, for example while an iOS app is in the background, PAPI starts a new follow and forgets the old blocks. A read still running at one of them failed with `is not pinned (stop-storage)`. PAPI retries reads that don't name a block, but not reads at a fixed hash.

Such a read now pins again and runs at the new block, up to three runs in all. If pinning again returns the block that was dropped, it returns the error instead.

- A read you passed a snapshot (`at: { blockHash, blockNumber }`) is not retried. You chose that block, so you still get the error.
- Every value in a result still comes from one block.
