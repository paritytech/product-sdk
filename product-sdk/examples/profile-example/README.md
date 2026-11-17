# Profile example

An offline walk through `@parity/product-sdk/profile`: read a profile, load its avatar, publish a change in the core's order, and set a mood. DotNS is `createFakeContractRuntime` from `@parity/product-sdk/testing`; Bulletin and the statement store are small doubles. No wallet, no chain, no transaction.

Run from `product-sdk/`:

```sh
pnpm --filter @parity/product-sdk-profile-example... build
pnpm --filter @parity/product-sdk-profile-example demo
```

What a live app does differently: it builds the runtime with `createContractRuntimeFromClient` over its Asset Hub client and omits `tld` and `contentResolverAddress`, which the SDK reads from the chain; it takes the preimage manager and statement store from `@parity/product-sdk/host`; it maps the owner with `ensureContractAccountMapped` before preparing, funds it, and submits `prepared.call` with the owner's signer through `@parity/product-sdk-tx`, waiting for finality before verifying. The `product-sdk-profile` skill has the full recipe.
