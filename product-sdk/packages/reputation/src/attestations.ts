// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    createContract,
    type AbiEntry,
    type Contract,
    type ContractError,
    type ContractOptions,
    type ContractRuntime,
    type PrepareOptions,
    type QueryOptions,
    type QueryResult,
    type TxOptions,
} from "@parity/product-sdk-contracts";
import type { BatchableCall, TxError, TxResult } from "@parity/product-sdk-tx";
import { err, normalizeError, ok, type Result } from "@parity/result";
import type { Hex } from "viem";
import { ATTESTATION_SERVICE_ABI, SCHEMA_REGISTRY_ABI } from "./abi.js";
import {
    ReputationDecodeError,
    ReputationError,
    ReputationInputError,
    ReputationQueryError,
} from "./errors.js";

export type H160 = Hex;

export interface Attestation {
    readonly id: bigint;
    readonly schemaId: bigint;
    readonly time: bigint;
    readonly expirationTime: bigint;
    readonly revocationTime: bigint;
    readonly refId: bigint;
    readonly recipient: H160;
    readonly attester: H160;
    readonly revocable: boolean;
    readonly data: Hex;
}

export interface AttestationSchema {
    readonly id: bigint;
    readonly registerer: H160;
    readonly resolver: H160;
    readonly revocable: boolean;
    readonly unique: boolean;
    readonly schema: string;
}

export interface AttestationRequest {
    readonly schemaId: bigint;
    readonly recipient: H160;
    readonly data: Hex;
    readonly revocable: boolean;
    /** Seconds since the Unix epoch. Zero means no expiration. */
    readonly expirationTime?: bigint;
    readonly refId?: bigint;
}

export interface RevocationRequest {
    readonly schemaId: bigint;
    readonly id: bigint;
}

export interface AttestationClientOptions extends ContractOptions {
    serviceAddress: H160;
    schemaRegistryAddress: H160;
}

export type AttestationPrepareOptions = PrepareOptions & { origin: string };
export const MAX_ATTESTATION_READ_IDS = 100;

export interface AttestationClient {
    readonly serviceAddress: H160;
    readonly schemaRegistryAddress: H160;
    readSchema(
        id: bigint,
        options?: QueryOptions,
    ): Promise<Result<AttestationSchema | null, ReputationError>>;
    readAttestation(
        id: bigint,
        options?: QueryOptions,
    ): Promise<Result<Attestation | null, ReputationError>>;
    /** Results retain the input order, including duplicates and missing IDs. */
    readAttestations(
        ids: readonly bigint[],
        options?: QueryOptions,
    ): Promise<Result<(Attestation | null)[], ReputationError>>;
    isActive(id: bigint, options?: QueryOptions): Promise<Result<boolean, ReputationError>>;
    prepareAttestation(
        request: AttestationRequest,
        options: AttestationPrepareOptions,
    ): Promise<Result<BatchableCall, ReputationError | ContractError>>;
    attest(
        request: AttestationRequest,
        options?: TxOptions,
    ): Promise<Result<TxResult, ReputationError | ContractError | TxError>>;
    prepareRevocation(
        request: RevocationRequest,
        options: AttestationPrepareOptions,
    ): Promise<Result<BatchableCall, ReputationError | ContractError>>;
    revoke(
        request: RevocationRequest,
        options?: TxOptions,
    ): Promise<Result<TxResult, ReputationError | ContractError | TxError>>;
}

type Service = Contract<{
    methods: {
        getAttestationById: { args: [bigint]; response: unknown };
        getAttestationByIds: { args: [bigint[]]; response: unknown };
        isActive: { args: [bigint]; response: unknown };
        attest: { args: [ReturnType<typeof toAttestationRequest>]; response: bigint };
        revoke: { args: [ReturnType<typeof toRevocationRequest>]; response: undefined };
    };
}>;
type Registry = Contract<{ methods: { getSchema: { args: [bigint]; response: unknown } } }>;

function uint(value: unknown, bits: number, field: string, nonzero = false): bigint {
    if (typeof value !== "bigint" || value < (nonzero ? 1n : 0n) || value >= 1n << BigInt(bits)) {
        throw new ReputationInputError(
            `${field} must be a ${nonzero ? "nonzero " : ""}uint${bits}.`,
        );
    }
    return value;
}

