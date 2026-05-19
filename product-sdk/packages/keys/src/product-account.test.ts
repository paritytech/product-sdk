import { describe, expect, it } from "vitest";
import { createChainCode } from "./product-account.js";

describe("createChainCode", () => {
    it("encodes the numeric junction '0' as 32 zero bytes (u64 LE, zero-padded)", () => {
        const result = createChainCode("0");
        expect(result).toBeInstanceOf(Uint8Array);
        expect(result.length).toBe(32);
        expect(Array.from(result)).toEqual(new Array(32).fill(0));
    });

    it("encodes the numeric junction '1' as [1, 0×31] (u64 LE, zero-padded)", () => {
        const result = createChainCode("1");
        const expected = new Uint8Array(32);
        expected[0] = 1;
        expect(Array.from(result)).toEqual(Array.from(expected));
    });

    it("encodes a string junction 'product' as SCALE str + zero-padded to 32 bytes", () => {
        const result = createChainCode("product");
        expect(result.length).toBe(32);
        expect(result[0]).toBe(0x1c); // compact-length: 7 << 2
        expect(new TextDecoder().decode(result.slice(1, 8))).toBe("product");
        expect(Array.from(result.slice(8))).toEqual(new Array(24).fill(0));
    });

    it("encodes a string junction near the 32-byte boundary without falling back to blake2b", () => {
        const code = "a".repeat(30);
        const result = createChainCode(code);
        expect(result.length).toBe(32);
        expect(result[0]).toBe(30 << 2);
        expect(new TextDecoder().decode(result.slice(1, 31))).toBe(code);
        expect(result[31]).toBe(0);
    });

    it("hashes a string junction whose SCALE encoding exceeds 32 bytes via blake2b", () => {
        const longCode = "a".repeat(100);
        const result = createChainCode(longCode);
        expect(result.length).toBe(32);
        const repeat = createChainCode(longCode);
        expect(Array.from(result)).toEqual(Array.from(repeat));
    });
});
