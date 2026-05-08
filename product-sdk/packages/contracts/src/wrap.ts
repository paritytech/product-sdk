import type { PolkadotSigner, SS58String } from "polkadot-api";
import { submitAndWatch } from "@parity/product-sdk-tx";
import { seedToAccount } from "@parity/product-sdk-keys";
import { createLogger } from "@parity/product-sdk-logger";
import { DEV_PHRASE, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { ContractSignerMissingError } from "./errors.js";
import type {
    AbiEntry,
    BatchableCall,
    Contract,
    ContractDef,
    ContractDefaults,
    PrepareOptions,
    QueryOptions,
    TxOptions,
} from "./types.js";

const log = createLogger("contracts");

/**
 * Ink SDK contract instance returned by `inkSdk.getContract()`.
 *
 * Typed as `any` because we call `.query()` / `.send()` with runtime method
 * names — the SDK's `ContractSdk<D>` requires compile-time descriptor
 * knowledge that runtime ABIs can't provide.
 */
type InkContract = any;

/** Extract method name → ordered parameter names from the ABI. */
function buildMethodArgMap(abi: AbiEntry[]): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const entry of abi) {
        if (entry.type === "function" && entry.name) {
            map[entry.name] = entry.inputs.map((p) => p.name);
        }
    }
    return map;
}

/** Convert positional arguments to a named object matching the ABI parameter names. */
function positionalToNamed(argNames: string[], values: unknown[]): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (let i = 0; i < argNames.length; i++) {
        data[argNames[i]] = values[i];
    }
    return data;
}

/**
 * If the caller passed more arguments than the ABI expects and the last
 * argument is a plain object, treat it as an options override.
 */
function extractOverrides<T>(
    argNames: string[],
    args: unknown[],
): { positionalArgs: unknown[]; overrides?: T } {
    if (args.length > argNames.length && args.length > 0) {
        const last = args[args.length - 1];
        if (last && typeof last === "object" && !Array.isArray(last)) {
            return { positionalArgs: args.slice(0, -1), overrides: last as T };
        }
    }
    return { positionalArgs: args };
}

/**
 * Dev address (Alice) used as fallback origin for read-only queries when no
 * wallet is connected. Queries are dry-run simulations — the origin only
 * affects gas estimation and is safe to stub.
 *
 * This is a development convenience. In production, the origin is resolved
 * from the signerManager (logged-in account) or an explicit defaultOrigin.
 */
const QUERY_FALLBACK_ORIGIN = seedToAccount(DEV_PHRASE, "//Alice").ss58Address as SS58String;

/**
 * Resolve the origin address: explicit override → signerManager → static default.
 * For queries, pass `forQuery: true` to enable the dev-address fallback.
 */
function resolveOrigin(
    defaults: ContractDefaults,
    override?: SS58String,
    forQuery?: boolean,
): SS58String | undefined {
    if (override) return override;
    const sourceAddr = defaults.signerManager?.getState().selectedAccount?.address;
    if (sourceAddr) return sourceAddr as SS58String;
    if (defaults.origin) return defaults.origin;
    if (forQuery) {
        log.warn("No origin configured — using dev fallback (Alice) for query dry-run");
        return QUERY_FALLBACK_ORIGIN;
    }
    return undefined;
}

/**
 * Resolve the signer: explicit override → signerManager → static default.
 */
function resolveSigner(
    defaults: ContractDefaults,
    override?: PolkadotSigner,
): PolkadotSigner | undefined {
    return override ?? defaults.signerManager?.getSigner() ?? defaults.signer;
}

/**
 * Wrap an ink SDK contract instance with a proxy that exposes each ABI
 * method as `{ query, tx }` — converting positional arguments to the
 * named-parameter format the SDK expects.
 */
