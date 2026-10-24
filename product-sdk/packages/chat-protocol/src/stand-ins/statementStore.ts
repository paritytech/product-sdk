// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    bytesEqual,
    encodeStatement,
    type Statement,
    type StatementFilter,
    type StatementPage,
    type StatementsPort,
    type SubmitOutcome,
    toHex,
    type Unsubscribe,
    verifiedSigner,
} from "../index.js";

/** Admission limits of the stand-in store, modelled on the People-chain statement store. */
export interface StandInStoreOptions {
    /** Largest encoded statement. */
    maxStatementBytes?: number;
    /** Most statements one signer may hold; undefined means unlimited. */
    statementsPerSigner?: number;
    /** Page size of the backlog delivered to a new subscription. */
    backlogPageSize?: number;
}

interface Subscriber {
    filter: StatementFilter;
    onPage: (page: StatementPage) => void;
    onEnd: (reason: string) => void;
    active: boolean;
}

/** Faults a test can switch on. */
export interface StoreFaults {
    /** Probability (0..1) that a live delivery to a subscriber is dropped. */
    dropLive: number;
    /** Probability (0..1) that a live delivery is delivered twice. */
    duplicateLive: number;
}

/**
 * Statement store double shared by every client in a test. It applies the
 * admission rules the native protocol depends on: one statement per (signer,
 * channel), replacement only with a strictly higher expiry, per-signer quotas,
 * size limits and proof verification.
 */
export class StandInStatementStore {
    private readonly stored = new Map<string, Statement>();
    private readonly subscribers = new Set<Subscriber>();
    private readonly options: Required<StandInStoreOptions>;
    readonly faults: StoreFaults = { dropLive: 0, duplicateLive: 0 };
    private random: () => number = Math.random;
    submitted = 0;

    constructor(options: StandInStoreOptions = {}) {
        this.options = {
            maxStatementBytes: options.maxStatementBytes ?? 512 * 1024,
            statementsPerSigner: options.statementsPerSigner ?? Number.POSITIVE_INFINITY,
            backlogPageSize: options.backlogPageSize ?? 16,
        };
    }

    /** Makes faults deterministic. */
    seedRandom(random: () => number): void {
        this.random = random;
    }

    /** A client view of the store. */
    client(): StatementsPort {
        return {
            submit: (statement) => Promise.resolve(this.submit(statement)),
            subscribe: (filter, onPage, onEnd) => this.subscribe(filter, onPage, onEnd),
        };
    }

    /** Every stored statement. */
    all(): Statement[] {
        return [...this.stored.values()];
    }

    /**
     * Keeps `statement` beside whatever replaced it, as the network keeps a statement that another account (an
     * anonymous delivery account, say) wrote on the same topic.
     */
    keep(statement: Statement): void {
        this.stored.set(`kept:${toHex(encodeStatement(statement))}`, statement);
    }

    /** Ends every live subscription, as a host connection reset does. */
    endAllSubscriptions(reason = "connection reset"): void {
        for (const subscriber of [...this.subscribers]) {
            subscriber.active = false;
            this.subscribers.delete(subscriber);
            subscriber.onEnd(reason);
        }
    }

    private submit(statement: Statement): SubmitOutcome {
        this.submitted++;
        const signer = verifiedSigner(statement);
        if (!signer) return { kind: "Rejected", reason: "badProof", retriable: false };
        if (encodeStatement(statement).length > this.options.maxStatementBytes) {
            return { kind: "Rejected", reason: "dataTooLarge", retriable: false };
        }
        const key = statement.channel
            ? `${toHex(signer)}:c:${toHex(statement.channel)}`
            : `${toHex(signer)}:n:${toHex(encodeStatement(statement))}`;
        const existing = this.stored.get(key);
        if (existing) {
            if (bytesEqual(encodeStatement(existing), encodeStatement(statement)))
                return { kind: "Accepted" };
            if ((existing.expiry ?? 0n) >= (statement.expiry ?? 0n)) {
                return { kind: "Rejected", reason: "channelPriorityTooLow", retriable: false };
            }
        } else {
            const held = [...this.stored.keys()].filter((storedKey) =>
                storedKey.startsWith(`${toHex(signer)}:`),
            ).length;
            if (held >= this.options.statementsPerSigner) {
                return { kind: "Rejected", reason: "accountFull", retriable: false };
            }
        }
        this.stored.set(key, statement);
        for (const subscriber of this.subscribers) {
            if (!matches(subscriber.filter, statement)) continue;
            if (this.random() < this.faults.dropLive) continue;
            const copies = this.random() < this.faults.duplicateLive ? 2 : 1;
            for (let copy = 0; copy < copies; copy++) {
                queueMicrotask(() => {
                    if (subscriber.active)
                        subscriber.onPage({ statements: [statement], isComplete: true });
                });
            }
        }
        return { kind: "Accepted" };
    }

    private subscribe(
        filter: StatementFilter,
        onPage: (page: StatementPage) => void,
        onEnd: (reason: string) => void,
    ): Unsubscribe {
        const topicCount = "matchAll" in filter ? filter.matchAll.length : filter.matchAny.length;
        const limit = "matchAll" in filter ? 4 : 128;
        const subscriber: Subscriber = { filter, onPage, onEnd, active: true };
        if (topicCount > limit) {
            queueMicrotask(() => onEnd(`too many topics: ${topicCount} > ${limit}`));
            return () => {};
        }
        this.subscribers.add(subscriber);
        const backlog = this.all().filter((statement) => matches(filter, statement));
        queueMicrotask(() => {
            if (!subscriber.active) return;
            const size = this.options.backlogPageSize;
            if (backlog.length === 0) {
                subscriber.onPage({ statements: [], isComplete: true });
                return;
            }
            for (let offset = 0; offset < backlog.length; offset += size) {
                if (!subscriber.active) return;
                subscriber.onPage({
                    statements: backlog.slice(offset, offset + size),
                    isComplete: offset + size >= backlog.length,
                });
            }
        });
        return () => {
            subscriber.active = false;
            this.subscribers.delete(subscriber);
        };
    }
}

function matches(filter: StatementFilter, statement: Statement): boolean {
    const has = (topic: Uint8Array) =>
        statement.topics.some((candidate) => bytesEqual(candidate, topic));
    return "matchAll" in filter ? filter.matchAll.every(has) : filter.matchAny.some(has);
}
