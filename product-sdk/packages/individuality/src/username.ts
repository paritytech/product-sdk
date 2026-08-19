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
import { err, normalizeError, ok, type Result } from "@parity/result";
import { IndividualityDecodeError, ProductIndividualityError } from "./errors.js";

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

/**
 * The name to show for a consumer: the claimed one when there is one, else the
 * lite one.
 *
 * The host computes this same rule over the same record at session-pairing time
 * and exposes the answer as `account.getUserId().primaryUsername`. For the
 * signed-in user the two should agree; if they do not, the session snapshot is
 * older than the chain.
 */
export function displayUsername(record: ConsumerUsernames): string {
    return record.fullUsername ?? record.liteUsername;
}

/**
 * Whether this account can still claim a bare name.
 *
 * This is the chain's own precondition, not an approximation of it: the claim
 * extrinsic rejects a record that already carries a full username.
 */
export function canClaimFullUsername(record: ConsumerUsernames): boolean {
    return record.fullUsername === null;
}

/**
 * The letters part of a lite username, which is what a claim would offer.
 *
 * A lite username is letters, one dot, then digits, so the dot is always there
 * and there is only one. A full username has no dot and is returned unchanged.
 *
 * A suggestion, not an entitlement. An account may hold a reservation for a
 * different name, and the reservation is what the chain honours.
 */
export function usernameBase(username: string): string {
    const dot = username.indexOf(".");
    return dot === -1 ? username : username.slice(0, dot);
}

/** Options every read is given, so a caller can pin and cancel it. */
interface ReadAt {
    at?: string;
    signal?: AbortSignal;
}

/**
 * The chain surface this read needs, structural rather than a pinned descriptor.
 *
 * Anything exposing this one entry satisfies it: a real `ChainClient` from
 * `getChainAPI`, a future People Lite deployment, or a hand-rolled test double.
 * Deliberately narrower than `IndividualityChain` in `read.ts`, so a double for
 * either read does not have to implement the other's entries.
 *
 * Written with method shorthand on purpose: the parameter bivariance that gives
 * is what lets the real PAPI signature satisfy the loosened key type below.
 *
 * Fidelity is checked at compile time from the umbrella package, in
 * `packages/sdk/src/individuality/contract.test.ts`, for the reason recorded
 * there: inside this package the same assertion is vacuous.
 */
export interface ConsumersChain {
    individuality: {
        query: {
            Resources: {
                Consumers: {
                    getValue(key: string, options?: ReadAt): Promise<RawConsumerInfo | undefined>;
                };
            };
        };
    };
}

/** Options for {@link lookupUsername}. */
export interface LookupUsernameOptions {
    /** The account to read, SS58 encoded. This is the storage key. */
    account: string;
    /**
     * Read at this block rather than the current best one. One read cannot mix
     * eras, so this exists only so a caller can join this read to a batch that
     * has already pinned a block, such as `readPersonhoodState`.
     */
    at?: string;
    signal?: AbortSignal;
}

/**
 * Read the usernames registered for an account, from `Resources.Consumers`.
 *
 * Returns a `Result`, per the SDK-wide error model: `ok` carries the answer,
 * `err` carries a {@link ProductIndividualityError}. An account with no consumer
 * record is **not** a failure. It resolves to `ok(null)`, because the chain was
 * asked and answered.
 *
 * The account is the input the SDK already hands callers: `rootAddress` from a
 * paired session keys this map.
 *
 * **Not an authorization oracle.** This is a client-side read in a client-side
 * library, and a backend that trusts "the SDK said this name is theirs" is
 * trivially spoofed.
 */
