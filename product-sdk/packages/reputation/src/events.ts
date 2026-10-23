// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@parity/result";
import { bytesToHex, decodeEventLog, toEventSelector, type Hex } from "viem";
import { ATTESTATION_SERVICE_ABI } from "./abi.js";
import type { H160 } from "./attestations.js";
import { ReputationDecodeError, ReputationError, ReputationInputError } from "./errors.js";

export interface AttestedEvent {
    readonly recipient: H160;
    readonly attester: H160;
    readonly schemaId: bigint;
    readonly id: bigint;
}

const ATTESTED_TOPIC = toEventSelector("Attested(address,address,uint256,uint256)");

function record(value: unknown): Record<string, unknown> | undefined {
    if (value !== null && typeof value === "object") return value as Record<string, unknown>;
    return undefined;
}

function emitted(event: unknown): Record<string, unknown> | undefined {
    const outer = record(event);
    if (outer?.type === "Revive.ContractEmitted" || outer?.type === "ContractEmitted") {
        return record(outer.value);
    }
    if (outer?.type !== "Revive") return undefined;
    const inner = record(outer.value);
    return inner?.type === "ContractEmitted" ? record(inner.value) : record(inner?.ContractEmitted);
}

function hex(value: unknown): Hex {
    if (value instanceof Uint8Array) return bytesToHex(value);
    if (typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value)) return value as Hex;
    throw new ReputationDecodeError("The contract event contains invalid bytes.");
}

/** Decode IDs from this service's transaction events, including hashed IDs. */
export function readAttestedEvents(
    events: readonly unknown[],
    serviceAddress: H160,
): Result<AttestedEvent[], ReputationError> {
    try {
        if (
            !Array.isArray(events) ||
            typeof serviceAddress !== "string" ||
            !/^0x[0-9a-fA-F]{40}$/.test(serviceAddress)
        ) {
            throw new ReputationInputError(
                "Provide transaction events and a 20-byte service address.",
            );
        }
        const results: AttestedEvent[] = [];
        for (const event of events) {
            const value = emitted(event);
            if (!value) continue;
            if (hex(value.contract).toLowerCase() !== serviceAddress.toLowerCase()) continue;
            if (!Array.isArray(value.topics) || value.topics.length === 0) continue;
            const topics = value.topics.map(hex) as [Hex, ...Hex[]];
            if (topics[0].toLowerCase() !== ATTESTED_TOPIC) continue;
            const decoded = decodeEventLog({
                abi: ATTESTATION_SERVICE_ABI,
                eventName: "Attested",
                topics,
                data: hex(value.data),
                strict: true,
            });
            results.push({
                recipient: decoded.args.recipient.toLowerCase() as H160,
                attester: decoded.args.attester.toLowerCase() as H160,
                schemaId: decoded.args.schema,
                id: decoded.args.id,
            });
        }
        return ok(results);
    } catch (cause) {
        return err(
            cause instanceof ReputationError
                ? cause
                : new ReputationDecodeError("The attestation event could not be decoded.", {
                      cause,
                  }),
        );
    }
}
