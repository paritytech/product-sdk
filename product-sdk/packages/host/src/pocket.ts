// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wrapper for the host's Pocket surface, backed by `truApi.pocket.*` and the
 * `PocketCard` context of `truApi.renderer.*`.
 *
 * A Pocket card is a face the product draws into the host's Pocket tab. The
 * product declares its cards in the worker manifest, and the host asks for a
 * face over `renderer.onRender` whenever one is on screen. `Pocket` itself only
 * lists cards and removes them, so drawing goes through the renderer.
 *
 * `getPocketManager()` returns a manager for drawing a card, reading the card
 * list, hearing about presses, and giving a card up.
 *
 * @module
 */
import type { HostRendererActionSubscribeItem, RendererNode, TrUApiClient } from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import { unwrapHostResult } from "./truapi.js";
import type { HostSubscription } from "./types.js";

/** One of the product's cards, as the host lists it. Re-exported from `@parity/truapi`. */
export type { PocketCard } from "@parity/truapi";
import type { PocketCard } from "@parity/truapi";

const log = createLogger("host:pocket");

/**
 * What a card's handler returns: what to run when the card leaves the screen.
 *
 * `undefined` in place of `void` would reject the ordinary `(send) => send(face)`,
 * whose inferred return is `void`. The protocol's own
 * `HostInitiatedSubscriptionHandler` is `(() => void) | void` for the same reason.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: a handler body that just draws returns void
export type CardCleanup = (() => void) | void;

/**
 * Called when the host puts a card on screen, with the sink to draw into.
 *
 * `send` may be called as often as the product likes for as long as the card is
 * there, which is the whole difference between a card and a picture. Return
 * what should run when it leaves, or a promise of it when deciding what to draw
 * takes a round trip.
 */
export type CardDrawHandler = (
    send: (face: RendererNode) => void,
) => CardCleanup | Promise<CardCleanup>;

/**
 * Handle for one card's registration.
 *
 * There is no `onInterrupt` here, unlike a subscription: `renderer.onRender` is
 * a registration rather than a stream, and the host has no channel to interrupt
 * it through.
 */
export interface CardDrawRegistration {
    unsubscribe(): void;
}

/**
 * A press or a value change inside one of the product's card faces.
 *
 * `renderer.actionSubscribe` is the only way back from a card: the face is a
 * one way stream, and this is what a `clickAction` or `valueChangeAction` named
 * in the tree comes back as.
 */
export type PocketCardAction = HostRendererActionSubscribeItem;

/** Pocket manager handle. */
export interface PocketManager {
    /**
     * Draw `cardId` whenever the host puts it on screen.
     *
     * One registration serves every card the product draws, so calling this
     * twice is safe and the two cards do not interfere.
     */
    drawCard(cardId: string, draw: CardDrawHandler): CardDrawRegistration;
    /** Every action inside `cardId`'s face, and nothing else. */
    subscribeCardAction(
        cardId: string,
        callback: (action: PocketCardAction) => void,
    ): HostSubscription;
    /** The product's cards, republished whenever the collection changes. */
    subscribeCards(callback: (cards: PocketCard[]) => void): HostSubscription;
    /**
     * Give a card up. Resolves when it is gone, and rejects when the host
     * refuses, which it does for a card it placed itself. Removing a card that
     * was never there succeeds.
     */
    removeCard(cardId: string): Promise<void>;
}

/** Build a {@link PocketManager} over a TruAPI client. */
function adaptPocketManager(client: TrUApiClient): PocketManager {
    const handlers = new Map<string, CardDrawHandler>();
    // One `onRender` slot exists per client, so the registration is shared and
    // opened on the first card rather than per card.
    let registration: { unsubscribe(): void } | null = null;

    function register(): void {
        if (registration !== null) return;
        registration = client.renderer.onRender((request, send, interrupt) => {
            // Another of this product's bodies, drawn through the same callback.
            // Not ours to answer, and not ours to interrupt.
            if (request.context.tag !== "PocketCard") return;

            const { cardId } = request.context.value;
            const draw = handlers.get(cardId);
            if (draw === undefined) {
                // One of this product's cards that nothing is drawing. Saying so
                // beats leaving the face blank with no explanation.
                interrupt();
                return;
            }
            return runDraw(cardId, draw, send, interrupt);
        });
    }

    return {
        drawCard(cardId, draw) {
            handlers.set(cardId, draw);
            register();
            return {
                unsubscribe() {
                    handlers.delete(cardId);
                    if (handlers.size > 0 || registration === null) return;
                    registration.unsubscribe();
                    registration = null;
                },
            };
        },
        subscribeCardAction(cardId, callback) {
            return subscribeWithInterrupt(client.renderer.actionSubscribe(), (action) => {
                if (action.context.tag !== "PocketCard") return;
                if (action.context.value.cardId !== cardId) return;
                callback(action);
            });
        },
        subscribeCards(callback) {
            return subscribeWithInterrupt(client.pocket.listSubscribe(), (item) =>
                callback(item.cards),
            );
        },
        async removeCard(cardId) {
            await unwrapHostResult(
                client.pocket.removeCard({ cardId }),
                "pocket removeCard failed",
            );
        },
    };
}

