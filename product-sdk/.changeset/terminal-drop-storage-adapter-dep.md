---
"@parity/product-sdk-terminal": patch
---

Drop the direct `@novasamatech/storage-adapter` dependency. Terminal only used its `StorageAdapter` type, which is now declared locally in `node-storage.ts` (structurally identical, so `createNodeStorageAdapter()` is still accepted by `host-papp`'s `createPappAdapter`). The package is still installed transitively through `@novasamatech/host-papp`; this just removes it from terminal's own manifest and published types.
