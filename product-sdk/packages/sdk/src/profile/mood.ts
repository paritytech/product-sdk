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
 * doubles. Signers and topics are lower-case hex everywhere in memory: the
 * two places a signer enters, a proof and a statement, lower-case it, and the
 * feed's is lower-cased once at each entry point.
 */
import { blake2b256, bytesToHex, hexToBytes, utf8ToBytes } from "@parity/product-sdk-crypto";
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

import type { DotNsError } from "../identity/dotns-errors.js";
import type { DotNsClientOptions } from "../identity/dotns-registry.js";
import { decodeExact, moodBodyCodec } from "./codec.js";
import { ProfileError, hostCallFailed } from "./errors.js";
import { resolveProfileName } from "./lookup.js";
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
const DEFAULT_MOOD_READ_TIMEOUT_MS = 15_000;

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

/**
 * What the reader rule needs of one statement, once it has passed the two
 * checks a reader makes at the door: an Sr25519 proof, and an expiry. Exported
 * so a fixture can build them; `signer` is lower-case hex.
 */
export interface MoodStatement {
    signer: HexString;
    /** The store's expiry: seconds in the upper 32 bits, a sequence below. */
    expiry: bigint;
    /** The body. */
    data?: Uint8Array;
}

/**
 * `deriveEntropy` from `@parity/product-sdk/host`, or a double of it. The host
 * takes a key of 1 to 32 bytes and answers 32 bytes of entropy per wallet and
 * product; {@link deriveMoodFeed} hands it {@link moodTopicKey}, always 32.
 */
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
 * The key the mood topic's entropy is derived under: the blake2b-256 of
 * {@link moodTopicLabel}. The host refuses a key over 32 bytes, and the label
 * is 22 bytes before the name, so the label itself only fits a name of 10
 * bytes or fewer. The hash fits every name, and is the one Seity applied
 * before this module did, so a name's topic is the same either way.
 * Kept off the barrel, as the label is.
 */
