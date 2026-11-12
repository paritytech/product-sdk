// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    ContractDryRunFailedError,
    ContractInvalidOriginError,
    ContractRevertedError,
    ContractSignerMissingError,
    createContractRuntime,
    type ReviveDryRunCall,
    type ReviveDryRunResult,
    type ReviveTypedApi,
    type TxOptions,
} from "@parity/product-sdk-contracts";
import { createDevSigner, type SubmittableTransaction } from "@parity/product-sdk-tx";
import { unwrapErr, unwrapOk } from "@parity/result";
import {
    bytesToHex,
    decodeFunctionData,
    encodeErrorResult,
    encodeFunctionResult,
    hexToBytes,
    type Abi,
    type Hex,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { ATTESTATION_SERVICE_ABI, SCHEMA_REGISTRY_ABI } from "./abi.js";
import {
    createAttestationClient,
    MAX_ATTESTATION_READ_IDS,
    type AttestationPrepareOptions,
    type AttestationRequest,
    type RevocationRequest,
} from "./attestations.js";
import {
    ReputationDecodeError,
    ReputationError,
    ReputationInputError,
    ReputationQueryError,
} from "./errors.js";

const SERVICE: Hex = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REGISTRY: Hex = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RECIPIENT: Hex = "0x1234567890123456789012345678901234567890";
const ATTESTER: Hex = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";
const ORIGIN = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BLOCK: Hex = `0x${"12".repeat(32)}`;
const WEIGHT = { ref_time: 300n, proof_size: 17n };
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

const RECORD = {
    id: 42n,
    schema: 7n,
    time: 100n,
    expirationTime: 200n,
    revocationTime: 0n,
    refId: 99n,
    recipient: RECIPIENT,
    attester: ATTESTER,
    revocable: true,
    data: "0xff00017f" as Hex,
};
const EMPTY_RECORD = {
    id: 0n,
    schema: 0n,
    time: 0n,
    expirationTime: 0n,
    revocationTime: 0n,
    refId: 0n,
    recipient: ZERO_ADDRESS,
    attester: ZERO_ADDRESS,
    revocable: false,
    data: "0x" as Hex,
};
const SCHEMA = {
    id: 7n,
    registerer: ATTESTER,
    resolver: ZERO_ADDRESS,
    revocable: true,
    unique: true,
    schema: " bytes arbitraryClaim ",
};
const REQUEST: AttestationRequest = {
    schemaId: 7n,
    recipient: RECIPIENT,
    data: "0xff00017f",
    revocable: true,
    expirationTime: 200n,
    refId: 99n,
};

function successful(data: Hex): ReviveDryRunResult {
    return {
        weight_consumed: WEIGHT,
        weight_required: WEIGHT,
        storage_deposit: { type: "Charge", value: 33n },
        max_storage_deposit: { type: "Charge", value: 33n },
        gas_consumed: 5n,
        result: { success: true, value: { flags: 0, data: hexToBytes(data) } },
    };
}

type Responder = (name: string, args: readonly unknown[], destination: string) => unknown;

function harness(respond: Responder = () => RECORD) {
    const createSubmitAndWatch = vi.fn<SubmittableTransaction["createSubmitAndWatch"]>(() => ({
        subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    }));
    const transaction = { createSubmitAndWatch, decodedCall: { type: "Revive.call" } };
    const call = vi.fn(
        (_args: Parameters<ReviveTypedApi["tx"]["Revive"]["call"]>[0]) => transaction,
    );
    const dryRun = vi.fn<ReviveDryRunCall>(
        async (_origin, destination, _value, _gas, _deposit, data) => {
            const abi: Abi =
                destination === REGISTRY ? SCHEMA_REGISTRY_ABI : ATTESTATION_SERVICE_ABI;
            const decoded = decodeFunctionData({ abi, data: bytesToHex(data) });
            return successful(
                encodeFunctionResult({
                    abi,
                    functionName: decoded.functionName,
                    result: respond(decoded.functionName, decoded.args ?? [], destination),
                }),
            );
        },
    );
    const runtime = createContractRuntime({
        tx: { Revive: { call, map_account: () => transaction } },
        query: { Revive: { OriginalAccount: { getValue: async () => undefined } } },
        apis: { ReviveApi: { call: dryRun } },
    });
    const client = unwrapOk(
        createAttestationClient(runtime, {
            serviceAddress: SERVICE,
            schemaRegistryAddress: REGISTRY,
            defaultOrigin: ORIGIN,
        }),
    );
    return { client, runtime, dryRun, call, transaction, createSubmitAndWatch };
}

describe("attestation reads", () => {
    it("decodes the deployed ABI and retains reference IDs and opaque bytes", async () => {
        const { client, dryRun } = harness();
        const record = unwrapOk(await client.readAttestation(RECORD.id));
        const { schema, ...expected } = RECORD;
        expect(record).toEqual({ ...expected, schemaId: schema });
        expect(record).not.toHaveProperty("schema");
        const dryRunCall = dryRun.mock.calls[0];
        expect(dryRunCall[0]).toBe(ORIGIN);
        expect(dryRunCall[1]).toBe(SERVICE);
        expect(dryRunCall[6]).toEqual({ at: "finalized" });
        expect(
            decodeFunctionData({
                abi: ATTESTATION_SERVICE_ABI,
                data: bytesToHex(dryRunCall[5]),
            }),
        ).toEqual({ functionName: "getAttestationById", args: [42n] });
    });

    it("returns null for an unknown ID and zero", async () => {
        const { client } = harness(() => EMPTY_RECORD);
        expect(unwrapOk(await client.readAttestation(123n))).toBeNull();
        expect(unwrapOk(await client.readAttestation(0n))).toBeNull();
    });

    it("keeps batch order, duplicates, missing records, and hashed IDs", async () => {
        const hashedId = 1n << 255n;
        const ids = [hashedId, 9n, hashedId, MAX_UINT256];
        const { client, dryRun } = harness((name, args) => {
            expect(name).toBe("getAttestationByIds");
            expect(args).toEqual([ids]);
            return ids.map((id) => (id === 9n ? EMPTY_RECORD : { ...RECORD, id }));
        });
        const results = unwrapOk(await client.readAttestations(ids, { at: BLOCK }));
        expect(results.map((result) => result?.id ?? null)).toEqual([
            hashedId,
            null,
            hashedId,
            MAX_UINT256,
        ]);
        expect(results[0]?.refId).toBe(99n);
        expect(dryRun.mock.calls[0][6]).toEqual({ at: BLOCK });
        expect(dryRun).toHaveBeenCalledOnce();
    });

    it("does no query for an empty batch", async () => {
        const { client, dryRun } = harness();
        expect(unwrapOk(await client.readAttestations([]))).toEqual([]);
        expect(dryRun).not.toHaveBeenCalled();
    });

    it("rejects sparse batch entries before querying", async () => {
        const { client, dryRun } = harness();
        expect(unwrapErr(await client.readAttestations(new Array<bigint>(1)))).toBeInstanceOf(
            ReputationInputError,
        );
        expect(dryRun).not.toHaveBeenCalled();
    });

    it("keeps the finalized default when at is explicitly undefined", async () => {
        const { client, dryRun } = harness((name) => {
            if (name === "getSchema") return SCHEMA;
            if (name === "getAttestationByIds") return [RECORD];
            if (name === "isActive") return true;
            return RECORD;
        });
        unwrapOk(await client.readSchema(7n, { at: undefined }));
        unwrapOk(await client.readAttestation(42n, { at: undefined }));
        unwrapOk(await client.readAttestations([42n], { at: undefined }));
        unwrapOk(await client.isActive(42n, { at: undefined }));
        expect(dryRun.mock.calls.map((call) => call[6])).toEqual(
            Array(4).fill({ at: "finalized" }),
        );
    });

    it("accepts the maximum batch size", async () => {
        const ids = Array.from({ length: MAX_ATTESTATION_READ_IDS }, (_, index) => BigInt(index));
        const { client, dryRun } = harness(() =>
            ids.map((id) => (id === 0n ? EMPTY_RECORD : { ...RECORD, id })),
        );
        const records = unwrapOk(await client.readAttestations(ids));
        expect(records).toHaveLength(MAX_ATTESTATION_READ_IDS);
        expect(dryRun).toHaveBeenCalledOnce();
    });

    it("rejects a batch above the limit before querying", async () => {
        const { client, dryRun } = harness();
        expect(
            unwrapErr(await client.readAttestations(Array(MAX_ATTESTATION_READ_IDS + 1).fill(1n))),
        ).toBeInstanceOf(ReputationInputError);
        expect(dryRun).not.toHaveBeenCalled();
    });

    it.each([-1n, 1n << 256n, 42, "42", null])(
        "rejects an invalid read ID before querying: %s",
        async (id) => {
            const { client, dryRun } = harness();
            for (const method of [client.readAttestation, client.readSchema, client.isActive]) {
                expect(unwrapErr(await method(id as bigint))).toBeInstanceOf(ReputationInputError);
            }
            expect(unwrapErr(await client.readAttestations([id as bigint]))).toBeInstanceOf(
                ReputationInputError,
            );
            expect(dryRun).not.toHaveBeenCalled();
        },
    );

    it("rejects an unexpected record ID", async () => {
        const { client } = harness(() => ({ ...RECORD, id: 43n }));
        expect(unwrapErr(await client.readAttestation(42n))).toBeInstanceOf(ReputationDecodeError);
    });

    it("rejects an unexpected batch length", async () => {
        const { client } = harness(() => [RECORD]);
        expect(unwrapErr(await client.readAttestations([42n, 43n]))).toBeInstanceOf(
            ReputationDecodeError,
        );
    });

    it("rejects a batch record in the wrong slot", async () => {
        const { client } = harness(() => [{ ...RECORD, id: 43n }, RECORD]);
        expect(unwrapErr(await client.readAttestations([42n, 43n]))).toBeInstanceOf(
            ReputationDecodeError,
        );
    });

    it("decodes schemas without changing their definitions", async () => {
        const { client, dryRun } = harness((_name, _args, destination) => {
            expect(destination).toBe(REGISTRY);
            return SCHEMA;
        });
        expect(unwrapOk(await client.readSchema(7n))).toEqual(SCHEMA);
        expect(dryRun.mock.calls[0][1]).toBe(REGISTRY);
    });

    it("returns null for a missing schema", async () => {
        const { client } = harness(() => ({
            ...SCHEMA,
            id: 0n,
            schema: "",
            registerer: ZERO_ADDRESS,
        }));
        expect(unwrapOk(await client.readSchema(9n))).toBeNull();
    });

    it("rejects a schema returned for a different ID", async () => {
        const { client } = harness(() => SCHEMA);
        expect(unwrapErr(await client.readSchema(8n))).toBeInstanceOf(ReputationDecodeError);
    });

    it.each([true, false])("uses the contract activity result: %s", async (active) => {
        const { client, dryRun } = harness((name) => {
            if (name === "getAttestationById") return RECORD;
            expect(name).toBe("isActive");
            return active;
        });
        unwrapOk(await client.readAttestation(42n, { at: BLOCK }));
        expect(unwrapOk(await client.isActive(42n, { at: BLOCK }))).toBe(active);
        expect(dryRun.mock.calls.map((call) => call[6])).toEqual([{ at: BLOCK }, { at: BLOCK }]);
    });

    it("preserves a runtime dispatch failure", async () => {
        const detail = { type: "AccountNotMapped" };
        const { client, dryRun } = harness();
        dryRun.mockResolvedValueOnce({
            ...successful("0x"),
            result: { success: false, value: detail },
        });
        const error = unwrapErr(await client.readAttestation(42n));
        expect(error).toBeInstanceOf(ReputationQueryError);
        expect(error.cause).toBe(detail);
        expect((error as ReputationQueryError).detail).toBe(detail);
    });

    it("preserves a contract revert instead of decoding it as a record", async () => {
        const { client, dryRun } = harness();
        const data = encodeErrorResult({
            abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
            errorName: "Error",
            args: ["Resolver rejected"],
        });
        dryRun.mockResolvedValueOnce({
            ...successful(data),
            result: { success: true, value: { flags: 1, data: hexToBytes(data) } },
        });
        const error = unwrapErr(await client.readAttestation(42n));
        expect(error).toBeInstanceOf(ReputationQueryError);
        expect((error as ReputationQueryError).detail).toMatchObject({
            type: "ContractRevertedWithPayload",
            data,
            reason: "Resolver rejected",
        });
    });

    it("returns transport failures with their cause", async () => {
        const cause = new Error("Node disconnected");
        const { client, dryRun } = harness();
        dryRun.mockRejectedValueOnce(cause);
        const error = unwrapErr(await client.readSchema(7n));
        expect(error).toBeInstanceOf(ReputationError);
        expect(error.cause).toBe(cause);
    });

    it("returns malformed ABI output as an error", async () => {
        const { client, dryRun } = harness();
        dryRun.mockResolvedValueOnce(successful("0x12"));
        const error = unwrapErr(await client.readAttestation(42n));
        expect(error).toBeInstanceOf(ReputationError);
        expect(error.cause).toBeInstanceOf(Error);
    });
});

describe("attestation writes", () => {
    it("prepares the ABI request with the actual origin and estimated limits", async () => {
        const { client, dryRun, call, transaction, createSubmitAndWatch } = harness(() => 123n);
        const prepared = unwrapOk(
            await client.prepareAttestation(REQUEST, { origin: ORIGIN, at: BLOCK }),
        );
        expect(prepared).toBe(transaction);
        expect(dryRun.mock.calls[0][0]).toBe(ORIGIN);
        expect(dryRun.mock.calls[0][6]).toEqual({ at: BLOCK });
        const args = call.mock.calls[0][0];
        expect(args).toMatchObject({
            dest: SERVICE,
            value: 0n,
            weight_limit: WEIGHT,
            storage_deposit_limit: 33n,
        });
        expect(
            decodeFunctionData({ abi: ATTESTATION_SERVICE_ABI, data: bytesToHex(args.data) }),
        ).toEqual({
            functionName: "attest",
            args: [
                {
                    schema: REQUEST.schemaId,
                    data: {
                        recipient: REQUEST.recipient,
                        expirationTime: REQUEST.expirationTime,
                        revocable: REQUEST.revocable,
                        refId: REQUEST.refId,
                        data: REQUEST.data,
                    },
                },
            ],
        });
        expect(createSubmitAndWatch).not.toHaveBeenCalled();
    });

    it("defaults expiration and reference to zero without restricting opaque data", async () => {
        const { client, call } = harness(() => 1n);
        unwrapOk(
            await client.prepareAttestation(
                {
                    schemaId: MAX_UINT256,
                    recipient: ZERO_ADDRESS,
                    data: "0x",
                    revocable: false,
                },
                { origin: ORIGIN },
            ),
        );
        expect(
            decodeFunctionData({
                abi: ATTESTATION_SERVICE_ABI,
                data: bytesToHex(call.mock.calls[0][0].data),
            }).args,
        ).toEqual([
            {
                schema: MAX_UINT256,
                data: {
                    recipient: ZERO_ADDRESS,
                    expirationTime: 0n,
                    revocable: false,
                    refId: 0n,
                    data: "0x",
                },
            },
        ]);
    });

    it("accepts maximum uint64 expiration and uint256 reference", async () => {
        const { client, call } = harness(() => 1n);
        unwrapOk(
            await client.prepareAttestation(
                {
                    ...REQUEST,
                    expirationTime: MAX_UINT64,
                    refId: MAX_UINT256,
                },
                { origin: ORIGIN },
            ),
        );
        expect(
            decodeFunctionData({
                abi: ATTESTATION_SERVICE_ABI,
                data: bytesToHex(call.mock.calls[0][0].data),
            }).args?.[0],
        ).toMatchObject({
            data: { expirationTime: MAX_UINT64, refId: MAX_UINT256 },
        });
    });

    it("prepares revocation with a hashed ID without submitting", async () => {
        const { client, dryRun, call, createSubmitAndWatch } = harness(() => undefined);
        unwrapOk(
            await client.prepareRevocation({ schemaId: 7n, id: MAX_UINT256 }, { origin: ORIGIN }),
        );
        expect(dryRun.mock.calls[0][0]).toBe(ORIGIN);
        expect(
            decodeFunctionData({
                abi: ATTESTATION_SERVICE_ABI,
                data: bytesToHex(call.mock.calls[0][0].data),
            }),
        ).toEqual({
            functionName: "revoke",
            args: [{ schema: 7n, data: { id: MAX_UINT256 } }],
        });
        expect(createSubmitAndWatch).not.toHaveBeenCalled();
    });

    it("forwards both supplied limits and skips the sizing dry-run", async () => {
        const { client, dryRun, call } = harness();
        const gasLimit = { ref_time: 1234n, proof_size: 56n };
        unwrapOk(
            await client.prepareRevocation(
                { schemaId: 7n, id: 42n },
                {
                    origin: ORIGIN,
                    gasLimit,
                    storageDepositLimit: 12n,
                    at: "best",
                },
            ),
        );
        expect(dryRun).not.toHaveBeenCalled();
        expect(call.mock.calls[0][0]).toMatchObject({
            weight_limit: gasLimit,
            storage_deposit_limit: 12n,
        });
    });

    it("keeps a supplied gas limit while estimating the storage deposit", async () => {
        const { client, dryRun, call } = harness(() => 1n);
        const gasLimit = { ref_time: 1234n, proof_size: 56n };
        unwrapOk(await client.prepareAttestation(REQUEST, { origin: ORIGIN, gasLimit }));
        expect(dryRun).toHaveBeenCalledOnce();
        expect(call.mock.calls[0][0]).toMatchObject({
            weight_limit: gasLimit,
            storage_deposit_limit: 33n,
        });
    });

    it("snapshots prepare options while a dry-run is pending", async () => {
        const { client, dryRun, call } = harness();
        let resume!: (value: ReviveDryRunResult) => void;
        dryRun.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resume = resolve;
                }),
        );
        const gasLimit = { ref_time: 1234n, proof_size: 56n };
        const options: AttestationPrepareOptions = { origin: ORIGIN, gasLimit, at: BLOCK };
        const pending = client.prepareAttestation(REQUEST, options);
        options.origin = "not-an-account";
        options.at = "best";
        gasLimit.ref_time = 0n;
        resume(successful("0x"));
        unwrapOk(await pending);
        expect(call.mock.calls[0][0].weight_limit).toEqual({ ref_time: 1234n, proof_size: 56n });
        expect(dryRun.mock.calls[0][0]).toBe(ORIGIN);
        expect(dryRun.mock.calls[0][6]).toEqual({ at: BLOCK });
    });

    it.each([
        ["zero schema", { schemaId: 0n }],
        ["negative schema", { schemaId: -1n }],
        ["oversized schema", { schemaId: 1n << 256n }],
        ["number schema", { schemaId: 7 }],
        ["negative reference", { refId: -1n }],
        ["oversized reference", { refId: 1n << 256n }],
        ["number reference", { refId: 99 }],
        ["null reference", { refId: null }],
        ["negative expiration", { expirationTime: -1n }],
        ["oversized expiration", { expirationTime: 1n << 64n }],
        ["number expiration", { expirationTime: 200 }],
        ["null expiration", { expirationTime: null }],
        ["short address", { recipient: "0x1234" }],
        ["non-hex address", { recipient: `0x${"gg".repeat(20)}` }],
        ["account ID address", { recipient: `0x${"12".repeat(32)}` }],
        ["odd hex data", { data: "0x123" }],
        ["non-hex data", { data: "0xzz" }],
        ["number data", { data: 12 }],
        ["non-boolean revocable", { revocable: 1 }],
    ])("rejects invalid attestation input: %s", async (_name, patch) => {
        const { client, dryRun, call } = harness();
        const request = { ...REQUEST, ...patch } as unknown as AttestationRequest;
        expect(
            unwrapErr(await client.prepareAttestation(request, { origin: ORIGIN })),
        ).toBeInstanceOf(ReputationInputError);
        expect(unwrapErr(await client.attest(request))).toBeInstanceOf(ReputationInputError);
        expect(dryRun).not.toHaveBeenCalled();
        expect(call).not.toHaveBeenCalled();
    });

    it.each([
        { schemaId: 0n, id: 42n },
        { schemaId: -1n, id: 42n },
        { schemaId: 7n, id: 0n },
        { schemaId: 7n, id: -1n },
        { schemaId: 7n, id: 1n << 256n },
        { schemaId: 7n, id: 42 },
    ])("rejects invalid revocation input: %s", async (request) => {
        const { client, dryRun, call } = harness();
        const invalid = request as RevocationRequest;
        expect(
            unwrapErr(await client.prepareRevocation(invalid, { origin: ORIGIN })),
        ).toBeInstanceOf(ReputationInputError);
        expect(unwrapErr(await client.revoke(invalid))).toBeInstanceOf(ReputationInputError);
        expect(dryRun).not.toHaveBeenCalled();
        expect(call).not.toHaveBeenCalled();
    });

    it.each([undefined, {}, { origin: "" }])(
        "requires an explicit prepare origin: %j",
        async (options) => {
            const { client, dryRun, call } = harness();
            expect(
                unwrapErr(
                    await client.prepareAttestation(REQUEST, options as AttestationPrepareOptions),
                ),
            ).toBeInstanceOf(ReputationInputError);
            expect(
                unwrapErr(
                    await client.prepareRevocation(
                        { schemaId: 7n, id: 42n },
                        options as AttestationPrepareOptions,
                    ),
                ),
            ).toBeInstanceOf(ReputationInputError);
            expect(dryRun).not.toHaveBeenCalled();
            expect(call).not.toHaveBeenCalled();
        },
    );

    it.each([RECIPIENT, "not-an-account"])(
        "rejects a prepare origin that is not SS58: %s",
        async (origin) => {
            const { client, dryRun, call } = harness();
            expect(unwrapErr(await client.prepareAttestation(REQUEST, { origin }))).toBeInstanceOf(
                ContractInvalidOriginError,
            );
            expect(dryRun).not.toHaveBeenCalled();
            expect(call).not.toHaveBeenCalled();
        },
    );

    it("returns a dry-run dispatch failure before building a call", async () => {
        const { client, dryRun, call } = harness();
        const detail = { type: "AccountNotMapped" };
        dryRun.mockResolvedValueOnce({
            ...successful("0x"),
            result: { success: false, value: detail },
        });
        expect(
            unwrapErr(await client.prepareAttestation(REQUEST, { origin: ORIGIN })),
        ).toBeInstanceOf(ContractDryRunFailedError);
        expect(call).not.toHaveBeenCalled();
    });

    it("returns a contract revert before building a revocation call", async () => {
        const { client, dryRun, call } = harness();
        dryRun.mockResolvedValueOnce({
            ...successful("0x"),
            result: { success: true, value: { flags: 1, data: new Uint8Array() } },
        });
        expect(
            unwrapErr(
                await client.prepareRevocation({ schemaId: 7n, id: 42n }, { origin: ORIGIN }),
            ),
        ).toBeInstanceOf(ContractRevertedError);
        expect(call).not.toHaveBeenCalled();
    });

    it("returns a preparation transport failure with its cause", async () => {
        const cause = new Error("Node disconnected");
        const { client, dryRun, call } = harness();
        dryRun.mockRejectedValueOnce(cause);
        const error = unwrapErr(await client.prepareAttestation(REQUEST, { origin: ORIGIN }));
        expect(error).toBeInstanceOf(ReputationError);
        expect(error.cause).toBe(cause);
        expect(call).not.toHaveBeenCalled();
    });

    it("requires a signer for direct writes", async () => {
        const { client, dryRun, call, createSubmitAndWatch } = harness();
        expect(unwrapErr(await client.attest(REQUEST))).toBeInstanceOf(ContractSignerMissingError);
        expect(unwrapErr(await client.revoke({ schemaId: 7n, id: 42n }))).toBeInstanceOf(
            ContractSignerMissingError,
        );
        expect(dryRun).not.toHaveBeenCalled();
        expect(call).not.toHaveBeenCalled();
        expect(createSubmitAndWatch).not.toHaveBeenCalled();
    });

    it.each(["attest", "revoke"] as const)(
        "submits %s with the configured signer when transaction options are omitted",
        async (method) => {
            const { runtime, dryRun, call, createSubmitAndWatch } = harness((name) =>
                name === "attest" ? 123n : undefined,
            );
            const signer: NonNullable<TxOptions["signer"]> = createDevSigner("Alice");
            const client = unwrapOk(
                createAttestationClient(runtime, {
                    serviceAddress: SERVICE,
                    schemaRegistryAddress: REGISTRY,
                    defaultOrigin: ORIGIN,
                    defaultSigner: signer,
                }),
            );
            const block = { hash: BLOCK, number: 123, index: 2 };
            createSubmitAndWatch.mockImplementationOnce(() => ({
                subscribe(handlers) {
                    queueMicrotask(() => {
                        handlers.next({
                            type: "finalized",
                            txHash: "0x1234",
                            ok: true,
                            block,
                            events: [],
                        });
                    });
                    return { unsubscribe: vi.fn() };
                },
            }));
            const result =
                method === "attest"
                    ? await client.attest(REQUEST)
                    : await client.revoke({ schemaId: 7n, id: 42n });
            expect(unwrapOk(result)).toEqual({ txHash: "0x1234", ok: true, block, events: [] });
            expect(dryRun).toHaveBeenCalledOnce();
            expect(dryRun.mock.calls[0][0]).toBe(ORIGIN);
            expect(call).toHaveBeenCalledOnce();
            expect(createSubmitAndWatch.mock.calls[0][0]).toBe(signer);
        },
    );

    it.each(["attest", "revoke"] as const)(
        "submits %s through the supplied signer and returns the finalized receipt",
        async (method) => {
            const { client, dryRun, call, createSubmitAndWatch } = harness();
            const unsubscribe = vi.fn();
            const block = { hash: BLOCK, number: 123, index: 2 };
            const events = [{ type: "Revive.ContractEmitted", value: { contract: SERVICE } }];
            createSubmitAndWatch.mockImplementationOnce(() => ({
                subscribe(handlers) {
                    queueMicrotask(() => {
                        handlers.next({ type: "created", txHash: "0x1234" });
                        handlers.next({
                            type: "finalized",
                            txHash: "0x1234",
                            ok: true,
                            block,
                            events,
                        });
                    });
                    return { unsubscribe };
                },
            }));
            let resume!: (value: ReviveDryRunResult) => void;
            dryRun.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resume = resolve;
                    }),
            );
            const signer: NonNullable<TxOptions["signer"]> = createDevSigner("Alice");
            const gasLimit = { ref_time: 1234n, proof_size: 56n };
            const onStatus = vi.fn();
            const options: TxOptions = {
                origin: ORIGIN,
                signer,
                gasLimit,
                at: BLOCK,
                waitFor: "finalized",
                mortalityPeriod: 77,
                onStatus,
            };
            const pending =
                method === "attest"
                    ? client.attest(REQUEST, options)
                    : client.revoke({ schemaId: 7n, id: 42n }, options);
            gasLimit.ref_time = 0n;
            options.onStatus = vi.fn();
            options.mortalityPeriod = 1;
            resume(successful("0x"));
            expect(unwrapOk(await pending)).toEqual({ txHash: "0x1234", ok: true, block, events });
            expect(call.mock.calls[0][0].weight_limit).toEqual({
                ref_time: 1234n,
                proof_size: 56n,
            });
            expect(createSubmitAndWatch).toHaveBeenCalledExactlyOnceWith(signer, {
                mortality: { mortal: true, period: 77 },
            });
            expect(onStatus.mock.calls.map(([status]) => status)).toEqual(["signing", "finalized"]);
            expect(unsubscribe).toHaveBeenCalledOnce();
        },
    );
});

describe("client configuration", () => {
    it.each(["0x", `0x${"zz".repeat(20)}`, RECIPIENT.slice(2)])(
        "rejects an invalid configured contract address: %s",
        (address) => {
            const { runtime } = harness();
            expect(
                unwrapErr(
                    createAttestationClient(runtime, {
                        serviceAddress: address as Hex,
                        schemaRegistryAddress: REGISTRY,
                    }),
                ),
            ).toBeInstanceOf(ReputationInputError);
            expect(
                unwrapErr(
                    createAttestationClient(runtime, {
                        serviceAddress: SERVICE,
                        schemaRegistryAddress: address as Hex,
                    }),
                ),
            ).toBeInstanceOf(ReputationInputError);
        },
    );

    it("normalizes configured address casing", () => {
        const { runtime } = harness();
        const client = unwrapOk(
            createAttestationClient(runtime, {
                serviceAddress: `0x${"aA".repeat(20)}`,
                schemaRegistryAddress: `0x${"bB".repeat(20)}`,
            }),
        );
        expect(client.serviceAddress).toBe(SERVICE);
        expect(client.schemaRegistryAddress).toBe(REGISTRY);
    });
});
