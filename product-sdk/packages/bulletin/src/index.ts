/**
 * @parity/product-sdk-bulletin — Upload and retrieve content on the Polkadot Bulletin Chain.
 *
 * Wraps `@parity/bulletin-sdk` (chunking, DAG-PB manifests, CID calculation,
 * progress events) and adds:
 *
 * - **Network presets** via {@link BulletinChain}
 * - **Read helpers** ({@link BulletinClient.fetchBytes} / {@link BulletinClient.fetchJson})
 * - **Authorization pre-flight** via {@link checkAuthorization}
 *
 * @packageDocumentation
 */

// Our additions
export { BulletinClient } from "./client.js";
export type { CreateBulletinClientOptions } from "./client.js";
export { BulletinChain } from "./networks.js";
export type { BulletinEnvironment, BulletinNetwork } from "./networks.js";
export { checkAuthorization } from "./authorization.js";
export { createLazySigner } from "./lazy-signer.js";
export { executeQuery, queryBytes, queryJson } from "./query.js";
export { resolveQueryStrategy } from "./resolve-query.js";
export type { QueryStrategy } from "./resolve-query.js";
export { verifyOnChain } from "./verify.js";
export type { ChainStoredEntry, VerifyOnChainOptions } from "./verify.js";
export {
    cidToPreimageKey,
    hashToCid,
    HashAlgorithm,
    CidCodec,
} from "./cid.js";

// Errors — both upstream `BulletinError` and our read-side errors
export {
    BulletinError,
    ErrorCode,
    ProductBulletinError,
    BulletinAuthorizationError,
    BulletinCidError,
    BulletinHostUnavailableError,
    BulletinLookupInterruptedError,
    BulletinLookupTimeoutError,
} from "./errors.js";

// Types
export type {
    AuthorizationStatus,
    BulletinApi,
    Environment,
    QueryOptions,
} from "./types.js";

// Re-exports from upstream SDK — surface for power users + so consumers
// don't need a separate `@parity/bulletin-sdk` import.
export {
    AsyncBulletinClient,
    BulletinPreparer,
    AuthCallBuilder,
    CallBuilder,
    StoreBuilder,
    MockBulletinClient,
    AuthorizationScope,
    ChunkStatus,
    TxStatus,
    WaitFor,
    MAX_CHUNK_SIZE,
    MAX_FILE_SIZE,
    DEFAULT_CHUNKER_CONFIG,
    DEFAULT_CLIENT_CONFIG,
    DEFAULT_STORE_OPTIONS,
    calculateCid,
    cidFromBytes,
    cidToBytes,
    convertCid,
    estimateAuthorization,
    getContentHash,
    parseCid,
    reassembleChunks,
    resolveClientConfig,
    validateChunkSize,
    CID,
} from "@parity/bulletin-sdk";

export type {
    BulletinClientInterface,
    BulletinTypedApi,
    Chunk,
    ChunkDetails,
    ChunkProgressEvent,
    ChunkedStoreResult,
    ChunkerConfig,
    ClientConfig,
    DagManifest,
    MockClientConfig,
    MockOperation,
    ProgressCallback,
    ProgressEvent,
    StoreOptions,
    StoreResult,
    SubmitFn,
    TransactionReceipt,
    TransactionStatusEvent,
} from "@parity/bulletin-sdk";
