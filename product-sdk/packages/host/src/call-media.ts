// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The media of a call in a chat room, run by the host's own call engine.
 *
 * A product that runs a call in one of its rooms asks the host to start the
 * audio, or the audio and video; the host runs the media with its own engine and
 * call screen, and the product never touches the microphone or camera. The two
 * hosts agree on the media through signals that the products carry in their own
 * encrypted channel: the host hands the product its signals as `CallSignal` room
 * events, and the product gives the host the other side's with {@link CallMedia.signal}.
 *
 * `start` needs the user's consent in that room: a call button pressed or a call
 * accepted within the last 180 seconds. Otherwise it fails with
 * {@link CallMediaNotAllowedError}.
 *
 * @module
 */
import type { HostCallMediaError, TrUApiClient } from "@parity/truapi";

import { FeatureUnavailableError } from "./chat-errors.js";
import {
    HostCallFailedError,
    HostError,
    type HostErrorPayload,
    HostResponseDecodeError,
} from "./errors.js";
import { type Result, err, ok } from "./result.js";
import { getClient } from "./transport.js";
import { matchHostResult, toHex } from "./truapi.js";

/** `start` came without the user's consent in the room within the last 180 seconds. */
export class CallMediaNotAllowedError extends HostError {
    constructor() {
        super("callMedia.start: the user did not start or accept a call in this room just now");
        this.name = "CallMediaNotAllowedError";
    }
}

/** The host's call engine. Obtain it with {@link getCallMedia}. */
export interface CallMedia {
    /**
     * Start the media of the call the room shows as `Active`. `offerer` is the side
     * whose engine makes the media offer: in the call-media RFC's flow the side that
     * accepted the call, in the native person chat the caller. The two sides must
     * agree, so exactly one of them starts as the offerer.
     */
    start(request: {
        roomId: string;
        callId: string;
        video: boolean;
        offerer: boolean;
    }): Promise<Result<void, HostError>>;
    /** Give the host a media signal of the other side of the call (1 byte to 64 KiB). */
    signal(roomId: string, callId: string, signal: Uint8Array): Promise<Result<void, HostError>>;
    /** Stop the media of the call: it ended. */
    stop(roomId: string, callId: string): Promise<Result<void, HostError>>;
}

function settle(result: Parameters<typeof matchHostResult>[0], call: string) {
    return new Promise<Result<void, HostError>>((resolve) => {
        matchHostResult(
            result,
            call,
            () => resolve(ok(undefined)),
            (error) => {
                if (error instanceof HostResponseDecodeError) return resolve(err(error));
                const payload = error as HostErrorPayload;
                if (payload.tag === "Unsupported")
                    return resolve(err(new FeatureUnavailableError("callMedia")));
                const failure =
                    payload.tag === "Domain"
                        ? (payload.value.value as HostCallMediaError | undefined)
                        : undefined;
                resolve(
                    err(
                        failure?.tag === "NotAllowed"
                            ? new CallMediaNotAllowedError()
                            : new HostCallFailedError(call, payload),
                    ),
                );
            },
        );
    });
}

/** The {@link CallMedia} of a client, or `undefined` when the client has no call media. */
export function createCallMedia(client: TrUApiClient): CallMedia | undefined {
    const media = client.callMedia as Partial<TrUApiClient["callMedia"]> | undefined;
    if (!media?.start || !media.signal || !media.stop) return undefined;
    const { start, signal, stop } = media as TrUApiClient["callMedia"];
    return {
        start: (request) => settle(start.call(media, request), "callMedia.start"),
        signal: (roomId, callId, bytes) =>
            settle(
                signal.call(media, { roomId, callId, signal: toHex(bytes) }),
                "callMedia.signal",
            ),
        stop: (roomId, callId) => settle(stop.call(media, { roomId, callId }), "callMedia.stop"),
    };
}

/** The host's call engine, or `null` outside a container or on a host without call media. */
export async function getCallMedia(): Promise<CallMedia | null> {
    const client = await getClient();
    return (client && createCallMedia(client)) ?? null;
}

if (import.meta.vitest) {
    const { test, expect, vi } = import.meta.vitest;
    const { okAsync, errAsync } = await import("neverthrow");

    test("a client without call media gives none", () => {
        expect(createCallMedia({} as TrUApiClient)).toBeUndefined();
    });

    test("signal carries the bytes as hex", async () => {
        const signal = vi.fn(() => okAsync({}));
        const media = createCallMedia({
            callMedia: { start: vi.fn(), signal, stop: vi.fn() },
        } as unknown as TrUApiClient);
        expect(await media?.signal("r", "c", new Uint8Array([1, 2]))).toEqual(ok(undefined));
        expect(signal).toHaveBeenCalledWith({ roomId: "r", callId: "c", signal: "0x0102" });
    });

    test("a start without consent is CallMediaNotAllowedError", async () => {
        const start = vi.fn(() =>
            errAsync({ tag: "Domain", value: { tag: "V1", value: { tag: "NotAllowed" } } }),
        );
        const media = createCallMedia({
            callMedia: { start, signal: vi.fn(), stop: vi.fn() },
        } as unknown as TrUApiClient);
        const result = await media?.start({
            roomId: "r",
            callId: "c",
            video: false,
            offerer: true,
        });
        expect(result?.ok).toBe(false);
        if (result && !result.ok) expect(result.error).toBeInstanceOf(CallMediaNotAllowedError);
    });

    test("getCallMedia returns null outside a container", async () => {
        expect(await getCallMedia()).toBeNull();
    });
}
