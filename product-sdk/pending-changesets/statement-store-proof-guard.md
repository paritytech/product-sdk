---
"@parity/product-sdk-statement-store": patch
---

Harden proof-signer extraction when reading statements. The code cast `stmt.proof.value` to `Record<string, unknown>` and then ran `"signer" in proofValue`, which throws a `TypeError` if the proof value is ever a primitive. Replace the cast with a real object-ness narrow (`typeof === "object" && !== null`) before the `in` check; TypeScript then narrows the signer field without any cast.