export function wrapContract(
    inkContract: InkContract,
    abi: AbiEntry[],
    defaults: ContractDefaults,
): Contract<ContractDef> {
    const methodArgs = buildMethodArgMap(abi);

    return new Proxy({} as any, {
        get(_, methodName: string) {
            if (typeof methodName !== "string") return undefined;
            const argNames = methodArgs[methodName];
            if (!argNames) return undefined;

            return {
                query: async (...args: unknown[]) => {
                    const { positionalArgs, overrides } = extractOverrides<QueryOptions>(
                        argNames,
                        args,
                    );
                    const data = positionalToNamed(argNames, positionalArgs);
                    const origin = resolveOrigin(defaults, overrides?.origin, true)!;

                    const result = await inkContract.query(methodName, {
                        origin,
                        data,
                        ...(overrides?.value !== undefined && { value: overrides.value }),
                    });
                    return {
                        success: result.success,
                        value: result.success ? result.value.response : undefined,
                        gasRequired: result.value?.gasRequired,
                    };
                },

                tx: async (...args: unknown[]) => {
                    const { positionalArgs, overrides } = extractOverrides<TxOptions>(
                        argNames,
                        args,
                    );
                    const data = positionalToNamed(argNames, positionalArgs);
                    const signer = resolveSigner(defaults, overrides?.signer);
                    if (!signer) {
                        throw new ContractSignerMissingError();
                    }

                    const origin =
                        resolveOrigin(defaults, overrides?.origin) ??
                        (ss58Address(signer.publicKey) as SS58String);
                    const inkTx = inkContract.send(methodName, {
                        data,
                        origin,
                        ...(overrides?.value !== undefined && { value: overrides.value }),
                        ...(overrides?.gasLimit && { gasLimit: overrides.gasLimit }),
                        ...(overrides?.storageDepositLimit !== undefined && {
                            storageDepositLimit: overrides.storageDepositLimit,
                        }),
                    });
                    return submitAndWatch(inkTx, signer, {
                        waitFor: overrides?.waitFor,
                        timeoutMs: overrides?.timeoutMs,
                        mortalityPeriod: overrides?.mortalityPeriod,
                        onStatus: overrides?.onStatus,
                    });
                },

                prepare: (...args: unknown[]): BatchableCall => {
                    const { positionalArgs, overrides } = extractOverrides<PrepareOptions>(
                        argNames,
                        args,
                    );
                    const data = positionalToNamed(argNames, positionalArgs);
                    // prepare() doesn't require a signer — origin here is for
                    // dry-run gas estimation; the batch's signer replaces it
                    // as the dispatched origin at submission.
                    const origin = resolveOrigin(defaults, overrides?.origin, true)!;
                    return inkContract.send(methodName, {
                        data,
                        origin,
                        ...(overrides?.value !== undefined && { value: overrides.value }),
                        ...(overrides?.gasLimit && { gasLimit: overrides.gasLimit }),
                        ...(overrides?.storageDepositLimit !== undefined && {
                            storageDepositLimit: overrides.storageDepositLimit,
                        }),
                    });
                },
            };
        },
    });
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    describe("buildMethodArgMap", () => {
        test("extracts function parameter names from ABI", () => {
            const abi: AbiEntry[] = [
                { type: "constructor", inputs: [], stateMutability: "nonpayable" },
                {
                    type: "function",
                    name: "transfer",
                    inputs: [
                        { name: "to", type: "address" },
                        { name: "amount", type: "uint256" },
                    ],
                    outputs: [{ name: "", type: "bool" }],
                },
                {
                    type: "function",
                    name: "balanceOf",
                    inputs: [{ name: "owner", type: "address" }],
                    outputs: [{ name: "", type: "uint256" }],
                },
                { type: "event", name: "Transfer", inputs: [] },
            ];
            const map = buildMethodArgMap(abi);
            expect(map).toEqual({
                transfer: ["to", "amount"],
                balanceOf: ["owner"],
            });
        });

        test("returns empty map for ABI with no functions", () => {
            const abi: AbiEntry[] = [
                { type: "constructor", inputs: [] },
                { type: "event", name: "Evt", inputs: [] },
            ];
            expect(buildMethodArgMap(abi)).toEqual({});
        });
    });

    describe("positionalToNamed", () => {
        test("maps positional values to named keys", () => {
            expect(positionalToNamed(["a", "b"], [1, 2])).toEqual({ a: 1, b: 2 });
        });

        test("handles empty args", () => {
            expect(positionalToNamed([], [])).toEqual({});
        });
    });

    describe("extractOverrides", () => {
        test("returns overrides when extra object arg is present", () => {
            const result = extractOverrides<{ origin: string }>(["a"], [42, { origin: "0x1" }]);
            expect(result.positionalArgs).toEqual([42]);
            expect(result.overrides).toEqual({ origin: "0x1" });
        });

        test("returns no overrides when arg count matches", () => {
            const result = extractOverrides(["a", "b"], [1, 2]);
            expect(result.positionalArgs).toEqual([1, 2]);
            expect(result.overrides).toBeUndefined();
        });

        test("does not treat array as overrides", () => {
            const result = extractOverrides(["a"], [1, [2, 3]]);
            expect(result.positionalArgs).toEqual([1, [2, 3]]);
            expect(result.overrides).toBeUndefined();
        });

        test("does not treat primitive as overrides", () => {
            const result = extractOverrides(["a"], [1, "extra"]);
            expect(result.positionalArgs).toEqual([1, "extra"]);
            expect(result.overrides).toBeUndefined();
        });
    });

    /** Build a partial SignerManager mock for tests. */
    function mockSigner(opts: {
        address?: string | null;
        signer?: any;
    }): import("@parity/product-sdk-signer").SignerManager {
        return {
            getSigner: () => opts.signer ?? null,
            getState: () => ({
                selectedAccount: opts.address ? ({ address: opts.address } as any) : null,
            }),
        } as any;
    }

    describe("resolveOrigin", () => {
        test("explicit override wins", () => {
            const defaults: ContractDefaults = {
                origin: "5Static" as SS58String,
                signerManager: mockSigner({ address: "5Source" }),
            };
            expect(resolveOrigin(defaults, "5Override" as SS58String)).toBe("5Override");
        });

        test("signerManager wins over static default", () => {
            const defaults: ContractDefaults = {
                origin: "5Static" as SS58String,
                signerManager: mockSigner({ address: "5Source" }),
            };
            expect(resolveOrigin(defaults)).toBe("5Source");
        });

        test("falls back to static default", () => {
            const defaults: ContractDefaults = { origin: "5Static" as SS58String };
            expect(resolveOrigin(defaults)).toBe("5Static");
        });

        test("returns undefined when nothing available", () => {
            expect(resolveOrigin({})).toBeUndefined();
        });

        test("skips signerManager when no account selected", () => {
            const defaults: ContractDefaults = {
                origin: "5Static" as SS58String,
                signerManager: mockSigner({ address: null }),
            };
            expect(resolveOrigin(defaults)).toBe("5Static");
        });
    });

    describe("resolveSigner", () => {
        const fakeSigner = { id: "fake" } as any;
        const sourceSigner = { id: "source" } as any;

        test("explicit override wins", () => {
            const defaults: ContractDefaults = {
                signer: { id: "static" } as any,
                signerManager: mockSigner({ signer: sourceSigner }),
            };
            expect(resolveSigner(defaults, fakeSigner)).toBe(fakeSigner);
        });

        test("signerManager wins over static default", () => {
            const defaults: ContractDefaults = {
                signer: { id: "static" } as any,
                signerManager: mockSigner({ signer: sourceSigner }),
            };
            expect(resolveSigner(defaults)).toBe(sourceSigner);
        });

        test("falls back to static default", () => {
            const defaults: ContractDefaults = { signer: fakeSigner };
            expect(resolveSigner(defaults)).toBe(fakeSigner);
        });

        test("returns undefined when nothing available", () => {
            expect(resolveSigner({})).toBeUndefined();
        });

        test("skips signerManager when getSigner returns null", () => {
            const defaults: ContractDefaults = {
                signer: fakeSigner,
                signerManager: mockSigner({}),
            };
            expect(resolveSigner(defaults)).toBe(fakeSigner);
        });
    });

    describe("wrapContract — prepare", () => {
        // .prepare() port from polkadot-apps@4b60d19. Asserts that the
        // method returns a BatchableCall consumable by batchSubmitAndWatch
        // without going through submission, doesn't require a signer, and
        // forwards the gas/value overrides the same way `.tx()` does.

        const abi: AbiEntry[] = [
            {
                type: "function",
                name: "increment",
                inputs: [],
                outputs: [],
                stateMutability: "nonpayable",
            },
            {
                type: "function",
                name: "add",
                inputs: [{ name: "n", type: "uint32" }],
                outputs: [],
                stateMutability: "nonpayable",
            },
        ];

        test("prepare returns ink send result without submitting", () => {
            let sendCapture: any;
            const fakeSendResult = { waited: Promise.resolve({ decodedCall: { pallet: "X" } }) };
            const fakeInk = {
                send: (method: string, args: any) => {
                    sendCapture = { method, args };
                    return fakeSendResult;
                },
            };
            const wrapped = wrapContract(fakeInk, abi, { origin: "5Alice" as any });

            const result = wrapped.add.prepare(42);
            expect(sendCapture.method).toBe("add");
            expect(sendCapture.args.data).toEqual({ n: 42 });
            expect(sendCapture.args.origin).toBe("5Alice");
            expect(result).toBe(fakeSendResult);
        });

        test("prepare does not require a signer", () => {
            const fakeInk = {
                send: () => ({ waited: Promise.resolve({ decodedCall: {} }) }),
            };
            const wrapped = wrapContract(fakeInk, abi, {});
            // No signer, no signerManager, no default origin — should still work
            expect(() => wrapped.increment.prepare()).not.toThrow();
        });

        test("prepare uses fallback origin for dry-run gas estimation", () => {
            let captured: any;
            const fakeInk = {
                send: (_: string, args: any) => {
                    captured = args;
                    return { waited: Promise.resolve({ decodedCall: {} }) };
                },
            };
            const wrapped = wrapContract(fakeInk, abi, {});

            wrapped.increment.prepare();
            expect(captured.origin).toBe(QUERY_FALLBACK_ORIGIN);
        });

        test("prepare forwards value, gasLimit, storageDepositLimit", () => {
            let captured: any;
            const fakeInk = {
                send: (_: string, args: any) => {
                    captured = args;
                    return { waited: Promise.resolve({ decodedCall: {} }) };
                },
            };
            const wrapped = wrapContract(fakeInk, abi, { origin: "5A" as any });

            const gasLimit = { ref_time: 1_000_000n, proof_size: 1024n };
            wrapped.add.prepare(7, {
                value: 500n,
                gasLimit,
                storageDepositLimit: 999n,
            });
            expect(captured.data).toEqual({ n: 7 });
            expect(captured.value).toBe(500n);
            expect(captured.gasLimit).toBe(gasLimit);
            expect(captured.storageDepositLimit).toBe(999n);
        });

        test("prepare override origin wins over signerManager and default", () => {
            let captured: any;
            const fakeInk = {
                send: (_: string, args: any) => {
                    captured = args;
                    return { waited: Promise.resolve({ decodedCall: {} }) };
                },
            };
            const wrapped = wrapContract(fakeInk, abi, {
                origin: "5Default" as any,
                signerManager: mockSigner({ address: "5Source" }),
            });

            wrapped.increment.prepare({ origin: "5Override" as any });
            expect(captured.origin).toBe("5Override");
        });

        test("prepare result is consumable by batchSubmitAndWatch", async () => {
            const { batchSubmitAndWatch } = await import("@parity/product-sdk-tx");
            const prepared = [
                { waited: Promise.resolve({ decodedCall: { call: "one" } }) },
                { waited: Promise.resolve({ decodedCall: { call: "two" } }) },
            ];
            const fakeInk = {
                send: (_: string, _args: any) => prepared.shift()!,
            };
            const wrapped = wrapContract(fakeInk, abi, { origin: "5A" as any });

            const a = wrapped.increment.prepare();
            const b = wrapped.add.prepare(1);

            const captured: unknown[][] = [];
            const fakeApi = {
                tx: {
                    Utility: {
                        batch_all: (args: { calls: unknown[] }) => {
                            captured.push(args.calls);
                            return {
                                signSubmitAndWatch: () => ({
                                    subscribe: (h: any) => {
                                        h.next({ type: "signed", txHash: "0xb" });
                                        h.next({
                                            type: "txBestBlocksState",
                                            txHash: "0xb",
                                            found: true,
                                            ok: true,
                                            events: [],
                                            block: { hash: "0xblk", number: 1, index: 0 },
                                        });
                                        return { unsubscribe: () => {} };
                                    },
                                }),
                            };
                        },
                    },
                },
            } as any;

            const result = await batchSubmitAndWatch([a, b], fakeApi, {
                publicKey: new Uint8Array(32),
            } as any);
            expect(result.ok).toBe(true);
            expect(captured[0]).toEqual([{ call: "one" }, { call: "two" }]);
        });
    });
}