/**
 * Run one card's handler and give the host back its cleanup.
 *
 * Two things have to hold here. Nothing may escape: an unhandled throw or
 * rejection ends the shared registration, and every card the product has stays
 * blank for the rest of the worker's life with nothing on the device saying
 * why. And a cleanup that resolves after the card has already left has to run
 * at once, or whatever it was meant to stop keeps sending faces into a
 * subscription nobody is watching.
 */
function runDraw(
    cardId: string,
    draw: CardDrawHandler,
    send: (face: RendererNode) => void,
    interrupt: () => void,
): CardCleanup {
    let released = false;
    let cleanup: (() => void) | undefined;

    const settle = (outcome: CardCleanup): void => {
        if (released) {
            outcome?.();
            return;
        }
        cleanup = outcome ?? undefined;
    };

    const fail = (reason: unknown): void => {
        log.error(`card ${cardId} could not be drawn: ${String(reason)}`);
        interrupt();
    };

    try {
        const outcome = draw(send);
        if (isPromise(outcome)) outcome.then(settle, fail);
        else settle(outcome);
    } catch (reason) {
        fail(reason);
        return undefined;
    }

    return () => {
        released = true;
        cleanup?.();
    };
}

function isPromise(value: CardCleanup | Promise<CardCleanup>): value is Promise<CardCleanup> {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as Promise<CardCleanup>).then === "function"
    );
}

/**
 * Get the host Pocket manager. Returns `null` when running outside a host
 * container.
 *
 * @example
 * ```ts
 * import { getPocketManager } from "@parity/product-sdk-host";
 *
 * const pocket = await getPocketManager();
 * pocket?.subscribeCards((cards) => console.log(cards.map((card) => card.cardId)));
 * ```
 */
export async function getPocketManager(): Promise<PocketManager | null> {
    const client = await getClient();
    return client ? adaptPocketManager(client) : null;
}

