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
 * A client has **one** `onRender` slot, so the card registry belongs to the
 * client rather than to a manager, and every manager built over one client
 * shares it. Two calls to {@link getPocketManager} therefore cooperate instead
 * of cancelling each other's cards.
 *
 * The slot itself is owned by `renderer.ts`, which dispatches by context. This
 * module claims `PocketCard` and routes it per card. Claiming it leaves the
 * chat and input contexts free for whatever else the product draws.
 *
 * @module
 */
import { createLogger } from "@parity/product-sdk-logger";
import type {
    CallErrorValue,
    HexString,
    HostRendererActionSubscribeItem,
    RendererNode,
    TrUApiClient,
    VersionedProductRendererRenderError,
} from "@parity/truapi";

import { registerRenderContext, renderFailure } from "./renderer.js";
import { getClient, getClientSync, subscribeWithInterrupt } from "./transport.js";
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

/** Which card the host is asking for, and what it carried. */
export interface CardRender {
    /** The card being drawn. */
    cardId: string;
    /** The product-defined payload, echoed back by the host and opaque to it. */
    payload: HexString;
}

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
    render: CardRender,
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
     * Drawing a card that is already being drawn replaces the handler, and the
     * older handle's `unsubscribe` then does nothing, so the live handler cannot
     * be torn down by a stale one.
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
     *
     * The card's draw handler stays registered, so the product draws the card
     * again if the host ever puts it back.
     */
    removeCard(cardId: string): Promise<void>;
}

/** What one client's cards share: the single render slot, and one action stream. */
interface PocketRegistry {
    /** Card id to its handler. The entry's identity is the registration token. */
    readonly cards: Map<string, { draw: CardDrawHandler }>;
    /** Card id to everyone listening for that card's actions. */
    readonly listeners: Map<string, Set<(action: PocketCardAction) => void>>;
    /** Passed the reason when the shared action stream ends. */
    readonly interrupted: Set<(reason?: unknown) => void>;
    renderRegistered: boolean;
    actionsSubscribed: boolean;
}

// Keyed by client rather than held per manager, because the registration these
// guard is per client. A WeakMap so a discarded client takes its registry with it.
const registries = new WeakMap<TrUApiClient, PocketRegistry>();

function registryFor(client: TrUApiClient): PocketRegistry {
    const existing = registries.get(client);
    if (existing !== undefined) return existing;

    const created: PocketRegistry = {
        cards: new Map(),
        listeners: new Map(),
        interrupted: new Set(),
        renderRegistered: false,
        actionsSubscribed: false,
    };
    registries.set(client, created);
    return created;
}

/**
 * Claim the `PocketCard` context, once.
 *
 * Never given back. The claim is what routes a card to its handler, and a
 * product that has drawn a card once will be asked for it again whenever it
 * comes back on screen.
 */
function registerRenderer(client: TrUApiClient, registry: PocketRegistry): void {
    if (registry.renderRegistered) return;
    registry.renderRegistered = true;

    registerRenderContext(client, "PocketCard", (request, send, interrupt) => {
        // The slot only routes `PocketCard` here. The guard is for the compiler,
        // which cannot know that from the handler's type.
        if (request.context.tag !== "PocketCard") return;

        const { cardId } = request.context.value;
        const entry = registry.cards.get(cardId);
        if (entry === undefined) {
            interrupt(renderFailure(`no handler is drawing the pocket card '${cardId}'`));
            return;
        }
        return runDraw({ cardId, payload: request.payload }, entry.draw, send, interrupt);
    });
}

/** Open the one action stream this client needs, once. */
function subscribeActions(client: TrUApiClient, registry: PocketRegistry): void {
    if (registry.actionsSubscribed) return;
    registry.actionsSubscribed = true;

    const subscription = subscribeWithInterrupt(client.renderer.actionSubscribe(), (action) => {
        if (action.context.tag !== "PocketCard") return;
        const listeners = registry.listeners.get(action.context.value.cardId);
        if (listeners === undefined) return;
        // Copied, because a listener is allowed to unsubscribe from inside itself.
        for (const listener of [...listeners]) listener(action);
    });

    subscription.onInterrupt((reason) => {
        for (const handler of [...registry.interrupted]) handler(reason);
    });
}

/**
 * Run one card's handler and give the host back its cleanup.
 *
 * Three things have to hold. Nothing may escape into the transport, which calls
 * both this handler and its teardown without a guard of its own, and whose
 * teardown loop would strand every other body if one threw. A cleanup that
 * resolves after the card has already left has to run at once, or whatever it
 * was meant to stop keeps sending faces into a subscription nobody is watching.
 * And the promise this leaves behind needs its own rejection handler, or a
 * throw inside the settle path becomes an unhandled rejection.
 */
