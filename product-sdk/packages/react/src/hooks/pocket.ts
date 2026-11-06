// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { UseQueryResult } from "@tanstack/react-query";
import {
    type CardDrawHandler,
    type PocketCard,
    type PocketCardAction,
    type RenderContextTag,
    type RenderHandler,
    queryKeys,
} from "@parity/product-sdk-hooks-core";
import { useCallback, useEffect, useRef } from "react";
import { useRuntime } from "../context.js";
import {
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    dropMutate,
    useLiveQuery,
    useTruapiMutation,
} from "../internal.js";

/**
 * The product's Pocket cards, live: the whole set on subscribe and again after
 * every change. The host owns the collection — a product observes and removes
 * its cards but cannot add one. Host-only: standalone the query errors with
 * `HostUnavailableError`.
 */
export function usePocketCards(options?: {
    enabled?: boolean;
    query?: QueryOptions<PocketCard[]>;
}): UseQueryResult<PocketCard[], Error> {
    const runtime = useRuntime();
    return useLiveQuery<PocketCard[]>({
        queryKey: queryKeys.pocketCards(),
        attach: (onValue, onError) => runtime.pocket.watchCards(onValue, onError),
        enabled: options?.enabled ?? true,
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
}

/** Give a card up: `remove(cardId)`. Rejects for a card the host placed itself (`Privileged`). */
export function useRemovePocketCard(options?: {
    mutation?: MutationOptions<void, string>;
}): NamedMutation<void, string> & { remove: (cardId: string) => Promise<void> } {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        (cardId: string) => runtime.pocket.removeCard(cardId),
        options?.mutation,
    );
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        remove: useCallback((cardId: string) => mutateAsync(cardId), [mutateAsync]),
    };
}

/**
 * Draw a Pocket card whenever the host puts it on screen. `draw(send, render)`
 * may call `send(face)` as often as it likes while the card is displayed and
 * returns the cleanup to run when it leaves. Registered for the component's
 * lifetime; the latest `draw` is always the one used.
 */
export function usePocketCard(
    cardId: string | undefined,
    draw: CardDrawHandler,
    options?: { enabled?: boolean; onError?: (error: unknown) => void },
): void {
    const runtime = useRuntime();
    const drawRef = useRef(draw);
    drawRef.current = draw;
    const onErrorRef = useRef(options?.onError);
    onErrorRef.current = options?.onError;
    const enabled = options?.enabled ?? true;

    useEffect(() => {
        if (!enabled || cardId === undefined) return;
        return runtime.pocket.drawCard(
            cardId,
            (send, render) => drawRef.current(send, render),
            (e) => onErrorRef.current?.(e),
        );
    }, [runtime, cardId, enabled]);
}

/** Presses and value changes inside one card's face, via a stable handler. */
export function usePocketCardActions(
    cardId: string | undefined,
    onAction: (action: PocketCardAction) => void,
    options?: { enabled?: boolean; onError?: (error: unknown) => void },
): void {
    const runtime = useRuntime();
    const handlerRef = useRef(onAction);
    handlerRef.current = onAction;
    const onErrorRef = useRef(options?.onError);
    onErrorRef.current = options?.onError;
    const enabled = options?.enabled ?? true;

    useEffect(() => {
        if (!enabled || cardId === undefined) return;
        return runtime.pocket.watchCardActions(
            cardId,
            (action) => handlerRef.current(action),
            (e) => onErrorRef.current?.(e),
        );
    }, [runtime, cardId, enabled]);
}

/**
 * Draw one kind of product-rendered body (`"ChatMessage"`, `"Input"`, …)
 * through the client's single render slot. Pocket cards have their own hook
 * ([`usePocketCard`](./usePocketCard)); this is the escape hatch for the
 * other contexts. Registered for the component's lifetime.
 */
export function useRenderer(
    tag: RenderContextTag,
    handler: RenderHandler,
    options?: { enabled?: boolean; onError?: (error: unknown) => void },
): void {
    const runtime = useRuntime();
    const handlerRef = useRef(handler);
    handlerRef.current = handler;
    const onErrorRef = useRef(options?.onError);
    onErrorRef.current = options?.onError;
    const enabled = options?.enabled ?? true;

    useEffect(() => {
        if (!enabled) return;
        return runtime.renderer.draw(
            tag,
            (request, send, interrupt) => handlerRef.current(request, send, interrupt),
            (e) => onErrorRef.current?.(e),
        );
    }, [runtime, tag, enabled]);
}
