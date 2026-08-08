// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Native-backend chat adapter.
 *
 * The iOS "native backend" chat runtime speaks the legacy novasama container
 * protocol, not truapi/SCALE. `@novasamatech/host-api-wrapper`'s
 * `createProductChatManager()` already implements that protocol and its public
 * surface is structurally the product-sdk {@link ChatManager}. This adapter
 * exposes it under the unified interface so chat products keep working on the
 * native backend during the transition, the way non-chat SPA (single-page app)
 * products already keep a native adapter alongside the truapi one.
 *
 * The truapi and novasama TS shapes for the same wire data diverge in three
 * places, each translated explicitly (never a blind cast):
 *
 *  - the custom-renderer node — see {@link toNovasamaNode} (product-sdk/react
 *    shape → novasama shape);
 *  - `ChatMessageContent` — `Text` is `{ text }` on truapi but a bare string on
 *    novasama, and `Custom.payload` is a hex string on truapi but `Uint8Array`
 *    on novasama (see {@link toNovaMessageContent}/{@link fromNovaMessageContent});
 *  - `ActionTriggered.payload` — hex string on truapi, `Uint8Array` on novasama.
 *
 * Room/bot registration and room-list payloads are field-identical and pass
 * through unchanged.
 *
 * `@novasamatech/host-api-wrapper` is loaded via a dynamic `import()` from
 * {@link getNativeChatManager} so truapi-only products never pull the legacy
 * novasama tree into their bundle.
 *
 * @module
 */
import type { ChatMessageContent } from "@parity/truapi";

import type {
    ChatManager,
    ChatCustomMessageRenderingRegistration,
    ChatCustomMessageRenderingRequestHandler,
    ChatReceivedAction,
} from "./chat.js";
import { fromHex, toHex } from "./truapi.js";
import { toNovasamaNode } from "./nativeChatNode.js";
import type { HostSubscription } from "./types.js";

type Any = any;

/** Minimal shape of `createProductChatManager()`'s return that we consume. */
interface NativeChatBackend {
    registerRoom(params: { roomId: string; name: string; icon: string }): Promise<"New" | "Exists">;
    registerBot(params: { botId: string; name: string; icon: string }): Promise<"New" | "Exists">;
    sendMessage(roomId: string, payload: Any): Promise<{ messageId: string }>;
    subscribeChatList(callback: (rooms: Any[]) => void): NovaSubscription;
    subscribeAction(callback: (action: Any) => void): NovaSubscription;
    onCustomMessageRenderingRequest(
        renderer: (
            params: {
                messageId: string;
                messageType: string;
                payload: Uint8Array;
                subscribeActions: Any;
            },
            render: (node: Any) => void,
        ) => VoidFunction,
    ): VoidFunction;
}

/** A novasama `Subscription<void>`: unsubscribe plus an interrupt hook. */
interface NovaSubscription {
    unsubscribe(): void;
    onInterrupt?(callback: (reason?: unknown) => void): () => void;
}

/**
 * Detect the legacy native chat host. The native container injects
 * `webkit.messageHandlers.__container__` (see the iOS `ContainerBridge`); its
 * presence — with no truapi host — means we're on the native backend.
 */
export function isNativeChatHost(): boolean {
    const handlers = (globalThis as Any)?.webkit?.messageHandlers;
    return typeof handlers?.__container__?.postMessage === "function";
}

/** truapi `ChatMessageContent` → the novasama wire shape. */
function toNovaMessageContent(content: ChatMessageContent): Any {
    switch (content.tag) {
        case "Text":
            // truapi `{ text }` → novasama bare string.
            return { tag: "Text", value: content.value.text };
        case "Custom":
            // truapi hex payload → novasama bytes.
            return {
                tag: "Custom",
                value: {
                    messageType: content.value.messageType,
                    payload: fromHex(content.value.payload),
                },
            };
        // The other variants (RichText/Actions/File/Reaction/ReactionRemoved)
        // are field-identical between the stacks and forwarded unchanged.
        default:
            return content;
    }
}

/** novasama `ChatMessageContent` → the truapi shape product code expects. */
function fromNovaMessageContent(content: Any): Any {
    switch (content.tag) {
        case "Text":
            return { tag: "Text", value: { text: content.value } };
        case "Custom":
            return {
                tag: "Custom",
                value: {
                    messageType: content.value.messageType,
                    payload: toHex(content.value.payload),
                },
            };
        default:
            return content;
    }
}

