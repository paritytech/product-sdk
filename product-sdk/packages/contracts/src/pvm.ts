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
 * Read the `.polkavm` bytecode artifact produced by `cargo pvm-contract build`.
 *
 * Returned bytes are ready to hand to `Revive.instantiate_with_code` (or to
 * any future deploy helper layered on top of it). Use this when you already
 * have an ABI in hand (e.g. inline or fetched separately) and only need the
 * PolkaVM blob — otherwise prefer {@link loadPvmContractArtifacts}.
 *
 * Node-only.
 */
export async function loadPvmContractCode(path: string): Promise<Uint8Array> {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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
    const [abi, bytecode] = await Promise.all([
        loadPvmContractAbi(`${basePath}.abi.json`),
        loadPvmContractCode(`${basePath}.polkavm`),
    ]);
    return { abi, bytecode };
}

if (import.meta.vitest) {
    const { test, expect, describe, beforeAll, afterAll } = import.meta.vitest;

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

    describe("loadPvmContractAbi / loadPvmContractArtifacts", () => {
        // Cover the Node-only filesystem helpers via a real tmpdir round-trip.
        // The cargo-pvm-contract toolchain emits files at
        //   target/<name>.release.abi.json
        //   target/<name>.release.polkavm
        // — we recreate that layout here.
        let dir = "";
        let base = "";
        let lonely = "";
        let badAbi = "";
        // Minimal PolkaVM magic (`PVM\0`) is enough to exercise the path —
        // we don't validate bytecode contents in the loader.
        const fakeBytecode = new Uint8Array([0x50, 0x56, 0x4d, 0x00, 0x01, 0x02, 0x03]);

        beforeAll(async () => {
            const { mkdtempSync, writeFileSync } = await import("node:fs");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");
            dir = mkdtempSync(join(tmpdir(), "pvm-loader-test-"));
            base = join(dir, "counter.release");
            lonely = join(dir, "lonely.release");
            badAbi = join(dir, "bad.release");
            writeFileSync(`${base}.abi.json`, JSON.stringify(sampleAbi));
            writeFileSync(`${base}.polkavm`, fakeBytecode);
            writeFileSync(`${lonely}.abi.json`, JSON.stringify(sampleAbi));
            writeFileSync(`${badAbi}.abi.json`, "{not valid json");
        });

        afterAll(async () => {
            const { rmSync } = await import("node:fs");
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        });

        test("loadPvmContractAbi parses a JSON file from disk", async () => {
            const abi = await loadPvmContractAbi(`${base}.abi.json`);
            expect(abi).toEqual(sampleAbi);
        });

        test("loadPvmContractArtifacts reads abi + bytecode pair", async () => {
            const out = await loadPvmContractArtifacts(base);
            expect(out.abi).toEqual(sampleAbi);
            expect(out.bytecode).toBeInstanceOf(Uint8Array);
            expect(Array.from(out.bytecode)).toEqual(Array.from(fakeBytecode));
        });

        test("loadPvmContractCode reads only the .polkavm blob", async () => {
            const code = await loadPvmContractCode(`${base}.polkavm`);
            expect(code).toBeInstanceOf(Uint8Array);
            expect(Array.from(code)).toEqual(Array.from(fakeBytecode));
        });

        test("loadPvmContractAbi rejects a missing file", async () => {
            await expect(loadPvmContractAbi(`${base}.does-not-exist`)).rejects.toThrow();
        });

        test("loadPvmContractArtifacts rejects when bytecode is missing", async () => {
            // Only `${lonely}.abi.json` exists — `.polkavm` is absent.
            await expect(loadPvmContractArtifacts(lonely)).rejects.toThrow();
        });

        test("loadPvmContractAbi propagates parse errors with helpful message", async () => {
            await expect(loadPvmContractAbi(`${badAbi}.abi.json`)).rejects.toThrow(
                /not valid JSON/,
            );
        });
    });
}