function address(value: unknown, field: string): H160 {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new ReputationInputError(`${field} must be a 20-byte hex address.`);
    }
    return value.toLowerCase() as H160;
}

function bytes(value: unknown): Hex {
    if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
        throw new ReputationInputError("Attestation data must be a hex string with whole bytes.");
    }
    return value as Hex;
}

function boolean(value: unknown, field: string): boolean {
    if (typeof value !== "boolean") {
        throw new ReputationInputError(`${field} must be a boolean.`);
    }
    return value;
}

function toAttestationRequest(request: AttestationRequest) {
    return {
        schema: uint(request.schemaId, 256, "Schema ID", true),
        data: {
            recipient: address(request.recipient, "Recipient"),
            expirationTime: uint(
                request.expirationTime === undefined ? 0n : request.expirationTime,
                64,
                "Expiration time",
            ),
            revocable: boolean(request.revocable, "Revocable"),
            refId: uint(request.refId === undefined ? 0n : request.refId, 256, "Reference ID"),
            data: bytes(request.data),
        },
    };
}

function toRevocationRequest(request: RevocationRequest) {
    return {
        schema: uint(request.schemaId, 256, "Schema ID", true),
        data: { id: uint(request.id, 256, "Attestation ID", true) },
    };
}

function fields(value: unknown, names: readonly string[]): unknown[] {
    if (Array.isArray(value) && value.length === names.length) return value;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        return names.map((name) => record[name]);
    }
    throw new ReputationDecodeError("The contract returned an invalid record.");
}

function decodeAttestation(value: unknown, expectedId: bigint): Attestation | null {
    try {
        const [
            id,
            schemaId,
            time,
            expirationTime,
            revocationTime,
            refId,
            recipient,
            attester,
            revocable,
            data,
        ] = fields(value, [
            "id",
            "schema",
            "time",
            "expirationTime",
            "revocationTime",
            "refId",
            "recipient",
            "attester",
            "revocable",
            "data",
        ]);
        const recordId = uint(id, 256, "Attestation ID");
        if (recordId === 0n) return null;
        if (recordId !== expectedId) {
            throw new ReputationDecodeError("The contract returned a different attestation ID.");
        }
        return {
            id: recordId,
            schemaId: uint(schemaId, 256, "Schema ID", true),
            time: uint(time, 64, "Creation time"),
            expirationTime: uint(expirationTime, 64, "Expiration time"),
            revocationTime: uint(revocationTime, 64, "Revocation time"),
            refId: uint(refId, 256, "Reference ID"),
            recipient: address(recipient, "Recipient"),
            attester: address(attester, "Attester"),
            revocable: boolean(revocable, "Revocable"),
            data: bytes(data),
        };
    } catch (cause) {
        if (cause instanceof ReputationDecodeError) throw cause;
        throw new ReputationDecodeError("The contract returned an invalid attestation.", { cause });
    }
}

function decodeSchema(value: unknown, expectedId: bigint): AttestationSchema | null {
    try {
        const [id, registerer, resolver, revocable, unique, schema] = fields(value, [
            "id",
            "registerer",
            "resolver",
            "revocable",
            "unique",
            "schema",
        ]);
        const recordId = uint(id, 256, "Schema ID");
        if (recordId === 0n) return null;
        if (recordId !== expectedId || typeof schema !== "string") {
            throw new ReputationDecodeError("The contract returned an invalid schema.");
        }
        return {
            id: recordId,
            registerer: address(registerer, "Registerer"),
            resolver: address(resolver, "Resolver"),
            revocable: boolean(revocable, "Revocable"),
            unique: boolean(unique, "Unique"),
            schema,
        };
    } catch (cause) {
        if (cause instanceof ReputationDecodeError) throw cause;
        throw new ReputationDecodeError("The contract returned an invalid schema.", { cause });
    }
}

async function query<T>(operation: string, call: Promise<QueryResult<T>>): Promise<T> {
    const result = await call;
    if (!result.success) throw new ReputationQueryError(operation, result.value);
    return result.value;
}

async function read<T>(operation: () => Promise<T>): Promise<Result<T, ReputationError>> {
    try {
        return ok(await operation());
    } catch (cause) {
        return err(normalizeError(cause, ReputationError));
    }
}

function prepareOptions(options: AttestationPrepareOptions): AttestationPrepareOptions {
    if (!options?.origin) {
        throw new ReputationInputError(
            "Provide the signing account's SS58 origin to prepare a call.",
        );
    }
    return { ...options, gasLimit: options.gasLimit && { ...options.gasLimit } };
}