/** novasama received action → the truapi `ChatReceivedAction` shape. */
function fromNovaAction(action: Any): ChatReceivedAction {
    const payload = action.payload;
    if (payload?.tag === "MessagePosted") {
        return {
            ...action,
            payload: { tag: "MessagePosted", value: fromNovaMessageContent(payload.value) },
        };
    }
    if (payload?.tag === "ActionTriggered") {
        const t = payload.value;
        return {
            ...action,
            payload: {
                tag: "ActionTriggered",
                value: { ...t, payload: t.payload === undefined ? undefined : toHex(t.payload) },
            },
        };
    }
    return action;
}

/** Adapt a novasama subscription to the host's {@link HostSubscription}. */
function adaptSubscription(sub: NovaSubscription): HostSubscription {
    return {
        unsubscribe: () => sub.unsubscribe(),
        onInterrupt: (callback) => sub.onInterrupt?.(callback) ?? (() => {}),
    };
}

/**
 * Build a {@link ChatManager} over a novasama native chat backend. The backend
 * is injected (production supplies `createProductChatManager()`; tests supply a
 * fake), so this module carries no static novasama import.
 */
export function createNativeChatManager(backend: NativeChatBackend): ChatManager {
    return {
        registerRoom(request) {
            return backend.registerRoom(request);
        },
        registerBot(request) {
            return backend.registerBot(request);
        },
        sendMessage(roomId, payload) {
            return backend.sendMessage(roomId, toNovaMessageContent(payload));
        },
        subscribeChatList(callback) {
            return adaptSubscription(backend.subscribeChatList((rooms) => callback(rooms)));
        },
        subscribeAction(callback) {
            return adaptSubscription(
                backend.subscribeAction((action) => callback(fromNovaAction(action))),
            );
        },
        onCustomMessageRenderingRequest(
            handler: ChatCustomMessageRenderingRequestHandler,
        ): ChatCustomMessageRenderingRegistration {
            // The product-sdk handler is host-initiated (returns an observable of
            // truapi nodes); the novasama backend wants a `(params, render)`
            // callback. Bridge the two, translating each emitted node into the
            // novasama shape its codec can encode.
            const dispose = backend.onCustomMessageRenderingRequest((params, render) => {
                const source = handler({
                    messageId: params.messageId,
                    messageType: params.messageType,
                    payload: params.payload,
                    subscribeActions: params.subscribeActions,
                });
                const subscription = source.subscribe({
                    next: (node) => render(toNovasamaNode(node)),
                    // The native render callback has no failure channel (unlike
                    // the truapi host-initiated stream, which interrupts), so a
                    // renderer error can only be dropped here — it just stops
                    // producing further trees.
                    error: () => {},
                });
                return () => subscription.unsubscribe();
            });
            return { unsubscribe: dispose };
        },
    };
}

/**
 * Get a native-backend {@link ChatManager}, loading the novasama wrapper on
 * demand. Called by {@link getChatManager} only when {@link isNativeChatHost}.
 */
export async function getNativeChatManager(): Promise<ChatManager> {
    const { createProductChatManager } = await import("@novasamatech/host-api-wrapper");
    return createNativeChatManager(createProductChatManager() as unknown as NativeChatBackend);
}

