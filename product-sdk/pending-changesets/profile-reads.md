---
"@parity/product-sdk": minor
---

**Read a person's public profile from their dotNS name, through `@parity/product-sdk/profile`.**

A profile is one dotNS text record, `profile`, holding a base64 SCALE `ProfileRecord` on the layout the RFC "Core-resolved public profiles" fixes: a list of entries, each a length-prefixed byte string that starts with the entry's variant index (`WrapperKeepOpaque<ProfileEntry>`), so a reader keeps every entry it cannot read and a writer puts it back. The RFC allocates index 0, `Avatar` (a Bulletin CID and a declared format). This package proposes the next three and is where further indices are claimed: 1 `Name`, 2 `Nft`, 3 `Feed`, the entries Seity has written since 2026-10-30. `PROFILE_ENTRY_INDEX` is the table, with each kind's payload, reader rule and status.

- `getProfile(label, opts)` walks dotNS to the record and decodes it, taking the same `DotNsClientOptions` as every other dotNS read. It answers `ok({ tag: "Found", profile })`, `ok({ tag: "NoProfile" })` for a name with no readable profile (no resolver, a resolver whose `text` reverts, an empty record, a record that is not a profile, which includes one in the layout that preceded the RFC), or `err(DotNsError)` for a chain that could not be asked. The last two are kept apart on purpose: clear a cached profile on the first, keep it on the second.
- `decodeProfileRecord(text)` is the decoder alone. It refuses a record over 16 KiB before parsing and trailing bytes after it, takes the first `Avatar` whose format it knows and the first non-empty `Name` of at most 64 UTF-8 bytes, keeps every `Nft` and `Feed` that decodes, and keeps every entry it cannot read as `{ bytes }` in `unknown`.
- `loadAvatar(avatar, preimageManager)` fetches the bytes through the host's preimage lookup, keyed by the digest in the CID, and keeps them only if they are within the RFC's 2 MiB bound and hash to it. Never a gateway. A miss, an oversized answer or a mismatch is `null`, not a failure.
- `getPinnedNfts(chain, nfts)` confirms each pin against `Scarcity.Instances` and `getInstanceDisplays` at one finalized block: the purse must hold the instance and the instance must be minted from the collection and item the pin names. Dropped pins come back with a reason; a read the chain could not answer is a `ChainRead` `ProfileError` with the cause attached.

Read only. Feeds are returned as data and not subscribed to. The identity module gains `DOTNS_CONTENT_RESOLVER_ABI`, the content resolver's `text` view.
