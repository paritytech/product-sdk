// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The hash of one NFT claim credit, derived offline the way the game pallet derives it.
 *
 * `readCreditCandidates` names the credits a player could earn with it. The claims
 * the chain has awarded are read by `@parity/product-sdk-nfts`, which carries the
 * proof a mint needs.
 */
import { AccountId, Hex, Variant, u8, u32 } from "@polkadot-api/substrate-bindings";
import { blake2b256, bytesToHex, concatBytes, utf8ToBytes } from "@parity/product-sdk-utils";
import { U8_MAX, U32_MAX, checkIndex } from "./airdrop-ids.js";
import { ProductIndividualityError } from "./errors.js";
import type { PlayerKey } from "./player-key.js";

/** A Rust byte-string literal, so the raw bytes with no length prefix. */
const CREDIT_PREFIX = utf8ToBytes("polkadot-pop-game");
const PLAYER_KEY = Variant({ Account: AccountId(), Person: Hex(32) });
/** `Hex(32)` encodes a short value short instead of rejecting it, so an alias is checked first. */
const ALIAS_HEX = /^0x[0-9a-fA-F]{64}$/;

function encodePlayerKey(player: PlayerKey, role: "attester" | "attestee"): Uint8Array {
    if (player.type === "Person" && !ALIAS_HEX.test(player.value)) {
        throw new ProductIndividualityError(`credit ${role} alias must be 32 bytes of hex`);
    }
    try {
        return PLAYER_KEY.enc(player);
    } catch (cause) {
        throw new ProductIndividualityError(`credit ${role} is not a valid address`, { cause });
    }
}

/**
 * The credit one attestation awards, as lowercase hex:
 * `blake2b-256("polkadot-pop-game" ++ game_index ++ round ++ attester ++ attestee)`.
 *
 * `game_index` is a little-endian `u32`, `round` a `u8`, and each player a SCALE
 * `AccountOrPerson`. An account hashes as its raw bytes, so its SS58 prefix does not
 * matter.
 *
 * @throws ProductIndividualityError when a number is out of range or a player does
 *   not encode.
 */
export function creditHash(options: {
    gameIndex: number;
    round: number;
    attester: PlayerKey;
    attestee: PlayerKey;
}): string {
    const preimage = concatBytes(
        CREDIT_PREFIX,
        u32.enc(checkIndex(options.gameIndex, U32_MAX, "credit game index")),
        u8.enc(checkIndex(options.round, U8_MAX, "credit round")),
        encodePlayerKey(options.attester, "attester"),
        encodePlayerKey(options.attestee, "attestee"),
    );
    return `0x${bytesToHex(blake2b256(preimage))}`;
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { Enum } = await import("polkadot-api");

    const hex = (bytes: number[]) =>
        `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const account = (byte: number) => AccountId().dec(new Uint8Array(32).fill(byte));
    const hex32 = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;

    describe("creditHash", () => {
        // Both vectors come from `nft_claim_credit_spec` in individuality
        // `pallets/game/src/tests.rs`, so a changed preimage fails here rather
        // than as an empty pack.
        test("matches the pallet vector for an account attester and a person attestee", () => {
            expect(
                creditHash({
                    gameIndex: 32,
                    round: 5,
                    attester: Enum("Account", account(1)),
                    attestee: Enum("Person", hex32(2)),
                }),
            ).toBe(
                hex([
                    135, 205, 206, 159, 168, 238, 124, 124, 43, 173, 199, 120, 3, 56, 148, 117, 67,
                    126, 78, 190, 126, 15, 187, 177, 224, 186, 115, 113, 73, 121, 224, 196,
                ]),
            );
        });

        test("matches the pallet vector for a person attester and an account attestee", () => {
            expect(
                creditHash({
                    gameIndex: 35,
                    round: 9,
                    attester: Enum("Person", hex32(3)),
                    attestee: Enum("Account", account(4)),
                }),
            ).toBe(
                hex([
                    86, 240, 179, 9, 73, 32, 219, 236, 202, 127, 104, 185, 169, 196, 74, 74, 168,
                    221, 30, 78, 35, 75, 128, 151, 175, 250, 203, 174, 199, 71, 243, 194,
                ]),
            );
        });

        test("is sensitive to every field, to the direction, and to the variant", () => {
            const base = {
                gameIndex: 7,
                round: 1,
                attester: Enum("Account", account(9)),
                attestee: Enum("Account", account(8)),
            } as const;
            const hash = creditHash(base);
            expect(creditHash({ ...base, gameIndex: 8 })).not.toBe(hash);
            expect(creditHash({ ...base, round: 2 })).not.toBe(hash);
            expect(
                creditHash({ ...base, attester: base.attestee, attestee: base.attester }),
            ).not.toBe(hash);
            expect(creditHash({ ...base, attester: Enum("Person", hex32(9)) })).not.toBe(hash);
        });

        test("hashes an account by its bytes, whatever its SS58 prefix", () => {
            const generic = account(9);
            const polkadot = AccountId(0).dec(AccountId().enc(generic));
            const base = { gameIndex: 7, round: 1, attestee: Enum("Account", account(8)) };
            expect(creditHash({ ...base, attester: Enum("Account", polkadot) })).toBe(
                creditHash({ ...base, attester: Enum("Account", generic) }),
            );
        });

        test("accepts an upper-case alias", () => {
            const base = { gameIndex: 7, round: 1, attestee: Enum("Account", account(8)) };
            expect(creditHash({ ...base, attester: Enum("Person", `0x${"AB".repeat(32)}`) })).toBe(
                creditHash({ ...base, attester: Enum("Person", `0x${"ab".repeat(32)}`) }),
            );
        });

        test.each([
            ["a negative game index", { gameIndex: -1 }],
            ["a game index past u32", { gameIndex: 2 ** 32 }],
            ["a fractional game index", { gameIndex: 1.5 }],
            ["a round past u8", { round: 256 }],
            ["a negative round", { round: -1 }],
        ])("rejects %s", (_, override) => {
            expect(() =>
                creditHash({
                    gameIndex: 7,
                    round: 1,
                    attester: Enum("Account", account(9)),
                    attestee: Enum("Account", account(8)),
                    ...override,
                }),
            ).toThrow(ProductIndividualityError);
        });

        test("rejects an alias that is not 32 bytes, and an address that does not decode", () => {
            const base = { gameIndex: 7, round: 1, attestee: Enum("Account", account(8)) };
            expect(() => creditHash({ ...base, attester: Enum("Person", "0xabcd") })).toThrow(
                /attester alias/,
            );
            expect(() => creditHash({ ...base, attester: Enum("Account", "nope") })).toThrow(
                /attester is not a valid address/,
            );
        });
    });
}
