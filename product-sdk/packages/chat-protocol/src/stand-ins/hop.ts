// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    blake2b256,
    type HopDownload,
    HopPoolEntryCodec,
    type HopPort,
    type HopReference,
    hopTicketKeys,
    open,
    randomBytes,
    seal,
    toHex,
} from "../index.js";

/**
 * A HOP pool in memory, sealing entries as the native apps do (A.14): a
 * random ticket per entry, `seal(B(ticket, "encryption"), envelope)`,
 * identifier `B(entry)`. `failures` makes the next downloads fail.
 */
export class StandInHop implements HopPort {
    readonly entries = new Map<string, Uint8Array>();
    readonly acked: string[] = [];
    failures = 0;

    constructor(readonly node = "wss://hop.stand-in/node") {}

    async uploadBlob(data: Uint8Array): Promise<HopReference> {
        const ticket = randomBytes(32);
        const entry = seal(
            hopTicketKeys(ticket).encryptionKey,
            HopPoolEntryCodec.enc({ tag: "V1", value: { tag: "Inline", value: data } }),
        );
        const identifier = blake2b256(entry);
        this.entries.set(toHex(identifier), entry);
        return { identifier, ticket, node: this.node };
    }

    async downloadBlob(reference: HopReference): Promise<HopDownload> {
        if (this.failures > 0) {
            this.failures -= 1;
            throw new Error("node unreachable");
        }
        const entry = this.entries.get(toHex(reference.identifier));
        if (!entry || reference.node !== this.node) throw new Error("not found");
        const decoded = HopPoolEntryCodec.dec(
            open(hopTicketKeys(reference.ticket).encryptionKey, entry),
        );
        if (decoded.value.tag !== "Inline") throw new Error("chunked entries are not served here");
        return { data: decoded.value.value, entries: [reference.identifier] };
    }

    async ack(_reference: HopReference, entries: Uint8Array[]): Promise<void> {
        for (const entry of entries) {
            this.entries.delete(toHex(entry));
            this.acked.push(toHex(entry));
        }
    }
}
