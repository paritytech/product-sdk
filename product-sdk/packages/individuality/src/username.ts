// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The account to username direction, over `Resources.Consumers`.
 *
 * `Resources.UsernameOwnerOf` answers "who owns this username". This module
 * answers the question a results or profile screen actually asks: "what is this
 * account's username". The chain keys `Resources.Consumers` by account and its
 * value carries both names plus the credibility.
 *
 * Three facts about the record come from the pallet, not from the descriptor,
 * and none of them is visible to the compiler:
 *
 * 1. **A lite username is always present, a full one only after a claim.** The
 *    chain writes `full_username` and `Credibility::Person` in the same
 *    statement, so an unset full username and `Lite` credibility always agree.
 * 2. **`full_username.is_none()` is the chain's own precondition for claiming a
 *    bare name.** Eligibility is a reading of this record, not a guess.
 * 3. **A demoted person keeps `Person` and keeps their full username.** Demotion
 *    fires when the person authorization goes stale, and it rewrites only the
 *    `demoted` flag, so that flag is the only signal separating a demoted person
 *    from one in good standing.
 *
 * Both names are restricted on chain to ASCII: a full username is lowercase
 * letters only, a lite username is letters, one dot, then digits. So a decode
 * failure here means the descriptor and the chain disagree.
 */
import { IndividualityDecodeError } from "./errors.js";

/**
 * The raw `Resources.Consumers` value, narrowed to the fields we read.
 *
 * The chain also sends `identifier_key`, an opaque communication key with no
 * bearing on names. Extra fields on the actual value are accepted; this is a
 * structural type, not an exhaustive record of the storage entry.
 */
export interface RawConsumerInfo {
    lite_username: Uint8Array;
    full_username?: Uint8Array | undefined;
    credibility: { type: string; value?: { alias: string; demoted: boolean } | undefined };
}

/**
 * A consumer's standing as the resources pallet records it.
 *
 * `alias` is the person alias the pallet stores against the credibility, which
 * is not the same value as a contextual alias from `People.AccountToAlias`.
 */
export type UsernameCredibility =
    | { tag: "Lite" }
    | { tag: "Person"; alias: string; demoted: boolean };

/** The usernames registered for one account, decoded. */
export interface ConsumerUsernames {
    /** Always present. Letters, one dot, then digits, for example `alice.07`. */
    liteUsername: string;
    /** The claimed bare name, when the account has claimed one. */
    fullUsername: string | null;
    credibility: UsernameCredibility;
}

/**
 * Decode a raw `Resources.Consumers` value.
 *
 * `undefined` in means the account has no consumer record, which is a real
 * answer rather than a failure, so it maps to `null` rather than throwing.
 */
export function decodeConsumerInfo(value: RawConsumerInfo | undefined): ConsumerUsernames | null {
    if (value === undefined) return null;

    const liteUsername = decodeUsername(value.lite_username);
    if (liteUsername.length === 0) {
        throw new IndividualityDecodeError("consumer record has no lite username");
    }

    return {
        liteUsername,
        fullUsername: optionalUsername(value.full_username),
        credibility: decodeCredibility(value.credibility),
    };
}

/**
 * Decode one name strictly.
 *
 * The lenient default turns malformed bytes into U+FFFD, which would return a
 * username nobody owns. Both names are ASCII on chain, so a failure here means
 * the descriptor and the chain disagree.
 */
function decodeUsername(bytes: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
        throw new IndividualityDecodeError("consumer username is not valid UTF-8", { cause });
    }
}

/**
 * Absent, and absent because empty, both become `null`.
 *
 * Empty is what the host treats as absent, at its decoder and again at its
 * accessor. On-chain validation puts a minimum length on both names, so this is
 * insurance rather than a documented state, and it keeps an empty string out of
 * every display path.
 */
function optionalUsername(bytes: Uint8Array | undefined): string | null {
    if (bytes === undefined) return null;
    const username = decodeUsername(bytes);
    return username.length === 0 ? null : username;
}

