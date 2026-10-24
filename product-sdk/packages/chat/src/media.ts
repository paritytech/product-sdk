// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Media items of messages.
 *
 * Resources never travel as a URL, so the host never fetches from an address a
 * product chose. A media item names a file in the HOP pool of the
 * person-to-person chat, which the host claims through the core, and the core
 * opens and uploads HOP files for the person chat product only: on any other
 * product these items are refused (`hop_attachments`). The ticket opens the file,
 * so a product sends a resource only through its own encrypted channel.
 *
 * @module
 */
import type {
    ChatMediaItem,
    ChatMediaMeta,
    ChatResource,
    HexString,
} from "@parity/product-sdk-host";

/** A file in the HOP pool, as a message names it. */
export interface HopFile {
    /** The 32-byte identifier of the file's root entry. */
    identifier: HexString;
    /** The 32-byte ticket that claims and opens it. */
    ticket: HexString;
    /** The `wss://` node that holds it. */
    node: string;
    /** The size the sender states. */
    size: bigint;
}

/** The resource of a HOP file. */
export function hopResource(file: HopFile): ChatResource {
    return { tag: "Hop", value: file };
}

/** The HOP file of a media item, or `undefined` for any other resource. */
export function hopFileOf(item: ChatMediaItem): HopFile | undefined {
    const resource = item.value.resource;
    return resource.tag === "Hop" ? resource.value : undefined;
}

/** An image, drawn in the message at its stated size with the placeholder until its bytes arrive. */
export function image(resource: ChatResource, meta: ChatMediaMeta): ChatMediaItem {
    return { tag: "Image", value: { resource, meta } };
}

/** A video, played in the host's player; `meta.placeholder` is its poster. */
export function video(resource: ChatResource, meta: ChatMediaMeta): ChatMediaItem {
    return { tag: "Video", value: { resource, meta } };
}

/** A file, opened through the host's share sheet and saved under `fileName`. */
export function file(resource: ChatResource, meta: ChatMediaMeta, fileName: string): ChatMediaItem {
    return { tag: "File", value: { resource, meta, fileName } };
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("a HOP file round-trips through a media item", () => {
        const hop: HopFile = {
            identifier: `0x${"01".repeat(32)}`,
            ticket: `0x${"02".repeat(32)}`,
            node: "wss://n",
            size: 3n,
        };
        const item = image(hopResource(hop), {
            mimeType: "image/png",
            width: 2,
            height: 1,
            placeholder: "LEHV6n",
        });
        expect(hopFileOf(item)).toEqual(hop);
        expect(file(hopResource(hop), { mimeType: "application/pdf" }, "a.pdf").tag).toBe("File");
    });
}
