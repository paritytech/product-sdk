// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { unwrapErr, unwrapOk } from "@parity/result";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hexToBytes } from "viem";
import { ATTESTATION_SERVICE_ABI } from "./abi.js";
import { readAttestedEvents } from "./events.js";
import { ReputationDecodeError, ReputationInputError } from "./errors.js";

const SERVICE = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const AUTHOR = "0x4444444444444444444444444444444444444444";

function log(id = 8n, schema = 5n) {
    return {
        contract: SERVICE,
        topics: encodeEventTopics({
            abi: ATTESTATION_SERVICE_ABI,
            eventName: "Attested",
            args: { recipient: RECIPIENT, attester: AUTHOR, schema },
        }),
        data: encodeAbiParameters([{ type: "uint256" }], [id]),
    };
}

describe("readAttestedEvents", () => {
    it("filters other contracts and unrelated events while preserving batch order", () => {
        const hashedId = (1n << 255n) + 73n;
        const events = [
            { type: "System", value: { type: "ExtrinsicSuccess" } },
            {
                type: "Revive",
                value: { type: "ContractEmitted", value: { ...log(), contract: OTHER } },
            },
            { type: "Revive", value: { type: "ContractEmitted", value: log(hashedId) } },
            { type: "Revive.ContractEmitted", value: log(9n, 6n) },
            { type: "ContractEmitted", value: { contract: SERVICE, topics: ["0x00"], data: "0x" } },
        ];
        expect(unwrapOk(readAttestedEvents(events, SERVICE))).toEqual([
            { recipient: RECIPIENT, attester: AUTHOR, schemaId: 5n, id: hashedId },
            { recipient: RECIPIENT, attester: AUTHOR, schemaId: 6n, id: 9n },
        ]);
    });

    it("accepts PAPI bytes as well as hex strings", () => {
        const value = log();
        expect(
            unwrapOk(
                readAttestedEvents(
                    [
                        {
                            type: "ContractEmitted",
                            value: {
                                contract: hexToBytes(SERVICE),
                                data: hexToBytes(value.data),
                                topics: value.topics.map((topic) =>
                                    hexToBytes(topic as `0x${string}`),
                                ),
                            },
                        },
                    ],
                    SERVICE,
                ),
            ),
        ).toEqual([{ recipient: RECIPIENT, attester: AUTHOR, schemaId: 5n, id: 8n }]);
    });

    it("accepts the alternate nested Revive event used by the MVP", () => {
        expect(
            unwrapOk(
                readAttestedEvents(
                    [{ type: "Revive", value: { ContractEmitted: log() } }],
                    SERVICE,
                ),
            ),
        ).toEqual([{ recipient: RECIPIENT, attester: AUTHOR, schemaId: 5n, id: 8n }]);
    });

    it("does not infer an ID when the receipt contains no matching event", () => {
        expect(unwrapOk(readAttestedEvents([], SERVICE))).toEqual([]);
    });

    it("reports a malformed matching log without losing the cause", () => {
        const error = unwrapErr(
            readAttestedEvents(
                [
                    {
                        type: "ContractEmitted",
                        value: {
                            ...log(),
                            data: "0x",
                        },
                    },
                ],
                SERVICE,
            ),
        );
        expect(error).toBeInstanceOf(ReputationDecodeError);
        expect(error.cause).toBeInstanceOf(Error);
    });

    it("rejects a malformed service address", () => {
        expect(unwrapErr(readAttestedEvents([], "0x12"))).toBeInstanceOf(ReputationInputError);
    });
});
