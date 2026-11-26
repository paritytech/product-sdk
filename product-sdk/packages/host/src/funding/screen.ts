// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A channel between a provider's worker and the App screens it shows.
 *
 * A screen cannot answer `presentFrame` or hand anything to the worker
 * directly, so the two talk through the product's host storage, which they
 * share: the worker writes the view the screen draws, and the screen writes
 * the action the user took.
 *
 * Keys, under the channel's `prefix`:
 * - `<prefix>:view:<intent>`: what the screen draws;
 * - `<prefix>:action:<intent>`: what the user did;
 * - `<prefix>:active:<route>`: the intent the route shows, for a host that
 *   drops the route's query.
 *
 * @module
 */
import type { FundingFrameOutcome, HexString } from "@parity/truapi";

import { HostUnavailableError } from "../errors.js";
import { getClientSync } from "../transport.js";
import { type FundingClient, call } from "./client.js";
import { FundingAbortedError } from "./errors.js";
import type { FundingSession } from "./session.js";
import { decodeJson, encodeJson } from "./state.js";

/** An action a screen hands back to the worker, told apart by `kind`. */
export interface ScreenAction {
    kind: string;
}

/** The worker's side of a {@link screenChannel}. */
export interface ScreenChannel<View, Action extends ScreenAction> {
    /**
     * Write `view`, show `route`, and resolve with the first action of `kind`
     * the screen writes, or with what `onClosed` makes of the frame closing
     * without one (`undefined` by default). An action stored before a restart
     * is returned without showing the screen again.
     */
    show<K extends Action["kind"]>(
        session: FundingSession<unknown>,
        route: string,
        view: View,
        kind: K,
        options?: {
            onClosed?: (outcome: FundingFrameOutcome) => Extract<Action, { kind: K }> | undefined;
        },
    ): Promise<Extract<Action, { kind: K }> | undefined>;
    /** Drop the session's keys. Done for you when the session ends. */
    forget(intent: string): Promise<void>;
}

type Storage = Pick<FundingClient, "localStorage">;

const viewKey = (prefix: string, intent: string) => `${prefix}:view:${intent}`;
const actionKey = (prefix: string, intent: string) => `${prefix}:action:${intent}`;
const activeKey = (prefix: string, route: string) => `${prefix}:active:${route.split("?")[0]}`;

function storageOf(client: Storage | undefined, what: string): Storage {
    const resolved = client ?? (getClientSync() as Storage | null);
    if (!resolved) throw new HostUnavailableError(`${what}: TruAPI unavailable`);
    return resolved;
}

async function read(storage: Storage, key: string): Promise<unknown> {
    const { value } = await call(storage.localStorage.read({ key }), "localStorage.read");
    if (value === undefined) return undefined;
    try {
        return decodeJson(value);
    } catch {
        return undefined;
    }
}

async function write(storage: Storage, key: string, value: unknown): Promise<void> {
    await call(storage.localStorage.write({ key, value: encodeJson(value) }), "localStorage.write");
}

/** Resolve with the first action of `kind` written under `key`, until `signal` fires. */
function nextAction<Action extends ScreenAction>(
    storage: Storage,
    key: string,
    kind: string,
    signal: AbortSignal,
): Promise<Action> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new FundingAbortedError("waiting for a screen"));
        const subscription = storage.localStorage.subscribe({ request: { key } }).subscribe({
            next: ({ value }: { value?: HexString }) => {
                if (value === undefined) return;
                let action: Action | undefined;
                try {
                    action = decodeJson(value) as Action;
                } catch {
                    return;
                }
                if (action?.kind === kind) {
                    subscription.unsubscribe();
                    resolve(action);
                }
            },
        });
        signal.addEventListener(
            "abort",
            () => {
                subscription.unsubscribe();
                reject(new FundingAbortedError("waiting for a screen"));
            },
            { once: true },
        );
    });
}

/**
 * The worker's side of the channel under `prefix`. The App side is
 * {@link screenSession} and {@link submitScreenAction} with the same prefix.
 *
 * @example
 * ```ts
 * const screens = screenChannel<BankView, BankAction>("acme");
 * const sent = await screens.show(session, "bank", view, "bank-sent", {
 *     onClosed: (outcome) => (outcome.tag === "Closed" ? { kind: "bank-sent" } : undefined),
 * });
 * ```
 */
export function screenChannel<View, Action extends ScreenAction>(
    prefix: string,
    client?: Storage,
): ScreenChannel<View, Action> {
    const channel: ScreenChannel<View, Action> = {
        async show(session, route, view, kind, options) {
            const storage = storageOf(client, "screenChannel");
            type Wanted = Extract<Action, { kind: typeof kind }>;
            const key = actionKey(prefix, session.intent);
            const stored = (await read(storage, key)) as Action | undefined;
            if (stored?.kind === kind) return stored as Wanted;
            await write(storage, viewKey(prefix, session.intent), view);
            await write(storage, activeKey(prefix, route), session.intent);
            session.onEnd(() => channel.forget(session.intent));

            const waiting = new AbortController();
            const stop = () => waiting.abort();
            session.signal.addEventListener("abort", stop, { once: true });
            const action = nextAction<Wanted>(storage, key, kind, waiting.signal);
            const frame = session.presentApp(route);
            try {
                const first = await Promise.race([
                    action.then((value) => ({ action: value })),
                    frame.then((outcome) => ({ outcome })),
                ]);
                if ("action" in first) {
                    frame.catch(() => {});
                    return first.action;
                }
                const late = (await read(storage, key)) as Action | undefined;
                if (late?.kind === kind) return late as Wanted;
                return options?.onClosed?.(first.outcome);
            } finally {
                session.signal.removeEventListener("abort", stop);
                waiting.abort();
                action.catch(() => {});
            }
        },
        async forget(intent) {
            const storage = storageOf(client, "screenChannel");
            for (const key of [viewKey(prefix, intent), actionKey(prefix, intent)]) {
                await call(storage.localStorage.clear({ key }), "localStorage.clear");
            }
        },
    };
    return channel;
}

/**
 * The App side: the session a screen shows and the view the worker wrote
 * for it. The intent comes from the route's `intent` query, which
 * `presentApp` adds, or else from what the worker wrote for `route`.
 * Resolves `undefined` when there is no session to show.
 */
export async function screenSession<View>(
    prefix: string,
    route: string,
    client?: Storage,
): Promise<{ intent: string; view: View | undefined } | undefined> {
    const storage = storageOf(client, "screenSession");
    const fromQuery =
        typeof globalThis.location === "object"
            ? new URLSearchParams(globalThis.location.search).get("intent")
            : null;
    const intent =
        fromQuery ?? ((await read(storage, activeKey(prefix, route))) as string | undefined);
    if (typeof intent !== "string") return undefined;
    return { intent, view: (await read(storage, viewKey(prefix, intent))) as View | undefined };
}

/** The App side: hand the user's action on the screen for `intent` to the worker. */
export async function submitScreenAction<Action extends ScreenAction>(
    prefix: string,
    intent: string,
    action: Action,
    client?: Storage,
): Promise<void> {
    await write(storageOf(client, "submitScreenAction"), actionKey(prefix, intent), action);
}
