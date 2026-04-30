import {
    AsyncBulletinClient,
    type AuthCallBuilder,
    type BulletinTypedApi,
    type CallBuilder,
    type ClientConfig,
    type StoreBuilder,
    type SubmitFn,
} from "@parity/bulletin-sdk";
import { getChainAPI } from "@parity/product-sdk-chain-client";
import { createLogger } from "@parity/product-sdk-logger";
import type { PolkadotClient, PolkadotSigner } from "polkadot-api";

import { checkAuthorization } from "./authorization.js";
import { gatewayUrl } from "./gateway.js";
import { BulletinChain, type BulletinEnvironment } from "./networks.js";
import { fetchContent } from "./query.js";
import type { AuthorizationStatus, BulletinApi, QueryOptions } from "./types.js";

const log = createLogger("bulletin");

/**
 * Options for {@link BulletinClient.create}.
 *
 * One of two construction shapes is supported:
 *
 * - **Environment shorthand** — pass an `environment` string keyed by
 *   {@link BulletinChain}. Wires up the chain-client and gateway preset
 *   automatically.
 * - **Explicit network** — pass `genesisHash`, `descriptor`, and `gateway`
 *   directly (e.g., spread from a {@link BulletinChain} entry, or supply
 *   custom values for a private chain).
 */
export type CreateBulletinClientOptions =
    | (CreateBulletinClientCommon & { environment: BulletinEnvironment })
    | (CreateBulletinClientCommon & {
          genesisHash: `0x${string}`;
          descriptor: (typeof BulletinChain)[BulletinEnvironment]["descriptor"];
          gateway: string | null;
      });

interface CreateBulletinClientCommon {
    /** Signer for transaction submission. Required — every store needs a signer. */
    signer: PolkadotSigner;
    /** Optional config forwarded to {@link AsyncBulletinClient}. */
    config?: Partial<ClientConfig>;
}

/**
 * Ergonomic entry point for Bulletin Chain operations.
 *
 * Wraps {@link AsyncBulletinClient} from `@parity/bulletin-sdk` (which handles
 * chunking, DAG-PB manifests, CID calculation, and progress events) and adds:
 *
 * - **Network presets** via {@link BulletinClient.create} and {@link BulletinChain}.
 * - **Read helpers** ({@link fetchBytes}, {@link fetchJson}) — upstream is
 *   upload-only.
 * - **Pre-flight authorization check** ({@link checkAuthorization}) for
 *   friendlier UX before submitting a store.
 *
 * For uploads, mirror upstream's fluent builders:
 *
 * ```ts
 * const client = await BulletinClient.create({ environment: "paseo", signer });
 * const result = await client.store(data).send();
 * ```
 *
 * For chunked uploads with progress:
 *
 * ```ts
 * const result = await client
 *   .store(largeFile)
 *   .withChunkSize(1 << 20)
 *   .withCallback((evt) => console.log(evt))
 *   .send();
 * ```
 */
export class BulletinClient {
    /** Underlying upstream client — exposed for power users. */
    readonly inner: AsyncBulletinClient;
    /** Typed Bulletin Chain API. */
    readonly api: BulletinApi;
    /** IPFS gateway base URL, or `null` if none is configured for this network. */
    readonly gateway: string | null;

    /** Constructed via {@link create} or {@link from}. */
    private constructor(inner: AsyncBulletinClient, api: BulletinApi, gateway: string | null) {
        this.inner = inner;
        this.api = api;
        this.gateway = gateway;
    }

    /**
     * Create a client from an environment shorthand or an explicit network.
     *
     * Environment form uses our `getChainAPI(env)` to resolve the typed API and
     * the gateway preset from {@link BulletinChain}. Explicit form skips the
     * environment lookup and lets you pass any genesis/descriptor/gateway combo.
     *
     * @example
     * ```ts
     * // Shorthand
     * const client = await BulletinClient.create({ environment: "paseo", signer });
     *
     * // Explicit (custom network, or override gateway)
     * const client = await BulletinClient.create({
     *   ...BulletinChain.paseo,
     *   signer,
     *   config: { defaultChunkSize: 1 << 20 },
     * });
     * ```
     */
    static async create(options: CreateBulletinClientOptions): Promise<BulletinClient> {
        if ("environment" in options) {
            const preset = BulletinChain[options.environment];
            const chain = await getChainAPI(options.environment);
            const inner = new AsyncBulletinClient(
                chain.bulletin as BulletinTypedApi,
                options.signer,
                chain.raw.bulletin.submit as SubmitFn,
                options.config,
                () => chain.destroy(),
            );
            log.info("BulletinClient created (environment shorthand)", {
                environment: options.environment,
            });
            return new BulletinClient(inner, chain.bulletin, preset.gateway);
        }

        // Explicit form — caller owns the descriptor + gateway choice. We still
        // need a PolkadotClient to feed AsyncBulletinClient. Going through
        // chain-client keeps connection management consistent across the SDK.
        const { genesisHash, descriptor, gateway, signer, config } = options;
        const { createChainClient } = await import("@parity/product-sdk-chain-client");
        // genesisHash is currently unused by createChainClient (host routes
        // connections), but we pass it through for future RPC-direct paths.
        void genesisHash;
        const chain = await createChainClient({
            chains: { bulletin: descriptor },
            rpcs: { bulletin: [] },
        });
        const inner = new AsyncBulletinClient(
            chain.bulletin as BulletinTypedApi,
            signer,
            chain.raw.bulletin.submit as SubmitFn,
            config,
            () => chain.destroy(),
        );
        log.info("BulletinClient created (explicit network)");
        return new BulletinClient(inner, chain.bulletin, gateway);
    }

