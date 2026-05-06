import {
    AsyncBulletinClient,
    type AuthCallBuilder,
    type BulletinTypedApi,
    type CallBuilder,
    type ClientConfig,
    type StoreBuilder,
    type SubmitFn,
} from "@parity/bulletin-sdk";
import { createChainClient, getChainAPI } from "@parity/product-sdk-chain-client";
import { createLogger } from "@parity/product-sdk-logger";
import type { PolkadotClient, PolkadotSigner } from "polkadot-api";

import { checkAuthorization } from "./authorization.js";
import type { BulletinChain, BulletinEnvironment } from "./networks.js";
import { executeQuery } from "./query.js";
import { resolveQueryStrategy, type QueryStrategy } from "./resolve-query.js";
import type { AuthorizationStatus, BulletinApi, QueryOptions } from "./types.js";
import { verifyOnChain, type ChainStoredEntry, type VerifyOnChainOptions } from "./verify.js";

const log = createLogger("bulletin");

/**
 * Options for {@link BulletinClient.create}.
 *
 * One of two construction shapes is supported:
 *
 * - **Environment shorthand** — pass an `environment` string keyed by
 *   {@link BulletinChain}. Wires up the chain-client automatically.
 * - **Explicit network** — pass `genesisHash` and `descriptor` directly
 *   (e.g., spread from a {@link BulletinChain} entry, or supply custom
 *   values for a private chain).
 */