if (import.meta.vitest) {
    const { test, expect, afterEach } = import.meta.vitest;
    const { setTruApiClient } = await import("./transport.js");

    type Observer = { next?: (item: unknown) => void; error?: (reason?: unknown) => void };

    /** A stream a test can push items into. */
    function stream() {
        const observers: Observer[] = [];
        return {
            observable: {
                subscribe(observer: Observer) {
                    observers.push(observer);
                    return { subscriptionId: "1", unsubscribe() {} };
                },
            },
            push(item: unknown) {
                for (const observer of observers) observer.next?.(item);
            },
        };
    }

    /** A `ResultAsync` shaped enough for `unwrapHostResult`. */
    function result<T>(outcome: { ok: T } | { err: unknown }) {
        return {
            match: async <A, B>(onOk: (value: T) => A, onErr: (error: unknown) => B) =>
                "ok" in outcome ? onOk(outcome.ok) : onErr(outcome.err),
        };
    }

    afterEach(() => setTruApiClient(null));

    test("getPocketManager returns null outside a container", async () => {
        expect(await getPocketManager()).toBeNull();
    });

    test("subscribeCards reports the card list the host publishes", async () => {
        const cards = stream();
        setTruApiClient({
            pocket: { listSubscribe: () => cards.observable },
        } as unknown as TrUApiClient);

        const seen: unknown[] = [];
        const pocket = await getPocketManager();
        pocket?.subscribeCards((list) => seen.push(list));
        cards.push({ cards: [{ cardId: "loyalty", privileged: false }] });

        expect(seen).toEqual([[{ cardId: "loyalty", privileged: false }]]);
    });

    test("removeCard resolves when the host lets the card go", async () => {
        const removed: string[] = [];
        setTruApiClient({
            pocket: {
                removeCard: ({ cardId }: { cardId: string }) => {
                    removed.push(cardId);
                    return result({ ok: undefined });
                },
            },
        } as unknown as TrUApiClient);

        const pocket = await getPocketManager();
        await expect(pocket?.removeCard("loyalty")).resolves.toBeUndefined();
        expect(removed).toEqual(["loyalty"]);
    });

    // A privileged card is one the host placed itself. The product asking for it
    // back is refused, and a caller that ignored the refusal would believe the
    // card was gone.
    test("removeCard rejects when the host refuses a privileged card", async () => {
        setTruApiClient({
            pocket: { removeCard: () => result({ err: { tag: "Privileged" } }) },
        } as unknown as TrUApiClient);

        const pocket = await getPocketManager();
        await expect(pocket?.removeCard("humanity")).rejects.toThrow(/removeCard/);
    });

    // One product can have several cards, and every action for every one of them
    // arrives on one stream. Handing a card's callback another card's press would
    // be worse than dropping it.
    test("subscribeCardAction delivers only this card's actions", async () => {
        const actions = stream();
        setTruApiClient({
            renderer: { actionSubscribe: () => actions.observable },
        } as unknown as TrUApiClient);

        const seen: string[] = [];
        const pocket = await getPocketManager();
        pocket?.subscribeCardAction("loyalty", (action) => seen.push(action.actionId));

        actions.push({
            context: { tag: "PocketCard", value: { cardId: "loyalty" } },
            actionId: "stamp",
        });
        actions.push({
            context: { tag: "PocketCard", value: { cardId: "other" } },
            actionId: "nope",
        });
        actions.push({ context: { tag: "ChatMessage", value: {} }, actionId: "chat" });

        expect(seen).toEqual(["stamp"]);
    });
    /** A fake `renderer.onRender` a test can drive as the host would. */
    function renderer() {
        type Handler = (
            request: unknown,
            send: (face: unknown) => void,
            interrupt: () => void,
            // biome-ignore lint/suspicious/noConfusingVoidType: mirrors the protocol's own handler type.
        ) => (() => void) | void;
        let handler: Handler | undefined;
        const interrupts: number[] = [];
        return {
            registrations: 0,
            onRender(next: Handler) {
                this.registrations += 1;
                handler = next;
                return { unsubscribe() {} };
            },
            get interrupted() {
                return interrupts.length;
            },
            /** Put a card on screen. Returns what the host would call when it leaves. */
            draw(cardId: string, sent: unknown[]) {
                return handler?.(
                    { context: { tag: "PocketCard", value: { cardId } }, payload: "0x" },
                    (face) => sent.push(face),
                    () => interrupts.push(1),
                );
            },
            drawChat() {
                return handler?.(
                    { context: { tag: "ChatMessage", value: {} }, payload: "0x" },
                    () => {},
                    () => interrupts.push(1),
                );
            },
        };
    }

    const face = { tag: "Nil" } as RendererNode;

    function hostWith(renderers: ReturnType<typeof renderer>) {
        setTruApiClient({
            renderer: { onRender: renderers.onRender.bind(renderers) },
        } as unknown as TrUApiClient);
    }

    // There is one `onRender` slot per client. Registering per card would mean
    // the second card silently replaced the first, and the reference workers
    // interrupt on a card id they do not know, which cancels another card's
    // render the moment a product has two.
    test("one registration serves every card, and neither card interrupts the other", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        const loyalty: unknown[] = [];
        const stamps: unknown[] = [];
        pocket?.drawCard("loyalty", (send) => send(face));
        pocket?.drawCard("stamps", (send) => send(face));

        host.draw("loyalty", loyalty);
        host.draw("stamps", stamps);

        expect(host.registrations).toBe(1);
        expect(loyalty).toEqual([face]);
        expect(stamps).toEqual([face]);
        expect(host.interrupted).toBe(0);
    });

    test("a card nobody draws is interrupted, and another context is left alone", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        pocket?.drawCard("loyalty", (send) => send(face));

        host.draw("unknown-card", []);
        expect(host.interrupted).toBe(1);

        host.drawChat();
        expect(host.interrupted).toBe(1);
    });

    // An unhandled rejection inside the handler ends the registration, and every
    // card the product has stays blank for the rest of the worker's life. One
    // bad render must cost one render.
    test("a handler that throws does not take the other cards with it", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        const good: unknown[] = [];
        pocket?.drawCard("bad", () => {
            throw new Error("boom");
        });
        pocket?.drawCard("good", (send) => send(face));

        expect(() => host.draw("bad", [])).not.toThrow();
        expect(host.interrupted).toBe(1);

        host.draw("good", good);
        expect(good).toEqual([face]);
    });

    test("a handler that rejects does not take the other cards with it", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        const good: unknown[] = [];
        pocket?.drawCard("bad", () => Promise.reject(new Error("boom")));
        pocket?.drawCard("good", (send) => send(face));

        host.draw("bad", []);
        await Promise.resolve();
        expect(host.interrupted).toBe(1);

        host.draw("good", good);
        expect(good).toEqual([face]);
    });

    // Deciding what to draw is usually async, but the host's handler is not. A
    // cleanup that arrives after the card has gone has to run at once, or the
    // timer it was meant to stop keeps sending faces nobody is watching.
    test("a cleanup that resolves after the card has gone runs immediately", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        let stopped = 0;
        pocket?.drawCard("slow", async () => () => {
            stopped += 1;
        });

        const release = host.draw("slow", []);
        release?.();
        expect(stopped).toBe(0);

        await Promise.resolve();
        await Promise.resolve();
        expect(stopped).toBe(1);
    });

    test("a cleanup that arrives in time runs when the card leaves", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        let stopped = 0;
        pocket?.drawCard("card", () => () => {
            stopped += 1;
        });

        const release = host.draw("card", []);
        expect(stopped).toBe(0);
        release?.();
        expect(stopped).toBe(1);
    });

    test("unsubscribing a card stops it being drawn", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        const sent: unknown[] = [];
        const registration = pocket?.drawCard("card", (send) => send(face));
        registration?.unsubscribe();

        host.draw("card", sent);
        expect(sent).toEqual([]);
        expect(host.interrupted).toBe(1);
    });
}
