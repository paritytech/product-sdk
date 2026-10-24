// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { Clock, IdSource, Logger } from "../ports.js";
import type { Compactor } from "../transport/session.js";
import type { CompactedBatch } from "../transport/sessionState.js";
import { encodeChatMessage } from "../wire/chatMessage.js";
import { CompactionBatchCodec, HOP_INLINE_MAX_BYTES } from "../wire/hop.js";
import type { HopPort } from "./ports.js";

/** Attempts of one compaction, shared by its batches, and the pause between them (A.14). */
const COMPACTION_ATTEMPTS = 3;
const COMPACTION_RETRY_MS = 2_000;

/** Splits encoded messages into batches whose `SCALE(Vec<Vec<u8>>)` stays within the inline entry limit. */
export function compactionBatches(messages: Uint8Array[]): Uint8Array[][] {
    const batches: Uint8Array[][] = [];
    let current: Uint8Array[] = [];
    for (const message of messages) {
        const candidate = [...current, message];
        if (
            current.length > 0 &&
            CompactionBatchCodec.enc(candidate).length > HOP_INLINE_MAX_BYTES
        ) {
            batches.push(current);
            current = [message];
        } else {
            current = candidate;
        }
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

/**
 * Moves messages too large for the statement store into HOP entries, each
 * replaced on the session by a `CompactionCommit` naming its entry (A.14).
 */
export class HopCompactor implements Compactor {
    constructor(
        private readonly hop: HopPort,
        private readonly clock: Clock,
        private readonly ids: IdSource,
        private readonly logger: Logger,
    ) {}

    async compact(messages: Uint8Array[]): Promise<CompactedBatch[]> {
        const batches = compactionBatches(messages);
        const compacted: CompactedBatch[] = [];
        let attempts = COMPACTION_ATTEMPTS;
        for (const originals of batches) {
            for (;;) {
                try {
                    const reference = await this.hop.uploadBlob(
                        CompactionBatchCodec.enc(originals),
                    );
                    const commit = encodeChatMessage({
                        id: this.ids.next(),
                        timestamp: BigInt(this.clock.nowMs()),
                        content: {
                            tag: "CompactionCommit",
                            value: {
                                claimIdentifier: reference.identifier,
                                claimTicket: reference.ticket,
                                node: { tag: "WssUrl", value: reference.node },
                            },
                        },
                    });
                    compacted.push({ commit, originals });
                    break;
                } catch (error) {
                    attempts -= 1;
                    this.logger.warn(
                        `compaction upload failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    if (attempts <= 0) throw error;
                    await this.clock.sleep(COMPACTION_RETRY_MS);
                }
            }
        }
        return compacted;
    }
}