function runDraw(
    render: CardRender,
    draw: CardDrawHandler,
    send: (face: RendererNode) => void,
    interrupt: (reason: CallErrorValue<VersionedProductRendererRenderError>) => void,
): CardCleanup {
    let released = false;
    let cleanup: CardCleanup;

    const settle = (outcome: CardCleanup): void => {
        if (!released) {
            cleanup = outcome;
            return;
        }
        runCleanup(render.cardId, outcome);
    };

    const fail = (reason: unknown): void => {
        log.error(`pocket card ${render.cardId} could not be drawn`, reason);
        interrupt(renderFailure(`the product could not draw '${render.cardId}'`));
    };

    try {
        const outcome = draw(send, render);
        if (isPromise(outcome)) {
            outcome.then(settle, fail).catch((reason: unknown) => {
                log.error(`pocket card ${render.cardId} failed after being drawn`, reason);
            });
        } else {
            settle(outcome);
        }
    } catch (reason) {
        fail(reason);
        return undefined;
    }

    return () => {
        released = true;
        runCleanup(render.cardId, cleanup);
    };
}

/**
 * Run a card's cleanup.
 *
 * The transport calls the teardown it was handed with no guard, from a loop over
 * every open body. A throw here would abort that loop and leave the rest of them
 * never torn down.
 */
function runCleanup(cardId: string, cleanup: CardCleanup): void {
    try {
        cleanup?.();
    } catch (reason) {
        log.error(`pocket card ${cardId} failed while being released`, reason);
    }
}

function isPromise(value: CardCleanup | Promise<CardCleanup>): value is Promise<CardCleanup> {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as Promise<CardCleanup>).then === "function"
    );
}

