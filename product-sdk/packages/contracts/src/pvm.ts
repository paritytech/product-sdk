import type { AbiEntry } from "./types.js";

/** ABI + PolkaVM bytecode pair emitted by `cargo pvm-contract build`. */
export interface PvmContractArtifacts {
    abi: AbiEntry[];
    bytecode: Uint8Array;
}

/**
 * Parse an in-memory cargo-pvm-contract ABI artifact.
 *
 * Accepts the shapes the toolchain may produce or that products may pass:
 * - parsed JSON array — `AbiEntry[]`
 * - parsed JSON object with an `abi` property — `{ abi: AbiEntry[] }`
 * - JSON string of either of the above
 * - `Uint8Array` containing UTF-8 JSON of either of the above
 *
 * @throws if the input cannot be coerced to a non-empty `AbiEntry[]`.
 */
export function parsePvmContractAbi(source: unknown): AbiEntry[] {
    let value: unknown = source;

    if (value instanceof Uint8Array) {
        value = new TextDecoder().decode(value);
    }
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch (cause) {
            throw new Error("Invalid PVM ABI: not valid JSON", { cause });
        }
    }
    if (value && typeof value === "object" && !Array.isArray(value) && "abi" in value) {
        value = (value as { abi: unknown }).abi;
    }
    if (!Array.isArray(value)) {
        throw new Error("Invalid PVM ABI: expected an array of ABI entries");
    }
    for (const entry of value) {
        if (!entry || typeof entry !== "object" || typeof (entry as AbiEntry).type !== "string") {
            throw new Error(
                "Invalid PVM ABI: every entry must have a string `type` (function/event/constructor/...)",
            );
        }
        const inputs = (entry as AbiEntry).inputs;
        if (inputs !== undefined && !Array.isArray(inputs)) {
            throw new Error("Invalid PVM ABI: `inputs` must be an array when present");
        }
    }
    return value as AbiEntry[];
}

/**
 * Read a cargo-pvm-contract ABI file from disk and parse it.
 *
 * Node-only. For browser/in-memory inputs use {@link parsePvmContractAbi}.
 */
export async function loadPvmContractAbi(path: string): Promise<AbiEntry[]> {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(path);
    return parsePvmContractAbi(buf);
}

/**
 * Read both the `.abi.json` and `.polkavm` artifacts produced by
 * `cargo pvm-contract build` for a given base path.
 *
 * `basePath` is the path prefix shared by both files — typically
 * `target/<name>.release`. The function reads `${basePath}.abi.json` and
 * `${basePath}.polkavm`.
 *
 * Node-only.
 */
export async function loadPvmContractArtifacts(basePath: string): Promise<PvmContractArtifacts> {
    const { readFile } = await import("node:fs/promises");
    const [abiBuf, codeBuf] = await Promise.all([
        readFile(`${basePath}.abi.json`),
        readFile(`${basePath}.polkavm`),
    ]);
    return {
        abi: parsePvmContractAbi(abiBuf),
        bytecode: new Uint8Array(codeBuf.buffer, codeBuf.byteOffset, codeBuf.byteLength),
    };
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    const sampleAbi: AbiEntry[] = [
        { type: "constructor", inputs: [], stateMutability: "nonpayable" },
        {
            type: "function",
            name: "increment",
            inputs: [],
            outputs: [],
            stateMutability: "nonpayable",
        },
        {
            type: "function",
            name: "get",
            inputs: [],
            outputs: [{ name: "", type: "uint32" }],
            stateMutability: "view",
        },
    ];

    describe("parsePvmContractAbi", () => {
        test("accepts a parsed AbiEntry[] array directly", () => {
            expect(parsePvmContractAbi(sampleAbi)).toEqual(sampleAbi);
        });

        test("accepts a wrapped { abi } object", () => {
            expect(parsePvmContractAbi({ abi: sampleAbi })).toEqual(sampleAbi);
        });

        test("accepts a JSON string of an array", () => {
            expect(parsePvmContractAbi(JSON.stringify(sampleAbi))).toEqual(sampleAbi);
        });

        test("accepts a JSON string of a wrapped object", () => {
            expect(parsePvmContractAbi(JSON.stringify({ abi: sampleAbi }))).toEqual(sampleAbi);
        });

        test("accepts a UTF-8 Uint8Array", () => {
            const bytes = new TextEncoder().encode(JSON.stringify(sampleAbi));
            expect(parsePvmContractAbi(bytes)).toEqual(sampleAbi);
        });

        test("throws on invalid JSON string", () => {
            expect(() => parsePvmContractAbi("{not json")).toThrow(/not valid JSON/);
        });

        test("throws when input is not an array", () => {
            expect(() => parsePvmContractAbi(42)).toThrow(/expected an array/);
            expect(() => parsePvmContractAbi({ foo: "bar" })).toThrow(/expected an array/);
        });

        test("throws when an entry is missing `type`", () => {
            expect(() => parsePvmContractAbi([{ name: "noType" }])).toThrow(/string `type`/);
        });

        test("throws when `inputs` is not an array", () => {
            expect(() =>
                parsePvmContractAbi([{ type: "function", inputs: "not an array" }]),
            ).toThrow(/`inputs` must be an array/);
        });

        test("treats null as invalid", () => {
            expect(() => parsePvmContractAbi(null)).toThrow();
        });
    });
}
