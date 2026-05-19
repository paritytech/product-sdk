import type { MerchantPaymentRecordStore } from "./types.js";

export class MemoryMerchantPaymentRecordStore implements MerchantPaymentRecordStore {
    private readonly records = new Map<string, unknown>();

    async get<T>(key: string): Promise<T | undefined> {
        return structuredClone(this.records.get(key)) as T | undefined;
    }

    async set<T>(key: string, value: T): Promise<void> {
        this.records.set(key, structuredClone(value));
    }

    async remove(key: string): Promise<void> {
        this.records.delete(key);
    }
}
