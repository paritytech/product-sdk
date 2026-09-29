// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The product's single `onRender` slot, shared between the surfaces that draw
 * through it.
 *
 * A client has one slot, and registering again replaces whatever was there. But
 * the renderer serves three kinds of body: a Pocket card face, a chat message,
 * and an input widget. A product may well want more than one of them, so the
 * slot is owned here and dispatched by context, and each surface claims only
 * the contexts it draws. Claiming one leaves the others free.
 *
 * The slot itself is never given back. Releasing it makes the transport buffer
 * incoming render requests and replay them at whoever registers next, which
 * would draw a body that left the screen long ago. Claims are released one at a
 * time instead, and a context nothing claims is refused rather than left to
 * hang on the device.
 *
 * @module
 */
import type {
    CallErrorValue,
    ProductRendererRenderRequest,
    RenderContext,
    RendererNode,
    TrUApiClient,
    VersionedProductRendererRenderError,
} from "@parity/truapi";

import { getClient } from "./transport.js";

/** Which kind of body the host is asking for. */
export type RenderContextTag = RenderContext["tag"];

/**
 * What a render handler returns: what to run when the body leaves the screen.
 *
 * `undefined` in place of `void` would reject the ordinary `(request, send) =>
 * send(body)`, whose inferred return is `void`.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: a handler body that just draws returns void
export type RenderCleanup = (() => void) | void;

/** The reason carried on the interrupt channel when a body cannot be drawn. */
export type RenderFailure = CallErrorValue<VersionedProductRendererRenderError>;

/** Draws one kind of body. */
export type RenderHandler = (
    request: ProductRendererRenderRequest,
    send: (body: RendererNode) => void,
    interrupt: (reason?: RenderFailure) => void,
) => RenderCleanup;

/** Handle for one claimed context. */
export interface RenderRegistration {
    unsubscribe(): void;
}

/** Build the reason, so a refusal reaches the host instead of dying here. */
export function renderFailure(reason: string): RenderFailure {
    return { tag: "Domain", value: { tag: "V1", value: { reason } } };
}

/** What one client's render surfaces share. */
interface RenderSlot {
    readonly handlers: Map<RenderContextTag, RenderHandler>;
    claimed: boolean;
}

// Keyed by client rather than per caller, because the slot is per client.
// A WeakMap so a discarded client takes its slot with it.
const slots = new WeakMap<TrUApiClient, RenderSlot>();

function slotFor(client: TrUApiClient): RenderSlot {
    const existing = slots.get(client);
    if (existing !== undefined) return existing;

    const created: RenderSlot = { handlers: new Map(), claimed: false };
    slots.set(client, created);
    return created;
}

/**
 * Claim one render context on this client.
 *
 * Claiming a second context leaves the first alone. Claiming one that is
 * already claimed replaces its handler, which is what the raw slot would do.
 */
export function registerRenderContext(
    client: TrUApiClient,
    tag: RenderContextTag,
    handler: RenderHandler,
): RenderRegistration {
    const slot = slotFor(client);
    slot.handlers.set(tag, handler);
    claimSlot(client, slot);

    return {
        unsubscribe() {
            // Only if it is still ours. A later claim on the same context owns it.
            if (slot.handlers.get(tag) === handler) slot.handlers.delete(tag);
        },
    };
}

function claimSlot(client: TrUApiClient, slot: RenderSlot): void {
    if (slot.claimed) return;
    slot.claimed = true;

    client.renderer.onRender((request, send, interrupt) => {
        const handler = slot.handlers.get(request.context.tag);
        if (handler === undefined) {
            interrupt(renderFailure(`this product draws no ${request.context.tag} body`));
            return;
        }
        return handler(request, send, interrupt);
    });
}

/** Renderer manager handle. */
export interface RendererManager {
    /**
     * Draw one kind of body. Returns a handle that gives the context back.
     *
     * Reach for a surface's own wrapper where there is one. `getPocketManager()`
     * claims `PocketCard` for you and routes it per card.
     */
    draw(tag: RenderContextTag, handler: RenderHandler): RenderRegistration;
}

