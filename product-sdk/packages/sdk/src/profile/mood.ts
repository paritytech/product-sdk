// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The public mood feed: a mood is one statement on the name's mood topic,
 * signed by the host's statement allowance key, gone a day after it was set.
 * The record's `mood` feed entry names the topic and the signer; nothing here
 * touches the record. Seity proved the feed first (`doc/MOOD_FEED.md` there);
 * the body, the expiry packing and the reader rule are its, carried over with
 * its vectors so a mood set from one product reads the same from another.
 *
 * The palette is fixed here so every product shows the same intent for the
 * same bytes. It grows by appending, never by renumbering, and an index a
 * build does not know reads as no mood, so an older product degrades quietly
 * when a newer one adds a kind.
 *
 * Every host interaction goes through the handles the product passes in, the
 * host package's statement store and entropy derivation, so this module never
 * asks the host for anything itself and a test or an offline demo supplies
 * doubles.
 */
import { bytesToHex, hexToBytes, utf8ToBytes } from "@parity/product-sdk-crypto";
import type {
    HostStatementStore,
    HostSubscription,
    SignedStatement,
    Statement,
    StatementProof,
    StatementsPage,
} from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";
import { type Result, err, ok } from "@parity/result";

import { DotNsError } from "../identity/dotns-errors.js";
import { type DotNsClientOptions, resolveTld } from "../identity/dotns-registry.js";
import { decodeExact, moodBodyCodec } from "./codec.js";
import { ProfileError } from "./errors.js";
import { isAcceptableProfileLabel, normalizeProfileLabel } from "./lookup.js";
import type { ProfileFeed } from "./types.js";

type HexString = `0x${string}`;

const log = createLogger("profile");

/** The feed kind a mood feed entry carries. */
export const MOOD_FEED_KIND = "mood";

/** The standardised moods. The index is what travels; append, never renumber. */
export const MOOD_KINDS = ["calm", "focused", "hyped", "social", "low-key", "away"] as const;
/** How strongly. The index is what travels; append, never renumber. */
export const MOOD_INTENSITIES = ["soft", "steady", "loud"] as const;
export type MoodKind = (typeof MOOD_KINDS)[number];
export type MoodIntensity = (typeof MOOD_INTENSITIES)[number];

/** A mood lasts a day. Setting a new one replaces it; nothing renews it. */
export const MOOD_TTL_SECS = 24 * 60 * 60;

/** How long a read waits for the host to finish the topic's backfill. */
export const DEFAULT_MOOD_READ_TIMEOUT_MS = 15_000;

/** A mood as a reader sees it. Times are Unix seconds. */
export interface Mood {
    kind: MoodKind;
    intensity: MoodIntensity;
    /** When the owner set it. */
    setAt: number;
    /** When it lapses on its own: `setAt` plus at most a day. */
    expiresAt: number;
}

/** What a product chooses when it sets a mood. */
export type MoodChoice = Pick<Mood, "kind" | "intensity">;

/** What the reader rule needs of one statement. Exported so a fixture can build them. */
export interface MoodStatement {
    /** The proof's signer, or null when the proof is not Sr25519. */
    signer: HexString | null;
    /** The store's expiry: seconds in the upper 32 bits, a sequence below. */
    expiry?: bigint;
    /** The body. */
    data?: Uint8Array;
}

/** `deriveEntropy` from `@parity/product-sdk/host`, or a double of it. */
export type DeriveEntropy = (context: Uint8Array) => Promise<Result<Uint8Array, Error>>;

const CLEAR = 0xff;
const ZERO_TOPIC: HexString = `0x${"00".repeat(32)}`;

/**
 * The context the name's mood topic is derived from. Versioned so the topic
 * can be rotated: bump it and publish again; statements on the old topic lapse
 * within a day. Product-neutral on purpose: a product that moves onto this
 * module publishes each name's feed entry once, and from then on shares it.
 * Kept off the barrel: a reader takes the topic from the record, never derives it.
 */
export function moodTopicLabel(fullName: string): string {
    return `profile:mood:topic:v1:${fullName}`;
}

/**
 * The 14-byte body: `kind u8 | intensity u8 | set_at u64 LE | ttl_secs u32 LE`,
 * which is SCALE for the struct. A clear is kind and intensity `0xFF` with
 * `set_at` now, which decodes to no mood; its later expiry replaces the live
 * one. `InvalidEntry` for a kind or intensity outside the palette.
 */
