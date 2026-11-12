// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {
    createContractRuntime,
    type ReviveDryRunResult,
    type ReviveTypedApi,
} from "@parity/product-sdk-contracts";
import {
    ATTESTATION_SERVICE_ABI,
    SCHEMA_REGISTRY_ABI,
    createAttestationClient,
    readHonourTally,
    type SubjectId,
} from "@parity/product-sdk-reputation";
import type { Result } from "@parity/result";
import {
    bytesToHex,
    decodeAbiParameters,
    decodeFunctionData,
    encodeAbiParameters,
    encodeFunctionResult,
    encodePacked,
    hexToBytes,
    keccak256,
    parseAbiParameters,
    type Hex,
} from "viem";

const SERVICE = "0x1111111111111111111111111111111111111111";
const REGISTRY = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const ATTESTER = "0x4444444444444444444444444444444444444444";
const ORIGIN = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const SUBJECT: SubjectId = `0x${"55".repeat(32)}`;
const BLOCK_HASH = `0x${"66".repeat(32)}`;
const SCHEMA_ID = 7n;
const ratingSchema = parseAbiParameters("uint8 rating,string note");
const payload = encodeAbiParameters(ratingSchema, [4, "Delivered on time"]);
const id = BigInt(
    keccak256(encodePacked(["address", "address", "uint256"], [ATTESTER, RECIPIENT, SCHEMA_ID])),
);
const record = {
    id,
    schema: SCHEMA_ID,
    time: 1_700_000_000n,
    expirationTime: 0n,
    revocationTime: 0n,
    refId: 17n,
    recipient: RECIPIENT,
    attester: ATTESTER,
    revocable: true,
    data: payload,
} as const;
const missing = { ...record, id: 0n };

function unwrap<T, E extends Error>(result: Result<T, E>): T {
    if (!result.ok) throw result.error;
    return result.value;
}

function output(data: Hex): ReviveDryRunResult {
    return {
        weight_consumed: { ref_time: 1n, proof_size: 1n },
        weight_required: { ref_time: 1n, proof_size: 1n },
        storage_deposit: { type: "Charge", value: 0n },
        max_storage_deposit: { type: "Charge", value: 0n },
        gas_consumed: 0n,
        result: { success: true, value: { flags: 0, data: hexToBytes(data) } },
    };
}

const api: ReviveTypedApi = {
    apis: {
        ReviveApi: {
            async call(origin, dest, _value, _gas, _deposit, calldata) {
                const data = bytesToHex(calldata);
                if (dest === REGISTRY) {
                    const { functionName, args } = decodeFunctionData({
                        abi: SCHEMA_REGISTRY_ABI,
                        data,
                    });
                    assert.equal(functionName, "getSchema");
                    assert.equal(args[0], SCHEMA_ID);
                    return output(
                        encodeFunctionResult({
                            abi: SCHEMA_REGISTRY_ABI,
                            functionName: "getSchema",
                            result: {
                                id: SCHEMA_ID,
                                registerer: ATTESTER,
                                resolver: "0x0000000000000000000000000000000000000000",
                                revocable: true,
                                unique: true,
                                schema: "uint8 rating,string note",
                            },
                        }),
                    );
                }
                assert.equal(dest, SERVICE);
                const { functionName, args } = decodeFunctionData({
                    abi: ATTESTATION_SERVICE_ABI,
                    data,
                });
                switch (functionName) {
                    case "getAttestationById":
                        return output(
                            encodeFunctionResult({
                                abi: ATTESTATION_SERVICE_ABI,
                                functionName,
                                result: args[0] === id ? record : missing,
                            }),
                        );
                    case "getAttestationByIds":
                        return output(
                            encodeFunctionResult({
                                abi: ATTESTATION_SERVICE_ABI,
                                functionName,
                                result: args[0].map((key) => (key === id ? record : missing)),
                            }),
                        );
                    case "isActive":
                        return output(
                            encodeFunctionResult({
                                abi: ATTESTATION_SERVICE_ABI,
                                functionName,
                                result: args[0] === id,
                            }),
                        );
                    case "attest":
                        assert.equal(origin, ORIGIN);
                        assert.equal(args[0].schema, SCHEMA_ID);
                        assert.equal(args[0].data.data, payload);
                        return output(
                            encodeFunctionResult({
                                abi: ATTESTATION_SERVICE_ABI,
                                functionName,
                                result: id,
                            }),
                        );
                    case "revoke":
                        assert.equal(origin, ORIGIN);
                        assert.equal(args[0].schema, SCHEMA_ID);
                        assert.equal(args[0].data.id, id);
                        return output("0x");
                }
            },
        },
    },
    query: { Revive: { OriginalAccount: { getValue: async () => ORIGIN } } },
    tx: {
        Revive: {
            call(args) {
                return {
                    decodedCall: { type: "Revive", value: { type: "call", value: args } },
                    createSubmitAndWatch() {
                        throw new Error("This offline example cannot submit transactions.");
                    },
                };
            },
            map_account() {
                throw new Error("This offline example cannot map accounts.");
            },
        },
    },
};

async function main(): Promise<void> {
    const runtime = createContractRuntime(api);
    const attestations = unwrap(
        createAttestationClient(runtime, {
            serviceAddress: SERVICE,
            schemaRegistryAddress: REGISTRY,
            defaultOrigin: ORIGIN,
        }),
    );
    const schema = unwrap(await attestations.readSchema(SCHEMA_ID));
    assert.equal(schema?.schema, "uint8 rating,string note");
    const attestation = unwrap(await attestations.readAttestation(id));
    assert.ok(attestation);
    assert.equal(attestation.refId, 17n);
    const [rating, note] = decodeAbiParameters(ratingSchema, attestation.data);
    console.log(
        `Attestation ${attestation.id}: rating ${rating}, note "${note}", refId ${attestation.refId}`,
    );
    const page = unwrap(await attestations.readAttestations([id, 1n, id]));
    assert.deepEqual(page, [attestation, null, attestation]);
    assert.equal(unwrap(await attestations.isActive(id)), true);

    unwrap(
        await attestations.prepareAttestation(
            {
                schemaId: SCHEMA_ID,
                recipient: RECIPIENT,
                data: payload,
                revocable: true,
                refId: 17n,
            },
            { origin: ORIGIN },
        ),
    );
    unwrap(await attestations.prepareRevocation({ schemaId: SCHEMA_ID, id }, { origin: ORIGIN }));
    console.log("Prepared attestation and revocation calls. No transaction submitted.");

    const tally = unwrap(
        await readHonourTally(
            {
                individuality: {
                    query: {
                        Honour: {
                            Tally: {
                                async getValue(subjectId, options) {
                                    assert.equal(subjectId, SUBJECT);
                                    assert.equal(options.at, BLOCK_HASH);
                                    return 3;
                                },
                            },
                        },
                    },
                },
                raw: {
                    individuality: {
                        getFinalizedBlock: async () => ({ hash: BLOCK_HASH, number: 100 }),
                    },
                },
            },
            SUBJECT,
        ),
    );
    assert.equal(tally.score, 3);
    console.log(`Honour score ${tally.score} at block ${tally.at.blockNumber} (offline fixture).`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
