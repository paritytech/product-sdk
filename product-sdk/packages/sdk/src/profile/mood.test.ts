// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// The mood feed against doubles of the host's statement store. The body, the
// expiry packing and the reader rule are pinned to the first publisher's vectors
// (`profile-core/test/mood-feed.test.ts` there), so a mood set by either reads
// the same from the other. The fake store is hand-rolled because the host
// package's fake has an inert statement store and no entropy domain.
import { createFakeContractRuntime } from "@parity/product-sdk-contracts/testing";
import { blake2b256, bytesToHex } from "@parity/product-sdk-crypto";
import {
    type HostStatementStore,
    HostTimeoutError,
    type SignedStatement,
    type Statement,
    type StatementsPage,
} from "@parity/product-sdk-host";
import { type Result, err, ok } from "@parity/result";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DOT_TLD } from "../identity/dotns-namehash.js";
import {
    MOOD_TTL_SECS,
    type Mood,
    type MoodChoice,
    type MoodStatement,
    type MoodWatch,
    decodeMoodBody,
    deriveMoodFeed,
    encodeMoodBody,
    moodExpiry,
    moodTopicKey,
    moodTopicLabel,
    pickMood,
    readMood,
    setMood,
    watchMood,
} from "./mood.js";
import type { ProfileFeed } from "./types.js";

const SIGNER = `0x${"aa".repeat(32)}` as const;
const OTHER = `0x${"bb".repeat(32)}` as const;
const TOPIC = `0x${"11".repeat(32)}` as const;
const NOW = 1_800_000_000;
const CALM: Mood = {
    kind: "calm",
    intensity: "loud",
    setAt: NOW - 60,
    expiresAt: NOW - 60 + 86_400,
};
const FEED: ProfileFeed = { kind: "mood", topic: TOPIC, signer: SIGNER };

const hex = (bytes: Uint8Array) => bytesToHex(bytes);
const unwrap = <T, E extends Error>(result: Result<T, E>): T => {
    if (!result.ok) throw result.error;
    return result.value;
};
const body = (mood: MoodChoice | null, setAt: number) => unwrap(encodeMoodBody(mood, setAt));
const reason = <T>(result: Result<T, { reason: string }>) =>
    result.ok ? "ok" : result.error.reason;

/** The vectors' statement builder, on this module's types. */
const statement = (
    mood: Mood | null,
    opts: { signer?: `0x${string}`; setAt?: number; seq?: number } = {},
): MoodStatement => {
    const setAt = opts.setAt ?? mood?.setAt ?? NOW;
    return {
        signer: opts.signer ?? SIGNER,
        expiry: moodExpiry(setAt, opts.seq ?? 0),
        data: body(mood, setAt),
    };
};

/** A signed statement as the host would deliver it. */
const signed = (
    mood: MoodChoice | null,
    setAt: number,
    opts: {
        signer?: `0x${string}`;
        seq?: number;
        tag?: "Sr25519" | "Ed25519";
        data?: `0x${string}`;
        expiry?: bigint | null;
    } = {},
): SignedStatement => ({
    topics: [TOPIC],
    channel: TOPIC,
    ...(opts.expiry === null ? {} : { expiry: opts.expiry ?? moodExpiry(setAt, opts.seq ?? 0) }),
    data: opts.data ?? `0x${hex(body(mood, setAt))}`,
    proof: {
        tag: opts.tag ?? "Sr25519",
        value: { signature: `0x${"00".repeat(64)}`, signer: opts.signer ?? SIGNER },
    } as SignedStatement["proof"],
});

interface FakeStore extends HostStatementStore {
    submitted: SignedStatement[];
    /** Deliver a page to every open subscription. */
    deliver(page: StatementsPage): void;
    /** Fire the host-side interrupt on every open subscription. */
    interrupt(reason?: unknown): void;
    unsubscribed: number;
    cancelled: number;
}

/**
 * A store that proves as `signer`, records submissions, and delivers what the
 * test says: `pages` after `subscribe` returns, as from the host, or inside
 * `subscribe` with `sync`.
 */