export function encodeMoodBody(
    mood: MoodChoice | null,
    setAt: number,
): Result<Uint8Array, ProfileError> {
    const kind = mood === null ? CLEAR : MOOD_KINDS.indexOf(mood.kind);
    const intensity = mood === null ? CLEAR : MOOD_INTENSITIES.indexOf(mood.intensity);
    if (kind < 0 || intensity < 0) {
        return err(
            new ProfileError("InvalidEntry", "a mood is a kind and an intensity from the palette"),
        );
    }
    return ok(moodBodyCodec.enc({ kind, intensity, setAt: BigInt(setAt), ttlSecs: MOOD_TTL_SECS }));
}

/**
 * The body back as a mood, or null for a clear, an index this build does not
 * know, or bytes that are not exactly a body. All three mean "no mood" to a
 * reader. The lapse is held to a day whatever the writer put in `ttl_secs`,
 * so no statement can make a watch wait, or spin, on an impossible time.
 */
export function decodeMoodBody(bytes: Uint8Array): Mood | null {
    const body = decodeExact(moodBodyCodec, bytes);
    if (body === null) return null;
    const kind = MOOD_KINDS[body.kind];
    const intensity = MOOD_INTENSITIES[body.intensity];
    if (kind === undefined || intensity === undefined) return null;
    const setAt = Number(body.setAt);
    return { kind, intensity, setAt, expiresAt: setAt + Math.min(body.ttlSecs, MOOD_TTL_SECS) };
}

/**
 * The statement's expiry: the lapse time in the upper 32 bits, a sequence in
 * the lower. The store keeps one statement per signer and channel and replaces
 * it only for a strictly higher expiry, so the sequence lets a mood set within
 * the same second as the last still win. The same packing as the statement
 * store package's `createExpiry`, which this package does not depend on; the
 * sequence is taken modulo 2^32.
 */
export function moodExpiry(setAt: number, seq: number): bigint {
    return (BigInt(setAt + MOOD_TTL_SECS) << 32n) | BigInt(seq >>> 0);
}

/** The live own statement and when it stops counting, for the reader and the watch. */
function liveStatement(
    statements: readonly MoodStatement[],
    signer: HexString,
    nowSecs: number,
): { mood: Mood; lapsesAt: number } | null {
    const wanted = signer.toLowerCase();
    let best: MoodStatement | null = null;
    for (const statement of statements) {
        if (statement.signer?.toLowerCase() !== wanted || statement.expiry === undefined) continue;
        if (!best || statement.expiry > (best.expiry as bigint)) best = statement;
    }
    if (!best || !best.data) return null;
    const storeLapse = Number((best.expiry as bigint) >> 32n);
    if (storeLapse <= nowSecs) return null;
    const mood = decodeMoodBody(best.data);
    if (!mood || nowSecs >= mood.expiresAt) return null;
    return { mood, lapsesAt: Math.min(storeLapse, mood.expiresAt) };
}

/**
 * The live mood among `statements`, or null. Only the feed's signer counts,
 * because the store lets anyone post on any topic; of the signer's own, the
 * highest expiry wins, and it counts only while unexpired in the store and
 * while its own `set_at + ttl` has not passed, both on the reader's clock.
 */
