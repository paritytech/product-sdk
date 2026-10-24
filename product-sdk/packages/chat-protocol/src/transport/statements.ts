// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { toHex } from "../bytes.js";
import { sr25519Verify } from "../crypto/primitives.js";
import type {
    Clock,
    Logger,
    StatementFilter,
    StatementPage,
    StatementProver,
    StatementsPort,
    SubmitOutcome,
    Unsubscribe,
} from "../ports.js";
import { type Statement, statementProofPayload } from "../wire/statement.js";

/** Submit attempts on a retriable rejection (`noAllowance`, `storeFull`), as the native apps make. */
export const SUBMIT_ATTEMPTS = 10;

/** Delay between submit attempts. */
export const SUBMIT_RETRY_DELAY_MS = 2_000;

/** Most topics in one `matchAny` subscription. */
export const MAX_MATCH_ANY_TOPICS = 128;

/** Signs `statement` with `prover` and submits it, retrying retriable rejections. */
export async function proveAndSubmit(
    statements: StatementsPort,
    prover: StatementProver,
    statement: Statement,
    clock: Clock,
): Promise<SubmitOutcome> {
    const proof = await prover.prove(statement);
    const signed: Statement = { ...statement, proof };
    let outcome: SubmitOutcome = { kind: "Rejected", reason: "not submitted", retriable: false };
    for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt++) {
        outcome = await statements.submit(signed);
        if (outcome.kind === "Accepted" || !outcome.retriable) return outcome;
        if (attempt < SUBMIT_ATTEMPTS) await clock.sleep(SUBMIT_RETRY_DELAY_MS);
    }
    return outcome;
}

/** The sr25519 signer of a statement whose proof verifies, or undefined. */
export function verifiedSigner(statement: Statement): Uint8Array | undefined {
    const proof = statement.proof;
    if (proof?.tag !== "Sr25519") return undefined;
    const { signature, signer } = proof.value;
    return sr25519Verify(statementProofPayload(statement), signature, signer) ? signer : undefined;
}

/** Key identifying a statement for dedup without hashing it: signer, channel, expiry, first topic. */
export function statementKey(statement: Statement): string {
    const signer = statement.proof?.tag === "Sr25519" ? toHex(statement.proof.value.signer) : "-";
    const channel = statement.channel ? toHex(statement.channel) : "-";
    const topic = statement.topics[0] ? toHex(statement.topics[0]) : "-";
    return `${signer}:${channel}:${statement.expiry ?? "-"}:${topic}`;
}

/**
 * Reads every stored statement matching `filter`: subscribes until the first
 * complete page, then stops. Statements whose proof does not verify are dropped.
 */
export function fetchStatements(
    statements: StatementsPort,
    filter: StatementFilter,
    clock: Clock,
    timeoutMs = 30_000,
): Promise<Statement[]> {
    return new Promise((resolve, reject) => {
        const collected: Statement[] = [];
        let settled = false;
        // biome-ignore lint/style/useConst: finish() can run inside subscribe(), before the assignment; a const would throw there.
        let unsubscribe: Unsubscribe | undefined;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            unsubscribe?.();
            if (error) reject(error);
            else resolve(collected);
        };
        unsubscribe = statements.subscribe(
            filter,
            (page) => {
                for (const statement of page.statements) {
                    if (verifiedSigner(statement)) collected.push(statement);
                }
                if (page.isComplete) finish();
            },
            (reason) => finish(new Error(`statement fetch ended: ${reason}`)),
        );
        if (settled) unsubscribe();
        clock.sleep(timeoutMs).then(() => finish(new Error("statement fetch timed out")));
    });
}

/** A statement delivered to a topic listener, with its verified signer. */
export interface VerifiedStatement {
    statement: Statement;
    signer: Uint8Array;
}

/** Receives each statement of a listened topic, with its verified signer. */
export type TopicListener = (statement: VerifiedStatement) => void;

/**
 * Multiplexes topic listeners into few `matchAny` subscriptions, as hosts cap
 * how many requests a worker keeps open. Verifies proofs, drops duplicates,
 * and resubscribes when a stream ends.
 */
export class TopicSubscriptions {
    private readonly listeners = new Map<
        string,
        { topic: Uint8Array; listeners: Set<TopicListener> }
    >();
    private onTopicsChanged: (() => void) | undefined;
    private readonly seen = new Set<string>();
    private active: Unsubscribe[] = [];
    private refreshScheduled = false;
    private closed = false;

    constructor(
        private readonly statements: StatementsPort,
        private readonly clock: Clock,
        private readonly logger: Logger,
        private readonly resubscribeDelayMs = 1_000,
    ) {}

    /** Listens to statements on `topic`. Returns a handle that stops listening. */
    listen(topic: Uint8Array, listener: TopicListener): Unsubscribe {
        const key = toHex(topic);
        let entry = this.listeners.get(key);
        if (!entry) {
            entry = { topic, listeners: new Set() };
            this.listeners.set(key, entry);
            this.scheduleRefresh();
        }
        entry.listeners.add(listener);
        return () => {
            const current = this.listeners.get(key);
            if (!current) return;
            current.listeners.delete(listener);
            if (current.listeners.size === 0) {
                this.listeners.delete(key);
                this.scheduleRefresh();
            }
        };
    }

    /** Calls `callback` after the set of topics changes. */
    watch(callback: () => void): void {
        this.onTopicsChanged = callback;
    }

    /** Stops every subscription. */
    close(): void {
        this.closed = true;
        for (const stop of this.active) stop();
        this.active = [];
    }

    private scheduleRefresh(): void {
        if (this.refreshScheduled || this.closed) return;
        this.refreshScheduled = true;
        queueMicrotask(() => {
            this.refreshScheduled = false;
            this.refresh();
        });
    }

    private refresh(): void {
        for (const stop of this.active) stop();
        this.active = [];
        if (this.closed) return;
        this.onTopicsChanged?.();
        const topics = [...this.listeners.values()].map((entry) => entry.topic);
        for (let offset = 0; offset < topics.length; offset += MAX_MATCH_ANY_TOPICS) {
            const chunk = topics.slice(offset, offset + MAX_MATCH_ANY_TOPICS);
            let ended = false;
            const stop = this.statements.subscribe(
                { matchAny: chunk },
                (page) => this.deliver(page),
                (reason) => {
                    if (ended || this.closed) return;
                    ended = true;
                    this.logger.warn(`statement subscription ended (${reason}); resubscribing`);
                    this.clock.sleep(this.resubscribeDelayMs).then(() => this.scheduleRefresh());
                },
            );
            this.active.push(() => {
                ended = true;
                stop();
            });
        }
    }

    private deliver(page: StatementPage): void {
        for (const statement of page.statements) {
            const key = statementKey(statement);
            if (this.seen.has(key)) continue;
            const signer = verifiedSigner(statement);
            if (!signer) {
                this.logger.warn("dropped a statement whose proof does not verify");
                continue;
            }
            this.seen.add(key);
            for (const topic of statement.topics) {
                const entry = this.listeners.get(toHex(topic));
                if (!entry) continue;
                for (const listener of entry.listeners) {
                    try {
                        listener({ statement, signer });
                    } catch (error) {
                        this.logger.warn(
                            `statement listener failed: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }
                }
            }
        }
    }
}