function fakeStore(
    opts: { signer?: `0x${string}`; pages?: StatementsPage[]; sync?: boolean } = {},
): FakeStore {
    const listeners = new Set<(page: StatementsPage) => void>();
    // Kept past unsubscribe on purpose: a late interrupt must be the module's to ignore.
    const handlers = new Set<(reason?: unknown) => void>();
    const store: FakeStore = {
        submitted: [],
        unsubscribed: 0,
        cancelled: 0,
        deliver(page) {
            for (const listener of listeners) listener(page);
        },
        interrupt(reason) {
            for (const onInterrupt of handlers) onInterrupt(reason);
        },
        subscribe(_filter, callback) {
            listeners.add(callback);
            const send = () => {
                for (const page of opts.pages ?? []) callback(page);
            };
            if (opts.sync) send();
            else queueMicrotask(send);
            return {
                unsubscribe() {
                    listeners.delete(callback);
                    store.unsubscribed += 1;
                },
                onInterrupt(onInterrupt) {
                    handlers.add(onInterrupt);
                    return () => {
                        store.cancelled += 1;
                    };
                },
            };
        },
        async createProofAuthorized(_statement: Statement) {
            return {
                tag: "Sr25519",
                value: { signature: `0x${"00".repeat(64)}`, signer: opts.signer ?? SIGNER },
            };
        },
        async submit(signedStatement) {
            store.submitted.push(signedStatement);
        },
    };
    return store;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the body, the expiry packing and the topic label", () => {
    test("pin the published vectors", () => {
        expect(hex(body(CALM, CALM.setAt))).toBe(`0002${"c4d1496b00000000"}${"80510100"}`);
        expect(hex(body(null, NOW))).toBe(`ffff${"00d2496b00000000"}${"80510100"}`);
        expect(moodExpiry(NOW, 7)).toBe((BigInt(NOW + 86_400) << 32n) | 7n);
        expect(moodTopicLabel("alice.paseo")).toBe("profile:mood:topic:v1:alice.paseo");
    });

    test("the body round-trips, and a clear, an unknown index or a short body is no mood", () => {
        expect(decodeMoodBody(body(CALM, CALM.setAt))).toEqual(CALM);
        expect(decodeMoodBody(body(null, NOW))).toBeNull();
        expect(decodeMoodBody(Uint8Array.of(99, 0, ...new Uint8Array(12)))).toBeNull();
        expect(decodeMoodBody(Uint8Array.of(0, 99, ...new Uint8Array(12)))).toBeNull();
        expect(decodeMoodBody(new Uint8Array(13))).toBeNull();
        expect(decodeMoodBody(new Uint8Array(15))).toBeNull();
    });

    test("a kind or intensity outside the palette is InvalidEntry", () => {
        expect(reason(encodeMoodBody({ kind: "furious" as never, intensity: "soft" }, NOW))).toBe(
            "InvalidEntry",
        );
        expect(reason(encodeMoodBody({ kind: "calm", intensity: "max" as never }, NOW))).toBe(
            "InvalidEntry",
        );
    });

    test("a writer's ttl is held to a day", () => {
        const bytes = body(CALM, CALM.setAt);
        bytes.set([0xff, 0xff, 0xff, 0xff], 10);
        expect(decodeMoodBody(bytes)?.expiresAt).toBe(CALM.setAt + MOOD_TTL_SECS);
    });
});

describe("pickMood", () => {
    test("takes the highest expiry from the feed signer, and ignores everyone else", () => {
        const later: Mood = {
            ...CALM,
            kind: "hyped",
            setAt: NOW - 10,
            expiresAt: NOW - 10 + 86_400,
        };
        const foreign = statement({ ...CALM, kind: "away", setAt: NOW - 1 }, { signer: OTHER });
        expect(pickMood([statement(CALM), statement(later), foreign], SIGNER, NOW)).toEqual(later);
        expect(pickMood([foreign], SIGNER, NOW)).toBeNull();
    });

    test("a clear with a later expiry means no mood", () => {
        expect(
            pickMood([statement(CALM), statement(null, { setAt: NOW - 5 })], SIGNER, NOW),
        ).toBeNull();
    });

    test("an expired mood is no mood, on the reader clock", () => {
        const old: Mood = { ...CALM, setAt: NOW - 90_000, expiresAt: NOW - 90_000 + 86_400 };
        expect(pickMood([statement(old)], SIGNER, NOW)).toBeNull();
    });

    test("the sequence breaks a tie within the same second", () => {
        const second: Mood = { ...CALM, kind: "social" };
        expect(
            pickMood([statement(CALM, { seq: 1 }), statement(second, { seq: 2 })], SIGNER, NOW),
        ).toEqual(second);
    });

    test("a body set in the future shows within a day of now and not beyond, on the owner's own clock", () => {
        const soon: Mood = { ...CALM, setAt: NOW + 100, expiresAt: NOW + 100 + 86_400 };
        expect(pickMood([statement(soon)], SIGNER, NOW)).toEqual(soon);
        const far: Mood = { ...CALM, setAt: NOW + 2 * 86_400, expiresAt: NOW + 3 * 86_400 };
        expect(pickMood([statement(far)], SIGNER, NOW)).toBeNull();
    });

    test("the signer compares case-insensitively, and a statement with no data is skipped", () => {
        expect(pickMood([statement(CALM)], SIGNER.toUpperCase() as `0x${string}`, NOW)).toEqual(
            CALM,
        );
        expect(pickMood([{ signer: SIGNER, expiry: moodExpiry(NOW, 0) }], SIGNER, NOW)).toBeNull();
    });
});