export function pickMood(
    statements: readonly MoodStatement[],
    signer: HexString,
    nowSecs: number,
): Mood | null {
    return liveStatement(statements, signer, nowSecs)?.mood ?? null;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const hostFailed = (what: string, cause: unknown) =>
    new ProfileError("Host", `the host could not ${what}`, { cause });

/** A signed statement as the reader rule sees it. Bad hex is a statement with no body. */
function toMoodStatement(statement: SignedStatement): MoodStatement {
    let data: Uint8Array | undefined;
    try {
        data = statement.data === undefined ? undefined : hexToBytes(statement.data.slice(2));
    } catch {
        data = undefined;
    }
    return {
        signer:
            statement.proof.tag === "Sr25519"
                ? (statement.proof.value.signer.toLowerCase() as HexString)
                : null,
        expiry: statement.expiry,
        data,
    };
}

/** The signer a proof carries. Mood readers accept Sr25519 only, which is what the allowance key is. */
function proofSigner(proof: StatementProof): Result<HexString, ProfileError> {
    return proof.tag === "Sr25519"
        ? ok(proof.value.signer.toLowerCase() as HexString)
        : err(
              new ProfileError(
                  "Host",
                  `the host signs statements with ${proof.tag}, which mood readers do not accept`,
              ),
          );
}

/**
 * The `mood` feed entry a publish writes for a name: the topic from host
 * entropy over the name, the signer learned from a proof over a throwaway
 * statement that is never submitted. Both are stable per wallet and product,
 * so every publish from the same product writes the same entry.
 *
 * Include it in every publish patch, not only the first, so the topic is in
 * the record before any mood is set. The feed replaces the record's mood feed
 * by kind, so a product that publishes takes the feed over: a mood set from
 * another product no longer shows until that product publishes again.
 *
 * The proof needs the statement-store allowance, so the product requests that
 * before its first publish, not after.
 */
export async function deriveMoodFeed(
    label: string,
    opts: DotNsClientOptions,
    statements: HostStatementStore,
    deriveEntropy: DeriveEntropy,
): Promise<Result<ProfileFeed, DotNsError | ProfileError>> {
    const tld = await resolveTld(opts);
    if (!tld.ok) return tld;
    const bare = normalizeProfileLabel(label, tld.value);
    if (!isAcceptableProfileLabel(bare)) {
        return err(new DotNsError("InvalidName", `${JSON.stringify(label)} is not a dotNS name`));
    }

    const entropy = await deriveEntropy(utf8ToBytes(moodTopicLabel(`${bare}${tld.value.suffix}`)));
    if (!entropy.ok) return err(hostFailed("derive the mood topic", entropy.error));
    if (entropy.value.length !== 32) {
        return err(
            new ProfileError("Host", `the host derived ${entropy.value.length} bytes, not 32`),
        );
    }

    const probe: Statement = { topics: [ZERO_TOPIC], expiry: BigInt(nowSeconds() + 60) << 32n };
    let proof: StatementProof;
    try {
        proof = await statements.createProofAuthorized(probe);
    } catch (cause) {
        return err(hostFailed("prove a statement", cause));
    }
    const signer = proofSigner(proof);
    if (!signer.ok) return signer;
    return ok({
        kind: MOOD_FEED_KIND,
        topic: `0x${bytesToHex(entropy.value)}`,
        signer: signer.value,
    });
}

// The last expiry this session sent. The store replaces a statement only for a
// strictly higher expiry, so a set in the same millisecond as the last, or
// after the clock stepped back, still goes out above it.
let lastExpiry = 0n;

/**
 * Set the name's mood now, or clear it with `null`. One statement on the
 * feed's topic, proved by the host and submitted; no record write.
 *
 * The proof must come from the feed's signer, or no reader will show the mood:
 * `SignerMismatch` means this product's key is not the one the record names,
 * so the product publishes the record with its own feed first.
 */
export async function setMood(
    feed: ProfileFeed,
    mood: MoodChoice | null,
    statements: HostStatementStore,
): Promise<Result<Mood | null, ProfileError>> {
    const nowMs = Date.now();
    const setAt = Math.floor(nowMs / 1000);
    const body = encodeMoodBody(mood, setAt);
    if (!body.ok) return body;
    // The millisecond within the second orders two sets in the same second.
    const expiry = moodExpiry(setAt, nowMs % 1000);
    lastExpiry = expiry > lastExpiry ? expiry : lastExpiry + 1n;
    const statement: Statement = {
        topics: [feed.topic],
        channel: feed.topic,
        expiry: lastExpiry,
        data: `0x${bytesToHex(body.value)}`,
    };

    let proof: StatementProof;
    try {
        proof = await statements.createProofAuthorized(statement);
    } catch (cause) {
        return err(hostFailed("prove the mood", cause));
    }
    const signer = proofSigner(proof);
    if (!signer.ok) return signer;
    if (signer.value !== feed.signer.toLowerCase()) {
        log.debug("the host's statement key is not the record's mood signer");
        return err(
            new ProfileError(
                "SignerMismatch",
                "the host signs as a key the record's mood feed does not name; publish the record from this product first",
            ),
        );
    }

    try {
        await statements.submit({ ...statement, proof });
    } catch (cause) {
        return err(hostFailed("submit the mood", cause));
    }
    log.debug(mood ? "mood sent" : "mood cleared");
    return ok(mood ? { ...mood, setAt, expiresAt: setAt + MOOD_TTL_SECS } : null);
}

/** Options for {@link readMood}. */
export interface ReadMoodOptions {
    /** Default {@link DEFAULT_MOOD_READ_TIMEOUT_MS}. */
    timeoutMs?: number;
    signal?: AbortSignal;
}

/**
 * The mood a feed shows now, or null. Reads the topic's backfill through the
 * host, keeping only the feed signer's statements, and applies
 * {@link pickMood}. An error means the host could not be read, which is not
 * the same as no mood: keep what was shown.
 */
export async function readMood(
    feed: ProfileFeed,
    statements: HostStatementStore,
    options: ReadMoodOptions = {},
): Promise<Result<Mood | null, ProfileError>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_MOOD_READ_TIMEOUT_MS;
    const wanted = feed.signer.toLowerCase();
    const own: MoodStatement[] = [];
    const outcome = await new Promise<Result<void, ProfileError>>((resolve) => {
        // A page can arrive before `subscribe` returns, so the handle may not
        // exist yet when the read ends.
        let subscription: HostSubscription | undefined;
        let cancelInterrupt: (() => void) | undefined;
        let ended = false;
        const end = (result: Result<void, ProfileError>) => {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            cancelInterrupt?.();
            subscription?.unsubscribe();
            resolve(result);
        };
        const onAbort = () =>
            end(
                err(
                    new ProfileError("Timeout", "the mood read was aborted", {
                        cause: options.signal?.reason,
                    }),
                ),
            );
        const timer = setTimeout(
            () =>
                end(
                    err(
                        new ProfileError(
                            "Timeout",
                            `the mood feed did not answer within ${timeoutMs} ms`,
                        ),
                    ),
                ),
            timeoutMs,
        );
        if (options.signal?.aborted) return onAbort();
        options.signal?.addEventListener("abort", onAbort, { once: true });
        try {
            subscription = statements.subscribe({ matchAll: [feed.topic] }, (page) => {
                for (const s of page.statements) {
                    const statement = toMoodStatement(s);
                    if (statement.signer === wanted) own.push(statement);
                }
                if (page.isComplete) end(ok(undefined));
            });
            cancelInterrupt = subscription.onInterrupt((reason) =>
                end(err(hostFailed("keep reading", reason))),
            );
        } catch (cause) {
            end(err(hostFailed("subscribe to the mood feed", cause)));
        }
        if (ended) {
            cancelInterrupt?.();
            subscription?.unsubscribe();
        }
    });
    if (!outcome.ok) return outcome;
    return ok(pickMood(own, feed.signer, nowSeconds()));
}

