---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

Add `AccountsProvider.ringVrfSign(keyHandle, message)`, the plain signature under a
registered ring-VRF member key for protocols that carry their own proof, as opposed to
`createRingVRFProof`, which proves ring membership. It takes the same opaque
`RingVrfKeyHandle` as the alias and proof calls, from `listRingVrfKeys` /
`findRingVrfKeyHandle`, and hands back the signature as bytes. `SignerManager` does not
wrap it; call the host package's `AccountsProvider` directly.
