// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-individuality — read a person's standing on the
 * individuality chain.
 *
 * Two reads, opposite directions. For a DotNS username, what is that person's
 * personhood state, as of one pinned finalized block? And for an account, what
 * usernames does it hold?
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
 * And the other direction, from an account:
 *
 * ```ts
 * import { displayUsername, lookupUsername } from "@parity/product-sdk-individuality";
 *
 * const usernames = await lookupUsername(chain, { account: rootAddress });
 * if (usernames.ok && usernames.value !== null) {
 *     console.log(displayUsername(usernames.value));
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

// The account to username direction, over `Resources.Consumers`. A lite name is
// always present; a full one appears once the person claimed a bare name, which
// is also exactly when they stop being eligible to claim.
export {
    canClaimFullUsername,
    decodeConsumerInfo,
    displayUsername,
    lookupUsername,
    usernameBase,
} from "./username.js";
export type {
    ConsumersChain,
    ConsumerUsernames,
    LookupUsernameOptions,
    RawConsumerInfo,
    UsernameCredibility,
} from "./username.js";

// Errors. `UsernameUnowned` is not one of them — it travels on the success
// channel as a `PersonhoodResult`.
export { IndividualityDecodeError, ProductIndividualityError } from "./errors.js";
