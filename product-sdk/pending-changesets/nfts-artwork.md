---
"@parity/product-sdk-nfts": minor
"@parity/product-sdk": minor
---

**`getVerifiedArtwork(imageRef, { source })`: the bytes an image reference names, only when they hash to it.**

An `ImageRef` is a content address, an ASCII CID or a bare 32-byte digest, and neither is the
bytes. Wherever the bytes come from, they are only the artwork if they hash to the digest the chain
committed to. This read decodes the reference into an address, asks a caller-supplied source for the
bytes, hashes them the way the multihash says, blake2b-256 or sha2-256, and answers `Verified` with
the bytes only when the digests match.

```ts
const art = await getVerifiedArtwork(item.imageRef, { source: preimageSource(manager) });
// -> ok({ tag: "Verified", address: { cid, digest, multihash }, bytes })
//    ok({ tag: "Missing", address })      the source had nothing
//    ok({ tag: "Mismatch", address })     the source lied, and the bytes are withheld
//    ok({ tag: "Unreadable" })            no address, or a multihash it cannot check
```

Two sources ship. `preimageSource(manager)` reads the host preimage manager by digest, which on
Bulletin is the preimage key, so no CID round trip is needed. `gatewaySource(baseUrl)` reads an IPFS
gateway by CID. Both are typed structurally, so this package depends on neither the host package nor
a fetch implementation, and a test or a cache can stand in for either.

`artworkAddress(imageRef)` is exported on its own for a caller that only wants the CID, for example
to build a gateway URL for an `<img>` it is willing to trust.
