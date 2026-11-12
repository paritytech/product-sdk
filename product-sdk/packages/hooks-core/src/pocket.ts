// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type CardDrawHandler,
    type CardDrawRegistration,
    HostUnavailableError,
    type PocketCard,
    type PocketCardAction,
    type PocketManager,
    type RenderContextTag,
    type RenderHandler,
    type RendererManager,
    getPocketManager,
    getRendererManager,
} from "@parity/product-sdk-host";
import type { RendererNode } from "@parity/truapi";
import type { HostController } from "./host.js";

/** Which card the host is asking for, and the payload it carried. */
export type CardRender = Parameters<CardDrawHandler>[1];

export type {
    CardDrawHandler,
    CardDrawRegistration,
    PocketCard,
    PocketCardAction,
    PocketManager,
    RenderContextTag,
    RenderHandler,
    RendererManager,
    RendererNode,
};

export interface PocketController {
    /** Pocket is a host capability; resolves null standalone. */
    getManager(): Promise<PocketManager | null>;
    /** The product's cards, republished whenever the host changes the collection. */
    watchCards(
        onCards: (cards: PocketCard[]) => void,
        onError?: (error: unknown) => void,
    ): () => void;
    /**
     * Draw `cardId` whenever the host puts it on screen: `draw` receives a
     * `send` sink it may call for as long as the card is displayed, and returns
     * the cleanup to run when it leaves. The registration survives the card
     * being removed, so the product draws it again if the host restores it.
     */
    drawCard(cardId: string, draw: CardDrawHandler, onError?: (error: unknown) => void): () => void;
    /** Presses and value changes inside `cardId`'s face. */
    watchCardActions(
        cardId: string,
        onAction: (action: PocketCardAction) => void,
        onError?: (error: unknown) => void,
    ): () => void;
    /** Give a card up. Rejects for a card the host placed itself (`Privileged`). */
    removeCard(cardId: string): Promise<void>;
}

export interface RendererController {
    /**
     * Draw one kind of product-rendered body (`ChatMessage`, `Input`, …) through
     * the client's single render slot. Pocket cards go through
     * `PocketController.drawCard`, which claims the `PocketCard` context.
     */
    draw(
        tag: RenderContextTag,
        handler: RenderHandler,
        onError?: (error: unknown) => void,
    ): () => void;
}

/** Bridge a lazily-resolved host manager into a synchronous teardown contract. */
function lazyRegistration<M>(
    resolve: () => Promise<M | null>,
    what: string,
    attach: (manager: M) => {
        unsubscribe(): void;
        onInterrupt?: (cb: (reason?: unknown) => void) => () => void;
    },
    onError?: (error: unknown) => void,
): () => void {
    let cancelled = false;
    let teardown: (() => void) | undefined;
    void resolve()
        .then((manager) => {
            if (cancelled) return;
            if (!manager) throw new HostUnavailableError(what);
            const registration = attach(manager);
            const offInterrupt = registration.onInterrupt?.((reason) => onError?.(reason));
            teardown = () => {
                offInterrupt?.();
                registration.unsubscribe();
            };
            if (cancelled) teardown();
        })
        .catch((e) => {
            if (!cancelled) onError?.(e);
        });
    return () => {
        cancelled = true;
        teardown?.();
    };
}

export function createPocketController(host: HostController): PocketController {
    let managerPromise: Promise<PocketManager | null> | null = null;

    const getManager = (): Promise<PocketManager | null> => {
        if (!managerPromise) {
            managerPromise = host.detect().then((inside) => (inside ? getPocketManager() : null));
            managerPromise.catch(() => {
                managerPromise = null;
            });
        }
        return managerPromise;
    };

    return {
        getManager,
        watchCards: (onCards, onError) =>
            lazyRegistration(getManager, "pocket", (m) => m.subscribeCards(onCards), onError),
        drawCard: (cardId, draw, onError) =>
            lazyRegistration(getManager, "pocket", (m) => m.drawCard(cardId, draw), onError),
        watchCardActions: (cardId, onAction, onError) =>
            lazyRegistration(
                getManager,
                "pocket",
                (m) => m.subscribeCardAction(cardId, onAction),
                onError,
            ),
        removeCard: async (cardId) => {
            const manager = await getManager();
            if (!manager) throw new HostUnavailableError("pocket");
            return manager.removeCard(cardId);
        },
    };
}

export function createRendererController(host: HostController): RendererController {
    let managerPromise: Promise<RendererManager | null> | null = null;

    const getManager = (): Promise<RendererManager | null> => {
        if (!managerPromise) {
            managerPromise = host.detect().then((inside) => (inside ? getRendererManager() : null));
            managerPromise.catch(() => {
                managerPromise = null;
            });
        }
        return managerPromise;
    };

    return {
        draw: (tag, handler, onError) =>
            lazyRegistration(getManager, "renderer", (m) => m.draw(tag, handler), onError),
    };
}
