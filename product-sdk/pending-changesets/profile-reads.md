---
"@parity/product-sdk": minor
---

**Read a person's public profile from their DotNS name, prepare a change to it, and set a mood on it, through `@parity/product-sdk/profile`.**

A profile is one DotNS text record, `profile`, on the deployment's content resolver: a base64 SCALE `ProfileRecord` on the core's layout, a list of entries each carried as length-prefixed bytes starting with the entry's variant index, so a reader keeps every entry it cannot read and a writer puts it back. Index 0 is the core's `Avatar`: a Bulletin CID as its 32-byte blake2b-256 digest, and a format (`png`, `jpeg`, `webp`, `gif`). This package proposes 1 `Name` and 3 `Feed`, reserves 2 for pinned NFTs with no payload yet, and `PROFILE_ENTRY_INDEX` is where the next index is claimed.

Reads:

- `getProfile(label, opts)` takes the same `DotNsClientOptions` as every DotNS read and accepts a DNS label or a dotted lite username such as `alice.01`. It answers `ok({ tag: "Found", profile })`, `ok({ tag: "NoProfile" })` for a name with no readable profile, or `err(DotNsError)` when the chain could not be asked. Clear a cached profile on the second, keep it on the third.
- `getProfileRecord(label, opts)` is the text as stored, `""` for none; `decodeProfileRecord(text)` is the decoder alone.
- `loadAvatar(avatar, preimageManager)` fetches the bytes through the host's preimage lookup, never a gateway, and keeps them only if they are within 2 MiB and hash to the CID; a miss is `null`, not a failure.

Writes, in the order the core's publisher keeps. The SDK prepares; the product maps and funds its account, signs and submits.

- `profileAvatar(bytes, format)` is the avatar entry for new bytes, from their digest, with no host call, so the record is rewritten and the write prepared before anything is uploaded.
- `rewriteProfileRecord(live, patch)` builds the new text from the live one and a `ProfilePatch`: `undefined` keeps a kind, `null` drops it, a value replaces it; feeds replace only the kinds named. A live text that is not a profile is refused rather than overwritten; pass `null` as `live` to replace one on purpose. The result is held to 16 KiB.
- `prepareSetProfile(label, text, opts)` is the content resolver's `setText` as a `BatchableCall`, sized by a dry-run as `opts.origin`, which must be an account the registry authorises for the name (`Unauthorised` otherwise) and already mapped in pallet-revive. It returns the text that was live, for a re-read before submitting. The name's resolver pointer is never moved.
- `submitAvatar(bytes, preimageManager)` puts the bytes on Bulletin after the prepare and before the submit, and holds the host to the digest `profileAvatar` wrote.
- `verifyPublishedProfile(label, text, opts)` reads the record back after finality.

Moods: the record's `mood` feed names a statement topic and a signer; a mood is one statement there, signed by the host's statement allowance key, gone a day after it was set, and setting one never writes the record.

- `deriveMoodFeed(label, opts, store, deriveEntropy)` is the feed entry every publish writes: the topic from host entropy under a 32-byte key, the signer from a proof the host makes and never submits. Both are stable per wallet and product.
- `setMood(feed, mood | null, store)` sets or clears; `SignerMismatch` means the record names another product's key: publish first. `readMood` answers the live mood or `null`; a host that could not be read is `Host` or `Timeout`, not "no mood". `watchMood` keeps answering and reports a lapse on its own.
- `MOOD_KINDS` and `MOOD_INTENSITIES` are the palette, fixed here and grown by appending; `pickMood`, `encodeMoodBody`, `decodeMoodBody` and `moodExpiry` are the pure parts, for fixtures and other readers.

`ProfileError` reasons: `NotBase64`, `TooLarge`, `Malformed`, `InvalidEntry`, `Host`, `SignerMismatch`, and `Timeout` for a host call whose deadline passed, which an avatar store or a mood submit may still outlive. The identity module gains `resolveDotNsContentResolver` and `DOTNS_CONTENT_RESOLVER_KEY`, the `contentResolverAddress` option on `DotNsClientOptions`, and the `Unauthorised` reason on `DotNsError`; `setDotNsRecord` now refuses an undecodable origin as `InvalidOrigin` before any call, as `prepareDotNsRegistration` already did.