/** Build a {@link PocketManager} over a TruAPI client. */
function adaptPocketManager(client: TrUApiClient): PocketManager {
    const registry = registryFor(client);

    return {
        drawCard(cardId, draw) {
            const entry = { draw };
            registry.cards.set(cardId, entry);
            registerRenderer(client, registry);

            return {
                unsubscribe() {
                    // A later drawCard for this id replaced the entry. Deleting
                    // now would take the live handler out with the stale one.
                    if (registry.cards.get(cardId) !== entry) return;
                    registry.cards.delete(cardId);
                },
            };
        },
        subscribeCardAction(cardId, callback) {
            const listeners = registry.listeners.get(cardId) ?? new Set();
            registry.listeners.set(cardId, listeners);
            listeners.add(callback);
            subscribeActions(client, registry);

            return {
                unsubscribe() {
                    listeners.delete(callback);
                    if (listeners.size === 0) registry.listeners.delete(cardId);
                },
                onInterrupt(handler) {
                    registry.interrupted.add(handler);
                    return () => {
                        registry.interrupted.delete(handler);
                    };
                },
            };
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

    /** A stream a test can push items into, counting how many were opened. */
    function stream() {
        const observers: Observer[] = [];
        return {
            get opened() {
                return observers.length;
            },
            observable: {
                subscribe(observer: Observer) {
                    observers.push(observer);
                    return { subscriptionId: "1", unsubscribe() {} };
                },
            },
            push(item: unknown) {
                for (const observer of observers) observer.next?.(item);
            },
            interrupt(reason: unknown) {
                for (const observer of observers) observer.error?.(reason);
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

    /**
     * A fake `renderer.onRender` that behaves as the real transport does.
     *
     * Two details are load-bearing and were wrong in an earlier version of these
     * tests. Registering replaces the installed handler rather than adding one,
     * and unsubscribing clears it only when it is still the one that was
     * installed. A forgiving fake hid a bug where two managers cancelled each
     * other's cards.
     */
    function renderer() {
        type Handler = (
            request: unknown,
            send: (face: unknown) => void,
            interrupt: (reason: unknown) => void,
        ) => CardCleanup;
        let installed: Handler | undefined;
        const reasons: string[] = [];

        return {
            registrations: 0,
            /** Set when the test wants the transport's interrupt to fail. */
            interruptThrows: false,
            get declined() {
                return reasons;
            },
            onRender(next: Handler) {
                this.registrations += 1;
                installed = next;
                return {
                    unsubscribe() {
                        if (installed === next) installed = undefined;
                    },
                };
            },
            get installed() {
                return installed !== undefined;
            },
            /** Put a card on screen. Returns what the host would call when it leaves. */
            draw(cardId: string, sent: unknown[], payload = "0x") {
                return installed?.(
                    { context: { tag: "PocketCard", value: { cardId } }, payload },
                    (face) => sent.push(face),
                    (reason) => {
                        if (this.interruptThrows) throw new Error("interrupt boom");
                        reasons.push(reasonText(reason));
                    },
                );
            },
            drawChat(sent: unknown[] = []) {
                return installed?.(
                    { context: { tag: "ChatMessage", value: {} }, payload: "0x" },
                    (body) => sent.push(body),
                    (reason) => reasons.push(reasonText(reason)),
                );
            },
        };
    }

    function reasonText(reason: unknown): string {
        const domain = reason as { value?: { value?: { reason?: string } } };
        return domain?.value?.value?.reason ?? "<no reason>";
    }

    const face = { tag: "Nil" } as RendererNode;

    function hostWith(host: ReturnType<typeof renderer>, extra: Record<string, unknown> = {}) {
        setTruApiClient({
            renderer: { onRender: host.onRender.bind(host), ...extra },
            ...extra,
        } as unknown as TrUApiClient);
    }

    afterEach(() => setTruApiClient(null));

    test("getPocketManager returns null outside a container", async () => {
        expect(await getPocketManager()).toBeNull();
    });

    // There is one `onRender` slot per client and registering replaces it. When
    // each manager kept its own card map, a second manager's handler served every
    // request and interrupted the first manager's cards, which is the exact
    // failure this module exists to remove.
    test("two managers over one client share the registry instead of fighting", async () => {
        const host = renderer();
        hostWith(host);

        const first = await getPocketManager();
        const second = await getPocketManager();
        const loyalty: unknown[] = [];
        const stamps: unknown[] = [];
        first?.drawCard("loyalty", (send) => send(face));
        second?.drawCard("stamps", (send) => send(face));

        host.draw("loyalty", loyalty);
        host.draw("stamps", stamps);

        expect(host.registrations).toBe(1);
        expect(loyalty).toEqual([face]);
        expect(stamps).toEqual([face]);
        expect(host.declined).toEqual([]);
    });

    test("one registration serves every card of one manager", async () => {
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
    });

    // Redrawing a card replaces its handler. A stale handle deleting the entry
    // would take the live handler out and leave the card undrawable.
    test("a stale registration handle cannot tear down the live handler", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        const drawn: unknown[] = [];
        const stale = pocket?.drawCard("loyalty", () => {});
        pocket?.drawCard("loyalty", (send) => send(face));
        stale?.unsubscribe();

        host.draw("loyalty", drawn);
        expect(drawn).toEqual([face]);
        expect(host.declined).toEqual([]);
    });

    test("the current handle does release the card", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        const drawn: unknown[] = [];
        const registration = pocket?.drawCard("loyalty", (send) => send(face));
        registration?.unsubscribe();

        host.draw("loyalty", drawn);
        expect(drawn).toEqual([]);
        expect(host.declined).toEqual(["no handler is drawing the pocket card 'loyalty'"]);
    });

    // Giving the slot back makes the transport buffer render requests and replay
    // them at whoever registers next, drawing a card that left the screen long ago.
    test("the render slot is kept even after the last card is released", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        const registration = pocket?.drawCard("only", (send) => send(face));
        registration?.unsubscribe();

        expect(host.installed).toBe(true);
    });

    // The interrupt channel carries a reason. Sending none leaves the device with
    // a blank face and nothing saying why, which is what this module is for.
    test("a card nobody draws is declined with a reason", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        pocket?.drawCard("loyalty", (send) => send(face));

        host.draw("unknown-card", []);
        expect(host.declined).toEqual(["no handler is drawing the pocket card 'unknown-card'"]);
    });

    // Pocket holds the only render slot, so nothing else can answer a chat body.
    // Leaving it unanswered hangs it on the device forever.
    // Drawing a card must not cost the product the other two render contexts.
    // Pocket claims `PocketCard` and nothing else, so a chat body the product
    // draws itself still reaches its own handler.
    test("drawing a card leaves the other contexts free", async () => {
        const host = renderer();
        hostWith(host);
        const client = getClientSync();

        const pocket = await getPocketManager();
        pocket?.drawCard("loyalty", (send) => send(face));

        const chats: unknown[] = [];
        registerRenderContext(client!, "ChatMessage", (_request, send) => send(face));
        host.drawChat(chats);

        expect(chats).toEqual([face]);
        expect(host.declined).toEqual([]);
    });

    test("a context nothing claims is declined rather than left hanging", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        pocket?.drawCard("loyalty", (send) => send(face));

        host.drawChat([]);
        expect(host.declined).toEqual(["this product draws no ChatMessage body"]);
    });

    test("the handler is given the card id and the payload the host echoed", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        const seen: CardRender[] = [];
        pocket?.drawCard("loyalty", (_send, render) => {
            seen.push(render);
        });

        host.draw("loyalty", [], "0xbeef");
        expect(seen).toEqual([{ cardId: "loyalty", payload: "0xbeef" }]);
    });

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
        expect(host.declined).toEqual(["the product could not draw 'bad'"]);

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
        expect(host.declined).toEqual(["the product could not draw 'bad'"]);

        host.draw("good", good);
        expect(good).toEqual([face]);
    });

    // The transport calls the teardown it was handed from a loop over every open
    // body, with no guard. A throw here would strand all the others.
    test("a cleanup that throws does not escape into the transport", async () => {
        const host = renderer();
        hostWith(host);

        const pocket = await getPocketManager();
        pocket?.drawCard("card", () => () => {
            throw new Error("cleanup boom");
        });

        const release = host.draw("card", []);
        expect(() => release?.()).not.toThrow();
    });

    // Reporting a rejected handler means logging and interrupting, and the
    // transport's interrupt can itself fail. Without a handler on the promise
    // that reporting runs in, that failure becomes an unhandled rejection, which
    // is the class this module claims to prevent.
    test("a failure while reporting a rejected handler stays contained", async () => {
        const host = renderer();
        host.interruptThrows = true;
        hostWith(host);

        const rejections: unknown[] = [];
        const capture = (reason: unknown) => rejections.push(reason);
        process.on("unhandledRejection", capture);

        const pocket = await getPocketManager();
        pocket?.drawCard("slow", () => Promise.reject(new Error("boom")));
        host.draw("slow", []);
        await new Promise((resolve) => setTimeout(resolve, 20));

        process.off("unhandledRejection", capture);
        expect(rejections).toEqual([]);
    });

    // Deciding what to draw is usually async while the host's handler is not, so
    // a cleanup can arrive after the card has gone. Dropping it leaves whatever
    // it was meant to stop running against a card nobody is watching.
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

    // Four cards used to mean four identical host subscriptions, each receiving
    // every action and discarding three quarters of them.
    test("many cards share one action stream", async () => {
        const actions = stream();
        setTruApiClient({
            renderer: { actionSubscribe: () => actions.observable },
        } as unknown as TrUApiClient);

        const pocket = await getPocketManager();
        const loyalty: string[] = [];
        const stamps: string[] = [];
        pocket?.subscribeCardAction("loyalty", (action) => loyalty.push(action.actionId));
        pocket?.subscribeCardAction("stamps", (action) => stamps.push(action.actionId));

        actions.push({
            context: { tag: "PocketCard", value: { cardId: "stamps" } },
            actionId: "press",
        });

        expect(actions.opened).toBe(1);
        expect(loyalty).toEqual([]);
        expect(stamps).toEqual(["press"]);
    });

    test("unsubscribing one card's actions leaves the others listening", async () => {
        const actions = stream();
        setTruApiClient({
            renderer: { actionSubscribe: () => actions.observable },
        } as unknown as TrUApiClient);

        const pocket = await getPocketManager();
        const kept: string[] = [];
        const dropped: string[] = [];
        pocket?.subscribeCardAction("kept", (action) => kept.push(action.actionId));
        const handle = pocket?.subscribeCardAction("dropped", (action) =>
            dropped.push(action.actionId),
        );
        handle?.unsubscribe();

        actions.push({ context: { tag: "PocketCard", value: { cardId: "kept" } }, actionId: "a" });
        actions.push({
            context: { tag: "PocketCard", value: { cardId: "dropped" } },
            actionId: "b",
        });

        expect(kept).toEqual(["a"]);
        expect(dropped).toEqual([]);
    });

    test("an interrupted action stream reaches every card's handler", async () => {
        const actions = stream();
        setTruApiClient({
            renderer: { actionSubscribe: () => actions.observable },
        } as unknown as TrUApiClient);

        const pocket = await getPocketManager();
        const reasons: unknown[] = [];
        pocket
            ?.subscribeCardAction("loyalty", () => {})
            ?.onInterrupt((reason) => reasons.push(reason));

        actions.interrupt("host went away");
        expect(reasons).toEqual(["host went away"]);
    });
}
