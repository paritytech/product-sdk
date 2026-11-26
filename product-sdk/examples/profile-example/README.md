# Profile example

An offline walk through `@parity/product-sdk/profile`: read a person's avatar, load its bytes, publish a new one in the core's order, and clear it. DotNS is `createFakeContractRuntime` from `@parity/product-sdk/testing`; Bulletin is a small double. No wallet, no chain, no transaction.

Run from `product-sdk/`:

```sh
pnpm --filter @parity/product-sdk-profile-example... build
pnpm --filter @parity/product-sdk-profile-example demo
```

What a live app does differently: it builds the runtime with `createContractRuntimeFromClient` over its Asset Hub client and omits `tld` and `contentResolverAddress`, which the SDK reads from the chain; it takes the preimage manager from `@parity/product-sdk/host`; it maps the owner with `ensureContractAccountMapped` before preparing, funds it, and submits `prepared.call` with the owner's signer through `@parity/product-sdk-tx`, verifying once the write is included. The `product-sdk-profile` skill has the full recipe.
