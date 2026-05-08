---
"@parity/product-sdk-terminal": patch
---

**Fix `BadProof` rejection on every transaction submitted via `createSessionSigner` / `createSessionSignerForAccount`.**

The signer built `PolkadotSigner` via `getPolkadotSigner` with a single callback that funneled both `signBytes` and `signTx` through `session.signRaw`. The mobile wallet's raw-signing interactor wraps incoming bytes with `<Bytes>...</Bytes>` before signing (anti-phishing) — so when polkadot-api invoked the callback for `signTx` with a SCALE-encoded extrinsic payload, the wallet signed the wrapped form and the chain rejected the resulting signature with `BadProof`.

Switched to `getPolkadotSignerFromPjs` from `polkadot-api/pjs-signer`, which takes separate `signPayload` and `signRaw` callbacks. Tx signing now routes through `session.signPayload` (mobile's payload interactor — no `<Bytes>` wrap, signs the actual extrinsic) and raw-byte signing keeps using `session.signRaw` (anti-phishing wrap intact).

No public API changes — `createSessionSigner(session, adapter)` and `createSessionSignerForAccount(session, ref)` keep their signatures. Internal routing is the only thing that changed. The two callbacks are extracted as named internal helpers (`makeSignPayloadCallback`, `makeSignRawCallback`) so the path the bug was on can be exercised directly. Full end-to-end tx signing roundtrip is still gated on the manual smoke test (`packages/terminal/manual-tests/qr-pair-and-sign-tx.mjs`) since CI cannot exercise a real phone.

Bundle size impact: `dist/index.js` grows from ~10.7 KB to ~19.4 KB. The increase is the metadata-decoder helpers required by the PJS adapter to translate PAPI's signer payload contract into the wire format host-papp expects, plus the now-named callback helpers (kept top-level rather than inlined for testability). `polkadot-api/pjs-signer` itself is externalized.
