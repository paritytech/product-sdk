---
"@parity/product-sdk": minor
"@parity/product-sdk-local-storage": minor
---

`@parity/product-sdk-local-storage` gains storage for records of a product's own. `ByteStore` is host storage as raw bytes (`hostByteStore(host)`, `getHostByteStore()`). `openJournaledStore(kv, prefix)` writes a change to several keys whole or not at all: the change goes to a journal first, and opening the store replays a journal a stopped worker left behind. `encodeRecord` and `decodeRecord` store JSON in which byte arrays and bigints round-trip. `PagedIndex` lists the ids of a collection with their order and flags in pages of 256, so adding an entry rewrites one page and opening reads the pages only, and `ClaimSet` remembers in 32 buckets which ids had a one-time effect. `@parity/product-sdk-local-storage/testing` gains `MemoryByteStore`, whose write budget simulates a worker the host stopped mid-change.