/** Options for {@link watchMood}. */
export interface WatchMoodOptions {
    /** Called when the host stops the subscription. The watch is over then. */
    onError?: (error: ProfileError) => void;
}

/** A running {@link watchMood}. */
export interface MoodWatch {
    unsubscribe(): void;
}

const sameMood = (a: Mood | null, b: Mood | null): boolean =>
    a === b ||
    (a !== null &&
        b !== null &&
        a.kind === b.kind &&
        a.intensity === b.intensity &&
        a.setAt === b.setAt);

/**
 * Keep reading a feed: `onChange` gets the live mood once the backfill is in,
 * then again whenever it changes, including to null when it lapses with no
 * new statement. Only the feed signer's highest statement is kept, so a long
 * watch stays small. `err` when the host refused the subscription outright.
 */
export function watchMood(
    feed: ProfileFeed,
    statements: HostStatementStore,
    onChange: (mood: Mood | null) => void,
    options: WatchMoodOptions = {},
): Result<MoodWatch, ProfileError> {
    const wanted = feed.signer.toLowerCase();
    let best: MoodStatement | null = null;
    // `undefined` until the first report, so a backfill with no mood still reports null.
    let shown: Mood | null | undefined;
    let complete = false;
    let stopped = false;
    let lapse: ReturnType<typeof setTimeout> | undefined;

    const evaluate = () => {
        if (stopped || !complete) return;
        clearTimeout(lapse);
        const now = nowSeconds();
        const live = liveStatement(best ? [best] : [], feed.signer, now);
        const mood = live?.mood ?? null;
        if (shown === undefined || !sameMood(mood, shown)) {
            shown = mood;
            onChange(mood);
        }
        // Re-evaluate when it lapses, so a feed with no new statement goes
        // quiet. `lapsesAt` is within a day, so the delay is always a real one.
        if (live) lapse = setTimeout(evaluate, (live.lapsesAt - now) * 1000 + 1);
    };

    const ingest = (page: StatementsPage) => {
        for (const s of page.statements) {
            const statement = toMoodStatement(s);
            if (statement.signer !== wanted || statement.expiry === undefined) continue;
            if (!best || statement.expiry > (best.expiry as bigint)) best = statement;
        }
        if (page.isComplete) complete = true;
        evaluate();
    };

    let subscription: HostSubscription | undefined;
    let cancelInterrupt: (() => void) | undefined;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(lapse);
        cancelInterrupt?.();
        subscription?.unsubscribe();
    };
    try {
        subscription = statements.subscribe({ matchAll: [feed.topic] }, ingest);
        cancelInterrupt = subscription.onInterrupt((reason) => {
            if (stopped) return;
            stop();
            options.onError?.(hostFailed("keep watching", reason));
        });
    } catch (cause) {
        stop();
        return err(hostFailed("subscribe to the mood feed", cause));
    }
    if (stopped) {
        cancelInterrupt?.();
        subscription.unsubscribe();
    }
    return ok({ unsubscribe: stop });
}
