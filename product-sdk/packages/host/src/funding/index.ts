// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `@parity/product-sdk-host/funding-provider` — the worker side of the
 * funding modality, for funding providers.
 *
 * A funding provider moves value into or out of the user's balance. Its
 * worker runs each session the host assigns it end to end: it takes the
 * user's payment on its own rail and credits the user with `payment.topUp`,
 * or collects with `payment.request` and pays the user out. The host decides
 * the outcome from the top-ups and payments the worker names.
 *
 * This module carries what every provider needs to do that safely:
 * {@link serveFunding} runs the sessions and quote asks, a
 * {@link FundingSession} saves before every external step and moves funds
 * under ids that make a repeat safe, so a worker that crashes or restarts
 * carries on without moving funds twice. How a provider takes payments,
 * prices and converts stays its own.
 *
 * A subpath of its own, so products that are not funding providers do not
 * carry it.
 *
 * @module
 */
export { serveFunding } from "./serve.js";
export type {
    CancelAnswer,
    FundingProviderHandlers,
    FundingServer,
    QuoteContext,
    ServeFundingOptions,
} from "./serve.js";
export { DEFAULT_FUNDING_TIMING, FundingSession } from "./session.js";
export type {
    CancelOffer,
    FailureCode,
    FundingTiming,
    PageResult,
    PaymentOutcome,
    ReportOutcome,
    SessionCancel,
    TopUpOutcome,
} from "./session.js";
export { MAX_SAVED_BYTES } from "./state.js";
export type { Journal, JournalEntry, SavedCancel, SavedStateSpec } from "./state.js";
export { deriveId } from "./ids.js";
export { refuse, quoted, validateAsk, quoteId } from "./quotes.js";
export type { AskPolicy, QuoteTerms } from "./quotes.js";
export { accountContext, deriveEntropyAccount } from "./accounts.js";
export type { EntropyAccount } from "./accounts.js";
export { screenChannel, screenSession, submitScreenAction } from "./screen.js";
export type { ScreenAction, ScreenChannel } from "./screen.js";
export {
    FundingAbortedError,
    FundingFailed,
    FundingProviderError,
    PaymentRefusedError,
    ReportRefusedError,
    SessionOverError,
    StateTooLargeError,
    TopUpRefusedError,
    hostErrorTag,
    isTransient,
} from "./errors.js";
export { poll, retry, sleep, waitUntil } from "./time.js";
export type { RetryOptions } from "./time.js";
export type { FundingClient } from "./client.js";
export type {
    FundingAssignment,
    FundingDeposit,
    FundingDirection,
    FundingFailure,
    FundingFrameOutcome,
    FundingFrameTarget,
    FundingPayout,
    FundingQuote,
    FundingQuoteAnswer,
    FundingQuoteAsk,
    FundingRail,
    FundingUpdate,
    PaymentTopUpSource,
} from "@parity/truapi";
