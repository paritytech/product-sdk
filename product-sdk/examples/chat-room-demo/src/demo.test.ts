// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { MemoryRoomMessageStore, serveRoomsOn, text } from "@parity/product-sdk-chat";
import { createChatTestbed, settle } from "@parity/product-sdk-chat/testing";
import { describe, expect, test } from "vitest";

import { startDemo } from "./demo.js";

async function runDemo() {
    const testbed = createChatTestbed();
    const pushed: string[] = [];
    let started: Awaited<ReturnType<typeof startDemo>> | undefined;
    serveRoomsOn(testbed.client, () => started);
    started = await startDemo({
        client: testbed.client,
        store: new MemoryRoomMessageStore(),
        clock: testbed.clock,
        notifications: {
            pushRoom: async (roomId, notice) => {
                pushed.push(`${roomId}: ${notice}`);
                return pushed.length;
            },
        },
    });
    const flush = async () => {
        for (let round = 0; round < 12; round++) {
            await settle();
            await testbed.clock.advance(100);
        }
        await started?.stop?.();
    };
    return { ...testbed, pushed, flush };
}

describe("the chat room demo", () => {
    test("the echo room opens with its welcome, and its notification went out", async () => {
        const { host, pushed, flush } = await runDemo();
        await flush();
        expect(host.room("echo").config?.productSource).toBe(true);
        const opened = await host.openRoom("echo");
        expect(opened.ok && opened.value.messages.map((message) => message.body)).toEqual([
            text("Hello! Write something."),
        ]);
        expect(pushed).toEqual(["echo: Hello! Write something."]);
    });

    test("a message gets a streamed reply: Preparing, edits, then Sent", async () => {
        const { host, flush } = await runDemo();
        const sent = await host.userSends("echo", text("hi there"));
        expect(sent.ok && sent.value.tag).toBe("MessageCreated");
        await flush();
        const tags = host.room("echo").feed.map((update) => update.tag);
        expect(tags[0]).toBe("New");
        expect(tags).toContain("Edited");
        expect(tags.at(-1)).toBe("StatusChanged");
        const opened = await host.openRoom("echo");
        const reply = opened.ok ? opened.value.messages.at(-1) : undefined;
        expect(reply?.body).toEqual(text("You said: hi there"));
        expect(reply?.status).toBe("Sent");
    });

    test("an opened link creates its room and shows it", async () => {
        const { host, flush } = await runDemo();
        expect(await host.openLink("echo", "demo:room:Book Club")).toEqual({ ok: true, value: { roomId: "room-bookclub" } });
        expect(await host.openLink("echo", "something else")).toEqual({ ok: true, value: {} });
        await flush();
        expect(host.room("room-bookclub").metadata?.name).toBe("Book Club");
    });

    test("the announcements room is a host-store room without input", async () => {
        const { host } = await runDemo();
        expect(host.room("announcements").config).toBeUndefined();
        expect(host.room("announcements").footer).toBe("Empty");
        expect(host.room("announcements").posted).toHaveLength(1);
    });
});