if (import.meta.vitest) {
    const { describe, it, expect, vi } = import.meta.vitest;

    // Fake novasama backend (the public shape of `createProductChatManager()`),
    // recording what the adapter forwards and letting tests drive inbound
    // actions and render requests the way the native container does.
    const makeFakeBackend = () => {
        const sent: Array<{ roomId: string; payload: Any }> = [];
        let actionCb: ((action: Any) => void) | undefined;
        let renderer: ((params: Any, render: (node: Any) => void) => VoidFunction) | undefined;
        let interruptCb: ((reason?: unknown) => void) | undefined;

        const backend: NativeChatBackend = {
            async registerRoom() {
                return "New";
            },
            async registerBot() {
                return "New";
            },
            async sendMessage(roomId: string, payload: Any) {
                sent.push({ roomId, payload });
                return { messageId: `m-${sent.length}` };
            },
            subscribeChatList() {
                return { unsubscribe() {} };
            },
            subscribeAction(cb: (action: Any) => void) {
                actionCb = cb;
                return {
                    unsubscribe() {},
                    onInterrupt(cb2: (reason?: unknown) => void) {
                        interruptCb = cb2;
                        return () => {};
                    },
                };
            },
            onCustomMessageRenderingRequest(
                r: (params: Any, render: (node: Any) => void) => VoidFunction,
            ) {
                renderer = r;
                return () => {};
            },
        };

        return {
            backend,
            sent,
            emitAction: (action: Any) => actionCb?.(action),
            fireInterrupt: (reason?: unknown) => interruptCb?.(reason),
            driveRender: (params: Any) => {
                const nodes: Any[] = [];
                renderer!(params, (n) => nodes.push(n));
                return { nodes };
            },
        };
    };

    describe("createNativeChatManager — message content translation", () => {
        it("sendMessage: truapi Text {text} → novasama bare string", async () => {
            const f = makeFakeBackend();
            const chat = createNativeChatManager(f.backend);
            const res = await chat.sendMessage("room", {
                tag: "Text",
                value: { text: "hi" },
            } as Any);
            expect(res.messageId).toBe("m-1");
            expect(f.sent[0]!.payload).toEqual({ tag: "Text", value: "hi" });
        });

        it("sendMessage: truapi Custom hex payload → novasama Uint8Array", async () => {
            const f = makeFakeBackend();
            const chat = createNativeChatManager(f.backend);
            await chat.sendMessage("room", {
                tag: "Custom",
                value: { messageType: "result", payload: "0xdead" },
            } as Any);
            const out = f.sent[0]!.payload;
            expect(out.tag).toBe("Custom");
            expect(out.value.messageType).toBe("result");
            expect(Array.from(out.value.payload as Uint8Array)).toEqual([0xde, 0xad]);
        });

        it("subscribeAction: novasama bare-string Text → truapi {text}", () => {
            const f = makeFakeBackend();
            const chat = createNativeChatManager(f.backend);
            const received: Any[] = [];
            chat.subscribeAction((a) => received.push(a));
            f.emitAction({
                roomId: "r",
                peer: "p",
                payload: { tag: "MessagePosted", value: { tag: "Text", value: "yo" } },
            });
            expect(received[0].payload.value).toEqual({ tag: "Text", value: { text: "yo" } });
        });

        it("subscribeAction: novasama ActionTriggered Uint8Array payload → truapi hex", () => {
            const f = makeFakeBackend();
            const chat = createNativeChatManager(f.backend);
            const received: Any[] = [];
            chat.subscribeAction((a) => received.push(a));
            f.emitAction({
                roomId: "r",
                peer: "p",
                payload: {
                    tag: "ActionTriggered",
                    value: { messageId: "m1", actionId: "a1", payload: new Uint8Array([1, 2]) },
                },
            });
            expect(received[0].payload.value.payload).toBe("0x0102");
        });
    });

    describe("createNativeChatManager — render bridge & lifecycle", () => {
        it("runs the product renderer and translates emitted nodes to the novasama shape", () => {
            const f = makeFakeBackend();
            const chat = createNativeChatManager(f.backend);

            chat.onCustomMessageRenderingRequest(() => ({
                subscribe(observer: Any) {
                    observer.next?.({
                        tag: "Text",
                        value: {
                            modifiers: [],
                            props: { style: "HeadlineLarge", color: "FgPrimary" },
                            children: [{ tag: "String", value: { text: "hi" } }],
                        },
                    });
                    return { unsubscribe() {} };
                },
            }));

            const { nodes } = f.driveRender({
                messageId: "m1",
                messageType: "t",
                payload: new Uint8Array(),
                subscribeActions: () => () => {},
            });
            expect(nodes[0].value.props).toEqual({ style: "headline.large", color: "fg.primary" });
            expect(nodes[0].value.children[0]).toEqual({ tag: "String", value: "hi" });
        });

        it("forwards the backend interrupt hook (not a no-op)", () => {
            const f = makeFakeBackend();
            const chat = createNativeChatManager(f.backend);
            const sub = chat.subscribeAction(() => {});
            const onInterrupt = vi.fn();
            sub.onInterrupt(onInterrupt);
            f.fireInterrupt("gone");
            expect(onInterrupt).toHaveBeenCalledWith("gone");
        });
    });

    describe("isNativeChatHost", () => {
        it("is false without a container global", () => {
            expect(isNativeChatHost()).toBe(false);
        });

        it("is true when webkit.messageHandlers.__container__ is present", () => {
            (globalThis as Any).webkit = {
                messageHandlers: { __container__: { postMessage() {} } },
            };
            try {
                expect(isNativeChatHost()).toBe(true);
            } finally {
                (globalThis as Any).webkit = undefined;
            }
        });
    });
}
