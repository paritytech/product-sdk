// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { Enum, Struct, u64, Vector } from "scale-ts";

import { VecU8 } from "./scale.js";

/** HOP pool entry envelope (Appendix A.14). Chunk entries are raw bytes, not enveloped. */
export const HopPoolEntryCodec = Enum(
    {
        V1: Enum(
            {
                Inline: VecU8,
                Chunked: Struct({ totalSize: u64, chunks: Vector(VecU8) }),
            },
            [0, 1],
        ),
    },
    [0],
);

/** Decoded HOP pool entry. */
export type HopPoolEntry = ReturnType<typeof HopPoolEntryCodec.dec>;

/** A compaction batch: encoded chat messages. */
export const CompactionBatchCodec = Vector(VecU8);

/** Largest inline entry plaintext. */
export const HOP_INLINE_MAX_BYTES = 1_999_936;

/** Raw chunk size of a chunked entry. */
export const HOP_CHUNK_BYTES = 2_000_000;