/** Narrow the credibility variant. Same policy as the other raw decodes here. */
function decodeCredibility(raw: RawConsumerInfo["credibility"]): UsernameCredibility {
    switch (raw.type) {
        case "Lite":
            return { tag: "Lite" };
        case "Person":
            // The payload is optional on this structural type so the Lite
            // variant, which carries none, still satisfies it.
            if (raw.value === undefined) {
                throw new IndividualityDecodeError("person credibility has no payload");
            }
            return { tag: "Person", alias: raw.value.alias, demoted: raw.value.demoted };
        default:
            // A variant added by a runtime upgrade must fail loudly, never read
            // as Lite. Fixed message: never echo chain data.
            throw new IndividualityDecodeError("unknown consumer credibility variant");
    }
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const ALIAS = `0x${"ab".repeat(32)}`;
    const utf8 = (value: string) => new TextEncoder().encode(value);

    /** A lite-only record; override any field per test. */
    const raw = (overrides: Partial<RawConsumerInfo> = {}): RawConsumerInfo => ({
        lite_username: utf8("alice.07"),
        credibility: { type: "Lite" },
        ...overrides,
    });

    const person = (demoted = false) => ({
        type: "Person",
        value: { alias: ALIAS, demoted },
    });

    describe("decodeConsumerInfo", () => {
        test("an account with no record is null, not a failure", () => {
            expect(decodeConsumerInfo(undefined)).toBeNull();
        });

        test("a lite-only record has no full username", () => {
            expect(decodeConsumerInfo(raw())).toEqual({
                liteUsername: "alice.07",
                fullUsername: null,
                credibility: { tag: "Lite" },
            });
        });

        test("a claimed record carries both names", () => {
            const decoded = decodeConsumerInfo(
                raw({ full_username: utf8("alice"), credibility: person() }),
            );
            expect(decoded?.liteUsername).toBe("alice.07");
            expect(decoded?.fullUsername).toBe("alice");
        });

        test("the person alias and the demoted flag are passed through", () => {
            expect(decodeConsumerInfo(raw({ credibility: person() }))?.credibility).toEqual({
                tag: "Person",
                alias: ALIAS,
                demoted: false,
            });
        });

        test("a demoted person still reads as a person, and keeps their name", () => {
            // The only signal that separates the two. Dropping it would report a
            // person whose authorization expired as one in good standing.
            const decoded = decodeConsumerInfo(
                raw({ full_username: utf8("alice"), credibility: person(true) }),
            );
            expect(decoded?.credibility).toEqual({ tag: "Person", alias: ALIAS, demoted: true });
            expect(decoded?.fullUsername).toBe("alice");
        });

        test("an empty full username is absent, not an empty string", () => {
            // Matches the host, which filters empty at its decoder and again at
            // its accessor. Left empty, it would be shown as a display name.
            expect(decodeConsumerInfo(raw({ full_username: new Uint8Array() }))?.fullUsername).toBe(
                null,
            );
        });

        test("an empty lite username is a decode error", () => {
            // Each throw case asserts its own message. A single always-throwing
            // body satisfies toThrow(IndividualityDecodeError) for all of them,
            // so the class alone does not discriminate.
            expect(() => decodeConsumerInfo(raw({ lite_username: new Uint8Array() }))).toThrow(
                IndividualityDecodeError,
            );
            expect(() => decodeConsumerInfo(raw({ lite_username: new Uint8Array() }))).toThrow(
                "consumer record has no lite username",
            );
        });

        test("an unknown credibility variant throws instead of reading as Lite", () => {
            expect(() => decodeConsumerInfo(raw({ credibility: { type: "Provisional" } }))).toThrow(
                "unknown consumer credibility variant",
            );
        });

        test("a person credibility with no payload throws", () => {
            expect(() => decodeConsumerInfo(raw({ credibility: { type: "Person" } }))).toThrow(
                "person credibility has no payload",
            );
        });

        test("bytes that are not UTF-8 throw rather than decoding to U+FFFD", () => {
            const invalid = new Uint8Array([0xff, 0xfe, 0xfd]);
            expect(() => decodeConsumerInfo(raw({ lite_username: invalid }))).toThrow(
                "consumer username is not valid UTF-8",
            );
            expect(decodeConsumerInfo(raw())?.liteUsername).not.toContain("�");
        });
    });
}
