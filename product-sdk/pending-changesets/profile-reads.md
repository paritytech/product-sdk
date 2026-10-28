---
"@parity/product-sdk": minor
---

**Read a person's public profile from their dotNS name, through `@parity/product-sdk/profile`.**

A profile is one dotNS text record, `profile`, holding a base64 SCALE `ProfileRecord`: an `avatar` (a Bulletin CID and a declared format), a display `name`, pinned `nft` entries and `feed` entries. The shapes mirror `truapi::v01::profile` in the host core, which reads the same record for hosts.

- `getProfile(label, opts)` walks dotNS to the record and decodes it, taking the same `DotNsClientOptions` as every other dotNS read. `ok(profile)` is a name with a record, `ok(null)` is a name with no readable profile (no resolver, a resolver whose `text` reverts, an empty or undecodable record), and `err(DotNsError)` is a chain that could not be asked. The last two are kept apart on purpose: clear a cached profile on the first, keep it on the second.
- `decodeProfileRecord(text)` is the decoder alone: refuses a record over 16 KiB before parsing and trailing bytes after it, takes the first `avatar` whose format it knows and the first `name` of at most 64 UTF-8 bytes, keeps every `nft` and `feed` that decodes, and keeps unknown kinds as `{ kind, payload }`.
- `loadAvatar(avatar, preimageManager)` fetches the bytes through the host's preimage lookup, keyed by the digest in the CID, and keeps them only if they hash to it. Never a gateway. A miss or a mismatch is `null`, not a failure.
- `getPinnedNfts(chain, nfts)` confirms each pin against `Scarcity.Instances` and `getInstanceDisplays` at one finalized block: the purse must hold the instance and the instance must be minted from the collection and item the pin names. Dropped pins come back with a reason.

Read only. Feeds are returned as data and not subscribed to. The identity module gains `DOTNS_CONTENT_RESOLVER_ABI`, the content resolver's `text` view.
