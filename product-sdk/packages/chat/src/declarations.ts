// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Declaring rooms: creating them and telling the host what each one serves.
 *
 * The host persists every declaration (configuration, metadata, features,
 * footer, contact), keyed by product and room, until the product replaces it or
 * deletes the room, so the chat list draws the product's rooms without starting
 * its worker. A product cannot read back what the host holds, so it declares
 * each room once per run; {@link RoomDeclarations} then sends a part again only
 * when it changes.
 *
 * @module
 */
import {
    type ChatRoomConfig,
    type ChatRoomContact,
    type ChatRoomFeatures,
    type ChatRoomFooter,
    type ChatRoomMetadata,
    type ChatRoomRegistrationStatus,
    type ChatRooms,
    type HostError,
    type Result,
    ok,
} from "@parity/product-sdk-host";

/** Everything a product declares about one room. Parts left out are not sent. */
export interface RoomDeclaration {
    /** The name `create_room` gives a new room. */
    name: string;
    /** The icon `create_room` gives a new room. Default `""`. */
    icon?: string;
    /** Which parts of the room the product serves. Declared right after the room is created. */
    config?: ChatRoomConfig;
    /** The room's name and description. */
    metadata?: ChatRoomMetadata;
    /** Optional features: call buttons, HOP attachments. */
    features?: ChatRoomFeatures;
    /** What the room shows below its messages. */
    footer?: ChatRoomFooter;
    /** The person the room is a conversation with. Served to the person chat product only. */
    contact?: ChatRoomContact;
}

type Part = "config" | "contact" | "features" | "metadata" | "footer";

/** The order the parts are declared in: the configuration first, as the base RFC asks. */
const PARTS: Part[] = ["config", "contact", "features", "metadata", "footer"];

function keyOf(value: unknown): string {
    return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${item}n` : item));
}

/**
 * Creates the product's rooms and declares their parts, sending only what changed
 * since this run last declared the room.
 *
 * @example
 * ```ts
 * const declarations = new RoomDeclarations(rooms);
 * await declarations.declare("support", {
 *     name: "Support",
 *     config: { productSource: true, reactionDetails: true, reportSeen: true },
 *     metadata: { name: "Support", description: "Ask us anything" },
 * });
 * ```
 */
export class RoomDeclarations {
    private readonly declared = new Map<string, Map<Part, string>>();

    constructor(private readonly rooms: ChatRooms) {}

    /**
     * Creates the room if this run has not, then declares each given part that
     * changed. Stops at the first refusal and returns it; the parts declared before
     * it stand, and a later `declare` sends the rest.
     *
     * @returns Whether `create_room` made the room (`"New"`) or found it
     *   (`"Exists"`), on the first declaration of the room in this run; `"Exists"`
     *   afterwards.
     */
    async declare(
        roomId: string,
        declaration: RoomDeclaration,
    ): Promise<Result<ChatRoomRegistrationStatus, HostError>> {
        let status: ChatRoomRegistrationStatus = "Exists";
        let parts = this.declared.get(roomId);
        if (!parts) {
            const created = await this.rooms.createRoom({
                roomId,
                name: declaration.name,
                icon: declaration.icon ?? "",
            });
            if (!created.ok) return created;
            status = created.value;
            parts = new Map();
            this.declared.set(roomId, parts);
        }
        for (const part of PARTS) {
            const value = declaration[part];
            if (value === undefined) continue;
            const key = keyOf(value);
            if (parts.get(part) === key) continue;
            const sent = await this.send(roomId, part, declaration);
            if (!sent.ok) return sent;
            parts.set(part, key);
        }
        return ok(status);
    }

    /** Deletes the room and everything the host holds for it. Succeeds for a room that does not exist. */
    async forget(roomId: string): Promise<Result<void, HostError>> {
        this.declared.delete(roomId);
        return this.rooms.deleteRoom(roomId);
    }

    /** Whether this run declared the room. */
    has(roomId: string): boolean {
        return this.declared.has(roomId);
    }

    /** The rooms this run declared. */
    roomIds(): string[] {
        return [...this.declared.keys()];
    }

    private send(
        roomId: string,
        part: Part,
        declaration: RoomDeclaration,
    ): Promise<Result<void, HostError>> {
        switch (part) {
            case "config":
                return this.rooms.setConfig(roomId, declaration.config as ChatRoomConfig);
            case "contact":
                return this.rooms.setContact(roomId, declaration.contact as ChatRoomContact);
            case "features":
                return this.rooms.setFeatures(roomId, declaration.features as ChatRoomFeatures);
            case "metadata":
                return this.rooms.setMetadata(roomId, declaration.metadata as ChatRoomMetadata);
            case "footer":
                return this.rooms.setFooter(roomId, declaration.footer as ChatRoomFooter);
        }
    }
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { createChatRooms } = await import("@parity/product-sdk-host");
    const { createFakeChatHost, createFakeTruApiClient } = await import(
        "@parity/product-sdk-host/testing"
    );

    const config: ChatRoomConfig = {
        productSource: true,
        reactionDetails: false,
        reportSeen: true,
    };

    test("a room is created, configured first, and an unchanged part is not sent again", async () => {
        const host = createFakeChatHost();
        const rooms = createChatRooms(createFakeTruApiClient({ chatHost: host }));
        const declarations = new RoomDeclarations(rooms);
        expect(
            await declarations.declare("r", { name: "R", config, metadata: { name: "R" } }),
        ).toEqual(ok("New"));
        host.room("r").metadata = { name: "changed on the host" };
        expect(
            await declarations.declare("r", { name: "R", config, metadata: { name: "R" } }),
        ).toEqual(ok("Exists"));
        expect(host.room("r").metadata).toEqual({ name: "changed on the host" });
        await declarations.declare("r", { name: "R", metadata: { name: "Renamed" } });
        expect(host.room("r").metadata).toEqual({ name: "Renamed" });
        expect(host.room("r").config).toEqual(config);
    });

    test("a refused part stops the declaration and is sent again next time", async () => {
        const host = createFakeChatHost();
        const rooms = createChatRooms(createFakeTruApiClient({ chatHost: host }));
        const declarations = new RoomDeclarations(rooms);
        const contact: ChatRoomContact = { account: `0x${"11".repeat(32)}`, state: "Established" };
        const declared = await declarations.declare("r", {
            name: "R",
            config,
            contact,
            metadata: { name: "R" },
        });
        expect(declared.ok).toBe(false);
        expect(host.room("r").config).toEqual(config);
        expect(host.room("r").metadata).toBeUndefined();
    });

    test("forget deletes the room and the next declare creates it again", async () => {
        const host = createFakeChatHost();
        const rooms = createChatRooms(createFakeTruApiClient({ chatHost: host }));
        const declarations = new RoomDeclarations(rooms);
        await declarations.declare("r", { name: "R" });
        await declarations.forget("r");
        expect(host.rooms.has("r")).toBe(false);
        expect(await declarations.declare("r", { name: "R" })).toEqual(ok("New"));
    });
}
