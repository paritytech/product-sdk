// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { blake2bHash } from "@parity/product-sdk-crypto/hashing";

import { bytesEqual, concat, utf8 } from "../bytes.js";
import type { AccountNamesEntry, DirectoryPort } from "./ports.js";

/** Key type byte of an X25519 chat key in the 65-byte on-chain container. */
export const CHAT_KEY_TYPE_X25519 = 0;

/** The X25519 key of a 65-byte chat key container, or undefined for another key type or length. */
export function chatKeyFromContainer(container: Uint8Array): Uint8Array | undefined {
    if (container.length !== 65 || container[0] !== CHAT_KEY_TYPE_X25519) return undefined;
    return container.slice(1, 33);
}

/** A 65-byte container for an X25519 chat key: type 0, key, 32 reserved zero bytes. */
export function chatKeyContainer(chatKey: Uint8Array): Uint8Array {
    return concat(new Uint8Array([CHAT_KEY_TYPE_X25519]), chatKey, new Uint8Array(32));
}

/** A peer as the chain knows it. */
export interface ResolvedPeer {
    accountId: Uint8Array;
    username: string | undefined;
    chatKey: Uint8Array;
}

/** Picks the chat key and username of an `AccountNames` entry: the full record first, then the lite one (D13). */
export function peerFromAccountNames(
    accountId: Uint8Array,
    entry: AccountNamesEntry,
): ResolvedPeer | undefined {
    if (!entry.lite) return undefined;
    const container = entry.full?.chat ?? entry.lite.chat;
    const chatKey = container ? chatKeyFromContainer(container) : undefined;
    if (!chatKey) return undefined;
    return { accountId, username: entry.full?.label ?? entry.lite.label, chatKey };
}

/** Resolves a peer's chat key and username from Asset Hub. */
export async function resolvePeer(
    directory: DirectoryPort,
    accountId: Uint8Array,
): Promise<ResolvedPeer | undefined> {
    const entry = await directory.accountNames(accountId);
    return entry ? peerFromAccountNames(accountId, entry) : undefined;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(text: string): Uint8Array {
    let value = 0n;
    for (const character of text) {
        const digit = BASE58_ALPHABET.indexOf(character);
        if (digit < 0) throw new Error("invalid base58");
        value = value * 58n + BigInt(digit);
    }
    const bytes: number[] = [];
    while (value > 0n) {
        bytes.unshift(Number(value % 256n));
        value /= 256n;
    }
    for (const character of text) {
        if (character !== "1") break;
        bytes.unshift(0);
    }
    return Uint8Array.from(bytes);
}

/** Account id of an SS58 address with a 32-byte payload, or undefined when the address is invalid. */
export function decodeSs58(address: string): Uint8Array | undefined {
    let bytes: Uint8Array;
    try {
        bytes = base58Decode(address.trim());
    } catch {
        return undefined;
    }
    const prefixLength = (bytes[0] ?? 0) & 0x40 ? 2 : 1;
    if (bytes.length !== prefixLength + 32 + 2) return undefined;
    const body = bytes.subarray(0, prefixLength + 32);
    const checksum = blake2bHash(concat(utf8("SS58PRE"), body), { length: 64 }).subarray(0, 2);
    if (!bytesEqual(checksum, bytes.subarray(prefixLength + 32))) return undefined;
    return bytes.slice(prefixLength, prefixLength + 32);
}
