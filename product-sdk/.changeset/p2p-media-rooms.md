---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**Add the `p2p` module: peer-to-peer media rooms (MoQ-over-iroh).**

New Result-typed host wrappers — `p2pStatus`, `createRoom`, `joinRoom`,
`leaveRoom`, `mediaEndpoint`, `p2pPublish`/`p2pUnpublish`, and the
`roomEvents` subscription (the keep-alive signal) — over the host's
`p2pMedia` TrUAPI service (companion RFC `TRUAPI_RFC_P2P_MEDIA.md`). A
p2p room is a session whose "relay" is a loopback endpoint the host serves
on `127.0.0.1` and whose remote party is a set of peers; dapps keep their
`@moq/*` pipeline and point it at the returned loopback URL. Domain errors
(`PermissionDenied`, `InvalidTicket`, `TooManyRooms`, …) surface as a typed
`P2pError` on the `err` channel; `HostUnavailableError` outside a container.

**Interim wire posture:** the `p2pMedia` service is not yet in the published
`@parity/truapi` generated client, so the module speaks the wire directly
through the shared transport with hand-authored SCALE codecs (frame ids
164–181, mirroring the host's `wire_table`). When the generated client
lands, the module collapses to thin wrappers over `truApi.p2pMedia.*` with
no public-API change.