describe("deriveMoodFeed", () => {
    const opts = { runtime: createFakeContractRuntime(), tld: DOT_TLD };
    /** As the host core derives: a key of 1 to 32 bytes, or an error (truapi `host_logic/entropy.rs`). */
    const entropy = (bytes: Uint8Array) =>
        vi.fn(async (key: Uint8Array) =>
            key.length >= 1 && key.length <= 32
                ? ok(bytes)
                : err(new Error(`"key" must be between 1 and 32 bytes, got ${key.length}`)),
        );
    const keyOf = (label: string) => blake2b256(new TextEncoder().encode(label));

    test("derives the topic from the full name and learns the signer from a proof it never submits", async () => {
        const store = fakeStore();
        const derive = entropy(new Uint8Array(32).fill(0x11));
        const feed = await deriveMoodFeed("Alice.dot", opts, store, derive);
        expect(feed).toEqual(ok({ kind: "mood", topic: TOPIC, signer: SIGNER }));
        expect(derive).toHaveBeenCalledWith(keyOf("profile:mood:topic:v1:alice.dot"));
        expect(store.submitted).toEqual([]);
    });

    test("a lite username keeps its parts", async () => {
        const derive = entropy(new Uint8Array(32).fill(0x11));
        await deriveMoodFeed("alice.01", opts, fakeStore(), derive);
        expect(derive).toHaveBeenCalledWith(keyOf("profile:mood:topic:v1:alice.01.dot"));
    });

    test("the key is 32 bytes whatever the name, so a long name derives as the host allows", async () => {
        // 40 bytes of label: the raw label is what a host refused.
        const derive = entropy(new Uint8Array(32).fill(0x11));
        const feed = await deriveMoodFeed("devdevdev.01", opts, fakeStore(), derive);
        expect(feed.ok).toBe(true);
        const key = derive.mock.calls[0]?.[0];
        expect(key).toHaveLength(32);
        expect(moodTopicKey("devdevdev.01.dot")).toEqual(key);
    });

    test("the key is the blake2b-256 of the label, as the first publisher derived it, so no topic moves", () => {
        // The first publisher hashed the label with blake2b-256 before handing it to the host.
        // The vector is Python's hashlib.blake2b(label, digest_size=32), an
        // implementation independent of the one under test.
        expect(bytesToHex(moodTopicKey("alice.paseo"))).toBe(
            "3d78979a1d4cb8cc7351ecc95ebc6bdac32f9afe5652041562a36960813d9c53",
        );
        expect(moodTopicKey("alice.paseo")).not.toEqual(moodTopicKey("alice.dot"));
    });

    test("refuses a label that is not a name, entropy that is not 32 bytes, and a host that cannot derive or prove", async () => {
        const store = fakeStore();
        const good = entropy(new Uint8Array(32));
        expect(reason(await deriveMoodFeed("not a name!", opts, store, good))).toBe("InvalidName");
        expect(
            reason(await deriveMoodFeed("alice", opts, store, entropy(new Uint8Array(16)))),
        ).toBe("Host");
        const down = async () => err(new Error("no host"));
        expect(reason(await deriveMoodFeed("alice", opts, store, down))).toBe("Host");

        const refusing = fakeStore();
        refusing.createProofAuthorized = async () => {
            throw new Error("declined");
        };
        expect(reason(await deriveMoodFeed("alice", opts, refusing, good))).toBe("Host");

        const ed = fakeStore();
        ed.createProofAuthorized = async () => ({
            tag: "Ed25519",
            value: { signature: "0x", signer: SIGNER },
        });
        expect(reason(await deriveMoodFeed("alice", opts, ed, good))).toBe("Host");
    });
});

