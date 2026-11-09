# Profile example

This Node example runs offline. It uses `createFakeContractRuntime` from `@parity/product-sdk/testing` for dotNS, a hand-rolled preimage manager for Bulletin, and a statement-store double for moods.
The name, record, avatar bytes, and owner are fixtures. It requires no wallet and submits no transaction.

Run from `product-sdk/`:

```sh
pnpm --filter @parity/product-sdk-profile-example... build
pnpm --filter @parity/product-sdk-profile-example demo
```

The example reads the profile of `alice.paseo` with `getProfile` and prints its avatar, display name, and feeds.
It loads the avatar bytes with `loadAvatar`.
It then publishes a change. It reads the live text with `getProfileRecord` and sets a new display name with `rewriteProfileRecord`, carrying the avatar and everything else.
It prepares the `setText` call with `prepareSetProfile` for a chosen SS58 origin and verifies the result with `verifyPublishedProfile`.

For a live app, create a runtime with `createContractRuntimeFromClient` from `@parity/product-sdk/contracts`, over your Asset Hub client and descriptor.
Omit `tld` and `contentResolverAddress`. The SDK reads both from the chain once per runtime.
Load the avatar with the manager from `getPreimageManager` in `@parity/product-sdk/host`. It returns `null` outside a host.

Use the account the registry authorises for the name as the origin. A prepared call requires a signer and submission through `@parity/product-sdk-tx`.
Map that account with `ensureContractAccountMapped` from the contracts package before you prepare, because the prepare dry-runs as the origin.
Fund it for the fee and the record's storage deposit. Submit with `batchSubmitAndWatch` and wait for finality before you verify.
Read the record again just before you submit. If it no longer equals `prepared.original`, start over.

A new avatar goes to Bulletin first, through `submitAvatar`, before the record names it. This example keeps the avatar it read.

The record's mood feed comes from `deriveMoodFeed` and goes into every publish, so the topic is in the record before any mood is set.
A mood is one statement on that topic through the host's statement store: `setMood` sets or clears it with no record write, `readMood` answers the live one, `watchMood` keeps answering.
The store here is a double. A live app uses `getStatementStore` and `deriveEntropy` from `@parity/product-sdk/host`, and requests the statement-store allowance with its first publish.
The app finds the owner account and decides who pays. This example does not register names or subscribe to feeds. Profiles carry no pinned NFTs yet: index 2 is reserved with no payload.