export async function lookupUsername(
    chain: ConsumersChain,
    options: LookupUsernameOptions,
): Promise<Result<ConsumerUsernames | null, ProductIndividualityError>> {
    const { account, at, signal } = options;
    try {
        // A caller who already cancelled should cost no round trip at all.
        signal?.throwIfAborted();
        const value = await chain.individuality.query.Resources.Consumers.getValue(account, {
            at,
            signal,
        });
        return ok(decodeConsumerInfo(value));
    } catch (cause) {
        // Every failure lands here: the decode errors thrown above, the early
        // abort, and any transport rejection. normalizeError passes an existing
        // package error through unchanged, so callers can still narrow it.
        return err(normalizeError(cause, ProductIndividualityError));
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

    describe("displayUsername", () => {
        const record = (fullUsername: string | null): ConsumerUsernames => ({
            liteUsername: "alice.07",
            fullUsername,
            credibility: { tag: "Lite" },
        });

        test("a claimed name wins over the lite one", () => {
            expect(displayUsername(record("alice"))).toBe("alice");
        });

        test("the lite name is used when nothing is claimed", () => {
            expect(displayUsername(record(null))).toBe("alice.07");
        });
    });

    describe("canClaimFullUsername", () => {
        const record = (fullUsername: string | null): ConsumerUsernames => ({
            liteUsername: "alice.07",
            fullUsername,
            credibility: { tag: "Lite" },
        });

        test("an unclaimed record can still claim", () => {
            expect(canClaimFullUsername(record(null))).toBe(true);
        });

        test("a claimed record cannot claim again", () => {
            expect(canClaimFullUsername(record("alice"))).toBe(false);
        });
    });

    describe("usernameBase", () => {
        test("a lite username strips to its letters", () => {
            expect(usernameBase("alice.07")).toBe("alice");
            expect(usernameBase("bigtava.07")).toBe("bigtava");
        });

        test("a full username has no dot and is returned unchanged", () => {
            expect(usernameBase("alice")).toBe("alice");
        });

        test("the first dot is the cut, not the last", () => {
            // Pins an otherwise arbitrary-looking choice. The chain allows
            // exactly one dot in a lite username, so first and last coincide on
            // every value this can be handed; the input below is unreachable.
            expect(usernameBase("bob.alice.07")).toBe("bob");
        });

        test("a leading dot strips to the empty label", () => {
            expect(usernameBase(".07")).toBe("");
        });
    });

    describe("lookupUsername", () => {
        const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

        /**
         * A chain double that records the key and the options the read was given.
         *
         * The key is recorded deliberately: without it, a read addressed with the
         * wrong key still satisfies every other assertion here.
         */
        function fakeChain(answer: RawConsumerInfo | undefined | (() => never)): {
            chain: ConsumersChain;
            calls: Array<{ key: string; options?: ReadAt }>;
        } {
            const calls: Array<{ key: string; options?: ReadAt }> = [];
            return {
                calls,
                chain: {
                    individuality: {
                        query: {
                            Resources: {
                                Consumers: {
                                    async getValue(key, options) {
                                        calls.push({ key, options });
                                        return typeof answer === "function" ? answer() : answer;
                                    },
                                },
                            },
                        },
                    },
                },
            };
        }

        test("an account with a record answers on the ok channel", async () => {
            const { chain } = fakeChain(raw({ full_username: utf8("alice") }));
            expect(await lookupUsername(chain, { account: ALICE })).toEqual({
                ok: true,
                value: {
                    liteUsername: "alice.07",
                    fullUsername: "alice",
                    credibility: { tag: "Lite" },
                },
            });
        });

        test("an account with no record is ok(null), not an error", async () => {
            const { chain } = fakeChain(undefined);
            expect(await lookupUsername(chain, { account: ALICE })).toEqual({
                ok: true,
                value: null,
            });
        });

        test("the key is the account itself, not a UTF-8 encoded username", async () => {
            const { chain, calls } = fakeChain(raw());
            await lookupUsername(chain, { account: ALICE });
            expect(calls[0]?.key).toBe(ALICE);
        });

        test("a pinned block is forwarded to the read", async () => {
            const at = `0x${"11".repeat(32)}`;
            const { chain, calls } = fakeChain(raw());
            await lookupUsername(chain, { account: ALICE, at });
            expect(calls[0]?.options?.at).toBe(at);
        });

        test("an already-aborted signal costs no round trip", async () => {
            const { chain, calls } = fakeChain(raw());
            const controller = new AbortController();
            controller.abort();
            const result = await lookupUsername(chain, {
                account: ALICE,
                signal: controller.signal,
            });
            expect(result.ok).toBe(false);
            expect(calls).toHaveLength(0);
        });

        test("a decode failure arrives on the err channel, typed", async () => {
            const { chain } = fakeChain(raw({ credibility: { type: "Provisional" } }));
            const result = await lookupUsername(chain, { account: ALICE });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.name).toBe("IndividualityDecodeError");
            // Asserted structurally rather than through isSdkError from
            // @parity/product-sdk-errors: importing it here would make this
            // package's fast test loop depend on that sibling being built.
            expect(result.error.isSdkError).toBe(true);
            expect(result.error.source).toBe("individuality");
        });

        test("an unreachable node arrives on the err channel, cause intact", async () => {
            const cause = new Error("websocket closed");
            const { chain } = fakeChain(() => {
                throw cause;
            });
            const result = await lookupUsername(chain, { account: ALICE });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.name).toBe("ProductIndividualityError");
            expect(result.error.cause).toBe(cause);
        });
    });
}