describe("setMood", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    test("one statement on the topic, as channel, with the packed expiry and the 14-byte body", async () => {
        vi.setSystemTime(NOW * 1000 + 345);
        const store = fakeStore();
        const result = await setMood(FEED, { kind: "calm", intensity: "loud" }, store);
        expect(result).toEqual(
            ok({ kind: "calm", intensity: "loud", setAt: NOW, expiresAt: NOW + MOOD_TTL_SECS }),
        );
        const [sent] = store.submitted;
        expect(sent?.topics).toEqual([TOPIC]);
        expect(sent?.channel).toBe(TOPIC);
        expect(sent?.expiry).toBe(moodExpiry(NOW, 345));
        expect(sent?.data).toBe(`0x${hex(body({ kind: "calm", intensity: "loud" }, NOW))}`);
        expect(sent?.proof.tag).toBe("Sr25519");
    });

    test("a set in the same millisecond, or after the clock stepped back, still goes out above the last", async () => {
        vi.setSystemTime(NOW * 1000 + 500);
        const store = fakeStore();
        await setMood(FEED, { kind: "calm", intensity: "soft" }, store);
        await setMood(FEED, { kind: "hyped", intensity: "soft" }, store);
        vi.setSystemTime(NOW * 1000 - 5_000);
        await setMood(FEED, null, store);
        const expiries = store.submitted.map((s) => s.expiry as bigint);
        expect(expiries[1]).toBe((expiries[0] as bigint) + 1n);
        expect(expiries[2]).toBe((expiries[1] as bigint) + 1n);
    });

    test("a clear is the clear body and answers null", async () => {
        vi.setSystemTime(NOW * 1000 + 10_000);
        const store = fakeStore();
        expect(await setMood(FEED, null, store)).toEqual(ok(null));
        expect(store.submitted[0]?.data).toBe(`0x${hex(body(null, NOW + 10))}`);
    });

    test("a choice outside the palette is InvalidEntry, before the host is asked", async () => {
        const store = fakeStore();
        expect(
            reason(await setMood(FEED, { kind: "furious" as never, intensity: "soft" }, store)),
        ).toBe("InvalidEntry");
        expect(store.submitted).toEqual([]);
    });

    test("a host that signs as another key is SignerMismatch, and nothing is submitted", async () => {
        const store = fakeStore({ signer: OTHER });
        expect(reason(await setMood(FEED, { kind: "calm", intensity: "soft" }, store))).toBe(
            "SignerMismatch",
        );
        expect(store.submitted).toEqual([]);
    });

    test("a host that cannot prove or cannot submit is Host, with the cause", async () => {
        const broken = fakeStore();
        broken.createProofAuthorized = async () => {
            throw new Error("declined");
        };
        const proving = await setMood(FEED, { kind: "calm", intensity: "soft" }, broken);
        expect(reason(proving)).toBe("Host");
        expect(!proving.ok && (proving.error.cause as Error).message).toBe("declined");

        const stuck = fakeStore();
        stuck.submit = async () => {
            throw new Error("offline");
        };
        expect(reason(await setMood(FEED, { kind: "calm", intensity: "soft" }, stuck))).toBe(
            "Host",
        );
    });

    test("a submit the host did not confirm in time is Timeout: the mood may still land", async () => {
        const slow = fakeStore();
        slow.submit = async () => {
            throw new HostTimeoutError(
                "statement submit",
                Object.assign(new Error("RequestTimeoutError"), { timeoutMs: 30_000 }),
            );
        };
        expect(reason(await setMood(FEED, { kind: "calm", intensity: "soft" }, slow))).toBe(
            "Timeout",
        );
    });
});

