---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Sign up for the game, and enter its prize draws in the same call.**

```ts
import {
    readGameSignUpRequirement,
    mintAccountAirdropVrfs,
    signUpWithAccountTx,
} from "@parity/product-sdk-individuality";
import { submitAndWatch } from "@parity/product-sdk-tx";

const req = await readGameSignUpRequirement(chain, {
    registrant: { tag: "Account", accountAddress },
    keyType: "sr25519",
});
if (req.ok && req.value.canEnterDraws) {
    const vrfs = await mintAccountAirdropVrfs(signer, {
        eventIds: req.value.eventIds,
        publicKey: account.publicKey,
    });
    if (vrfs.ok) {
        const tx = signUpWithAccountTx(chain, { identifierKey, airdrops: vrfs.value });
        await submitAndWatch(tx, signer, { waitFor: "finalized" });
    }
}
```

**Registering for the game and entering its prize draws are one extrinsic.**
`sign_up_with_account` takes `airdrops: Option<AirdropVrfs>` holding exactly one VRF per
scheduled draw, in airdrop-index order. Pass nothing to sign up without entering any draw.

**The `AirdropVrfs` variant is not the caller's choice** — the chain picks it from the player's
`Score` recognition and rejects the other one with
`Game.InvalidAirdropVrfVariantForRecognition`:

| `recognition.is_recognized()` | Required variant | Buildable |
|---|---|---|
| `false` — `NotRecognized`, `Suspended` | `Account` — sr25519 VRFs | yes |
| `true` — `Recognized`, `ExternallyRecognized` | `Alias` — ring-VRF membership proofs | **no** |

`Suspended` is *not* recognized, so a suspended player stays on the account path — the check is
`is_recognized()`, not "anything but `NotRecognized`".

**A recognized player cannot enter the draws through any SDK or host available today.** The
`Alias` variant needs a ring-VRF proof at the context
`blake2_256("pop:polkadot.network/airdrop" ++ event_id)`, and every context a host will sign
under is `blake2b_256("product/" ++ productId ++ "/" ++ suffix)`, computed by the host itself
from a `ProductProofContext` that admits nothing else. The two preimages cannot be made to
agree, so this needs a chain or host change rather than more SDK code. It surfaces as the
`AliasVrfsUnavailable` blocker, and it is why `signUpWithAccountTx` offers no `Alias` argument:
an argument that always fails on chain is worse than no argument. **Such a player can still sign
up** — with no draw entry — which is the whole difference the blocker makes.

**Read the requirement first; it is not optional.** Event ids are derived from the game index
*and* the draw count, which must come from the same block, and the entry count must equal
`airdrops_scheduled` exactly. A count mismatch fails the whole sign-up, deposit included, and
ids derived from a stale index address draws that do not exist.
`GameSignUpRequirement.blockers` reports every cause rather than the first, and separates the
ones that stop the extrinsic (`NoGameRunning`, `NotInRegistration`, `RegistrationEnded`,
`AlreadyRegistered`) from the ones that stop only the draws (`AliasVrfsUnavailable`,
`NoDrawsScheduled`, `NotSr25519`).

**Only sr25519 accounts can take the account path**, because the pallet reinterprets the account
id *as* the sr25519 public key. Nothing on chain records which scheme a 32-byte account id
belongs to, so this cannot be read — pass `keyType` and get a `NotSr25519` blocker, or omit it
and own the check. For the same reason the transcript's `signer` item must be the account that
signs the sign-up, not any other key the player holds.

`airdropVrfTranscript` is exported for a caller minting VRFs some other way. Both the transcript
label and its domain prefix are module-level `pub const`s in the airdrop pallet, so unlike
`Game`'s event-id base neither reaches metadata; the pinned test vectors are the only guard, the
same situation the `PeopleAirdrops` event-id base is in.

**There is no local VRF verification step.** dim2-spa verifies before submitting, because one
bad entry fails the whole sign-up — but schnorrkel VRF verification has no implementation in
this workspace, and the failure it guards against is the wrong signing key, which the transcript
binds and this code checks without any crypto. VRFs are minted sequentially rather than in
parallel: each is a signing operation, and firing sixteen at once is hidden by an `AutoSigning`
allowance right up until a product ships without one.

**Paseo only.** Devnet's pinned metadata predates the multi-airdrop sign-up, and the umbrella's
contract test asserts that a devnet client *fails* `SignUpChain` so a re-pin breaks the
assertion rather than leaving the surface quietly unsupported.
