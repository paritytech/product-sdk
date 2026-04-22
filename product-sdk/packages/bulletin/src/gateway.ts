import { BulletinGatewayFetchError, BulletinGatewayUnavailableError } from "./errors.js";
import type { Environment, FetchOptions } from "./types.js";

/** Add entries here as bulletin gateways go live on each network. */
const GATEWAYS: Partial<Record<Environment, string>> = {
    paseo: "https://paseo-ipfs.polkadot.io/ipfs/",
};

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Get the IPFS gateway URL for an environment.
 * @throws {BulletinGatewayUnavailableError} If the network doesn't have a live gateway yet.
 */
export function getGateway(env: Environment): string {
    const gw = GATEWAYS[env];
    if (!gw) {
        throw new BulletinGatewayUnavailableError(env);
    }
    return gw;
}

/** Build the full gateway URL for a CID. */
export function gatewayUrl(cid: string, gateway: string): string {
    return `${gateway}${cid}`;
}

/** Check if a CID exists on the gateway (HEAD request). Returns false on any error or timeout. */
export async function cidExists(
    cid: string,
    gateway: string,
    options?: FetchOptions,
): Promise<boolean> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(gatewayUrl(cid, gateway), {
            method: "HEAD",
            signal: controller.signal,
        });
        return response.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Fetch raw bytes from the gateway.
 * @throws {BulletinGatewayFetchError} If the gateway returns a non-OK response.
 */
export async function fetchBytes(
    cid: string,
    gateway: string,
    options?: FetchOptions,
): Promise<Uint8Array> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(gatewayUrl(cid, gateway), { signal: controller.signal });
        if (!response.ok) {
            throw new BulletinGatewayFetchError(cid, response.status, response.statusText);
        }
        return new Uint8Array(await response.arrayBuffer());
    } finally {
        clearTimeout(timer);
    }
}

/** Fetch and parse JSON from the gateway. */
export async function fetchJson<T>(
    cid: string,
    gateway: string,
    options?: FetchOptions,
): Promise<T> {
    const bytes = await fetchBytes(cid, gateway, options);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

if (import.meta.vitest) {
    const { describe, test, expect, vi, afterEach } = import.meta.vitest;

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("getGateway", () => {
        test("returns known URL for paseo", () => {
            const gw = getGateway("paseo");
            expect(gw).toMatch(/^https:\/\//);
            expect(gw).toMatch(/\/ipfs\/$/);
        });

        test("throws BulletinGatewayUnavailableError for environments without a live gateway", () => {
            expect(() => getGateway("polkadot")).toThrow(BulletinGatewayUnavailableError);
            expect(() => getGateway("kusama")).toThrow(BulletinGatewayUnavailableError);
        });
    });

    describe("gatewayUrl", () => {
        test("concatenates gateway and CID", () => {
            expect(gatewayUrl("bafyabc", "https://gw.example/ipfs/")).toBe(
                "https://gw.example/ipfs/bafyabc",
            );
        });
    });

    describe("cidExists", () => {
        test("returns true for 200 response", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
            expect(await cidExists("bafyabc", "https://gw/ipfs/")).toBe(true);
        });

        test("returns false for 404 response", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
            expect(await cidExists("bafyabc", "https://gw/ipfs/")).toBe(false);
        });

        test("returns false on network error", async () => {
            vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
            expect(await cidExists("bafyabc", "https://gw/ipfs/")).toBe(false);
        });

        test("returns false on timeout", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockImplementation(
                    (_url: string, init: { signal: AbortSignal }) =>
                        new Promise((_resolve, reject) => {
                            init.signal.addEventListener("abort", () =>
                                reject(new DOMException("aborted", "AbortError")),
                            );
                        }),
                ),
            );
            expect(await cidExists("bafyabc", "https://gw/ipfs/", { timeoutMs: 10 })).toBe(false);
        });
    });

    describe("fetchBytes", () => {
        test("returns bytes from response", async () => {
            const payload = new Uint8Array([1, 2, 3]);
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(payload.buffer),
                }),
            );
            const result = await fetchBytes("bafyabc", "https://gw/ipfs/");
            expect(result).toEqual(payload);
        });

        test("throws BulletinGatewayFetchError on non-ok response", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue({
                    ok: false,
                    status: 500,
                    statusText: "Internal Server Error",
                }),
            );
            const err = await fetchBytes("bafyabc", "https://gw/ipfs/").catch((e) => e);
            expect(err).toBeInstanceOf(BulletinGatewayFetchError);
            expect(err.cid).toBe("bafyabc");
            expect(err.status).toBe(500);
        });

        test("throws on timeout", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockImplementation(
                    (_url: string, init: { signal: AbortSignal }) =>
                        new Promise((_resolve, reject) => {
                            init.signal.addEventListener("abort", () =>
                                reject(new DOMException("aborted", "AbortError")),
                            );
                        }),
                ),
            );
            await expect(
                fetchBytes("bafyabc", "https://gw/ipfs/", { timeoutMs: 10 }),
            ).rejects.toThrow();
        });
    });

    describe("fetchJson", () => {
        test("parses JSON from response", async () => {
            const obj = { name: "test", value: 42 };
            const bytes = new TextEncoder().encode(JSON.stringify(obj));
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(bytes.buffer),
                }),
            );
            const result = await fetchJson<{ name: string; value: number }>(
                "bafyabc",
                "https://gw/ipfs/",
            );
            expect(result).toEqual(obj);
        });
    });
}