describe("readMood", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW * 1000);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    test("collects the backfill, keeps the feed signer's statements, and answers the live mood", async () => {
        const store = fakeStore({
            pages: [
                {
                    statements: [signed({ kind: "hyped", intensity: "soft" }, NOW - 5, { seq: 1 })],
                    isComplete: false,
                },
                {
                    statements: [
                        signed({ kind: "away", intensity: "loud" }, NOW, { seq: 2, signer: OTHER }),
                    ],
                    isComplete: true,
                },
            ],
        });
        expect(await readMood(FEED, store)).toEqual(
            ok({ kind: "hyped", intensity: "soft", setAt: NOW - 5, expiresAt: NOW - 5 + 86_400 }),
        );
        expect(store.unsubscribed).toBe(1);
        expect(store.cancelled).toBe(1);
    });

    test("a page delivered inside subscribe still ends the read and closes the subscription", async () => {
        const store = fakeStore({
            pages: [
                {
                    statements: [signed({ kind: "calm", intensity: "soft" }, NOW)],
                    isComplete: true,
                },
            ],
            sync: true,
        });
        expect((await readMood(FEED, store)).ok && true).toBe(true);
        expect(unwrap(await readMood(FEED, store))?.kind).toBe("calm");
        expect(store.unsubscribed).toBe(2);
    });

    test("an empty topic is no mood; a non-Sr25519 proof, bad hex, or a missing expiry does not count", async () => {
        const page = (s: SignedStatement) =>
            fakeStore({ pages: [{ statements: [s], isComplete: true }] });
        expect(
            await readMood(FEED, fakeStore({ pages: [{ statements: [], isComplete: true }] })),
        ).toEqual(ok(null));
        expect(
            await readMood(
                FEED,
                page(signed({ kind: "calm", intensity: "soft" }, NOW, { tag: "Ed25519" })),
            ),
        ).toEqual(ok(null));
        expect(
            await readMood(FEED, page(signed(null, NOW, { data: "0xzz" as `0x${string}` }))),
        ).toEqual(ok(null));
        expect(
            await readMood(
                FEED,
                page(signed({ kind: "calm", intensity: "soft" }, NOW, { expiry: null })),
            ),
        ).toEqual(ok(null));
    });

    test("a backfill that never completes is Timeout, and the subscription is closed", async () => {
        vi.useRealTimers();
        const store = fakeStore({ pages: [{ statements: [], isComplete: false }] });
        expect(reason(await readMood(FEED, store, { timeoutMs: 10 }))).toBe("Timeout");
        expect(store.unsubscribed).toBe(1);
    });

    test("an abort is Timeout with the reason, before or during the read", async () => {
        vi.useRealTimers();
        const early = new AbortController();
        early.abort("closed");
        const store = fakeStore({ pages: [{ statements: [], isComplete: false }] });
        const before = await readMood(FEED, store, { signal: early.signal });
        expect(reason(before)).toBe("Timeout");
        expect(!before.ok && before.error.cause).toBe("closed");
        expect(store.unsubscribed).toBe(0);

        const late = new AbortController();
        const pending = readMood(FEED, store, { signal: late.signal });
        await tick();
        late.abort();
        expect(reason(await pending)).toBe("Timeout");
        expect(store.unsubscribed).toBe(1);
    });

    test("a host that cannot subscribe, or interrupts the subscription, is Host", async () => {
        const store = fakeStore();
        store.subscribe = () => {
            throw new Error("no host");
        };
        expect(reason(await readMood(FEED, store))).toBe("Host");

        const dropped = fakeStore({ pages: [{ statements: [], isComplete: false }] });
        const pending = readMood(FEED, dropped);
        await tick();
        dropped.interrupt("gone");
        const result = await pending;
        expect(reason(result)).toBe("Host");
        expect(!result.ok && result.error.cause).toBe("gone");
        expect(dropped.unsubscribed).toBe(1);
    });
});

