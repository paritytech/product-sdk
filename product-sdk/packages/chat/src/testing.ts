// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Test helpers for chat products.
 *
 * {@link createChatTestbed} gives a test the host's side of the chat (a
 * `createFakeChatHost` double that applies the RFCs' rules and asks the product the
 * host's questions), a fake client over it, the product's {@link ChatRooms}, and a
 * manual clock that every part shares.
 *
 * @module
 */
import { type ChatRooms, type TruApi, createChatRooms } from "@parity/product-sdk-host";
import {
    type FakeChatHost,
    type FakeChatHostOptions,
    createFakeChatHost,
    createFakeTruApiClient,
} from "@parity/product-sdk-host/testing";
import { ManualClock } from "@parity/product-sdk-utils/testing";

export { createFakeChatHost } from "@parity/product-sdk-host/testing";
export type {
    ChatCapability,
    FakeCallMediaCall,
    FakeChatHost,
    FakeChatHostOptions,
    FakeChatRoom,
    FakeQueryOutcome,
} from "@parity/product-sdk-host/testing";
export { ManualClock, settle } from "@parity/product-sdk-utils/testing";

/** A product's rooms against a fake host, sharing one manual clock. */
export interface ChatTestbed {
    /** The host's side: declarations, feed, and the drivers that ask the product. */
    host: FakeChatHost;
    /** A client over `host`, for code that takes one. */
    client: TruApi;
    /** The product's rooms on `client`. */
    rooms: ChatRooms;
    clock: ManualClock;
}

/** A {@link ChatTestbed}. `startMs` starts the clock; the rest are the double's options. */
export function createChatTestbed(
    options: Omit<FakeChatHostOptions, "clock"> & { startMs?: number } = {},
): ChatTestbed {
    const { startMs, ...hostOptions } = options;
    const clock = new ManualClock(startMs);
    const host = createFakeChatHost({ ...hostOptions, clock });
    const client = createFakeTruApiClient({ chatHost: host });
    return { host, client, rooms: createChatRooms(client), clock };
}
