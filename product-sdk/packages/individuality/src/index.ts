// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-individuality — read a person's standing on the
 * individuality chain.
 *
 * One question, one answer: for a DotNS username, what is that person's
 * personhood state, as of one pinned finalized block?
 *
 * ```ts
 * import { getChainAPI } from "@parity/product-sdk-chain-client";
 * import { readPersonhoodState } from "@parity/product-sdk-individuality";
 *
 * const chain = await getChainAPI("paseo");
 * const result = await readPersonhoodState(chain, { username: "alice.dot" });
 * if (result.tag === "Resolved" && result.state.tag === "Member") {
 *     console.log(`member for ${result.state.activeWeeks} weeks`);
 * }
 * ```
 *
 * The derivation is exported separately from the read, so the pure state
 * machine can be used against a snapshot you already hold — no chain client, no
 * host container.
 *
 * **Not an authorization oracle.** This is a client-side read in a client-side
 * library, and a backend that trusts "the SDK said `Member`" is trivially
 * spoofed. Anything that gates value must verify on chain itself.
 */

// The seven-state union, its wrappers, and the pinned-block coordinates.
export type {
    AbsenceGracePolicy,
    FinalizedSnapshot,
    PersonhoodResult,
    PersonhoodState,
} from "./types.js";

// The pure derivation — the artifact issue #291 consumes.
export { derivePersonhoodState } from "./derive.js";
export type { PersonhoodParticipant, PersonhoodSnapshot } from "./derive.js";

// Raw storage values to domain shapes, for callers doing their own reads.
export { decodeAbsenceGracePolicy, toPersonhoodParticipant } from "./decode.js";
export type { RawParticipant, RawRecognition, RawStreak } from "./decode.js";

// The pinned batched read.
export { readPersonhoodState } from "./read.js";
export type { IndividualityChain, ReadPersonhoodStateOptions } from "./read.js";

// Errors. `UsernameUnowned` is not one of them — it travels on the success
// channel as a `PersonhoodResult`.
export { IndividualityDecodeError, ProductIndividualityError } from "./errors.js";
