// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-individuality — read a person's standing on the
 * individuality chain, and act as that person on it.
 *
 * Two halves. The **read** half answers one question: for a DotNS username, what
 * is that person's personhood state, as of one pinned finalized block? The
 * **write** half is `withAsPerson`, which wraps a signer so a call dispatches
 * under a person origin instead of an account origin.
 *
 * ```ts
 * import { getChainAPI } from "@parity/product-sdk-chain-client";
 * import { readPersonhoodState } from "@parity/product-sdk-individuality";
 *
 * const chain = await getChainAPI("paseo");
 * const result = await readPersonhoodState(chain, { username: "alice.dot" });
 * if (!result.ok) {
 *     console.error(result.error);
 * } else if (result.value.tag === "Resolved" && result.value.state.tag === "Member") {
 *     console.log(`member for ${result.value.state.activeWeeks} weeks`);
 * }
 * ```
 *
 * Failures arrive on the `err` channel as a `ProductIndividualityError`, per the
 * SDK-wide error model. A username nobody owns is not a failure: it is
 * `ok({ tag: "UsernameUnowned", ... })`.
 *
 * The derivation is exported separately from the read, so the pure state
 * machine can be used against a snapshot you already hold, with no chain client
 * and no host container.
 *
 * **Not an authorization oracle.** This is a client-side read in a client-side
 * library, and a backend that trusts "the SDK said `Member`" is trivially
 * spoofed. Anything that gates value must verify on chain itself.
 *
 * The write half needs no chain client and no submitter of its own. It returns a
 * `PolkadotSigner`, so it composes with `@parity/product-sdk-tx`:
 *
 * ```ts
 * import { submitAndWatch } from "@parity/product-sdk-tx";
 * import { withAsPerson } from "@parity/product-sdk-individuality";
 *
 * const signer = withAsPerson(accounts.getProductAccountSigner(account), {
 *     tag: "AliasWithAccount",
 * });
 * await submitAndWatch(api.tx.Game.sign_up_with_alias(), signer);
 * ```
 */

// The seven-state union, its wrappers, and the pinned-block coordinates.
export type {
    AbsenceGracePolicy,
    FinalizedSnapshot,
    PersonhoodInputs,
    PersonhoodParticipant,
    PersonhoodResult,
    PersonhoodState,
} from "./types.js";

// The pure derivation, for a snapshot the caller already holds.
export { derivePersonhoodState } from "./derive.js";

// Raw storage values to domain shapes, for callers doing their own reads.
export { decodeAbsenceGracePolicy, toPersonhoodParticipant } from "./decode.js";
export type { RawParticipant, RawRecognition, RawStreak } from "./decode.js";

// The pinned batched read.
export { readPersonhoodState } from "./read.js";
export type { IndividualityChain, RawAccountAlias, ReadPersonhoodStateOptions } from "./read.js";

// The write half: wrap a signer so the call runs under a person origin. Returns
// a `PolkadotSigner`, so submission stays with `@parity/product-sdk-tx`.
export { withAsPerson } from "./as-person-signer.js";
export type { AsPersonInfo, CreateRingVRFProof, RingVRFProof } from "./as-person-signer.js";

// The metadata-driven pieces underneath stay internal on purpose. They are
// written generically, taking an extension identifier rather than hard-coding
// `AsPerson`, so the other origin-modifying extensions on this chain can reuse
// them, and #291b should. But they are implementation details of `withAsPerson`
// today, and two of their types are shapes chosen to suit it rather than to be a
// public contract. Widening a surface later never breaks anyone; narrowing one
// after it ships does. Export them when something outside this package actually
// reaches for them.

// Errors. `UsernameUnowned` is not one of them — it travels on the success
// channel as a `PersonhoodResult`. `AsPersonError` is the write half's, and
// unlike the others it is thrown rather than returned, because it happens inside
// `PolkadotSigner.signTx` where there is no `Result` channel.
export { AsPersonError, IndividualityDecodeError, ProductIndividualityError } from "./errors.js";
