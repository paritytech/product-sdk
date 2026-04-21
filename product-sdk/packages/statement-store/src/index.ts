// Client
export { StatementStoreClient } from "./client.js";
export { ChannelStore } from "./channels.js";

// Topics
export {
    createTopic,
    createChannel,
    serializeTopicFilter,
    topicToHex,
    topicsEqual,
} from "./topics.js";

// Data encoding (JSON <-> Uint8Array)
export { encodeData, decodeData, toHex, fromHex } from "./data.js";

// Transport (advanced use — for consumers that need custom transport implementations)
export { createTransport } from "./transport.js";

// Errors
export {
    StatementStoreError,
    StatementEncodingError,
    StatementSubmitError,
    StatementSubscriptionError,
    StatementConnectionError,
    StatementDataTooLargeError,
} from "./errors.js";

// Types — re-exported from @novasamatech/sdk-statement
export type {
    Statement,
    SignedStatement,
    UnsignedStatement,
    Proof,
    SubmitResult,
    SdkTopicFilter,
} from "./types.js";

// Types — package-specific
export type {
    TopicHash,
    ChannelHash,
    TopicFilter,
    ConnectionCredentials,
    StatementStoreConfig,
    PublishOptions,
    ReceivedStatement,
    StatementSigner,
    StatementSignerWithKey,
    StatementTransport,
    Unsubscribable,
} from "./types.js";

// Constants
export { MAX_STATEMENT_SIZE, MAX_USER_TOTAL, DEFAULT_TTL_SECONDS } from "./types.js";
