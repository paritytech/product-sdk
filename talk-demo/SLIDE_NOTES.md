# Product-sdk — Speaker Notes

Notes per slide. Wording corrections baked in so the spoken narration is spec-accurate
even where the slide visuals stay as-is. Flagged items (⚠️) are things to fix before the talk.

---

## 1 — Title
Product-sdk: building products on Polkadot. One sentence on who you are and that this
is the toolkit for shipping apps that run *inside* a Polkadot host — wallet, browser,
or desktop — without each app reinventing keys, chain access, or storage.

## 2 — What is Product-sdk?
Set up the frame: a "product" is a sandboxed app the host runs on your behalf. The SDK is
the typed client your product code talks to; the host is the trusted environment around it.

## 3 — Polkadot Host (concept)
The host is the trusted runtime. ⚠️ **Be precise about two roles** — don't say all hosts
run your product:
- **Non-signing host** (Web / Desktop) — *runs* your product, holds **no** private keys.
- **Signing host** (Mobile) — *holds the keys*, and **never runs third-party products**
  (iOS won't host foreign code). It signs on request.
So "your product runs inside the host" is true for Web/Desktop; the phone is the signer it
talks to, not a place your product runs.

## 4 — Host (screenshot)
Concrete view: host chrome (tabs, address bar) wrapping the sandboxed product (W3S Passport).
The host owns the outer surface and the keys; the product owns only its sandbox.

## 5 — Desktop / Mobile / Browser
Three surfaces — but not interchangeable peers. Desktop & Browser are non-signing hosts that
run products; Mobile (Pocket) is the signer. ⚠️ Don't imply plug-and-play across hosts:
there's no capability discovery yet (`M-capability-discovery`) — hosts interoperate by
pinning matching versions in lockstep.

## 6 — Components (hub)
The SDK surface splits into method groups: Chain, Account, Signing, Device Access, Storage.
⚠️ "More…" — either name what's next (statements, remote/WebRTC) or cut it.
Note the auth split you'll return to: **Chain and Storage work anonymously; Account and
Signing require a connected session.**

## 7 — Chain (highlight)
Chain access = a typed PAPI client, scoped through the host. You don't manage RPC endpoints;
the host brokers the connection.

## 8 — Chain (code)  ✅ matches the demo
`createApp` → `app.chain.connect({ assetHub })` → `watchValue({ at: "best" })`. This is the
exact code in `connect.ts` and it runs live. Point out: descriptors are typed per-chain;
`watchValue` streams best blocks. Safe to live-run.

## 9 — Account (highlight)
⚠️ Define the word precisely — this is the deck's biggest conflation. A **product account**
is `ProductAccount{public_key}`, derived per (product, index), and has **no name**. It is not
the same as a legacy (imported, named) account, a DotNS user id, or the Account Holder who
owns the root key. The SDK gives a product its own derived account.

## 10 — Account (code)
⚠️ The slide shows `app.wallet.connect()`. In the real demo that's the *legacy* path and
returns no product account on Polkadot Desktop — `sdk.ts` drives a `SignerManager` +
`HostProvider` in product-account mode instead. Either show that code, or keep `app.wallet`
but call it "connect to the host," not "get the product account." Keys never leave the host —
that line stays true.

## 11 — Signing (highlight)
Signing is host-mediated: the product asks, the host prompts the user on the signing device,
the signature comes back. The product never sees a key.

## 12 — Signing (code)
⚠️ Slide shows `app.wallet.signMessage(...)`. Real demo path is `signer.signRaw(encode(text))`
and returns a `Result` (`if (!res.ok) throw`). Fine to simplify on the slide, but if you
live-code it, use the signer path and handle the Result — `app.wallet.signMessage` won't be
wired to the product account.

## 13 — Device Access (highlight)
The product can't grant itself anything — it *requests*, the host asks the user. ⚠️ There are
**two** permission families, not one: device permissions and remote permissions.

## 14 — Device Access (code)  ✅ matches the demo
`requestDevicePermission("Camera")` from `@parity/product-sdk-host`, returns `Promise<boolean>`.
The real enum has **9 device kinds** (Notifications, Camera, Microphone, Bluetooth, NFC,
Location, Clipboard, OpenUrl, Biometrics) plus **5 remote tags** (ChainSubmit, StatementSubmit,
PreimageSubmit, WebRtc, Remote). Camera is just one. Safe to live-run.

## 15 — Storage (highlight)
⚠️ "Storage" is two different things: **Local** (on-device key/value — instant, no chain, no
fees, no trust assumptions) and **Cloud** (on-chain via Bulletin — persisted, consensus,
costs an allowance). Say which you mean.

## 16 — Storage (code)
Local half is real: `app.localStorage.set/get`. ⚠️ The cloud half (`app.cloudStorage!.upload`)
is **disabled in this demo** — `sdk.ts` sets `cloudStorage: false` because the published
paseo-bulletin descriptor's genesis is stale vs. the host. The `!` would throw. Present cloud
as "same shape, coming once the host is provisioned," or re-enable before the talk.

## 17 — Product ⟷ Host Interaction
The bridge is `postMessage`, and the wire format is **TrUAPI**. Through it the product reaches
Chain State, Bulletin, Statement Store, and Device Storage. ⚠️ TrUAPI is the *wire* here — the
account derivation, pairing, and sandboxing that make this safe live in a separate host spec,
not in TrUAPI itself.

## 18 — TrUAPI
⚠️ Don't call TrUAPI "the contract that binds host and product" wholesale — it's **one layer**:
the host↔product wire protocol. The full stack is: **Product-SDK** (what you import) →
**`@parity/truapi`** (the package) → **TrUAPI** (the wire) → **inter-host spec** (derivation,
pairing, sandboxing). Consider a one-slide layer diagram here.

## 19 — Thank you
Three QRs: Product-sdk docs, Guides, TrUAPI. ⚠️ **Regenerate the Guides QR** — it still has the
`¡¡UPDATE QR!!` placeholder text under it.
