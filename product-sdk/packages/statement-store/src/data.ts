// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { StatementDataTooLargeError, StatementEncodingError } from "./errors.js";
import { MAX_STATEMENT_SIZE } from "./types.js";

/** Convert a hex string (with or without 0x prefix) to bytes. */
export function fromHex(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/** Convert bytes to a hex string with 0x prefix. */
export function toHex(bytes: Uint8Array): string {
    let hex = "0x";
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
}

/**
 * Encode a value as a JSON-serialized data payload for a statement.
 *
 * Serializes the value as JSON and encodes to UTF-8 bytes.
 * Throws {@link StatementDataTooLargeError} if the result exceeds
 * {@link MAX_STATEMENT_SIZE} bytes.
 *
 * @typeParam T - The type of value being encoded.
 * @param value - The value to serialize.
 * @returns UTF-8 encoded JSON bytes.
 * @throws {StatementDataTooLargeError} If the encoded data exceeds 512 bytes.
 */
export function encodeData<T>(value: T): Uint8Array {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json);
    if (bytes.length > MAX_STATEMENT_SIZE) {
        throw new StatementDataTooLargeError(bytes.length);
    }
    return bytes;
}

/**
 * Decode a JSON-serialized data payload from statement bytes.
 *
 * @typeParam T - The expected parsed type.
 * @param bytes - UTF-8 encoded JSON bytes.
 * @returns The parsed value.
 * @throws {StatementEncodingError} If the bytes are not valid UTF-8 or valid JSON.
 */
export function decodeData<T>(bytes: Uint8Array): T {
    try {
        const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return JSON.parse(json) as T;
    } catch (error) {
        throw new StatementEncodingError("Failed to decode JSON data", { cause: error });
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("encodeData / decodeData", () => {
        test("round-trips JSON object", () => {
            const original = { type: "presence", peerId: "abc123", timestamp: 1234 };
            const encoded = encodeData(original);
            const decoded = decodeData<typeof original>(encoded);
            expect(decoded).toEqual(original);
        });

        test("round-trips string", () => {
            const encoded = encodeData("hello");
            expect(decodeData<string>(encoded)).toBe("hello");
        });

        test("round-trips number", () => {
            const encoded = encodeData(42);
            expect(decodeData<number>(encoded)).toBe(42);
        });

        test("throws StatementDataTooLargeError for oversized data", () => {
            const large = { data: "x".repeat(600) };
            expect(() => encodeData(large)).toThrow(StatementDataTooLargeError);
        });

        test("allows data at exactly MAX_STATEMENT_SIZE", () => {
            const str = "a".repeat(510);
            const encoded = encodeData(str);
            expect(encoded.length).toBe(512);
        });

        test("throws StatementEncodingError for invalid JSON bytes", () => {
            const invalid = new TextEncoder().encode("{not valid json");
            expect(() => decodeData(invalid)).toThrow(StatementEncodingError);
        });

        test("throws StatementEncodingError for non-UTF-8 bytes", () => {
            const invalid = new Uint8Array([0xff, 0xfe, 0xfd]);
            expect(() => decodeData(invalid)).toThrow(StatementEncodingError);
        });
    });

    describe("toHex / fromHex", () => {
        test("round-trips bytes", () => {
            const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
            const hex = toHex(bytes);
            expect(hex).toBe("0xdeadbeef");
            expect(fromHex(hex)).toEqual(bytes);
        });

        test("handles hex without 0x prefix", () => {
            const bytes = fromHex("cafebabe");
            expect(bytes).toEqual(new Uint8Array([0xca, 0xfe, 0xba, 0xbe]));
        });

        test("handles empty input", () => {
            expect(toHex(new Uint8Array(0))).toBe("0x");
            expect(fromHex("0x")).toEqual(new Uint8Array(0));
        });
    });
}