/**
 * Get the renderer manager, for drawing a body the SDK has no wrapper for.
 * Returns `null` when running outside a host container.
 *
 * @example
 * ```ts
 * import { getRendererManager } from "@parity/product-sdk-host";
 *
 * const renderer = await getRendererManager();
 * renderer?.draw("ChatMessage", (request, send) => {
 *   send(body());
 * });
 * ```
 */
export async function getRendererManager(): Promise<RendererManager | null> {
    const client = await getClient();
    if (client === null) return null;
    return { draw: (tag, handler) => registerRenderContext(client, tag, handler) };
}

if (import.meta.vitest) {
    const { test, expect, afterEach } = import.meta.vitest;
    const { setTruApiClient } = await import("./transport.js");

    type Handler = (
        request: unknown,
        send: (body: unknown) => void,
        interrupt: (reason?: RenderFailure) => void,
    ) => RenderCleanup;

    /** A fake `renderer.onRender` a test can drive as the host would. */
    function host() {
        let handler: Handler | undefined;
        const declined: string[] = [];
        return {
            registrations: 0,
            client() {
                return {
                    renderer: {
                        onRender: (next: Handler) => {
                            this.registrations += 1;
                            handler = next;
                            return { unsubscribe() {} };
                        },
                    },
                } as unknown as TrUApiClient;
            },
            get declined() {
                return declined;
            },
            render(tag: string, sent: unknown[]) {
                return handler?.(
                    { context: { tag, value: { cardId: "loyalty" } }, payload: "0x" },
                    (body) => sent.push(body),
                    (reason) => declined.push(reasonText(reason)),
                );
            },
        };
    }

    /** The reason out of a nested domain error, without asserting its shape. */
    function reasonText(reason: unknown): string {
        const domain = reason as { value?: { value?: { reason?: string } } };
        return domain?.value?.value?.reason ?? "<no reason>";
    }

    const body = { tag: "Nil" } as RendererNode;

    afterEach(() => setTruApiClient(null));

    // The point of this module. Pocket claiming its context must not cost the
    // product the other two, which is what a single shared slot would do.
    test("claiming one context leaves the others free", () => {
        const fake = host();
        const client = fake.client();

        const cards: unknown[] = [];
        const chats: unknown[] = [];
        registerRenderContext(client, "PocketCard", (_request, send) => send(body));
        registerRenderContext(client, "ChatMessage", (_request, send) => send(body));

        fake.render("PocketCard", cards);
        fake.render("ChatMessage", chats);

        expect(fake.registrations).toBe(1);
        expect(cards).toEqual([body]);
        expect(chats).toEqual([body]);
        expect(fake.declined).toEqual([]);
    });

    test("a context nothing claims is refused with a reason", () => {
        const fake = host();
        const client = fake.client();
        registerRenderContext(client, "PocketCard", (_request, send) => send(body));

        fake.render("InputWidget", []);

        expect(fake.declined).toEqual(["this product draws no InputWidget body"]);
    });

    test("giving a context back leaves the others claimed", () => {
        const fake = host();
        const client = fake.client();
        const chats: unknown[] = [];

        const cards = registerRenderContext(client, "PocketCard", (_request, send) => send(body));
        registerRenderContext(client, "ChatMessage", (_request, send) => send(body));
        cards.unsubscribe();

        fake.render("PocketCard", []);
        fake.render("ChatMessage", chats);

        expect(fake.declined).toEqual(["this product draws no PocketCard body"]);
        expect(chats).toEqual([body]);
    });

    test("the cleanup a handler returns reaches the host", () => {
        const fake = host();
        const client = fake.client();
        let stopped = 0;

        registerRenderContext(client, "PocketCard", () => () => {
            stopped += 1;
        });

        const release = fake.render("PocketCard", []);
        expect(stopped).toBe(0);
        release?.();
        expect(stopped).toBe(1);
    });

    test("getRendererManager returns null outside a container", async () => {
        expect(await getRendererManager()).toBeNull();
    });
}
