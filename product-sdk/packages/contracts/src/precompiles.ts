// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { HexString, SS58String } from "polkadot-api";
import { bytesToHex, hexToBytes } from "viem";
import { ContractError } from "./errors.js";
import { createContract } from "./manager.js";
import type { AbiEntry } from "./types.js";
import type { ContractDryRunAt, ContractRuntime } from "./runtime.js";

/** pallet-revive system precompile address. */
export const SYSTEM_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000000900" as HexString;

const SYSTEM_PRECOMPILE_ABI = [
    {
        type: "function",
        name: "sr25519Verify",
        inputs: [
            { name: "signature", type: "uint8[64]" },
            { name: "message", type: "bytes" },
            { name: "publicKey", type: "bytes32" },
        ],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "view",
    },
] satisfies AbiEntry[];

export interface VerifySr25519SignatureArgs {
    /** 64-byte sr25519 signature. */
    signature: Uint8Array | readonly number[];
    /** Message bytes that were signed. Strings are UTF-8 encoded. */
    message: Uint8Array | string;
    /** 32-byte sr25519 public key. */
    publicKey: Uint8Array | HexString;
    /** Optional dry-run origin. Defaults to the contracts query fallback origin. */
    origin?: SS58String;
    /** Optional block target for the dry-run. */
    at?: ContractDryRunAt;
}

/**
 * Verify an sr25519 signature through pallet-revive's system precompile.
 *
 * This calls `sr25519Verify(uint8[64],bytes,bytes32)` on
 * `0x0000000000000000000000000000000000000900` using a read-only
 * `ReviveApi.call` dry-run. A cryptographically invalid signature returns
 * `false`; runtime/precompile call failures are surfaced as errors.
 */
export async function verifySr25519Signature(
    runtime: ContractRuntime,
    args: VerifySr25519SignatureArgs,
): Promise<boolean> {
    const signature = normalizeSignature(args.signature);
    const message =
        typeof args.message === "string" ? new TextEncoder().encode(args.message) : args.message;
    const publicKey = normalizeBytes32(args.publicKey, "publicKey");

    const system = createContract(runtime, SYSTEM_PRECOMPILE_ADDRESS, SYSTEM_PRECOMPILE_ABI);
    const result = await system.sr25519Verify.query(signature, bytesToHex(message), publicKey, {
        origin: args.origin,
        at: args.at,
    });

    if (!result.success) {
        throw new ContractError(
            `sr25519Verify precompile call failed: ${stringifyUnknown(result.value)}`,
        );
    }

    return Boolean(result.value);
}

function normalizeSignature(signature: Uint8Array | readonly number[]): number[] {
    if (signature.length !== 64) {
        throw new Error(`Expected 64-byte sr25519 signature, got ${signature.length} bytes`);
    }
    return Array.from(signature, (byte) => {
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
            throw new Error(`Expected sr25519 signature bytes in range 0..255, got ${byte}`);
        }
        return byte;
    });
}

function normalizeBytes32(value: Uint8Array | HexString, name: string): HexString {
    if (value instanceof Uint8Array) {
        if (value.length !== 32) {
            throw new Error(`Expected 32-byte ${name}, got ${value.length} bytes`);
        }
        return bytesToHex(value);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`Expected 32-byte ${name} as 0x-prefixed hex`);
    }
    return value.toLowerCase() as HexString;
}

function stringifyUnknown(value: unknown): string {
    if (typeof value === "string") return value;
    return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;

    const dryRunBase = {
        weight_consumed: { ref_time: 1n, proof_size: 1n },
        weight_required: { ref_time: 1n, proof_size: 1n },
        storage_deposit: { type: "Refund" as const, value: 0n },
        max_storage_deposit: { type: "Refund" as const, value: 0n },
        gas_consumed: 1n,
    };

    async function makeRuntime(value: boolean): Promise<ContractRuntime> {
        const { encodeFunctionResult } = await import("viem");
        const data = hexToBytes(
            encodeFunctionResult({
                abi: SYSTEM_PRECOMPILE_ABI,
                functionName: "sr25519Verify",
                result: value,
            }),
        );

        return {
            api: {} as ContractRuntime["api"],
            dryRunCall: vi.fn(async () => ({
                ...dryRunBase,
                result: { success: true as const, value: { flags: 0, data } },
            })),
        };
    }

    describe("verifySr25519Signature", () => {
        test("calls the system precompile and returns the decoded boolean", async () => {
            const runtime = await makeRuntime(true);
            const ok = await verifySr25519Signature(runtime, {
                signature: new Uint8Array(64).fill(1),
                message: "hello",
                publicKey: new Uint8Array(32).fill(2),
                at: "finalized",
            });

            expect(ok).toBe(true);
            expect(runtime.dryRunCall).toHaveBeenCalledTimes(1);
            expect(runtime.dryRunCall).toHaveBeenCalledWith(
                expect.any(String),
                SYSTEM_PRECOMPILE_ADDRESS,
                0n,
                undefined,
                undefined,
                expect.any(Uint8Array),
                { at: "finalized" },
            );
        });

        test("rejects invalid fixed byte lengths before calling the chain", async () => {
            const runtime = await makeRuntime(false);
            await expect(
                verifySr25519Signature(runtime, {
                    signature: new Uint8Array(63),
                    message: new Uint8Array(),
                    publicKey: new Uint8Array(32),
                }),
            ).rejects.toThrow(/64-byte sr25519 signature/);

            expect(runtime.dryRunCall).not.toHaveBeenCalled();
        });
    });
}