    /**
     * Construct from a pre-built `AsyncBulletinClient` and PAPI client.
     *
     * Use this when you already own the connection lifecycle (BYOD setups,
     * tests). The caller is responsible for calling `papiClient.destroy()`
     * — this client's {@link destroy} only tears down the upstream's
     * `onDestroy` hook.
     */
    static from(
        inner: AsyncBulletinClient,
        api: BulletinApi,
        gateway: string | null,
    ): BulletinClient {
        return new BulletinClient(inner, api, gateway);
    }

    // ─── Upload + authorization (forwarded to upstream) ────────────────

    /** Build a store transaction. See upstream `StoreBuilder` for chained options. */
    store(data: Uint8Array): StoreBuilder {
        return this.inner.store(data);
    }

    /** Authorize an account to store data on the chain (sudo required on most networks). */
    authorizeAccount(who: string, transactions: number, bytes: bigint): AuthCallBuilder {
        return this.inner.authorizeAccount(who, transactions, bytes);
    }

    /** Authorize content storage by hash (anyone can store; no fees). */
    authorizePreimage(contentHash: Uint8Array, maxSize: bigint): AuthCallBuilder {
        return this.inner.authorizePreimage(contentHash, maxSize);
    }

    /** Renew a stored transaction by block + index. */
    renew(block: number, index: number): CallBuilder {
        return this.inner.renew(block, index);
    }

    /** Estimate the authorization (transactions + bytes) needed for `dataSize`. */
    estimateAuthorization(dataSize: number): { transactions: number; bytes: number } {
        return this.inner.estimateAuthorization(dataSize);
    }

    // ─── Read side (our own helpers) ───────────────────────────────────

    /**
     * Fetch raw bytes for a CID.
     *
     * Tries chain storage first (when the runtime exposes the necessary query
     * — currently a no-op), then falls back to the configured IPFS gateway.
     */
    async fetchBytes(cid: string, options?: QueryOptions): Promise<Uint8Array> {
        return fetchContent(this.api, this.gateway, cid, options);
    }

    /** Fetch and parse JSON for a CID. */
    async fetchJson<T>(cid: string, options?: QueryOptions): Promise<T> {
        const bytes = await this.fetchBytes(cid, options);
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
    }

    /** Build the full gateway URL for a CID. Returns `null` if no gateway is configured. */
    gatewayUrl(cid: string): string | null {
        return this.gateway ? gatewayUrl(cid, this.gateway) : null;
    }

    /** Pre-flight: check whether `address` can store on the bulletin chain. */
    async checkAuthorization(address: string): Promise<AuthorizationStatus> {
        return checkAuthorization(this.api, address);
    }

    /** Tear down the underlying connection. */
    async destroy(): Promise<void> {
        await this.inner.destroy();
    }
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    describe("BulletinClient.from", () => {
        test("constructs with given inner, api, and gateway", () => {
            const inner = { destroy: vi.fn().mockResolvedValue(undefined) } as unknown as AsyncBulletinClient;
            const api = {} as BulletinApi;
            const client = BulletinClient.from(inner, api, "https://gw/ipfs/");
            expect(client.inner).toBe(inner);
            expect(client.api).toBe(api);
            expect(client.gateway).toBe("https://gw/ipfs/");
        });

        test("gatewayUrl returns null when gateway is null", () => {
            const inner = {} as AsyncBulletinClient;
            const client = BulletinClient.from(inner, {} as BulletinApi, null);
            expect(client.gatewayUrl("bafyabc")).toBeNull();
        });

        test("gatewayUrl concatenates when gateway is set", () => {
            const inner = {} as AsyncBulletinClient;
            const client = BulletinClient.from(inner, {} as BulletinApi, "https://gw/ipfs/");
            expect(client.gatewayUrl("bafyabc")).toBe("https://gw/ipfs/bafyabc");
        });

        test("destroy delegates to upstream", async () => {
            const destroy = vi.fn().mockResolvedValue(undefined);
            const inner = { destroy } as unknown as AsyncBulletinClient;
            const client = BulletinClient.from(inner, {} as BulletinApi, null);
            await client.destroy();
            expect(destroy).toHaveBeenCalledOnce();
        });

        test("store delegates to inner", () => {
            const builder = {} as StoreBuilder;
            const inner = { store: vi.fn().mockReturnValue(builder) } as unknown as AsyncBulletinClient;
            const client = BulletinClient.from(inner, {} as BulletinApi, null);
            const data = new Uint8Array([1, 2, 3]);
            expect(client.store(data)).toBe(builder);
            expect(inner.store).toHaveBeenCalledWith(data);
        });
    });
}
