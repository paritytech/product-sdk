/** Subset of product-sdk's hostLocalStorage that the KV store uses. */
export interface HostLocalStorage {
    readString(key: string): Promise<string | null>;
    writeString(key: string, value: string): Promise<void>;
    readJSON<T>(key: string): Promise<T | null>;
    writeJSON<T>(key: string, value: T): Promise<void>;
    /**
     * Clear a specific key from storage.
     * @param key - The key to clear
     */
    clear(key: string): Promise<void>;
}

/** Proof types returned from createProof (matches product-sdk SCALE-decoded types). */
export type StatementProof =
    | { tag: "Sr25519"; value: { signature: Uint8Array; signer: Uint8Array } }
    | { tag: "Ed25519"; value: { signature: Uint8Array; signer: Uint8Array } }
    | { tag: "Secp256k1Ecdsa"; value: { signature: Uint8Array; signer: Uint8Array } }
    | { tag: "EcdsaRecoverable"; value: { signature: Uint8Array } };

/** The statement store interface provided by the host API via product-sdk. */
export interface HostStatementStore {
    /**
     * Subscribe to statements matching the given topics.
     * @param topics - Topic filters as Uint8Array[]
     * @param callback - Called with batches of SignedStatement[]
     * @returns Subscription object with unsubscribe method
     */
    subscribe(
        topics: Uint8Array[],
        callback: (statements: unknown[]) => void,
    ): { unsubscribe: () => void };

    /**
     * Create a proof for a statement using the given account.
     * @param accountId - The account ID tuple [ss58Address, chainPrefix] from product-sdk
     * @param statement - The unsigned statement
     * @returns The proof (signature + signer info)
     */
    createProof(accountId: [string, number], statement: unknown): Promise<StatementProof>;

    /**
     * Submit a signed statement to the bulletin chain.
     * @param signedStatement - Statement with attached proof
     */
    submit(signedStatement: unknown): Promise<void>;
}