export function moodTopicKey(fullName: string): Uint8Array {
    return blake2b256(utf8ToBytes(moodTopicLabel(fullName)));
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
 * the lower, the packing the statement store defines (and the statement-store
 * package's `createExpiry` spells, which this package does not depend on for
 * one shift). The store keeps one statement per signer and channel and
 * replaces it only for a strictly higher expiry, so the sequence lets a mood
 * set within the same second as the last still win. Taken modulo 2^32.
 */
export function moodExpiry(setAt: number, seq: number): bigint {
    return (BigInt(setAt + MOOD_TTL_SECS) << 32n) | BigInt(seq >>> 0);
}

/** Of two of the signer's statements, the one the store keeps live: the higher expiry. */
const higher = (a: MoodStatement | null, b: MoodStatement): MoodStatement =>
    a && a.expiry >= b.expiry ? a : b;

/**
 * What the signer's live statement says now, and when it stops counting, or
 * null. Only the feed signer can write what counts, so the bounds here are
 * against the owner's own clock being wrong, or their own writer being odd,
 * never against a stranger: a body set more than a day ahead is no mood, and
 * the lapse is never more than a day away, whatever the store's expiry says.
 */
function liveMood(
    best: MoodStatement | null,
    nowSecs: number,
): { mood: Mood; lapsesAt: number } | null {
    if (!best || !best.data) return null;
    const storeLapse = Number(best.expiry >> 32n);
    if (storeLapse <= nowSecs) return null;
    const mood = decodeMoodBody(best.data);
    if (!mood || nowSecs >= mood.expiresAt || mood.setAt > nowSecs + MOOD_TTL_SECS) return null;
    return { mood, lapsesAt: Math.min(storeLapse, mood.expiresAt, nowSecs + MOOD_TTL_SECS) };
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
    const wanted = signer.toLowerCase();
    let best: MoodStatement | null = null;
    for (const statement of statements) {
        if (statement.signer.toLowerCase() === wanted) best = higher(best, statement);
    }
    return liveMood(best, nowSecs)?.mood ?? null;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const hostFailed = (what: string, cause: unknown) =>
    hostCallFailed(`the host could not ${what}`, cause);

/**
 * A signed statement as the reader rule sees it, or null when it is not the
 * feed signer's: another signer, a proof that is not Sr25519, or no expiry.
 * The signer is checked before the body is decoded, since a public topic
 * can carry anyone's statements. Bad hex is a statement with no body.
 */
function ownStatement(statement: SignedStatement, wanted: string): MoodStatement | null {
    if (statement.proof.tag !== "Sr25519" || statement.expiry === undefined) return null;
    const signer = statement.proof.value.signer.toLowerCase() as HexString;
    if (signer !== wanted) return null;
    let data: Uint8Array | undefined;
    try {
        data = statement.data === undefined ? undefined : hexToBytes(statement.data.slice(2));
    } catch {
        data = undefined;
    }
    return { signer, expiry: statement.expiry, data };
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
 * entropy under {@link moodTopicKey}, the signer learned from a proof over a throwaway
 * statement that is never submitted. Both are stable per wallet and product,
 * so every publish from the same product writes the same entry.
 *
 * Include it in every publish patch, not only the first, so the topic is in
 * the record before any mood is set. The feed replaces the record's mood feed
 * by kind, so a product that publishes takes the feed over: a mood set from
 * another product no longer shows until that product publishes again.
 *
 * The probe is an interim: the host does not yet say which key it signs
 * statements with, so one is asked for and read off the proof. It needs the
 * statement-store allowance, so the product requests that before its first
 * publish, not after. A host accessor for the key would make this a plain read.
 */
export async function deriveMoodFeed(
    label: string,
    opts: DotNsClientOptions,
    statements: HostStatementStore,
    deriveEntropy: DeriveEntropy,
): Promise<Result<ProfileFeed, DotNsError | ProfileError>> {
    const name = await resolveProfileName(label, opts);
    if (!name.ok) return name;
    const { bare, tld } = name.value;

    // Entropy first, on its own: a host that cannot derive is not asked to sign.
    const entropy = await deriveEntropy(moodTopicKey(`${bare}${tld.suffix}`));
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

// The last expiry this session sent. The millisecond within the second orders
// two sets in one second across sessions; holding each send above the last
// orders them within a session when the millisecond repeats or the clock
// steps back. Neither alone covers both.
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
        const live = liveMood(best, now);
        const mood = live?.mood ?? null;
        if (shown === undefined || !sameMood(mood, shown)) {
            shown = mood;
            onChange(mood);
        }
        // `onChange` may have unsubscribed; a timer armed after that would
        // hold a process open. Otherwise re-evaluate when the mood lapses, so a
        // feed with no new statement goes quiet. `lapsesAt` is within a day of
        // `now`, so the delay fits a timer.
        if (live && !stopped) lapse = setTimeout(evaluate, (live.lapsesAt - now) * 1000 + 1);
    };

    const ingest = (page: StatementsPage) => {
        for (const s of page.statements) {
            const statement = ownStatement(s, wanted);
            if (statement) best = higher(best, statement);
        }
        if (page.isComplete) complete = true;
        evaluate();
    };

    // A page can arrive inside `subscribe`, before the handle exists, so the
    // teardown is written to run with or without it.
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

/** Options for {@link readMood}. */
export interface ReadMoodOptions {
    /** Default 15 s. */
    timeoutMs?: number;
    signal?: AbortSignal;
}

/**
 * The mood a feed shows now, or null: a {@link watchMood} taken to its first
 * report, which comes once the backfill is in, under a deadline. An error
 * means the host could not be read, which is not the same as no mood: keep
 * what was shown.
 */
export function readMood(
    feed: ProfileFeed,
    statements: HostStatementStore,
    options: ReadMoodOptions = {},
): Promise<Result<Mood | null, ProfileError>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_MOOD_READ_TIMEOUT_MS;
    return new Promise((resolve) => {
        let watch: MoodWatch | undefined = undefined;
        let done = false;
        const end = (result: Result<Mood | null, ProfileError>) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            watch?.unsubscribe();
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

        const started = watchMood(feed, statements, (mood) => end(ok(mood)), {
            onError: (error) => end(err(error)),
        });
        if (!started.ok) return end(started);
        watch = started.value;
        // The first report may have come inside `watchMood`, before the handle existed.
        if (done) watch.unsubscribe();
    });
}
