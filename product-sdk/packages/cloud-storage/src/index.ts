/**
 * @parity/product-sdk-cloud-storage — Upload and retrieve content from the cloud
 * (currently through the Polkadot Bulletin Chain).
 *
 * Wraps `@parity/bulletin-sdk` (chunking, DAG-PB manifests, CID calculation,
 * progress events) and adds:
 *
 * - **Network presets** via {@link CloudStorageNetworks}
 * - **Read helpers** ({@link CloudStorageClient.fetchBytes} /
 *   {@link CloudStorageClient.fetchJson})
 * - **Authorization pre-flight** via {@link checkAuthorization}
 *
 * @packageDocumentation
 */

export { CloudStorageClient } from "./client.js";
export type { CreateCloudStorageClientOptions } from "./client.js";
export { CloudStorageNetworks } from "./networks.js";
export type { CloudStorageEnvironment, CloudStorageNetwork } from "./networks.js";
export { authorizeAccount, checkAuthorization } from "./authorization.js";
export type { AuthorizeAccountOptions } from "./authorization.js";
export { createLazySigner } from "./lazy-signer.js";
export { executeQuery, queryBytes, queryJson } from "./query.js";
export { resolveQueryStrategy } from "./resolve-query.js";
export type { QueryStrategy } from "./resolve-query.js";
export { verifyStored } from "./verify.js";
export type { ChainStoredEntry, VerifyStoredOptions } from "./verify.js";
export {
    cidToPreimageKey,
    hashToCid,
    HashAlgorithm,
    CidCodec,
} from "./cid.js";

// Errors — abstracted CloudStorage* family plus the upstream `BulletinError` /
// `ErrorCode` re-exports for callers that need to catch upstream failures
// specifically.
export {
    BulletinError,
    ErrorCode,
    ProductCloudStorageError,
    CloudStorageAuthorizationError,
    CloudStorageCidError,
    CloudStorageHostUnavailableError,
    CloudStorageLookupInterruptedError,
    CloudStorageLookupTimeoutError,
} from "./errors.js";

// Types
export type {
    AuthorizationStatus,
    CloudStorageApi,
    Environment,
    QueryOptions,
} from "./types.js";

// Re-exports from upstream `@parity/bulletin-sdk` — surfaced for power users
// + so consumers don't need a separate `@parity/bulletin-sdk` import.
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
