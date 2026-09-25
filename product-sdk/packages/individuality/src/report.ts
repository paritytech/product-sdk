// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The two game calls a signed-up player makes besides signing up: reporting on the
 * co-players of a finished game, and leaving the game for good.
 *
 * Both return the PAPI transaction unsigned, as `claimPrizeTx` does, so submission
 * stays with `@parity/product-sdk-tx`. Both accept the score participant origin, which
 * is how a player acts without paying a fee or holding any balance:
 *
 * ```ts
 * import { submitAndWatch } from "@parity/product-sdk-tx";
 * import { reportTx, withScoreParticipant } from "@parity/product-sdk-individuality";
 *
 * const tx = reportTx(chain, { fullReport: [["Person", "NotPerson"], ["Person"]] });
 * await submitAndWatch(tx, withScoreParticipant(signer));
 * ```
 *
 * A returning player signs up again under the same origin, see `signUpWithAccountTx`.
 */
import { ProductIndividualityError } from "./errors.js";

/** The judgement of one co-player, who either attended as a person or did not. */
export type ReportVote = "Person" | "NotPerson";

/** A vote as the pallet `Report` enum takes it. */
export type RawReportVote =
    | { type: "Person"; value: undefined }
    | { type: "NotPerson"; value: undefined };

/**
 * Structural, so a test double satisfies it. Matched by hand against the paseo
 * descriptors on 2026-09-25:
 *
 * ```
 * Game.report:   TxDescriptor<{ full_report: Array<Array<Enum<{ Person, NotPerson }>>> }>
 * Game.offboard: TxDescriptor<undefined>
 * ```
 */
export interface ReportChain<Tx = unknown> {
    individuality: {
        tx: {
            Game: {
                report(args: { full_report: RawReportVote[][] }): Tx;
                offboard(): Tx;
            };
        };
    };
}

/** Options for {@link reportTx}. */
export interface ReportOptions {
    /**
     * One entry per round of the game, exactly `rounds` of them. Each holds a vote per
     * co-player in the group of the reporter that round, in group order, which is
     * ascending player index, with the reporter left out. A round that does not match
     * the real group fails with `Game.InvalidReport`.
     */
    fullReport: readonly (readonly ReportVote[])[];
}

/**
 * Build `Game.report`, unsigned.
 *
 * Only valid while the game is in `Reporting`. Each `Person` vote awards the attestee
 * a claim credit on the spot, and the call fails with `Game.CreditCapacityExhausted`
 * before recording anything when there is no room for them. `Pays::No` on success.
 *
 * @throws ProductIndividualityError on a vote that is neither `Person` nor `NotPerson`.
 */
export function reportTx<Tx>(chain: ReportChain<Tx>, options: ReportOptions): Tx {
    return chain.individuality.tx.Game.report({
        full_report: options.fullReport.map((round) => round.map(toRawVote)),
    });
}

/**
 * Build `Game.offboard`, unsigned.
 *
 * Only valid between games, or during registration for a player who has not signed
 * up for that game. Offboarding a `Recognized` player suspends their personhood for
 * good: playing as a person again takes a new personal id with a new key.
 */
export function offboardTx<Tx>(chain: ReportChain<Tx>): Tx {
    return chain.individuality.tx.Game.offboard();
}

function toRawVote(vote: ReportVote): RawReportVote {
    if (vote !== "Person" && vote !== "NotPerson") {
        throw new ProductIndividualityError("a report vote must be Person or NotPerson");
    }
    return { type: vote, value: undefined };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");
    const { decAnyMetadata, unifyMetadata } = await import("@polkadot-api/substrate-bindings");
    const { getDynamicBuilder, getLookupFn } = await import("@polkadot-api/metadata-builders");

    const hex = (bytes: Uint8Array) =>
        `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

    const PASEO = new Uint8Array(
        readFileSync(
            new URL("../../descriptors/.papi/metadata/paseo_individuality.scale", import.meta.url),
        ),
    );
    const builder = getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(PASEO))));
    const encodeCall = (name: string, args: unknown) => {
        const { codec, location } = builder.buildCall("Game", name);
        return hex(Uint8Array.from([...location, ...codec.enc(args)]));
    };

    /** Encodes each call against the paseo metadata, the way PAPI would. */
    const paseo: ReportChain<string> = {
        individuality: {
            tx: {
                Game: {
                    report: (args) => encodeCall("report", args),
                    offboard: () => encodeCall("offboard", {}),
                },
            },
        },
    };

    function recordingChain() {
        const reports: Array<{ full_report: RawReportVote[][] }> = [];
        const chain: ReportChain<"tx"> = {
            individuality: {
                tx: {
                    Game: {
                        report: (args) => {
                            reports.push(args);
                            return "tx";
                        },
                        offboard: () => "tx",
                    },
                },
            },
        };
        return { chain, reports };
    }

    describe("reportTx", () => {
        test("encodes a two-round report to the pinned call bytes", () => {
            // Game is pallet 55 and report its call 3. Two rounds, the first with
            // two votes, `Person` as variant 0 and `NotPerson` as variant 1.
            expect(reportTx(paseo, { fullReport: [["Person", "NotPerson"], ["NotPerson"]] })).toBe(
                "0x3703080800010401",
            );
        });

        test("keeps the order of rounds and of votes within a round", () => {
            const { chain, reports } = recordingChain();
            reportTx(chain, { fullReport: [["NotPerson", "Person"], ["Person"]] });
            expect(reports).toEqual([
                {
                    full_report: [
                        [
                            { type: "NotPerson", value: undefined },
                            { type: "Person", value: undefined },
                        ],
                        [{ type: "Person", value: undefined }],
                    ],
                },
            ]);
        });

        test("rejects a vote the pallet has no variant for", () => {
            const { chain } = recordingChain();
            expect(() => reportTx(chain, { fullReport: [["person" as ReportVote]] })).toThrow(
                ProductIndividualityError,
            );
        });
    });

    describe("offboardTx", () => {
        test("encodes to the bare call, which takes no arguments", () => {
            expect(offboardTx(paseo)).toBe("0x3704");
        });
    });
}
