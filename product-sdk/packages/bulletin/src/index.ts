/**
 * @parity/product-sdk-bulletin — Upload and retrieve content on the Polkadot Bulletin Chain.
 *
 * `BulletinClient` covers the common case end-to-end: it picks an upload strategy
 * (host preimage API or signer-driven `TransactionStorage.store`), computes the
 * CID locally, submits, and returns the CID alongside a Bulletin gateway URL for
 * later retrieval. `checkAuthorization` is exposed separately as a pre-flight
 * helper, and the lower-level CID, gateway, and upload/query primitives are
 * available for consumers that need to compose those steps themselves.
 *
 * @packageDocumentation
 */
export { BulletinClient } from "./client.js";
export { checkAuthorization } from "./authorization.js";
export {
    computeCid,
    cidToPreimageKey,
    hashToCid,
    HashAlgorithm,
    CidCodec,
} from "./cid.js";
export {
    BulletinError,
    BulletinHostUnavailableError,
    BulletinLookupTimeoutError,
    BulletinLookupInterruptedError,
    BulletinAuthorizationError,
    BulletinGatewayUnavailableError,
    BulletinGatewayFetchError,
    BulletinCidError,
} from "./errors.js";
export { getGateway, gatewayUrl, cidExists, fetchBytes, fetchJson } from "./gateway.js";
export { resolveQueryStrategy } from "./resolve-query.js";
export { queryBytes, queryJson } from "./query.js";
export { resolveUploadStrategy } from "./resolve-signer.js";
export { upload, batchUpload } from "./upload.js";
export type {
    AuthorizationStatus,
    BulletinApi,
    Environment,
    UploadOptions,
    UploadResult,
    BatchUploadItem,
    BatchUploadResult,
    BatchUploadOptions,
    FetchOptions,
    QueryOptions,
} from "./types.js";
export type { UploadStrategy } from "./resolve-signer.js";
export type { QueryStrategy } from "./resolve-query.js";