function transactionOptions(options?: TxOptions): TxOptions | undefined {
    return options && { ...options, gasLimit: options.gasLimit && { ...options.gasLimit } };
}

/** Addresses and the connected chain are supplied by the caller. */
export function createAttestationClient(
    runtime: ContractRuntime,
    options: AttestationClientOptions,
): Result<AttestationClient, ReputationError> {
    try {
        const serviceAddress = address(options.serviceAddress, "Attestation service");
        const schemaRegistryAddress = address(options.schemaRegistryAddress, "Schema registry");
        const service = createContract(
            runtime,
            serviceAddress,
            ATTESTATION_SERVICE_ABI as unknown as AbiEntry[],
            options,
        ) as Service;
        const registry = createContract(
            runtime,
            schemaRegistryAddress,
            SCHEMA_REGISTRY_ABI as unknown as AbiEntry[],
            options,
        ) as Registry;
        return ok({
            serviceAddress,
            schemaRegistryAddress,
            readSchema: (id, queryOptions) =>
                read(async () => {
                    uint(id, 256, "Schema ID");
                    return decodeSchema(
                        await query(
                            "Read schema",
                            registry.getSchema.query(id, {
                                ...queryOptions,
                                at: queryOptions?.at ?? "finalized",
                            }),
                        ),
                        id,
                    );
                }),
            readAttestation: (id, queryOptions) =>
                read(async () => {
                    uint(id, 256, "Attestation ID");
                    return decodeAttestation(
                        await query(
                            "Read attestation",
                            service.getAttestationById.query(id, {
                                ...queryOptions,
                                at: queryOptions?.at ?? "finalized",
                            }),
                        ),
                        id,
                    );
                }),
            readAttestations: (ids, queryOptions) =>
                read(async () => {
                    if (!Array.isArray(ids) || ids.length > MAX_ATTESTATION_READ_IDS) {
                        throw new ReputationInputError(
                            `Read at most ${MAX_ATTESTATION_READ_IDS} attestation IDs per call.`,
                        );
                    }
                    const keys = Array.from(ids, (id) => uint(id, 256, "Attestation ID"));
                    if (keys.length === 0) return [];
                    const values = await query(
                        "Read attestations",
                        service.getAttestationByIds.query(keys, {
                            ...queryOptions,
                            at: queryOptions?.at ?? "finalized",
                        }),
                    );
                    if (!Array.isArray(values) || values.length !== keys.length) {
                        throw new ReputationDecodeError(
                            "The contract returned a different number of attestations.",
                        );
                    }
                    return values.map((value, index) => decodeAttestation(value, keys[index]));
                }),
            isActive: (id, queryOptions) =>
                read(async () => {
                    uint(id, 256, "Attestation ID");
                    const value = await query(
                        "Read attestation activity",
                        service.isActive.query(id, {
                            ...queryOptions,
                            at: queryOptions?.at ?? "finalized",
                        }),
                    );
                    if (typeof value !== "boolean") {
                        throw new ReputationDecodeError(
                            "The contract returned invalid attestation activity.",
                        );
                    }
                    return value;
                }),
            async prepareAttestation(request, prepare) {
                try {
                    return await service.attest.prepare(
                        toAttestationRequest(request),
                        prepareOptions(prepare),
                    );
                } catch (cause) {
                    return err(normalizeError(cause, ReputationError));
                }
            },
            async attest(request, txOptions) {
                try {
                    return await service.attest.tx(
                        toAttestationRequest(request),
                        transactionOptions(txOptions) ?? {},
                    );
                } catch (cause) {
                    return err(normalizeError(cause, ReputationError));
                }
            },
            async prepareRevocation(request, prepare) {
                try {
                    return await service.revoke.prepare(
                        toRevocationRequest(request),
                        prepareOptions(prepare),
                    );
                } catch (cause) {
                    return err(normalizeError(cause, ReputationError));
                }
            },
            async revoke(request, txOptions) {
                try {
                    return await service.revoke.tx(
                        toRevocationRequest(request),
                        transactionOptions(txOptions) ?? {},
                    );
                } catch (cause) {
                    return err(normalizeError(cause, ReputationError));
                }
            },
        });
    } catch (cause) {
        return err(normalizeError(cause, ReputationError));
    }
}