describe("watchMood", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(NOW * 1000);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    test("reports the live mood once the backfill is in, then each change, and stops on unsubscribe", async () => {
        const store = fakeStore({
            pages: [
                { statements: [], isComplete: false },
                {
                    statements: [signed({ kind: "calm", intensity: "soft" }, NOW - 5, { seq: 1 })],
                    isComplete: true,
                },
            ],
        });
        const seen: (Mood | null)[] = [];
        const watch = unwrap(watchMood(FEED, store, (mood) => seen.push(mood)));
        expect(seen).toEqual([]);
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.map((m) => m?.kind)).toEqual(["calm"]);

        // The same mood again is not a change; a newer one is; a foreign one
        // is nothing; a clear is.
        store.deliver({
            statements: [signed({ kind: "calm", intensity: "soft" }, NOW - 5, { seq: 1 })],
            isComplete: true,
        });
        store.deliver({
            statements: [signed({ kind: "hyped", intensity: "loud" }, NOW, { seq: 2 })],
            isComplete: true,
        });
        store.deliver({
            statements: [
                signed({ kind: "focused", intensity: "loud" }, NOW, { seq: 3, signer: OTHER }),
            ],
            isComplete: true,
        });
        store.deliver({ statements: [signed(null, NOW + 1, { seq: 0 })], isComplete: true });
        expect(seen.map((m) => m?.kind ?? null)).toEqual(["calm", "hyped", null]);

        watch.unsubscribe();
        expect(store.unsubscribed).toBe(1);
        expect(store.cancelled).toBe(1);
        store.deliver({
            statements: [signed({ kind: "away", intensity: "soft" }, NOW + 2)],
            isComplete: true,
        });
        expect(seen).toHaveLength(3);
    });

    test("a backfill with no mood reports null once", async () => {
        const store = fakeStore({ pages: [{ statements: [], isComplete: true }] });
        const seen: (Mood | null)[] = [];
        unwrap(watchMood(FEED, store, (mood) => seen.push(mood)));
        await vi.advanceTimersByTimeAsync(0);
        store.deliver({ statements: [], isComplete: true });
        expect(seen).toEqual([null]);
    });

    test("a mood that lapses with no new statement goes to null on its own, at the earlier of the two clocks", async () => {
        // The body says a day; the store says five seconds. The watch follows the store.
        const soon = signed({ kind: "calm", intensity: "soft" }, NOW - 10, {
            expiry: (BigInt(NOW + 5) << 32n) | 1n,
        });
        const store = fakeStore({ pages: [{ statements: [soon], isComplete: true }] });
        const seen: (Mood | null)[] = [];
        unwrap(watchMood(FEED, store, (mood) => seen.push(mood)));
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.map((m) => m?.kind ?? null)).toEqual(["calm"]);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(seen).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(seen.map((m) => m?.kind ?? null)).toEqual(["calm", null]);
    });

    test("a mood set ahead of the reader's clock lapses a day from now, not later", async () => {
        const ahead = signed({ kind: "calm", intensity: "soft" }, NOW + 3600);
        const store = fakeStore({ pages: [{ statements: [ahead], isComplete: true }] });
        const seen: (Mood | null)[] = [];
        unwrap(watchMood(FEED, store, (mood) => seen.push(mood)));
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.map((m) => m?.kind)).toEqual(["calm"]);
        // The first timer is bounded to a day from now; the mood itself lasts
        // until an hour after that, when a second, shorter timer ends it.
        await vi.advanceTimersByTimeAsync(86_400_000 + 1_000);
        expect(seen).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(seen.map((m) => m?.kind ?? null)).toEqual(["calm", null]);
    });

    test("unsubscribing from inside onChange leaves no timer behind", async () => {
        const store = fakeStore({
            pages: [
                {
                    statements: [signed({ kind: "calm", intensity: "soft" }, NOW)],
                    isComplete: true,
                },
            ],
        });
        let watch: MoodWatch | undefined = undefined;
        const started = watchMood(FEED, store, () => watch?.unsubscribe());
        watch = unwrap(started);
        await vi.advanceTimersByTimeAsync(0);
        expect(store.unsubscribed).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    test("unsubscribing clears the lapse timer", async () => {
        const store = fakeStore({
            pages: [
                {
                    statements: [signed({ kind: "calm", intensity: "soft" }, NOW - 86_395)],
                    isComplete: true,
                },
            ],
        });
        const seen: (Mood | null)[] = [];
        const watch = unwrap(watchMood(FEED, store, (mood) => seen.push(mood)));
        await vi.advanceTimersByTimeAsync(0);
        watch.unsubscribe();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(seen.map((m) => m?.kind)).toEqual(["calm"]);
    });

    test("a page delivered inside subscribe is seen", async () => {
        const store = fakeStore({
            pages: [
                {
                    statements: [signed({ kind: "calm", intensity: "soft" }, NOW)],
                    isComplete: true,
                },
            ],
            sync: true,
        });
        const seen: (Mood | null)[] = [];
        unwrap(watchMood(FEED, store, (mood) => seen.push(mood)));
        expect(seen.map((m) => m?.kind)).toEqual(["calm"]);
    });

    test("a host that refuses the subscription is err, not a silent watch", () => {
        const store = fakeStore();
        store.subscribe = () => {
            throw new Error("no host");
        };
        expect(reason(watchMood(FEED, store, () => {}))).toBe("Host");
    });

    test("an interrupted subscription ends the watch and reports Host once, and never after unsubscribe", async () => {
        const store = fakeStore();
        const onError = vi.fn();
        unwrap(watchMood(FEED, store, () => {}, { onError }));
        store.interrupt("gone");
        store.interrupt("gone again");
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]?.[0].reason).toBe("Host");
        expect(store.unsubscribed).toBe(1);

        const quiet = fakeStore();
        const onQuietError = vi.fn();
        const watch = unwrap(watchMood(FEED, quiet, () => {}, { onError: onQuietError }));
        watch.unsubscribe();
        quiet.interrupt("late");
        expect(onQuietError).not.toHaveBeenCalled();
    });
});
