// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type CardDrawHandler,
    type PocketCard,
    type PocketCardAction,
    type RenderContextTag,
    type RenderHandler,
    queryKeys,
} from "@parity/product-sdk-hooks-core";
import { toValue, watch as vueWatch } from "vue";
import { useRuntime } from "../context.js";
import {
    type MaybeGetter,
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    type QueryResult,
    dropMutate,
    toGetter,
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
    enabled?: MaybeGetter<boolean>;
    query?: QueryOptions<PocketCard[]>;
}): QueryResult<PocketCard[]> {
    const runtime = useRuntime();
    return useLiveQuery<PocketCard[]>({
        queryKey: () => queryKeys.pocketCards(),
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
    return {
        ...dropMutate(mutation),
        remove: (cardId: string) => mutation.mutateAsync(cardId),
    };
}

/** Re-attach a host registration whenever its reactive inputs change; detach on scope dispose. */
function useRegistration(
    inputs: () => readonly unknown[],
    enabled: MaybeGetter<boolean>,
    attach: () => () => void,
): void {
    const isEnabled = toGetter(enabled);
    vueWatch(
        () => [...inputs(), isEnabled()],
        (_next, _prev, onCleanup) => {
            if (!isEnabled()) return;
            onCleanup(attach());
        },
        { immediate: true },
    );
}

/**
 * Draw a Pocket card whenever the host puts it on screen. `draw(send, render)`
 * may call `send(face)` as often as it likes while the card is displayed and
 * returns the cleanup to run when it leaves. Registered for the scope's
 * lifetime; a reactive `cardId` re-registers.
 */
export function usePocketCard(
    cardId: MaybeGetter<string | undefined>,
    draw: CardDrawHandler,
    options?: { enabled?: MaybeGetter<boolean>; onError?: (error: unknown) => void },
): void {
    const runtime = useRuntime();
    const getCardId = toGetter(cardId);
    useRegistration(
        () => [getCardId()],
        () => getCardId() !== undefined && toValue(toGetter(options?.enabled ?? true)()) !== false,
        () => {
            const id = getCardId();
            if (id === undefined) return () => {};
            return runtime.pocket.drawCard(id, draw, options?.onError);
        },
    );
}

/** Presses and value changes inside one card's face. */
export function usePocketCardActions(
    cardId: MaybeGetter<string | undefined>,
    onAction: (action: PocketCardAction) => void,
    options?: { enabled?: MaybeGetter<boolean>; onError?: (error: unknown) => void },
): void {
    const runtime = useRuntime();
    const getCardId = toGetter(cardId);
    useRegistration(
        () => [getCardId()],
        () => getCardId() !== undefined && toValue(toGetter(options?.enabled ?? true)()) !== false,
        () => {
            const id = getCardId();
            if (id === undefined) return () => {};
            return runtime.pocket.watchCardActions(id, onAction, options?.onError);
        },
    );
}

/**
 * Draw one kind of product-rendered body (`"ChatMessage"`, `"Input"`, …)
 * through the client's single render slot. Pocket cards have their own
 * composable (`usePocketCard`); this is the escape hatch for the other
 * contexts. Registered for the scope's lifetime.
 */
export function useRenderer(
    tag: MaybeGetter<RenderContextTag>,
    handler: RenderHandler,
    options?: { enabled?: MaybeGetter<boolean>; onError?: (error: unknown) => void },
): void {
    const runtime = useRuntime();
    const getTag = toGetter(tag);
    useRegistration(
        () => [getTag()],
        options?.enabled ?? true,
        () => runtime.renderer.draw(getTag(), handler, options?.onError),
    );
}