export type CreateBulletinClientOptions =
    | (CreateBulletinClientCommon & { environment: BulletinEnvironment })
    | (CreateBulletinClientCommon & {
          genesisHash: `0x${string}`;
          descriptor: (typeof BulletinChain)[BulletinEnvironment]["descriptor"];
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
 * - **Read helpers** ({@link fetchBytes}, {@link fetchJson}) routed through
 *   the host's preimage subscription — upstream is upload-only and the SDK
 *   is container-only by design (no public-gateway fetches).
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

    /** Lazy-resolved host-preimage query strategy, cached for the client lifetime. */
    private queryStrategyPromise: Promise<QueryStrategy> | null = null;

    /** Constructed via {@link create} or {@link from}. */
    private constructor(inner: AsyncBulletinClient, api: BulletinApi) {
        this.inner = inner;
        this.api = api;
    }

    /** Resolve and cache the host query strategy on first use. */
    private resolveQuery(): Promise<QueryStrategy> {
        if (!this.queryStrategyPromise) {
            this.queryStrategyPromise = resolveQueryStrategy();
        }
        return this.queryStrategyPromise;
    }

    /**
     * Create a client from an environment shorthand or an explicit network.
     *
     * Environment form uses our `getChainAPI(env)` to resolve the typed API.
     * Explicit form skips the environment lookup and lets you pass any
     * genesis/descriptor combo.
     *
     * @example
     * ```ts
     * // Shorthand
     * const client = await BulletinClient.create({ environment: "paseo", signer });
     *
     * // Explicit (custom network)
     * const client = await BulletinClient.create({
     *   ...BulletinChain.paseo,
     *   signer,
     *   config: { defaultChunkSize: 1 << 20 },
     * });
     * ```
     */
    static async create(options: CreateBulletinClientOptions): Promise<BulletinClient> {
        if ("environment" in options) {
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
            return new BulletinClient(inner, chain.bulletin);
        }

        // Explicit form — caller owns the descriptor choice. We still need a
        // PolkadotClient to feed AsyncBulletinClient. Going through
        // chain-client keeps connection management consistent across the SDK.
        const { genesisHash, descriptor, signer, config } = options;
        // Catch the obvious foot-gun where caller mixes a genesis from one
        // network with a descriptor from another — the connection would
        // succeed but typed calls would silently target the wrong chain.
        // The descriptor's own `.genesis` field is the on-chain truth; the
        // user-supplied `genesisHash` is informational today (createChainClient
        // doesn't use it because host routes connections) but kept on the
        // option shape for future RPC-direct paths.
        if (descriptor.genesis && genesisHash.toLowerCase() !== descriptor.genesis.toLowerCase()) {
            throw new Error(
                `BulletinClient.create: genesisHash (${genesisHash}) does not match descriptor.genesis (${descriptor.genesis}). These must refer to the same network — check that you're pairing the right descriptor with the right genesis hash.`,
            );
        }
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
        return new BulletinClient(inner, chain.bulletin);
    }

    /**
     * Construct from a pre-built `AsyncBulletinClient` and PAPI typed API.
     *
     * Use this when you already own the connection lifecycle (BYOD setups,
     * tests). The caller is responsible for calling `papiClient.destroy()`
     * — this client's {@link destroy} only tears down the upstream's
     * `onDestroy` hook.
     */
    static from(inner: AsyncBulletinClient, api: BulletinApi): BulletinClient {
        return new BulletinClient(inner, api);
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
     * Fetch raw bytes for a CID via the host's preimage lookup.
     *
     * Container-only — outside a Polkadot Browser / Desktop host this
     * throws {@link BulletinHostUnavailableError}. The chain stores
     * content metadata (`content_hash`, size, codec) but the bytes
     * themselves are surfaced through the host's preimage subscription.
     *
     * Use {@link verifyOnChain} if you only need to confirm a CID was
     * recorded on-chain (no byte fetch).
     */
    async fetchBytes(cid: string, options?: QueryOptions): Promise<Uint8Array> {
        const strategy = await this.resolveQuery();
        return executeQuery(strategy, cid, options);
    }

    /** Fetch and parse JSON for a CID. */
    async fetchJson<T>(cid: string, options?: QueryOptions): Promise<T> {
        const bytes = await this.fetchBytes(cid, options);
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
    }

    /** Pre-flight: check whether `address` can store on the bulletin chain. */
    async checkAuthorization(address: string): Promise<AuthorizationStatus> {
        return checkAuthorization(this.api, address);
    }

    /**
     * Verify that a CID was recorded on-chain at the given block.
     *
     * Common pattern: pass `blockNumber` (and optionally `extrinsicIndex`)
     * from a `store(...).send()` receipt to confirm the upload landed.
     * See {@link verifyOnChain} for details.
     */
    async verifyOnChain(
        cid: string,
        options: VerifyOnChainOptions,
    ): Promise<ChainStoredEntry | null> {
        return verifyOnChain(this.api, cid, options);
    }

    /** Tear down the underlying connection. */
    async destroy(): Promise<void> {
        await this.inner.destroy();
    }
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    describe("BulletinClient.from", () => {
        test("constructs with given inner and api", () => {
            const inner = {
                destroy: vi.fn().mockResolvedValue(undefined),
            } as unknown as AsyncBulletinClient;
            const api = {} as BulletinApi;
            const client = BulletinClient.from(inner, api);
            expect(client.inner).toBe(inner);
            expect(client.api).toBe(api);
        });

        test("destroy delegates to upstream", async () => {
            const destroy = vi.fn().mockResolvedValue(undefined);
            const inner = { destroy } as unknown as AsyncBulletinClient;
            const client = BulletinClient.from(inner, {} as BulletinApi);
            await client.destroy();
            expect(destroy).toHaveBeenCalledOnce();
        });

        test("store delegates to inner", () => {
            const builder = {} as StoreBuilder;
            const inner = {
                store: vi.fn().mockReturnValue(builder),
            } as unknown as AsyncBulletinClient;
            const client = BulletinClient.from(inner, {} as BulletinApi);
            const data = new Uint8Array([1, 2, 3]);
            expect(client.store(data)).toBe(builder);
            expect(inner.store).toHaveBeenCalledWith(data);
        });
    });

    describe("BulletinClient.create (BYOD genesis assertion)", () => {
        // Stand-in descriptor with a known genesis. The full PAPI descriptor
        // type is a `ChainDefinition` with a deep type-level shape; the cast
        // below is fine for the assertion test because we never actually
        // reach createChainClient.
        const stubDescriptor = (
            genesis: `0x${string}`,
        ): (typeof BulletinChain)[BulletinEnvironment]["descriptor"] =>
            ({ genesis }) as unknown as (typeof BulletinChain)[BulletinEnvironment]["descriptor"];

        const realPaseo =
            "0x744960c32e3a3df5440e1ecd4d34096f1ce2230d7016a5ada8a765d5a622b4ea" as `0x${string}`;

        test("throws when genesisHash and descriptor.genesis disagree", async () => {
            await expect(
                BulletinClient.create({
                    genesisHash:
                        "0x0000000000000000000000000000000000000000000000000000000000000001",
                    descriptor: stubDescriptor(realPaseo),
                    signer: {} as PolkadotSigner,
                }),
            ).rejects.toThrow(/does not match descriptor\.genesis/i);
        });
    });
}
