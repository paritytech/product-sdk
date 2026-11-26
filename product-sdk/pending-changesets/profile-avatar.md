---
"@parity/product-sdk": minor
---

**Read and publish the avatar under a person's DotNS name, through `@parity/product-sdk/profile`.**

A profile is the `profile` text record on the deployment's content resolver: base64 of a SCALE `ProfileRecord` in the core's layout, so the avatar this module reads is the one hosts show. The avatar is a Bulletin CID, carried as its 32-byte digest, and a format: `png`, `jpeg`, `webp` or `gif`. Every other entry is kept as read when the record is rewritten.

- `getProfile(label, opts)` accepts a DNS label or a dotted lite username such as `alice.01`, and answers `Found`, `NoProfile` (clear a cached avatar) or `err` (keep it). `getProfileRecord` is the stored text and `decodeProfileRecord` the decoder alone. `loadAvatar` fetches the bytes through the host's preimage lookup and answers `Loaded` only if they hash to the CID, otherwise `Missing`, `Mismatch`, `TooLarge` or `Unreadable`, with `err` for a lookup that could not be made.
- A write is read, change, write back, in the core publisher's order. `profileAvatar(bytes, format)` builds the avatar from the bytes' digest with no host call. `rewriteProfileRecord(live, { avatar })` sets the avatar, or clears it with `null`, and refuses a live text that is not a profile. `prepareSetProfile(label, text, opts)` is the `setText` call, sized by a dry-run as `opts.origin`, which the registry must authorise for the name. `submitAvatar(bytes, manager)` stores the bytes on Bulletin after the prepare and before the submit, and `verifyPublishedProfile` reads the record back after finality.

`ProfileError` reasons: `NotBase64`, `TooLarge`, `Malformed`, `InvalidEntry`, `Host`, `Timeout` for a host call whose deadline passed, which an avatar store may still outlive, and `Aborted` for an avatar lookup its signal ended. The identity module gains `resolveDotNsContentResolver`, `DOTNS_CONTENT_RESOLVER_KEY`, the `contentResolverAddress` option and the `Unauthorised` reason on `DotNsError`. `setDotNsRecord` now refuses an undecodable origin as `InvalidOrigin` before any call, as `prepareDotNsRegistration` already did.
